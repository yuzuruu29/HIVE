import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createInternalAuthHeaders } from "@hive-cloud/security";
import { HiveRouter } from "@hive-cloud/router";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import { createApp } from "./app.js";
import { CloudStore } from "./store.js";
import type { ApiEnv } from "./env.js";

const baseUrl = process.env.DATABASE_URL;
const secret = "test-internal-service-secret-value";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "00000000-0000-4000-8000-00000000000a";

interface UsageFixture {
  app: Awaited<ReturnType<typeof createApp>>;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat: (opts?: { path?: string; extraHeaders?: Record<string, string> }) => any;
  close: () => Promise<void>;
}

/** Shared helper: seeds tenant+user, creates API key, builds app with DB-backed usage+billing. */
async function makeFixture(opts: {
  dbUrl: string;
  fiveHourLimit?: number;
  weeklyLimit?: number;
  fetch?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  tenantId?: string;
  trustedProxies?: string;
  providerKind?: string;
}): Promise<UsageFixture> {
  const env: ApiEnv = {
    NODE_ENV: "test",
    APP_ENV: "development",
    HIVE_DEPLOYMENT_MODE: "self_hosted",
    API_PORT: 4000,
    INTERNAL_SERVICE_SECRET: secret,
    HIVE_API_KEY_PEPPER: "test-api-key-pepper-at-least-32-characters",
    HIVE_ENCRYPTION_KEK_BASE64: Buffer.alloc(32, 2).toString("base64"),
    HIVE_BETA_BYPASS: true,
    HIVE_MOCK_PROVIDER: false,
    HIVE_LOCAL_PROVIDER_BRIDGE: false,
    OPENAI_MANAGED_MODEL: "gpt-4.1-mini",
    ANTHROPIC_MANAGED_MODEL: "claude-haiku-4-20250514",
    PRICE_STALE_MINUTES: 1_440,
    PAYPAL_ENV: "sandbox",
    WEB_ORIGIN: "http://localhost:3000",
    TRUSTED_PROXY_CIDRS: opts.trustedProxies ?? "127.0.0.1,::1",
    DATABASE_POOL_SIZE: 10,
    DATABASE_CONNECTION_TIMEOUT_MS: 5000,
    DATABASE_IDLE_TIMEOUT_MS: 30000,
    DATABASE_CONNECTION_MODE: undefined,
    DATABASE_APPLICATION_NAME: "hive_cloud_test",
    REDIS_URL: undefined,
    R2_BUCKET: "hive-cloud",
    R2_FORCE_PATH_STYLE: false,
    EMAIL_FROM: "HIVE <access@example.com>",
    OWNER_EMAILS: "owner@example.com",
    DATABASE_URL: opts.dbUrl,
    LIMIT_REQUESTS_5H: opts.fiveHourLimit ?? 500,
    LIMIT_REQUESTS_WEEKLY: opts.weeklyLimit ?? 5000,
    LIMIT_TOKENS_INPUT_5H: 1_000_000,
    LIMIT_TOKENS_OUTPUT_5H: 500_000,
  };

  const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
  const tenantId = opts.tenantId ?? TENANT;
  const subject = { userId: USER_ID, tenantId, role: "owner" as const, email: "owner@usage-test.local" };

  // Seed tenant+user rows so FK references always resolve
  const { Pool: SeedPool } = await import("pg");
  const seedP = new SeedPool({ connectionString: opts.dbUrl });
  try {
    await seedP.query("INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [tenantId, `T-${tenantId.slice(0, 8)}`, `usage-test-${tenantId.slice(0, 8)}`]);
    await seedP.query("INSERT INTO users (id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING", [USER_ID, "u@t"]);
  } finally { await seedP.end(); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providerKind: any = opts.providerKind ?? "groq";
  await store.addProvider(subject, {
    kind: providerKind,
    name: "Test provider",
    api_key: "test-provider-key",
    default_model: "hive-0.1",
    capabilities: { vision: false, tools: true, context_window: 32_768 },
  });

  const key = await store.createApiKey(subject, "Usage test key", ["chat:write", "models:read"], env.HIVE_API_KEY_PEPPER);
  const headers: Record<string, string> = { authorization: `Bearer ${key.raw}`, "content-type": "application/json" };

  const defaultFetch = async () => Response.json({
    id: "chatcmpl-test",
    choices: [{ message: { role: "assistant", content: "Response from Assistant" } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });

  const router = new HiveRouter({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch: (opts.fetch ?? defaultFetch) as any,
    requestId: () => crypto.randomUUID(),
  });

  const app = await createApp({ env, store, router });

  return {
    app,
    headers,
    chat: (overrides: { path?: string; extraHeaders?: Record<string, string> } = {}) => app.inject({
      method: "POST",
      url: overrides?.path ?? "/v1/chat/completions",
      headers: { ...headers, ...overrides?.extraHeaders },
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "Hello" }] },
    }),
    close: () => app.close(),
  };
}

describe.runIf(Boolean(baseUrl))("Usage enforcement through API routes", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    db = await createTestDatabase(baseUrl!);
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: db.dbUrl });
    try {
      await p.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'UT','usage-test') ON CONFLICT DO NOTHING", [TENANT]);
      await p.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'UT-B','usage-test-b') ON CONFLICT DO NOTHING", ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
      await p.query("INSERT INTO users (id,email) VALUES ($1,'u@t') ON CONFLICT DO NOTHING", [USER_ID]);
    } finally { await p.end(); }
  }, 120_000);

  afterAll(async () => { if (db) await db.dispose().catch(() => {}); });

  // Clean residual usage data between tests so each test sees a fresh counter
  beforeEach(async () => {
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: db.dbUrl });
    try {
      await p.query("DELETE FROM usage_windows");
    } finally { await p.end(); }
  });

  // 1 — request succeeds below limits
  it("managed-provider request succeeds below limits", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 100, weeklyLimit: 1000 });
    try { expect((await f.chat()).statusCode).toBe(200); } finally { await f.close(); }
  });

  // 2 — five-hour rejection
  it("five-hour limit rejection", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 0, weeklyLimit: 1000 });
    try {
      const r = await f.chat();
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe("usage_window_exceeded");
      expect(r.json().error.window).toBe("five_hour");
      expect(r.headers["retry-after"]).toBeTruthy();
      expect(r.headers["x-usage-window"]).toBe("five_hour");
      expect(r.headers["x-usage-limit"]).toBe("0");
      expect(r.headers["x-usage-remaining"]).toBe("0");
    } finally { await f.close(); }
  });

  // 3 — weekly rejection
  it("weekly limit rejection", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 100, weeklyLimit: 0 });
    try {
      const r = await f.chat();
      expect(r.statusCode).toBe(429);
      expect(r.json().error.window).toBe("weekly");
      expect(r.headers["x-usage-window"]).toBe("weekly");
    } finally { await f.close(); }
  });

  // 4 — both limits ok
  it("both limits ok", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 10, weeklyLimit: 10 });
    try { expect((await f.chat()).statusCode).toBe(200); } finally { await f.close(); }
  });

  // 5 — concurrent oversubscription prevention
  it("concurrent requests cannot oversubscribe the last unit", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 2, weeklyLimit: 10 });
    try {
      const [a, b, c] = await Promise.all([f.chat(), f.chat(), f.chat()]);
      expect([a, b, c].filter(r => r.statusCode === 200)).toHaveLength(2);
      expect([a, b, c].filter(r => r.statusCode === 429)).toHaveLength(1);
    } finally { await f.close(); }
  });

  // 6 — Provider failure returns 502 and releases usage for reuse
  // R1's failing fetch triggers HiveRouter cooldown (line 448: provider_network_error).
  // R2 uses a fresh fixture with a fresh router (no stale cooldown state).
  it("provider failure returns 502 and releases reservation", async () => {
    // R1: failing provider — sets cooldown on this router, releases usage
    const f1 = await makeFixture({
      dbUrl: db.dbUrl, fiveHourLimit: 2, weeklyLimit: 10,
      fetch: async () => { throw new Error("fail"); },
    });
    try {
      const r1 = await f1.chat();
      expect(r1.statusCode).toBe(502);
      expect(r1.json().error.code).toBe("upstream_error");
    } finally { await f1.close(); }

    // R2: fresh fixture with fresh router — no inherited cooldown
    // Usage was released by R1's error handler — released capacity is available
    const f2 = await makeFixture({
      dbUrl: db.dbUrl, fiveHourLimit: 2, weeklyLimit: 10,
    });
    try {
      const r2 = await f2.chat();
      expect(r2.statusCode).toBe(200);
    } finally { await f2.close(); }
  });

  // 7 — health bypass
  it("health route bypasses usage enforcement", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 0, weeklyLimit: 0 });
    try { expect((await f.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200); } finally { await f.close(); }
  });

  // 8 — tenant isolation
  it("tenant isolation", async () => {
    const fA = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 1, weeklyLimit: 10, tenantId: TENANT });
    const fB = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 1, weeklyLimit: 10, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    try {
      expect((await fA.chat()).statusCode).toBe(200);
      expect((await fB.chat()).statusCode).toBe(200); // separate counter
    } finally { await fA.close(); await fB.close(); }
  });

  // 9 — With trusted proxies set to 127.0.0.1, app.inject() reports 127.0.0.1 as connection IP.
  // Since 127.0.0.1 is trusted, Fastify uses the X-Forwarded-For value as client IP.
  // A non-trusted client cannot spoof the IP dimension — this tests that trusted-proxy
  // forwarding works correctly (creates a separate counter per forwarded IP).
  it("trusted forwarding header produces separate IP dimension", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 1, weeklyLimit: 10 });
    try {
      expect((await f.chat()).statusCode).toBe(200);
      // From a trusted proxy (127.0.0.1), the forwarded IP creates a new dimension
      expect((await f.chat({ extraHeaders: { "x-forwarded-for": "10.0.0.99" } })).statusCode).toBe(200);
    } finally { await f.close(); }
  });

  // 10 — provider-specific counters (concurrent because reservations release on success)
  it("provider-specific counters are isolated", async () => {
    const fGroq = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 1, weeklyLimit: 10, providerKind: "groq" });
    const fAnthro = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 1, weeklyLimit: 10, providerKind: "anthropic" });
    try {
      const [g1, a1, g2] = await Promise.all([fGroq.chat(), fAnthro.chat(), fGroq.chat()]);
      // Groq gets one success + one block (order non-deterministic under concurrency)
      expect([g1, g2].map(r => r.statusCode).sort()).toEqual([200, 429]);
      expect(a1.statusCode).toBe(200); // separate counter per provider
    } finally { await fGroq.close(); await fAnthro.close(); }
  });

  // 11 — webhook bypass
  it("webhook routes bypass ordinary usage enforcement", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 0, weeklyLimit: 0 });
    try { expect((await f.app.inject({ method: "POST", url: "/api/billing/webhook", payload: {} })).statusCode).not.toBe(429); } finally { await f.close(); }
  });

  // 12 — Admin endpoints require internal auth and return 403 for API keys
  it("admin route returns 403 for API-key auth", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 0, weeklyLimit: 0 });
    try {
      // API key auth — not internal/admin → 403
      expect((await f.app.inject({ method: "GET", url: "/api/admin/usage", headers: f.headers })).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  // 13 — fixture self-seeding prevents missing-tenant FK violations
  it("fresh-database fixture is auto-seeded and works without errors", { timeout: 30_000 }, async () => {
    const fresh = await createTestDatabase(baseUrl!, "no-ten");
    try {
      const f = await makeFixture({ dbUrl: fresh.dbUrl, fiveHourLimit: 10, weeklyLimit: 10 });
      try { expect((await f.chat()).statusCode).toBe(200); } finally { await f.close(); }
    } finally { await fresh.dispose().catch(() => {}); }
  });

  // 14 — internal auth bypasses usage
  it("internal auth bypasses usage enforcement intentionally", async () => {
    const f = await makeFixture({ dbUrl: db.dbUrl, fiveHourLimit: 0, weeklyLimit: 0 });
    try {
      const ia = createInternalAuthHeaders(
        { userId: USER_ID, tenantId: TENANT, role: "owner", email: "u@t" },
        secret, "POST", "/v1/chat/completions", Date.now(),
      );
      const r = await f.app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { ...ia, "content-type": "application/json" },
        payload: { model: "hive-0.1", messages: [{ role: "user", content: "Hello" }] },
      });
      expect(r.statusCode).toBe(200); // bypasses usage — succeeds even with 0 limits
    } finally { await f.close(); }
  });
});
