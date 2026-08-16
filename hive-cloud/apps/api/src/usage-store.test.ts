import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabase, withServiceRole } from "@hive-cloud/database";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import { UsageStore, rollingWindow, type UsageEnforcement } from "./usage-store.js";

const baseUrl = process.env.DATABASE_URL;

describe.runIf(Boolean(baseUrl))("UsageStore", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let store: UsageStore;

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl!);
    const { db } = createDatabase(testDb.dbUrl);
    store = new UsageStore(db);
    // Create the table in the isolated database
    await store.ensureTable();
  }, 120_000);

  afterAll(async () => {
    if (testDb) await testDb.dispose().catch(() => {});
  });

  it("computes deterministic rolling window boundaries", () => {
    const now = 1_000_000_000_000;
    const [start, end] = rollingWindow(now, 3_600_000); // 1-hour window
    expect(end - start).toBe(3_600_000);
    expect(now >= start && now < end).toBe(true);
  });

  it("increments a usage counter atomically", async () => {
    const key = { tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const r1 = await store.increment(key, "requests_5h");
    expect(r1.used).toBe(1);
    expect(r1.remaining).toBeLessThan(r1.limit);

    const r2 = await store.increment(key, "requests_5h");
    expect(r2.used).toBe(2);
  });

  it("separates counters by metric", async () => {
    const key = { tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const r1 = await store.increment(key, "requests_5h");
    const r2 = await store.increment(key, "tokens_input_5h", 150);
    expect(r1.used).toBe(1);
    expect(r2.used).toBe(150);
  });

  it("separates counters by tenant", async () => {
    const rA = await store.increment({ tenantId: "t-a" }, "requests_5h", 10);
    const rB = await store.increment({ tenantId: "t-b" }, "requests_5h", 20);
    expect(rA.used).toBe(10);
    expect(rB.used).toBe(20);
  });

  it("separates counters by user within the same tenant", async () => {
    const tenantId = "t-user-test";
    const r1 = await store.increment({ tenantId, userId: "u1" }, "requests_5h", 5);
    const r2 = await store.increment({ tenantId, userId: "u2" }, "requests_5h", 7);
    expect(r1.used).toBe(5);
    expect(r2.used).toBe(7);
  });

  it("check returns the current count without incrementing", async () => {
    const key = { tenantId: "check-test" };
    await store.increment(key, "requests_5h", 3);
    const checks = await store.check(key);
    const reqCheck = checks.find((c: UsageEnforcement) => c.limit.max > 0);
    expect(reqCheck?.current.used).toBe(3);
    // Check did not increment
    const r = await store.increment(key, "requests_5h");
    expect(r.used).toBe(4);
  });

  it("honours the configured limit", async () => {
    // Temporarily override the limit via env
    const original = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "3";

    const key = { tenantId: "limit-test" };
    // Reload the UsageStore with new env
    const { db } = createDatabase(testDb.dbUrl);
    const localStore = new UsageStore(db);

    const r1 = await localStore.increment(key, "requests_5h");
    expect(r1.remaining).toBe(2);
    await localStore.increment(key, "requests_5h");
    await localStore.increment(key, "requests_5h");
    const r4 = await localStore.increment(key, "requests_5h");
    expect(r4.remaining).toBe(0);

    if (original === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = original;
  });

  it("returns accurate resetsAt timestamp", async () => {
    const key = { tenantId: "reset-test" };
    const r = await store.increment(key, "requests_5h");
    expect(r.resetsAt).toBeTruthy();
    const resetTime = new Date(r.resetsAt).getTime();
    expect(resetTime).toBeGreaterThan(Date.now());
    expect(resetTime - Date.now()).toBeLessThan(5 * 60 * 60 * 1000);
  });

  it("cleanup removes expired windows", async () => {
    // Manually insert an expired window
    const veryOld = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await store["db"].execute(sql`
      INSERT INTO usage_windows (window_key, metric, window_start, window_end, count)
      VALUES ('cleanup-test', 'requests_5h', ${veryOld}, ${veryOld + 3600000}, 1)
    `);
    const deleted = await store.cleanup(14 * 24 * 60 * 60 * 1000);
    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it("adminSummary returns recent usage", async () => {
    const key = { tenantId: "admin-vis-test" };
    await store.increment(key, "requests_5h", 5);
    const summary = await store.adminSummary("admin-vis-test");
    expect(summary.length).toBeGreaterThanOrEqual(1);
    expect(summary[0]).toHaveProperty("window_key");
    expect(summary[0]).toHaveProperty("metric");
    expect(summary[0]).toHaveProperty("count");
  });
});
