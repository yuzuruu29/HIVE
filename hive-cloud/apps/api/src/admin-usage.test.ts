import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { createInternalAuthHeaders } from "@hive-cloud/security";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import { HiveRouter } from "@hive-cloud/router";
import { createApp } from "./app.js";
import { CloudStore } from "./store.js";
import type { ApiEnv } from "./env.js";

const baseUrl = process.env.DATABASE_URL;
const secret = "test-internal-service-secret-value";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "00000000-0000-4000-8000-00000000000a";

function adminHeaders(tenantId: string, method: string, path: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = createInternalAuthHeaders(
    { userId: USER_ID, tenantId, role: "owner", email: "admin@test.local" },
    secret,
    method,
    path,
  );
  return { ...base, ...extra };
}

interface AdminFixture {
  app: Awaited<ReturnType<typeof createApp>>;
  apiKeyHeaders: Record<string, string>;
  close: () => Promise<void>;
}

async function makeAdminFixture(opts: {
  dbUrl: string;
  fiveHourLimit?: number;
  weeklyLimit?: number;
  tenantId?: string;
}): Promise<AdminFixture> {
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
    TRUSTED_PROXY_CIDRS: "127.0.0.1,::1",
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
  const tenantId = opts.tenantId ?? TENANT_A;
  const subject = { userId: USER_ID, tenantId, role: "owner" as const, email: "test@local" };

  const { Pool: SeedPool } = await import("pg");
  const seedP = new SeedPool({ connectionString: opts.dbUrl });
  try {
    await seedP.query(
      "INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [tenantId, `T-${tenantId.slice(0, 8)}`, `admin-${tenantId.slice(0, 8)}`],
    );
    await seedP.query("INSERT INTO users (id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
      USER_ID,
      "u@t",
    ]);
  } finally {
    await seedP.end();
  }

  // Create an API key for the non-admin auth tests (using the SAME store as the app)
  const key = await store.createApiKey(
    subject,
    "Admin test key",
    ["chat:write", "models:read"],
    env.HIVE_API_KEY_PEPPER,
  );
  const apiKeyHeaders: Record<string, string> = {
    authorization: `Bearer ${key.raw}`,
    "content-type": "application/json",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = new HiveRouter({ fetch: (async () => Response.json({})) as any, requestId: () => crypto.randomUUID() });
  const app = await createApp({ env, store, router });

  return { app, apiKeyHeaders, close: async () => { await app.close(); } };
}

describe.runIf(Boolean(baseUrl))("Admin usage routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let fixture: AdminFixture;

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl!, "adm");
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: testDb.dbUrl });
    try {
      await p.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'AT','admin-tt') ON CONFLICT DO NOTHING", [TENANT_A]);
      await p.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'BT','admin-tb') ON CONFLICT DO NOTHING", [TENANT_B]);
      await p.query("INSERT INTO users (id,email) VALUES ($1,'u@t') ON CONFLICT DO NOTHING", [USER_ID]);
    } finally {
      await p.end();
    }
    fixture = await makeAdminFixture({ dbUrl: testDb.dbUrl });
  }, 120_000);

  afterAll(async () => {
    if (fixture) await fixture.close().catch(() => {});
    if (testDb) await testDb.dispose().catch(() => {});
  });

  beforeEach(async () => {
    const { Pool: PG } = await import("pg");
    const p = new PG({ connectionString: testDb.dbUrl });
    try {
      await p.query("DELETE FROM usage_overrides");
    } finally {
      await p.end();
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await fixture.app.inject({ method: "GET", url: "/api/admin/usage" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when authenticated but not admin", async () => {
    const res = await fixture.app.inject({
      method: "GET",
      url: "/api/admin/usage",
      headers: fixture.apiKeyHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin can get usage summary", async () => {
    const h = adminHeaders(TENANT_A, "GET", "/api/admin/usage");
    const res = await fixture.app.inject({
      method: "GET",
      url: "/api/admin/usage",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.tenantId).toBe(TENANT_A);
    expect(body.data.windows).toHaveLength(2);
    expect(body.data.windows[0].metric).toBe("requests_5h");
    expect(body.data.windows[1].metric).toBe("requests_weekly");
  });

  it("admin can create an override", async () => {
    const h = adminHeaders(TENANT_A, "PUT", "/api/admin/usage/overrides", { "content-type": "application/json" });
    const res = await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: h,
      payload: { metric: "requests_5h", max_override: 1000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      tenantId: TENANT_A,
      metric: "requests_5h",
      maxOverride: 1000,
    });
  });

  it("admin can list overrides", async () => {
    const putHeaders = adminHeaders(TENANT_A, "PUT", "/api/admin/usage/overrides", { "content-type": "application/json" });

    const p1 = await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: putHeaders,
      payload: { metric: "requests_5h", max_override: 500 },
    });
    expect(p1.statusCode).toBe(200);

    const p2 = await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: putHeaders,
      payload: { metric: "requests_weekly", max_override: 1000 },
    });
    expect(p2.statusCode).toBe(200);

    const h = adminHeaders(TENANT_A, "GET", "/api/admin/usage/overrides");
    const res = await fixture.app.inject({
      method: "GET",
      url: "/api/admin/usage/overrides",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].metric).toBe("requests_5h");
    expect(body.data[1].metric).toBe("requests_weekly");
  });

  it("admin can update an existing override via PUT", async () => {
    const putHeaders = adminHeaders(TENANT_A, "PUT", "/api/admin/usage/overrides", { "content-type": "application/json" });

    await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: putHeaders,
      payload: { metric: "requests_5h", max_override: 100 },
    });
    const res = await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: putHeaders,
      payload: { metric: "requests_5h", max_override: 300 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.maxOverride).toBe(300);
  });

  it("admin can delete an override", async () => {
    const putHeaders = adminHeaders(TENANT_A, "PUT", "/api/admin/usage/overrides", { "content-type": "application/json" });

    await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: putHeaders,
      payload: { metric: "requests_5h", max_override: 200 },
    });

    const h = adminHeaders(TENANT_A, "DELETE", "/api/admin/usage/overrides/requests_5h");
    const res = await fixture.app.inject({
      method: "DELETE",
      url: "/api/admin/usage/overrides/requests_5h",
      headers: h,
    });
    expect(res.statusCode).toBe(204);
  });

  it("deleting a non-existent override returns 404", async () => {
    const h = adminHeaders(TENANT_A, "DELETE", "/api/admin/usage/overrides/nonexistent");
    const res = await fixture.app.inject({
      method: "DELETE",
      url: "/api/admin/usage/overrides/nonexistent",
      headers: h,
    });
    expect(res.statusCode).toBe(404);
  });

  it("cross-tenant access is denied for overrides", async () => {
    const aPutHeaders = adminHeaders(TENANT_A, "PUT", "/api/admin/usage/overrides", { "content-type": "application/json" });
    await fixture.app.inject({
      method: "PUT",
      url: "/api/admin/usage/overrides",
      headers: aPutHeaders,
      payload: { metric: "requests_5h", max_override: 500 },
    });

    const bGetHeaders = adminHeaders(TENANT_B, "GET", "/api/admin/usage/overrides");
    const res = await fixture.app.inject({
      method: "GET",
      url: "/api/admin/usage/overrides",
      headers: bGetHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });
});
