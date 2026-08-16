import { randomUUID, timingSafeEqual } from "node:crypto";
import { PLAN_VERSIONS, TOPUP_SKUS } from "@hive-cloud/contracts";
import { digestCheckoutNonce, type BillingStore } from "./billing-store.js";
import type { PayPalClient } from "./paypal.js";
import type { WebhookHandler } from "./webhooks.js";

interface BillingHandlerOptions {
  webOrigin: string;
  enabled: boolean;
  planIds: Record<"builder_monthly" | "builder_annual" | "pro_monthly" | "pro_annual", string | undefined>;
}

function safeDigestEqual(actual: string, expectedDigest: string): boolean {
  const actualDigest = digestCheckoutNonce(actual);
  return actualDigest.length === expectedDigest.length && timingSafeEqual(Buffer.from(actualDigest), Buffer.from(expectedDigest));
}

function subscriptionStatus(status: string): string {
  if (status === "ACTIVE") return "active";
  if (status === "SUSPENDED") return "past_due";
  if (status === "CANCELLED") return "cancelled";
  if (status === "EXPIRED") return "expired";
  return "pending";
}

function validDate(value: unknown, fallback: Date): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback.toISOString();
}

export function createBillingHandlers(store: BillingStore, paypal: PayPalClient, options: BillingHandlerOptions) {
  return {
    async getPlans() {
      const plans = Object.values(PLAN_VERSIONS).map((plan) => ({
        id: plan.id,
        name: plan.name,
        monthlyPriceCents: plan.monthlyPriceCents,
        annualPriceCents: plan.annualPriceCents,
        monthlyManagedCredits: plan.monthlyManagedCredits,
        dailyJobLimit: plan.dailyJobLimit,
        councilRunLimit: plan.councilRunLimit,
        maxWorkspaces: plan.maxWorkspaces,
      }));
      return { status: 200, body: { plans } };
    },

    async getStatus(tenantId: string) {
      return { status: 200, body: await store.getSubscriptionStatus(tenantId) };
    },

    async createCheckout(tenantId: string, userId: string, email: string, body: { planId: string; interval: string }) {
      if (!options.enabled) return { status: 503, body: { error: "Managed billing is not configured for this deployment." } };
      if (body.planId !== "builder" && body.planId !== "pro") return { status: 400, body: { error: "Invalid plan" } };
      if (body.interval !== "monthly" && body.interval !== "annual") return { status: 400, body: { error: "Invalid interval" } };
      const paypalPlanId = options.planIds[`${body.planId}_${body.interval}`];
      if (!paypalPlanId) return { status: 503, body: { error: "This billing plan is not configured yet." } };
      const nonce = randomUUID();
      const checkout = await store.createCheckout(
        { userId, tenantId, email, role: "owner" },
        body.planId,
        body.interval,
        paypalPlanId,
        digestCheckoutNonce(nonce),
      );
      const returnUrl = new URL("/billing", options.webOrigin);
      returnUrl.searchParams.set("billing_return", "subscription");
      returnUrl.searchParams.set("checkout_id", checkout.id);
      returnUrl.searchParams.set("state", nonce);
      const cancelUrl = new URL("/billing", options.webOrigin);
      cancelUrl.searchParams.set("billing_cancelled", "subscription");
      const subscription = await paypal.createSubscription({
        planId: paypalPlanId,
        checkoutId: checkout.id,
        email,
        returnUrl: returnUrl.toString(),
        cancelUrl: cancelUrl.toString(),
      });
      if (!await store.attachCheckoutSubscription(tenantId, checkout.id, subscription.id)) throw new Error("Checkout expired before PayPal approval started");
      return {
        status: 201,
        body: { checkoutId: checkout.id, planId: checkout.planId, expiresAt: checkout.expiresAt, approvalUrl: subscription.approvalUrl },
      };
    },

    async confirmSubscription(tenantId: string, body: { subscriptionId: string; checkoutId: string; state: string }) {
      if (!options.enabled) return { status: 503, body: { error: "Managed billing is not configured for this deployment." } };
      const checkout = await store.getCheckout(tenantId, body.checkoutId);
      if (!checkout || checkout.status !== "pending" || Date.parse(checkout.expiresAt) <= Date.now() || !safeDigestEqual(body.state, checkout.nonceDigest)) {
        return { status: 409, body: { error: "Checkout is invalid or expired." } };
      }
      if (checkout.externalSubscriptionId !== body.subscriptionId) return { status: 409, body: { error: "Subscription does not match this checkout." } };
      const sub = await paypal.getSubscription(body.subscriptionId);
      if (sub.id !== body.subscriptionId || sub.planId !== checkout.paypalPlanId || sub.customId !== checkout.id || !["APPROVED", "ACTIVE"].includes(sub.status)) {
        return { status: 409, body: { error: "PayPal has not approved this subscription." } };
      }
      if (!await store.approveCheckout(tenantId, checkout.id, sub.id)) return { status: 409, body: { error: "Checkout could not be approved." } };
      const now = new Date();
      const periodEnd = validDate(sub.billingInfo?.["next_billing_time"], new Date(now.getTime() + 31 * 86_400_000));
      await store.upsertSubscription(tenantId, {
        externalSubscriptionId: sub.id,
        planVersion: checkout.planId,
        status: subscriptionStatus(sub.status),
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: periodEnd,
      });
      const plan = PLAN_VERSIONS[checkout.planId];
      if (sub.status === "ACTIVE" && plan) {
        await store.setEntitlement(tenantId, checkout.planId, { dailyJobLimit: plan.dailyJobLimit, councilRunLimit: plan.councilRunLimit, maxWorkspaces: plan.maxWorkspaces }, periodEnd);
      }
      await store.completeCheckout(tenantId, checkout.id);
      return { status: 200, body: { success: true, status: sub.status } };
    },

    async cancelSubscription(tenantId: string) {
      if (!options.enabled) return { status: 503, body: { error: "Managed billing is not configured for this deployment." } };
      const subscription = await store.getSubscription(tenantId);
      if (!subscription) return { status: 404, body: { error: "No subscription found." } };
      await paypal.cancelSubscription(subscription.externalSubscriptionId, "Customer requested cancellation");
      const success = await store.markSubscriptionCancellation(tenantId);
      return { status: success ? 200 : 409, body: { success } };
    },

    async createTopUpOrder(tenantId: string, body: { sku: string }) {
      if (!options.enabled) return { status: 503, body: { error: "Managed billing is not configured for this deployment." } };
      const topup = TOPUP_SKUS[body.sku as keyof typeof TOPUP_SKUS];
      if (!topup) return { status: 400, body: { error: "Invalid SKU" } };
      const customId = randomUUID();
      const returnUrl = new URL("/billing", options.webOrigin);
      returnUrl.searchParams.set("billing_return", "topup");
      const cancelUrl = new URL("/billing", options.webOrigin);
      cancelUrl.searchParams.set("billing_cancelled", "topup");
      const order = await paypal.createOrder({
        amountCents: topup.amountCents,
        customId,
        description: `${topup.credits} HIVE Credits`,
        returnUrl: returnUrl.toString(),
        cancelUrl: cancelUrl.toString(),
      });
      await store.createPaymentOrder(tenantId, order.id, customId, body.sku, topup.amountCents);
      return { status: 201, body: { orderId: order.id, status: order.status, approvalUrl: order.approvalUrl } };
    },

    async captureOrder(tenantId: string, orderId: string) {
      if (!options.enabled) return { status: 503, body: { error: "Managed billing is not configured for this deployment." } };
      const existingOrder = await store.getPaymentOrder(tenantId, orderId);
      if (!existingOrder) return { status: 404, body: { error: "Payment order not found." } };
      if (existingOrder.status === "captured" && existingOrder.externalCaptureId) {
        return { status: 200, body: { success: true, captureId: existingOrder.externalCaptureId } };
      }
      const topup = TOPUP_SKUS[existingOrder.sku as keyof typeof TOPUP_SKUS];
      if (!topup) return { status: 409, body: { error: "Payment order SKU is invalid." } };
      const capture = await paypal.captureOrder(orderId);
      if (capture.orderId !== orderId || capture.status !== "COMPLETED" || capture.customId !== existingOrder.customId || capture.amountCents !== existingOrder.amountCents || capture.currency !== existingOrder.currency) {
        return { status: 409, body: { error: "Captured payment does not match the order." } };
      }
      await store.grantPurchasedCredits(tenantId, topup.credits, orderId);
      await store.updatePaymentOrder(tenantId, orderId, { status: "captured", externalCaptureId: capture.captureId, creditsGranted: topup.credits });
      return { status: 200, body: { success: true, captureId: capture.captureId } };
    },
  };
}

export async function handlePayPalWebhook(webhookHandler: WebhookHandler, rawBody: string, headers: Record<string, string>, webhookId: string) {
  const event = JSON.parse(rawBody) as unknown;
  return webhookHandler.handleEvent(event, rawBody, {
    auth_algo: headers["paypal-auth-algo"] ?? "",
    cert_url: headers["paypal-cert-url"] ?? "",
    transmission_id: headers["paypal-transmission-id"] ?? "",
    transmission_sig: headers["paypal-transmission-sig"] ?? "",
    transmission_time: headers["paypal-transmission-time"] ?? "",
    webhook_id: webhookId,
  });
}
