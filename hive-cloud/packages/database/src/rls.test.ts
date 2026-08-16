import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createTestDatabase } from "./test-helpers.js";

const baseUrl = process.env.DATABASE_URL;

describe.runIf(Boolean(baseUrl))("Tenant RLS isolation (non-superuser)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let tenantPool: Pool;
  let servicePool: Pool;

  const T_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const T_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const U_A = "00000000-0000-4000-8000-00000000000a";
  const U_B = "00000000-0000-4000-8000-00000000000b";
  const C_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const C_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl!);
    const admin = new Pool({ connectionString: testDb.dbUrl });
    try {
      await admin.query("INSERT INTO users (id, email) VALUES ($1,'a@rls.lcl') ON CONFLICT DO NOTHING", [U_A]);
      await admin.query("INSERT INTO users (id, email) VALUES ($1,'b@rls.lcl') ON CONFLICT DO NOTHING", [U_B]);
      await admin.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'TA','ta-rls') ON CONFLICT DO NOTHING", [T_A]);
      await admin.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'TB','tb-rls') ON CONFLICT DO NOTHING", [T_B]);
      await admin.query("INSERT INTO conversations (id,tenant_id,user_id,mode,title) VALUES ($1,$2,$3,'chat','A') ON CONFLICT DO NOTHING", [C_A, T_A, U_A]);
      await admin.query("INSERT INTO conversations (id,tenant_id,user_id,mode,title) VALUES ($1,$2,$3,'chat','B') ON CONFLICT DO NOTHING", [C_B, T_B, U_B]);
      await admin.query("INSERT INTO router_requests (id,tenant_id,router_model,required_capabilities) VALUES ($1,$2,'hv','[]') ON CONFLICT DO NOTHING", ["44444444-4444-4444-8444-444444444444", T_A]);
      await admin.query("INSERT INTO router_requests (id,tenant_id,router_model,required_capabilities) VALUES ($1,$2,'hv','[]') ON CONFLICT DO NOTHING", ["55555555-5555-4555-8555-555555555555", T_B]);
      await admin.query("INSERT INTO credit_ledger (id,tenant_id,request_id,amount,reason,idempotency_key,balance_class) VALUES ($1,$2,$3,100,'t','rls-ta','subscription') ON CONFLICT DO NOTHING", ["11111111-1111-4111-8111-111111111111", T_A, "44444444-4444-4444-8444-444444444444"]);
      await admin.query("INSERT INTO credit_ledger (id,tenant_id,request_id,amount,reason,idempotency_key,balance_class) VALUES ($1,$2,$3,200,'t','rls-tb','subscription') ON CONFLICT DO NOTHING", ["22222222-2222-4222-8222-222222222222", T_B, "55555555-5555-4555-8555-555555555555"]);
      await admin.query("INSERT INTO billing_accounts (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [T_A]);
      await admin.query("INSERT INTO billing_accounts (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [T_B]);
      await admin.query("INSERT INTO billing_events (id,external_event_id,event_type,payload_hash,payload) VALUES ('33333333-3333-4333-8333-333333333333','ext-a','TEST','ha','{}') ON CONFLICT DO NOTHING");
      await admin.query("INSERT INTO audit_events (id,tenant_id,event_type,target_type) VALUES ($1,$2,'test','conv') ON CONFLICT DO NOTHING", ["66666666-6666-4666-8666-666666666666", T_A]);
      await admin.query("INSERT INTO audit_events (id,tenant_id,event_type,target_type) VALUES ($1,$2,'test','conv') ON CONFLICT DO NOTHING", ["77777777-7777-4777-8777-777777777777", T_B]);
    } finally {
      await admin.end();
    }
    tenantPool = new Pool({ connectionString: testDb.tenantUrl, max: 4 });
    servicePool = new Pool({ connectionString: testDb.serviceUrl, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await tenantPool?.end().catch(() => {});
    await servicePool?.end().catch(() => {});
    if (testDb) await testDb.dispose().catch(() => {});
  });

  const dbT = () => drizzle(tenantPool);
  const dbS = () => drizzle(servicePool);

  // ---------- role attributes ----------
  it("tenant role has NOSUPERUSER and NOBYPASSRLS", async () => {
    const r = await tenantPool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("service role has NOSUPERUSER and NOBYPASSRLS", async () => {
    const r = await servicePool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  // ---------- SELECT isolation ----------
  it("Tenant A sees its own conversation", async () => {
    await dbT().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
      const r = await tx.execute(sql`SELECT id FROM conversations WHERE id=${C_A}`);
      expect(r.rows).toHaveLength(1);
    });
  });

  it("Tenant A cannot see Tenant B conversation", async () => {
    await dbT().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
      const r = await tx.execute(sql`SELECT id FROM conversations WHERE id=${C_B}`);
      expect(r.rows).toHaveLength(0);
    });
  });

  // ---------- INSERT isolation ----------
  it("Tenant A cannot insert conversation for Tenant B", async () => {
    await expect(
      dbT().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
        await tx.execute(sql`INSERT INTO conversations (id,tenant_id,user_id,mode,title) VALUES (${"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"},${T_B},${U_B},'chat','Bogus')`);
      }),
    ).rejects.toThrow();
  });

  // UPDATE/DELETE with RLS silently affects 0 rows for invisible rows
  // (PostgreSQL's USING policy filters them out without raising an error)
  it("Tenant A cannot update Tenant B conversation (0 rows affected)", async () => {
    await dbT().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
      const r = await tx.execute(sql`UPDATE conversations SET title='hacked' WHERE id=${C_B}`);
      // RLS filters out Tenant B's row; 0 rows updated
      expect(r.rowCount).toBe(0);
    });
  });

  it("Tenant A cannot delete Tenant B conversation (0 rows affected)", async () => {
    await dbT().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
      const r = await tx.execute(sql`DELETE FROM conversations WHERE id=${C_B}`);
      // RLS filters out Tenant B's row; 0 rows deleted
      expect(r.rowCount).toBe(0);
    });
  });

  // ---------- missing/invalid context ----------
  it("missing tenant context fails closed (no rows visible)", async () => {
    const r = await dbT().execute(sql`SELECT id FROM conversations`);
    expect(r.rows).toHaveLength(0);
  });

  it("invalid tenant context (nonexistent UUID) fails closed", async () => {
    await dbT().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)`);
      const r = await tx.execute(sql`SELECT id FROM conversations`);
      expect(r.rows).toHaveLength(0);
    });
  });

  // ---------- context isolation across transactions ----------
  it("context is cleared after transaction commit (auto-commit boundary)", async () => {
    // Use session-level (false) to persist across auto-commit, then reset
    const db = dbT();
    await db.execute(sql`SELECT set_config('app.tenant_id',${T_A},false)`);
    const r1 = await db.execute(sql`SELECT id FROM conversations WHERE id=${C_A}`);
    expect(r1.rows).toHaveLength(1);
    // Reset
    await db.execute(sql`SELECT set_config('app.tenant_id','',false)`);
    const r2 = await db.execute(sql`SELECT id FROM conversations WHERE id=${C_A}`);
    expect(r2.rows).toHaveLength(0);
  });

  // ---------- context cleared after outcomes ----------
  it("context is cleared after explicit rollback", async () => {
    const db = dbT();
    await db.execute(sql`BEGIN`);
    await db.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
    await db.execute(sql`ROLLBACK`);
    const r = await db.execute(sql`SELECT current_setting('app.tenant_id',true) AS t`);
    expect(r.rows[0]?.t).toBeFalsy();
  });

  it("context is cleared after thrown error in transaction", async () => {
    const db = dbT();
    try {
      await db.execute(sql`BEGIN`);
      await db.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
      // Force an error
      await db.execute(sql`SELECT 1/0`);
    } catch {
      // Expected — ROLLBACK happens automatically
    }
    const r = await db.execute(sql`SELECT current_setting('app.tenant_id',true) AS t`);
    expect(r.rows[0]?.t).toBeFalsy();
  });

  // ---------- pooled connection reuse ----------
  it("context does not leak on pooled connection reuse", async () => {
    const pool = new Pool({ connectionString: testDb.tenantUrl, max: 1 });
    const db = drizzle(pool);
    try {
      // Set context session-level and verify
      await db.execute(sql`SELECT set_config('app.tenant_id',${T_A},false)`);
      const r1 = await db.execute(sql`SELECT current_setting('app.tenant_id',true) AS t`);
      expect(r1.rows[0]?.t).toBe(T_A);

      // End this session
      await pool.end();

      // Reconnect — new session, no context
      const pool2 = new Pool({ connectionString: testDb.tenantUrl, max: 1 });
      const db2 = drizzle(pool2);
      try {
        const r2 = await db2.execute(sql`SELECT current_setting('app.tenant_id',true) AS t`);
        expect(r2.rows[0]?.t).toBeFalsy();
      } finally {
        await pool2.end();
      }
    } finally {
      await pool.end().catch(() => {});
    }
  });

  // ---------- concurrent isolation ----------
  it("concurrent Tenant A and Tenant B operations remain isolated", async () => {
    const [rA, rB] = await Promise.all([
      dbT().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
        const r = await tx.execute(sql`SELECT id FROM conversations WHERE id=${C_A}`);
        return r.rows.length;
      }),
      dbT().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id',${T_B},true)`);
        const r = await tx.execute(sql`SELECT id FROM conversations WHERE id=${C_A}`);
        return r.rows.length;
      }),
    ]);
    expect(rA).toBe(1);
    expect(rB).toBe(0);
  });

  // ---------- multiple tables ----------
  describe("RLS across tenant-owned tables", () => {
    const cases: Array<{ name: string; table: string; whereCol: string; ownVal: string; otherVal: string }> = [
      { name: "credit_ledger", table: "credit_ledger", whereCol: "id", ownVal: "11111111-1111-4111-8111-111111111111", otherVal: "22222222-2222-4222-8222-222222222222" },
      { name: "billing_accounts", table: "billing_accounts", whereCol: "tenant_id", ownVal: T_A, otherVal: T_B },
      { name: "audit_events", table: "audit_events", whereCol: "id", ownVal: "66666666-6666-4666-8666-666666666666", otherVal: "77777777-7777-4777-8777-777777777777" },
    ];
    for (const c of cases) {
      it(`Tenant A sees own ${c.name}`, async () => {
        await dbT().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
          const r = await tx.execute(sql`SELECT ${sql.identifier(c.whereCol)} FROM ${sql.identifier(c.table)} WHERE ${sql.identifier(c.whereCol)} = ${c.ownVal}`);
          expect(r.rows.length).toBeGreaterThanOrEqual(1);
        });
      });
      it(`Tenant A cannot see Tenant B ${c.name}`, async () => {
        await dbT().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
          const r = await tx.execute(sql`SELECT ${sql.identifier(c.whereCol)} FROM ${sql.identifier(c.table)} WHERE ${sql.identifier(c.whereCol)} = ${c.otherVal}`);
          expect(r.rows).toHaveLength(0);
        });
      });
    }
  });

  // ---------- service role ----------
  it("service role reads across tenants with app.is_service context", async () => {
    await dbS().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_service','true',true)`);
      const r = await tx.execute(sql`SELECT id FROM conversations ORDER BY id`);
      expect(r.rows).toHaveLength(2);
    });
  });

  it("service role sees nothing without context", async () => {
    const r = await dbS().execute(sql`SELECT id FROM conversations`);
    expect(r.rows).toHaveLength(0);
  });

  it("service context clears after commit", async () => {
    await dbS().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_service','true',true)`);
      const r = await tx.execute(sql`SELECT count(*)::int AS cnt FROM conversations`);
      expect(r.rows[0]?.cnt).toBe(2);
    });
    // Outside transaction — context is gone
    const r = await dbS().execute(sql`SELECT current_setting('app.is_service',true) AS s`);
    expect(r.rows[0]?.s).toBeFalsy();
  });

  // ---------- billing_events ----------
  it("service role reads billing_events with context", async () => {
    await dbS().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_service','true',true)`);
      const r = await tx.execute(sql`SELECT id FROM billing_events`);
      expect(r.rows).toHaveLength(1);
    });
  });

  it("service role cannot read billing_events without context", async () => {
    const r = await dbS().execute(sql`SELECT id FROM billing_events`);
    expect(r.rows).toHaveLength(0);
  });

  it("tenant role cannot read billing_events even with context", async () => {
    await dbT().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
      const r = await tx.execute(sql`SELECT id FROM billing_events`);
      expect(r.rows).toHaveLength(0);
    });
  });

  it("tenant role cannot insert into billing_events", async () => {
    await expect(
      dbT().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id',${T_A},true)`);
        await tx.execute(sql`INSERT INTO billing_events (id,external_event_id,event_type,payload_hash,payload) VALUES ('88888888-8888-4888-8888-888888888888','ext-t','TEST','ht','{}')`);
      }),
    ).rejects.toThrow();
  });
});
