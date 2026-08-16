import { beforeEach, describe, expect, it } from "vitest";
import { BillingStore, digestCheckoutNonce } from "./billing-store.js";

function createSubject(tenantId = "tenant-1") {
  return { userId: "user-1", tenantId, email: "test@hive.local", role: "owner" as const };
}

describe("BillingStore", () => {
  let store: BillingStore;

  beforeEach(() => { store = new BillingStore(); });

  it("creates a tenant-bound pending checkout without storing the raw nonce", async () => {
    const checkout = await store.createCheckout(createSubject(), "builder", "monthly", "P-BUILDER", digestCheckoutNonce("nonce-1"));
    expect(checkout).toEqual(expect.objectContaining({ tenantId: "tenant-1", planId: "builder", paypalPlanId: "P-BUILDER", status: "pending" }));
    expect(checkout.nonceDigest).not.toContain("nonce-1");
    expect(await store.getCheckout("other-tenant", checkout.id)).toBeUndefined();
  });

  it("grants each credit source idempotently", async () => {
    expect(await store.grantStarterCredits("tenant-1")).toBe(50);
    expect(await store.grantStarterCredits("tenant-1")).toBe(50);
    expect(await store.grantMonthlyCredits("tenant-1", 600, "event-1")).toBe(650);
    expect(await store.grantMonthlyCredits("tenant-1", 600, "event-1")).toBe(650);
    expect(await store.grantPurchasedCredits("tenant-1", 200, "order-1")).toBe(850);
  });

  it("tracks subscriptions by both tenant and external ID", async () => {
    await store.upsertSubscription("tenant-1", {
      externalSubscriptionId: "I-SUB-1",
      planVersion: "builder",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect((await store.getSubscription("tenant-1"))?.status).toBe("active");
    expect((await store.findSubscriptionByExternal("I-SUB-1"))?.tenantId).toBe("tenant-1");
  });

  it("debits promotional, subscription, then purchased balances", async () => {
    await store.grantStarterCredits("tenant-1");
    await store.grantMonthlyCredits("tenant-1", 100, "event-sub-1");
    await store.grantPurchasedCredits("tenant-1", 200, "order-1");
    expect(await store.debitCredits("tenant-1", 75, "request-1")).toBe(true);
    expect(await store.getSubscriptionStatus("tenant-1")).toEqual(expect.objectContaining({ promotionalBalance: 0, managedCreditsBalance: 75, purchasedBalance: 200, totalBalance: 275 }));
  });

  it("does not partially drain a balance when a debit is insufficient", async () => {
    await store.grantStarterCredits("tenant-1");
    expect(await store.debitCredits("tenant-1", 100, "request-2")).toBe(false);
    expect((await store.getSubscriptionStatus("tenant-1")).totalBalance).toBe(50);
  });

  it("reserves atomically and settles exact usage even when it exceeds the estimate", async () => {
    await store.grantMonthlyCredits("tenant-1", 10, "payment-1");
    expect(await store.reserveCredits("tenant-1", "11111111-1111-4111-8111-111111111111", 5, "price-1", 20_000)).toBe(true);
    expect(await store.reserveCredits("tenant-1", "11111111-1111-4111-8111-111111111111", 5, "price-1", 20_000)).toBe(true);
    expect(await store.reserveCredits("tenant-1", "22222222-2222-4222-8222-222222222222", 6, "price-1", 20_000)).toBe(false);
    expect(await store.settleReservation("tenant-1", "11111111-1111-4111-8111-111111111111", 7, 25_000)).toEqual({ success: true, debitedCredits: 7 });
    expect((await store.getSubscriptionStatus("tenant-1")).totalBalance).toBe(3);
  });

  it("fails reservations closed at the platform spend cap", async () => {
    await store.grantMonthlyCredits("tenant-1", 10, "payment-2");
    expect(await store.reserveCredits("tenant-1", "33333333-3333-4333-8333-333333333333", 2, "price-1", 30_000, 20_000)).toBe(false);
  });

  it("retries failed webhook events but not completed ones", async () => {
    expect(await store.beginEvent("evt-1", "PAYMENT", "hash", {})).toBe("process");
    await store.markEventFailed("evt-1", "temporary");
    expect(await store.beginEvent("evt-1", "PAYMENT", "hash", {})).toBe("process");
    await store.markEventProcessed("evt-1");
    expect(await store.beginEvent("evt-1", "PAYMENT", "hash", {})).toBe("duplicate");
  });

  it("enforces payment-order tenant ownership", async () => {
    const order = await store.createPaymentOrder("tenant-1", "ORDER-1", "custom-1", "boost", 1000);
    expect(order.status).toBe("created");
    expect(await store.getPaymentOrder("tenant-2", "ORDER-1")).toBeUndefined();
    await store.updatePaymentOrder("tenant-1", "ORDER-1", { status: "captured", creditsGranted: 1000 });
    expect(await store.getPaymentOrder("tenant-1", "ORDER-1")).toEqual(expect.objectContaining({ status: "captured", creditsGranted: 1000 }));
  });
});
