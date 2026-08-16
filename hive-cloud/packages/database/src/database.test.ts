import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDatabase,
  diagnoseDatabase,
  validateProductionDatabaseConfig,
  auditDatabasePermissions,
  withTenant,
  withServiceRole,
} from "./index.js";
import { createTestDatabase } from "./test-helpers.js";

describe("validateProductionDatabaseConfig", () => {
  it("allows local databases when not in production/staging", () => {
    expect(() => validateProductionDatabaseConfig("postgres://hive:hive@localhost:5432/hive_cloud")).not.toThrow();
  });

  it("throws error for localhost in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => validateProductionDatabaseConfig("postgres://hive:hive@localhost:5432/hive_cloud")).toThrow(/cannot point to local host/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("throws error for missing migration URL during migration in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalMigrationUrl = process.env.DATABASE_MIGRATION_URL;
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_MIGRATION_URL;
    try {
      expect(() => validateProductionDatabaseConfig("postgres://hive:secure-pass@remote-host:5432/hive_cloud", true)).toThrow(/DATABASE_MIGRATION_URL is required/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalMigrationUrl === undefined) {
        delete process.env.DATABASE_MIGRATION_URL;
      } else {
        process.env.DATABASE_MIGRATION_URL = originalMigrationUrl;
      }
    }
  });

  it("throws error for placeholder passwords in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => validateProductionDatabaseConfig("postgres://hive:hive@remote-host:5432/hive_cloud")).toThrow(/placeholder password detected/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("throws error for sslmode=disable in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => validateProductionDatabaseConfig("postgres://hive:secure-pass@remote-host:5432/hive_cloud?sslmode=disable")).toThrow(/sslmode=disable is forbidden/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("throws error for invalid pool size in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalPoolSize = process.env.DATABASE_POOL_SIZE;
    process.env.NODE_ENV = "production";
    process.env.DATABASE_POOL_SIZE = "invalid";
    try {
      expect(() => validateProductionDatabaseConfig("postgres://hive:secure-pass@remote-host:5432/hive_cloud")).toThrow(/Invalid pool size/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalPoolSize === undefined) {
        delete process.env.DATABASE_POOL_SIZE;
      } else {
        process.env.DATABASE_POOL_SIZE = originalPoolSize;
      }
    }
  });

  it("throws error if service role is exposed in NEXT_PUBLIC_ env in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY = "service_role_secret";
    try {
      expect(() => validateProductionDatabaseConfig("postgres://hive:secure-pass@remote-host:5432/hive_cloud")).toThrow(/Security violation: service-role keys exposed/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      delete process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY;
    }
  });
});

describe("diagnoseDatabase", () => {
  it("detects local direct connection", () => {
    const diag = diagnoseDatabase("postgres://hive:hive@localhost:5432/hive_cloud");
    expect(diag).toEqual({
      provider: "local",
      connectionMode: "direct",
      tls: "disabled",
      poolSize: 10,
    });
  });

  it("detects supabase direct connection", () => {
    const diag = diagnoseDatabase("postgres://postgres:pass@db.abc.supabase.co:5432/postgres");
    expect(diag).toEqual({
      provider: "supabase",
      connectionMode: "direct",
      tls: "enabled",
      poolSize: 10,
    });
  });

  it("detects supabase session pooler", () => {
    const diag = diagnoseDatabase("postgres://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
    expect(diag).toEqual({
      provider: "supabase",
      connectionMode: "session-pooler",
      tls: "enabled",
      poolSize: 10,
    });
  });

  it("detects supabase transaction pooler", () => {
    const diag = diagnoseDatabase("postgres://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    expect(diag).toEqual({
      provider: "supabase",
      connectionMode: "transaction-pooler",
      tls: "enabled",
      poolSize: 10,
    });
  });
});

const baseUrl = process.env.DATABASE_URL;

describe.runIf(Boolean(baseUrl))("PostgreSQL Integration", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl!);
  }, 120_000);

  afterAll(async () => {
    if (testDb) await testDb.dispose().catch(() => {});
  });

  const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const USER_A = "00000000-0000-4000-8000-00000000000a";
  const USER_B = "00000000-0000-4000-8000-00000000000b";

  async function seedBaseData(db: ReturnType<typeof createDatabase>["db"]) {
    await withServiceRole(db, async (tx) => {
      await tx.execute(sql`insert into users (id, email) values (${USER_A}, 'user-a@test.local') on conflict (id) do nothing`);
      await tx.execute(sql`insert into users (id, email) values (${USER_B}, 'user-b@test.local') on conflict (id) do nothing`);
      await tx.execute(sql`insert into tenants (id, name, slug) values (${TENANT_A}, 'Tenant A', 'tenant-a') on conflict (id) do nothing`);
      await tx.execute(sql`insert into tenants (id, name, slug) values (${TENANT_B}, 'Tenant B', 'tenant-b') on conflict (id) do nothing`);
    });
  }

  it("isolates tenant context inside withTenant transaction", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      const tenantId = "11111111-1111-4111-8111-111111111111";
      await withTenant(db, tenantId, async (tx) => {
        const result = await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
        expect(result.rows[0]?.tenant).toBe(tenantId);
      });
    } finally {
      await pool.end();
    }
  });

  it("isolates service role context inside withServiceRole transaction", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await withServiceRole(db, async (tx) => {
        const result = await tx.execute(sql`select current_setting('app.is_service', true) as is_service`);
        expect(result.rows[0]?.is_service).toBe("true");
      });
    } finally {
      await pool.end();
    }
  });

  it("ensures connection parameters like statement timeout can be configured", async () => {
    const originalStatementTimeout = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "1000";
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      const result = await db.execute(sql`show statement_timeout`);
      expect(result.rows[0]?.statement_timeout).toBe("1s");
    } finally {
      await pool.end();
      if (originalStatementTimeout === undefined) {
        delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
      } else {
        process.env.DATABASE_STATEMENT_TIMEOUT_MS = originalStatementTimeout;
      }
    }
  });

  it("runs permission audit successfully", async () => {
    await expect(auditDatabasePermissions(testDb.dbUrl)).resolves.not.toThrow();
  });

  it("clears tenant and service context when a pooled connection is reused", async () => {
    const originalPoolSize = process.env.DATABASE_POOL_SIZE;
    process.env.DATABASE_POOL_SIZE = "1";
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await seedBaseData(db);

      // 1. Set Tenant A context & confirm the setting is active inside the transaction
      await withTenant(db, TENANT_A, async (tx) => {
        const ctx = await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
        expect(ctx.rows[0]?.tenant).toBe(TENANT_A);
      });

      // 2. After the transaction commits, app.tenant_id is cleared on the pooled connection
      const reuse1 = await db.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
      expect(reuse1.rows[0]?.tenant).toBeFalsy();

      // 3. Set Service role context & confirm
      await withServiceRole(db, async (tx) => {
        const sr = await tx.execute(sql`select current_setting('app.is_service', true) as is_service`);
        expect(sr.rows[0]?.is_service).toBe("true");
      });

      // 4. After service transaction commits, app.is_service is cleared
      const reuse2 = await db.execute(sql`select current_setting('app.is_service', true) as is_service`);
      expect(reuse2.rows[0]?.is_service).toBeFalsy();
    } finally {
      await pool.end();
      if (originalPoolSize === undefined) {
        delete process.env.DATABASE_POOL_SIZE;
      } else {
        process.env.DATABASE_POOL_SIZE = originalPoolSize;
      }
    }
  });

  it("verifies tenant_isolation RLS policy exists on conversations", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      const result = await db.execute(sql`
        select count(*)::int as cnt from pg_policies
        where tablename = 'conversations' and policyname = 'tenant_isolation'
      `);
      expect(result.rows[0]?.cnt).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("documents that the tenants table is globally readable (no tenant isolation)", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await seedBaseData(db);

      // Even inside a tenant context, tenants table is globally accessible
      await withTenant(db, TENANT_A, async (tx) => {
        const result = await tx.execute(sql`select id, slug from tenants order by slug`);
        expect(result.rows).toHaveLength(2);
        expect(result.rows.map((r: Record<string, unknown>) => r.slug as string).sort()).toEqual(["tenant-a", "tenant-b"]);
      });
    } finally {
      await pool.end();
    }
  });

  it("does not leak tenant context on successful transaction completion", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await withTenant(db, TENANT_A, async () => { /* no-op */ });
      const after = await db.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
      expect(after.rows[0]?.tenant).toBeFalsy();
    } finally {
      await pool.end();
    }
  });

  it("does not leak tenant context after a thrown error", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await expect(
        withTenant(db, TENANT_A, async () => { throw new Error("simulated failure"); }),
      ).rejects.toThrow("simulated failure");
      const after = await db.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
      expect(after.rows[0]?.tenant).toBeFalsy();
    } finally {
      await pool.end();
    }
  });

  it("does not leak tenant context after transaction rollback", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await expect(
        withTenant(db, TENANT_A, async (tx) => {
          await tx.execute(sql`select 1/0`); // division by zero causes rollback
        }),
      ).rejects.toThrow();
      const after = await db.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
      expect(after.rows[0]?.tenant).toBeFalsy();
    } finally {
      await pool.end();
    }
  });

  it("does not leak service context after a thrown error", async () => {
    const { db, pool } = createDatabase(testDb.dbUrl);
    try {
      await expect(
        withServiceRole(db, async () => { throw new Error("simulated service failure"); }),
      ).rejects.toThrow("simulated service failure");
      const after = await db.execute(sql`select current_setting('app.is_service', true) as is_service`);
      expect(after.rows[0]?.is_service).toBeFalsy();
    } finally {
      await pool.end();
    }
  });

  it("keeps concurrent tenant operations isolated from each other", async () => {
    const { db: db1, pool: pool1 } = createDatabase(testDb.dbUrl);
    const { db: db2, pool: pool2 } = createDatabase(testDb.dbUrl);
    try {
      await seedBaseData(db1);

      // Two separate connections, each setting a different tenant context
      const [r1, r2] = await Promise.all([
        withTenant(db1, TENANT_A, async (tx) => {
          const r = await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
          return r.rows[0]?.tenant;
        }),
        withTenant(db2, TENANT_B, async (tx) => {
          // Simulate a small delay to ensure concurrent execution
          await tx.execute(sql`select pg_sleep(0.05)`);
          const r = await tx.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
          return r.rows[0]?.tenant;
        }),
      ]);

      expect(r1).toBe(TENANT_A);
      expect(r2).toBe(TENANT_B);
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});
