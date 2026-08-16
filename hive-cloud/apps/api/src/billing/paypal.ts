interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "live";
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface PayPalLink {
  href?: string;
  rel?: string;
}

export class PayPalApiError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "PayPalApiError";
  }
}

function approvalUrl(links: PayPalLink[] | undefined): string | undefined {
  return links?.find((link) => link.rel === "approve")?.href;
}

export class PayPalClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #accessToken: string | null = null;
  #tokenExpiresAt = 0;
  #tokenPromise: Promise<string> | undefined;

  public constructor(options: PayPalClientOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#baseUrl = options.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  public getBaseUrl(): string { return this.#baseUrl; }

  async #requestJson(path: string, init: RequestInit, expectedStatuses: number[] = [200, 201]): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok || !expectedStatuses.includes(response.status)) {
      const issue = payload && typeof payload === "object" && "message" in payload ? String(payload.message) : `HTTP ${response.status}`;
      throw new PayPalApiError(response.status, `PayPal request failed: ${issue}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PayPalApiError(502, "PayPal returned an invalid response");
    return payload as Record<string, unknown>;
  }

  public async getAccessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#tokenExpiresAt) return this.#accessToken;
    if (this.#tokenPromise) return this.#tokenPromise;
    this.#tokenPromise = (async () => {
      const auth = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64");
      const data = await this.#requestJson("/v1/oauth2/token", {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      const accessToken = data["access_token"];
      const expiresIn = Number(data["expires_in"]);
      if (typeof accessToken !== "string" || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new PayPalApiError(502, "PayPal returned an invalid access token");
      this.#accessToken = accessToken;
      this.#tokenExpiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1_000;
      return accessToken;
    })();
    try {
      return await this.#tokenPromise;
    } finally {
      this.#tokenPromise = undefined;
    }
  }

  async #authorizedJson(path: string, init: RequestInit = {}, expectedStatuses?: number[]): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    return this.#requestJson(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    }, expectedStatuses);
  }

  public async createSubscription(params: {
    planId: string;
    checkoutId: string;
    email: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; status: string; approvalUrl: string }> {
    const data = await this.#authorizedJson("/v1/billing/subscriptions", {
      method: "POST",
      headers: { "PayPal-Request-Id": params.checkoutId },
      body: JSON.stringify({
        plan_id: params.planId,
        custom_id: params.checkoutId,
        subscriber: { email_address: params.email },
        application_context: {
          user_action: "SUBSCRIBE_NOW",
          return_url: params.returnUrl,
          cancel_url: params.cancelUrl,
        },
      }),
    });
    const id = data["id"];
    const status = data["status"];
    const approve = approvalUrl(data["links"] as PayPalLink[] | undefined);
    if (typeof id !== "string" || typeof status !== "string" || !approve) throw new PayPalApiError(502, "PayPal did not return a subscription approval link");
    return { id, status, approvalUrl: approve };
  }

  public async getSubscription(subscriptionId: string): Promise<{
    id: string;
    planId: string;
    customId?: string;
    status: string;
    subscriber?: { payer_id?: string };
    billingInfo?: Record<string, unknown>;
  }> {
    const data = await this.#authorizedJson(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const id = data["id"];
    const planId = data["plan_id"];
    const status = data["status"];
    if (typeof id !== "string" || typeof planId !== "string" || typeof status !== "string") throw new PayPalApiError(502, "PayPal returned invalid subscription details");
    return {
      id,
      planId,
      ...(typeof data["custom_id"] === "string" ? { customId: data["custom_id"] } : {}),
      status,
      ...(data["subscriber"] && typeof data["subscriber"] === "object" ? { subscriber: data["subscriber"] as { payer_id?: string } } : {}),
      ...(data["billing_info"] && typeof data["billing_info"] === "object" ? { billingInfo: data["billing_info"] as Record<string, unknown> } : {}),
    };
  }

  public async cancelSubscription(subscriptionId: string, reason: string): Promise<void> {
    const token = await this.getAccessToken();
    const response = await this.#fetch(`${this.#baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok || response.status !== 204) throw new PayPalApiError(response.status, `PayPal cancellation failed with HTTP ${response.status}`);
  }

  public async verifyWebhook(params: {
    auth_algo: string;
    cert_url: string;
    transmission_id: string;
    transmission_sig: string;
    transmission_time: string;
    webhook_id: string;
    webhook_event: unknown;
  }): Promise<boolean> {
    const result = await this.#authorizedJson("/v1/notifications/verify-webhook-signature", { method: "POST", body: JSON.stringify(params) });
    return result["verification_status"] === "SUCCESS";
  }

  public async createOrder(params: {
    amountCents: number;
    currency?: string;
    customId: string;
    description: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; status: string; approvalUrl: string }> {
    const amount = (params.amountCents / 100).toFixed(2);
    const data = await this.#authorizedJson("/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": params.customId },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: params.currency ?? "USD", value: amount }, description: params.description, custom_id: params.customId }],
        payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: params.returnUrl, cancel_url: params.cancelUrl } } },
      }),
    });
    const id = data["id"];
    const status = data["status"];
    const approve = approvalUrl(data["links"] as PayPalLink[] | undefined);
    if (typeof id !== "string" || typeof status !== "string" || !approve) throw new PayPalApiError(502, "PayPal did not return an order approval link");
    return { id, status, approvalUrl: approve };
  }

  public async captureOrder(orderId: string): Promise<{
    orderId: string;
    status: string;
    captureId: string;
    amountCents: number;
    currency: string;
    customId: string;
  }> {
    const data = await this.#authorizedJson(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      headers: { "PayPal-Request-Id": `capture:${orderId}` },
      body: "{}",
    });
    const purchaseUnits = data["purchase_units"] as Array<Record<string, unknown>> | undefined;
    const purchaseUnit = purchaseUnits?.[0];
    const payments = purchaseUnit?.["payments"] as { captures?: Array<Record<string, unknown>> } | undefined;
    const capture = payments?.captures?.[0];
    const amount = capture?.["amount"] as { value?: string; currency_code?: string } | undefined;
    const amountCents = Math.round(Number(amount?.value) * 100);
    const id = data["id"];
    const status = data["status"];
    const captureId = capture?.["id"];
    const captureStatus = capture?.["status"];
    const customId = purchaseUnit?.["custom_id"];
    if (typeof id !== "string" || typeof status !== "string" || typeof captureId !== "string" || captureStatus !== "COMPLETED" || !Number.isSafeInteger(amountCents) || amountCents <= 0 || typeof amount?.currency_code !== "string" || typeof customId !== "string") {
      throw new PayPalApiError(502, "PayPal returned invalid capture details");
    }
    return { orderId: id, status, captureId, amountCents, currency: amount.currency_code, customId };
  }
}
