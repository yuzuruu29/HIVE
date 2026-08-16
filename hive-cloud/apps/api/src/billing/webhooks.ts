import { createHash } from "node:crypto";
import { PLAN_VERSIONS } from "@hive-cloud/contracts";
import { BillingStore, type SubscriptionRecord } from "./billing-store.js";
import type { PayPalClient } from "./paypal.js";

interface PayPalEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
}

interface WebhookHeaders {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
}

type PlanIdMap = Record<string, string>;

function parseEvent(value: unknown): PayPalEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["event_type"] !== "string" || !record["resource"] || typeof record["resource"] !== "object" || Array.isArray(record["resource"])) return undefined;
  return { id: record["id"], event_type: record["event_type"], resource: record["resource"] as Record<string, unknown> };
}

function subscriptionIdFor(event: PayPalEvent): string | undefined {
  if (event.event_type.startsWith("BILLING.SUBSCRIPTION.")) return typeof event.resource["id"] === "string" ? event.resource["id"] : undefined;
  if (typeof event.resource["billing_agreement_id"] === "string") return event.resource["billing_agreement_id"];
  const supplementary = event.resource["supplementary_data"] as Record<string, unknown> | undefined;
  const related = supplementary?.["related_ids"] as Record<string, unknown> | undefined;
  const candidate = related?.["subscription_id"] ?? related?.["billing_agreement_id"];
  return typeof candidate === "string" ? candidate : undefined;
}

function nextBillingTime(billingInfo: Record<string, unknown> | undefined): string {
  const value = billingInfo?.["next_billing_time"];
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date(Date.now() + 31 * 86_400_000).toISOString();
}

export class WebhookHandler {
  readonly #store: BillingStore;
  readonly #paypal: PayPalClient;
  readonly #planIdMap: PlanIdMap;

  public constructor(store: BillingStore, paypalClient: PayPalClient, planIdMap: PlanIdMap = {}) {
    this.#store = store;
    this.#paypal = paypalClient;
    this.#planIdMap = planIdMap;
  }

  public async handleEvent(eventValue: unknown, rawBody: string, headers: WebhookHeaders): Promise<{ status: number; message: string }> {
    const event = parseEvent(eventValue);
    if (!event) return { status: 400, message: "Invalid webhook payload" };
    if (Object.values(headers).some((value) => !value)) return { status: 400, message: "Missing webhook verification headers" };
    const verified = await this.#paypal.verifyWebhook({ ...headers, webhook_event: eventValue });
    if (!verified) return { status: 401, message: "Invalid webhook signature" };

    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const disposition = await this.#store.beginEvent(event.id, event.event_type, payloadHash, eventValue);
    if (disposition === "duplicate") return { status: 200, message: "Already processed" };

    try {
      const tenantId = await this.#processEvent(event);
      await this.#store.markEventProcessed(event.id, tenantId);
      return { status: 200, message: "OK" };
    } catch (error) {
      await this.#store.markEventFailed(event.id, error instanceof Error ? error.message : "Unknown webhook processing failure");
      return { status: 500, message: "Webhook processing failed; retry required" };
    }
  }

  async #resolveSubscription(subscriptionId: string): Promise<{ tenantId: string; subscription: SubscriptionRecord; paypalPlanId: string }> {
    const existing = await this.#store.findSubscriptionByExternal(subscriptionId);
    const checkout = existing ? undefined : await this.#store.findCheckoutByExternal(subscriptionId);
    if (!existing && !checkout) throw new Error("Subscription is not bound to a HIVE tenant");
    const paypalSubscription = await this.#paypal.getSubscription(subscriptionId);
    const planVersion = this.#planIdMap[paypalSubscription.planId];
    if (!planVersion || !PLAN_VERSIONS[planVersion]) throw new Error("PayPal plan is not mapped to a HIVE plan");
    if (checkout && (checkout.paypalPlanId !== paypalSubscription.planId || checkout.planId !== planVersion)) throw new Error("Checkout plan does not match PayPal subscription");
    const tenantId = existing?.tenantId ?? checkout!.tenantId;
    const currentPeriodStart = existing?.subscription.currentPeriodStart ?? new Date().toISOString();
    return {
      tenantId,
      paypalPlanId: paypalSubscription.planId,
      subscription: {
        externalSubscriptionId: subscriptionId,
        planVersion,
        status: paypalSubscription.status === "ACTIVE" ? "active" : existing?.subscription.status ?? "pending",
        currentPeriodStart,
        currentPeriodEnd: nextBillingTime(paypalSubscription.billingInfo),
        ...(existing?.subscription.paidThrough ? { paidThrough: existing.subscription.paidThrough } : {}),
        cancelAtPeriodEnd: existing?.subscription.cancelAtPeriodEnd ?? false,
      },
    };
  }

  async #processEvent(event: PayPalEvent): Promise<string | undefined> {
    const subscriptionId = subscriptionIdFor(event);
    switch (event.event_type) {
      case "BILLING.SUBSCRIPTION.CREATED":
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        if (!subscriptionId) throw new Error("Webhook is missing subscription ID");
        const resolved = await this.#resolveSubscription(subscriptionId);
        if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") resolved.subscription.status = "active";
        await this.#store.upsertSubscription(resolved.tenantId, resolved.subscription);
        const plan = PLAN_VERSIONS[resolved.subscription.planVersion];
        if (plan && resolved.subscription.status === "active") {
          await this.#store.setEntitlement(resolved.tenantId, plan.id, { dailyJobLimit: plan.dailyJobLimit, councilRunLimit: plan.councilRunLimit, maxWorkspaces: plan.maxWorkspaces }, resolved.subscription.currentPeriodEnd);
        }
        return resolved.tenantId;
      }

      case "PAYMENT.SALE.COMPLETED": {
        if (!subscriptionId) throw new Error("Payment webhook is missing subscription ID");
        const resolved = await this.#resolveSubscription(subscriptionId);
        const plan = PLAN_VERSIONS[resolved.subscription.planVersion];
        if (!plan) throw new Error("Subscription plan is unavailable");
        const paidThrough = resolved.subscription.currentPeriodEnd;
        await this.#store.upsertSubscription(resolved.tenantId, { ...resolved.subscription, status: "active", paidThrough });
        await this.#store.grantMonthlyCredits(resolved.tenantId, plan.monthlyManagedCredits, event.id);
        await this.#store.setEntitlement(resolved.tenantId, plan.id, { dailyJobLimit: plan.dailyJobLimit, councilRunLimit: plan.councilRunLimit, maxWorkspaces: plan.maxWorkspaces }, paidThrough);
        return resolved.tenantId;
      }

      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
        if (!subscriptionId) throw new Error("Webhook is missing subscription ID");
        const resolved = await this.#resolveSubscription(subscriptionId);
        await this.#store.upsertSubscription(resolved.tenantId, { ...resolved.subscription, status: "past_due" });
        return resolved.tenantId;
      }

      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED": {
        if (!subscriptionId) throw new Error("Webhook is missing subscription ID");
        const resolved = await this.#resolveSubscription(subscriptionId);
        await this.#store.upsertSubscription(resolved.tenantId, {
          ...resolved.subscription,
          status: event.event_type.endsWith("EXPIRED") ? "expired" : "cancelled",
          cancelAtPeriodEnd: true,
          cancelledAt: new Date().toISOString(),
        });
        return resolved.tenantId;
      }

      case "PAYMENT.SALE.REFUNDED":
      case "PAYMENT.SALE.REVERSED": {
        if (!subscriptionId) throw new Error("Reversal webhook is missing subscription ID");
        const resolved = await this.#resolveSubscription(subscriptionId);
        const plan = PLAN_VERSIONS[resolved.subscription.planVersion];
        if (!plan) throw new Error("Subscription plan is unavailable");
        await this.#store.reverseMonthlyCredits(resolved.tenantId, plan.monthlyManagedCredits, event.id);
        await this.#store.upsertSubscription(resolved.tenantId, { ...resolved.subscription, status: "past_due" });
        return resolved.tenantId;
      }

      default:
        return undefined;
    }
  }
}
