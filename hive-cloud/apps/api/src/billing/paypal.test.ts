import { describe, it, expect, vi } from "vitest";
import { PayPalClient } from "./paypal.js";

function mockFetch(json: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    clone() { return this; },
  }) as unknown as typeof fetch;
}

describe("PayPalClient", () => {
  it("obtains access token", async () => {
    const client = new PayPalClient({
      clientId: "test-client-id",
      clientSecret: "test-secret",
      env: "sandbox",
      fetch: mockFetch({ access_token: "test-token", expires_in: 3600 }),
    });

    const token = await client.getAccessToken();
    expect(token).toBe("test-token");
  });

  it("fetches subscription details", async () => {
    const mockSub = {
      id: "I-SUB-123",
      plan_id: "P-PLAN-BUILDER",
      status: "ACTIVE",
      billing_info: {
        next_billing_time: "2026-08-19T00:00:00Z",
        last_payment: { amount: { value: "15.00", currency_code: "USD" } },
      },
      subscriber: { payer_id: "PAYER-123" },
    };

    const client = new PayPalClient({
      clientId: "test",
      clientSecret: "test",
      env: "sandbox",
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockSub }),
    });

    const sub = await client.getSubscription("I-SUB-123");
    expect(sub.id).toBe("I-SUB-123");
    expect(sub.status).toBe("ACTIVE");
    expect(sub.planId).toBe("P-PLAN-BUILDER");
  });

  it("verifies webhook signature", async () => {
    const client = new PayPalClient({
      clientId: "test",
      clientSecret: "test",
      env: "sandbox",
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ verification_status: "SUCCESS" }) }),
    });

    const result = await client.verifyWebhook({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.paypal.com/v1/notifications/certs/CERT",
      transmission_id: "txn-123",
      transmission_sig: "sig-value",
      transmission_time: new Date().toISOString(),
      webhook_id: "WH-123",
      webhook_event: { event_type: "BILLING.SUBSCRIPTION.ACTIVATED" },
    });
    expect(result).toBe(true);
  });

  it("creates and captures orders", async () => {
    const client = new PayPalClient({
      clientId: "test",
      clientSecret: "test",
      env: "sandbox",
      // Token is cached after first call; requireAuth only fetches when expired.
      // We mock 3 calls: token, create-order, capture.
      fetch: vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) })
        .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "ORDER-1", status: "CREATED", links: [{ rel: "approve", href: "https://paypal.test/approve" }] }) })
        .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "ORDER-1", status: "COMPLETED", purchase_units: [{ custom_id: "custom-1", payments: { captures: [{ id: "CAP-1", status: "COMPLETED", amount: { value: "10.00", currency_code: "USD" } }] } }] }) }),
    });

    const order = await client.createOrder({
      amountCents: 1000,
      customId: "custom-1",
      description: "1000 HIVE Credits",
      returnUrl: "https://hive.test/billing?return=topup",
      cancelUrl: "https://hive.test/billing?cancel=topup",
    });
    expect(order.id).toBe("ORDER-1");

    const capture = await client.captureOrder("ORDER-1");
    expect(capture).toEqual(expect.objectContaining({ status: "COMPLETED", captureId: "CAP-1", amountCents: 1000, customId: "custom-1" }));
  });

  it("fails closed on non-success PayPal responses", async () => {
    const client = new PayPalClient({ clientId: "bad", clientSecret: "bad", env: "sandbox", fetch: mockFetch({ message: "invalid client" }, 401) });
    await expect(client.getAccessToken()).rejects.toThrow("PayPal request failed");
  });

  it("uses sandbox base URL for sandbox env", () => {
    const client = new PayPalClient({
      clientId: "test",
      clientSecret: "test",
      env: "sandbox",
    });
    expect(client.getBaseUrl()).toBe("https://api-m.sandbox.paypal.com");
  });

  it("uses live base URL for live env", () => {
    const client = new PayPalClient({
      clientId: "test",
      clientSecret: "test",
      env: "live",
    });
    expect(client.getBaseUrl()).toBe("https://api-m.paypal.com");
  });
});
