import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingStore } from "./billing-store.js";
import type { PayPalClient } from "./paypal.js";
import { WebhookHandler } from "./webhooks.js";

const headers = {
  auth_algo: "SHA256withRSA",
  cert_url: "https://example.com/cert",
  transmission_id: "txn-1",
  transmission_sig: "sig",
  transmission_time: new Date().toISOString(),
  webhook_id: "WH-1",
};

describe("WebhookHandler", () => {
  let store: BillingStore;
  let handler: WebhookHandler;

  beforeEach(async () => {
    store = new BillingStore();
    await store.upsertSubscription("known-tenant", {
      externalSubscriptionId: "I-SUB-123",
      planVersion: "builder",
      status: "pending",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const paypalClient = {
      verifyWebhook: vi.fn().mockResolvedValue(true),
      getSubscription: vi.fn().mockResolvedValue({
        id: "I-SUB-123",
        planId: "P-BUILDER-MONTHLY",
        status: "ACTIVE",
        billingInfo: { next_billing_time: "2026-08-19T00:00:00Z" },
        subscriber: { payer_id: "PAYER-1" },
      }),
    } as unknown as PayPalClient;
    handler = new WebhookHandler(store, paypalClient, { "P-BUILDER-MONTHLY": "builder" });
  });

  it("activates without granting credits before a settled payment", async () => {
    const result = await handler.handleEvent({ id: "evt-001", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-SUB-123" } }, "RAW_BODY", headers);
    expect(result.status).toBe(200);
    expect((await store.getSubscriptionStatus("known-tenant")).totalBalance).toBe(0);
  });

  it("grants monthly credits only on PAYMENT.SALE.COMPLETED and remains idempotent", async () => {
    const event = { id: "evt-002", event_type: "PAYMENT.SALE.COMPLETED", resource: { billing_agreement_id: "I-SUB-123" } };
    expect((await handler.handleEvent(event, "RAW", headers)).status).toBe(200);
    expect((await store.getSubscriptionStatus("known-tenant")).totalBalance).toBe(600);
    expect((await handler.handleEvent(event, "RAW", headers)).message).toBe("Already processed");
    expect((await store.getSubscriptionStatus("known-tenant")).totalBalance).toBe(600);
  });

  it("returns 500 and leaves a failed event retryable when tenant resolution fails", async () => {
    const event = { id: "evt-003", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-UNKNOWN" } };
    expect((await handler.handleEvent(event, "RAW", headers)).status).toBe(500);
    expect((await handler.handleEvent(event, "RAW", headers)).status).toBe(500);
  });

  it("rejects missing verification headers before processing", async () => {
    const result = await handler.handleEvent({ id: "evt-004", event_type: "UNKNOWN", resource: {} }, "RAW", { ...headers, webhook_id: "" });
    expect(result.status).toBe(400);
  });
});
