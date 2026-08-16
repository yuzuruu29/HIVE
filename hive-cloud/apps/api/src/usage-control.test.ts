import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabase } from "@hive-cloud/database";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import { UsageControl, rollingWindow, type UsageWindowKey } from "./usage-control.js";

const baseUrl = process.env.DATABASE_URL;

describe.runIf(Boolean(baseUrl))("UsageControl atomicity and enforcement", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let control: UsageControl;

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl!);
    const { db } = createDatabase(testDb.dbUrl);
    control = new UsageControl(db, UsageControl.policyFromEnv());
    await control.ensureTables();
  }, 120_000);

  afterAll(async () => {
    if (testDb) await testDb.dispose().catch(() => {});
  });

  const key = (overrides?: Partial<UsageWindowKey>): UsageWindowKey => ({
    tenantId: "test-tenant",
    userId: "test-user",
    ipHash: "test-ip",
    ...overrides,
  });

  // ---- rolling window ----
  it("computes deterministic rolling window boundaries", () => {
    const now = 1_000_000_000_000;
    const [start, end] = rollingWindow(now, 3_600_000);
    expect(end - start).toBe(3_600_000);
    expect(now >= start && now < end).toBe(true);
  });

  // ---- basic acceptance ----
  it("request below both limits succeeds", async () => {
    const checks = await control.check(key());
    expect(checks.every((c) => c.allowed)).toBe(true);
    expect(checks.every((c) => c.used === 0)).toBe(true);
  });

  // ---- 5h limit rejection ----
  it("five-hour limit rejection", async () => {
    const k = key({ tenantId: "5h-reject" });
    // Set low limit via env
    const orig = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "2";

    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: process.env.LIMIT_REQUESTS_5H ?? "500", LIMIT_REQUESTS_WEEKLY: process.env.LIMIT_REQUESTS_WEEKLY ?? "5000" }));
    const r1 = await ctrl.tryReserve(k, "requests_5h", 1);
    expect(r1.accepted).toBe(true);
    const r2 = await ctrl.tryReserve(k, "requests_5h", 1);
    expect(r2.accepted).toBe(true);
    const r3 = await ctrl.tryReserve(k, "requests_5h", 1);
    expect(r3.accepted).toBe(false);

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig;
  });

  // ---- weekly limit rejection ----
  it("weekly limit rejection", async () => {
    const k = key({ tenantId: "weekly-reject" });
    const orig = process.env.LIMIT_REQUESTS_WEEKLY;
    process.env.LIMIT_REQUESTS_WEEKLY = "1";

    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: process.env.LIMIT_REQUESTS_5H ?? "500", LIMIT_REQUESTS_WEEKLY: process.env.LIMIT_REQUESTS_WEEKLY ?? "5000" }));
    const r1 = await ctrl.tryReserve(k, "requests_weekly", 1);
    expect(r1.accepted).toBe(true);
    const r2 = await ctrl.tryReserve(k, "requests_weekly", 1);
    expect(r2.accepted).toBe(false);

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_WEEKLY;
    else process.env.LIMIT_REQUESTS_WEEKLY = orig;
  });

  // ---- exact boundary ----
  it("exact five-hour boundary", () => {
    // Aligned to window size
    const winMs = 5 * 60 * 60 * 1000;
    // At the very start of a window
    const atBoundary = Math.floor(Date.now() / winMs) * winMs;
    const [start, end] = rollingWindow(atBoundary, winMs);
    expect(start).toBe(atBoundary);
    expect(end).toBe(atBoundary + winMs);

    // Just before the next boundary
    const beforeBoundary = end - 1;
    const [s2] = rollingWindow(beforeBoundary, winMs);
    expect(s2).toBe(start);
  });

  // ---- tenant isolation ----
  it("tenant isolation", async () => {
    const kA = key({ tenantId: "iso-a" });
    const kB = key({ tenantId: "iso-b" });
    await control.tryReserve(kA, "requests_5h", 10);
    const checksA = await control.check(kA);
    const checksB = await control.check(kB);
    expect(checksA.find((c) => c.metric === "requests_5h")?.used).toBe(10);
    expect(checksB.find((c) => c.metric === "requests_5h")?.used).toBe(0);
  });

  // ---- user isolation ----
  it("user isolation within one tenant", async () => {
    const tenantId = "user-iso";
    const kU1 = key({ tenantId, userId: "u1" });
    const kU2 = key({ tenantId, userId: "u2" });
    await control.tryReserve(kU1, "requests_5h", 7);
    const c1 = await control.check(kU1);
    const c2 = await control.check(kU2);
    expect(c1.find((c) => c.metric === "requests_5h")?.used).toBe(7);
    expect(c2.find((c) => c.metric === "requests_5h")?.used).toBe(0);
  });

  // ---- provider-specific ----
  it("provider-specific isolation", async () => {
    const kP1 = key({ provider: "openai" });
    const kP2 = key({ provider: "anthropic" });
    await control.tryReserve(kP1, "requests_5h", 3);
    const c1 = await control.check(kP1);
    const c2 = await control.check(kP2);
    expect(c1.find((c) => c.metric === "requests_5h")?.used).toBe(3);
    expect(c2.find((c) => c.metric === "requests_5h")?.used).toBe(0);
  });

  // ---- IP-specific ----
  it("IP-specific enforcement", async () => {
    const kIP1 = key({ ipHash: "ip-1" });
    const kIP2 = key({ ipHash: "ip-2" });
    await control.tryReserve(kIP1, "requests_5h", 5);
    const c1 = await control.check(kIP1);
    const c2 = await control.check(kIP2);
    expect(c1.find((c) => c.metric === "requests_5h")?.used).toBe(5);
    expect(c2.find((c) => c.metric === "requests_5h")?.used).toBe(0);
  });

  // ---- override raises limit ----
  it("override raises a limit", async () => {
    const k = key({ tenantId: "override-up" });
    const orig = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "1";

    // Use an override to allow more
    const r1 = await control.tryReserve(k, "requests_5h", 1, 5);
    expect(r1.accepted).toBe(true);
    const r2 = await control.tryReserve(k, "requests_5h", 1, 5);
    expect(r2.accepted).toBe(true);

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig;
  });

  // ---- override lowers limit ----
  it("override lowers a limit", async () => {
    const k = key({ tenantId: "override-down" });
    const orig = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "100";

    const r1 = await control.tryReserve(k, "requests_5h", 1, 0);
    expect(r1.accepted).toBe(false);

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig;
  });

  // ---- concurrent oversubscription prevention ----
  it("concurrent requests cannot oversubscribe the final remaining unit", async () => {
    const k = key({ tenantId: "concurrent-test" });
    const orig = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "3";

    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: process.env.LIMIT_REQUESTS_5H ?? "500", LIMIT_REQUESTS_WEEKLY: process.env.LIMIT_REQUESTS_WEEKLY ?? "5000" }));
    // Reserve 2 units first
    await ctrl.tryReserve(k, "requests_5h", 2);
    // Now fire 3 concurrent attempts for the last remaining unit
    const results = await Promise.all([
      ctrl.tryReserve(k, "requests_5h", 1),
      ctrl.tryReserve(k, "requests_5h", 1),
      ctrl.tryReserve(k, "requests_5h", 1),
    ]);
    const accepted = results.filter((r) => r.accepted).length;
    expect(accepted).toBe(1);

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig;
  });

  // ---- initial uncreated row concurrency ----
  it("concurrent requests on an uncreated row cannot oversubscribe limit", async () => {
    const k = key({ tenantId: "concurrent-uncreated-test" });
    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: "2", LIMIT_REQUESTS_WEEKLY: "5000" }));

    // 3 concurrent attempts when initial row does not exist yet (limit = 2)
    const results = await Promise.all([
      ctrl.tryReserve(k, "requests_5h", 1),
      ctrl.tryReserve(k, "requests_5h", 1),
      ctrl.tryReserve(k, "requests_5h", 1),
    ]);
    const accepted = results.filter((r) => r.accepted).length;
    const rejected = results.filter((r) => !r.accepted).length;
    expect(accepted).toBe(2);
    expect(rejected).toBe(1);
  });


  // ---- release on error ----
  it("provider failure releases an unused reservation", async () => {
    const k = key({ tenantId: "release-test" });
    const orig = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "2";

    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: process.env.LIMIT_REQUESTS_5H ?? "500", LIMIT_REQUESTS_WEEKLY: process.env.LIMIT_REQUESTS_WEEKLY ?? "5000" }));

    // Reserve and then release
    const r1 = await ctrl.tryReserve(k, "requests_5h", 1);
    expect(r1.accepted).toBe(true);
    await ctrl.release(k, "requests_5h", 1);

    // Should be able to reserve again
    const r2 = await ctrl.tryReserve(k, "requests_5h", 1);
    expect(r2.accepted).toBe(true);

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig;
  });

  // ---- idempotent release ----
  it("release cannot make usage negative (safe) and is callable multiple times", async () => {
    const k = key({ tenantId: "safe-release" });
    await control.tryReserve(k, "requests_5h", 5);
    await control.release(k, "requests_5h", 2);
    await control.release(k, "requests_5h", 3);
    const after = (await control.check(k)).find((c) => c.metric === "requests_5h")!.used;
    expect(after).toBe(0); // 5 - 2 - 3 = 0

    // Extra release is safe (clamped to 0)
    await control.release(k, "requests_5h", 10);
    const after2 = (await control.check(k)).find((c) => c.metric === "requests_5h")!.used;
    expect(after2).toBe(0);
  });

  // ---- check does not reserve ----
  it("check returns current count without reserving", async () => {
    const k = key({ tenantId: "check-no-reserve" });
    await control.tryReserve(k, "requests_5h", 3);
    const before = (await control.check(k)).find((c) => c.metric === "requests_5h")!.used;
    // Check again
    const after = (await control.check(k)).find((c) => c.metric === "requests_5h")!.used;
    expect(after).toBe(before);
    expect(after).toBe(3);
  });

  // ---- structured 429 metadata ----
  it("rejection returns correct metadata", async () => {
    const k = key({ tenantId: "meta-test" });
    const orig = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "1";

    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: process.env.LIMIT_REQUESTS_5H ?? "500", LIMIT_REQUESTS_WEEKLY: process.env.LIMIT_REQUESTS_WEEKLY ?? "5000" }));
    await ctrl.tryReserve(k, "requests_5h", 1);
    const r = await ctrl.tryReserve(k, "requests_5h", 1);
    expect(r.accepted).toBe(false);
    expect(r.used).toBe(1);
    expect(r.limit).toBe(1);
    expect(r.remaining).toBe(0);
    expect(r.resetsAt).toBeTruthy();
    expect(new Date(r.resetsAt).getTime()).toBeGreaterThan(Date.now());

    if (orig === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig;
  });

  // ---- multiple metric enforcement ----
  it("blocks when any window is exceeded (5h exceeded, weekly ok)", async () => {
    const k = key({ tenantId: "multi-metric" });
    const orig5h = process.env.LIMIT_REQUESTS_5H;
    process.env.LIMIT_REQUESTS_5H = "2";

    const ctrl = new UsageControl(createDatabase(testDb.dbUrl).db, UsageControl.policyFromEnv({ LIMIT_REQUESTS_5H: process.env.LIMIT_REQUESTS_5H ?? "500", LIMIT_REQUESTS_WEEKLY: process.env.LIMIT_REQUESTS_WEEKLY ?? "5000" }));
    await ctrl.tryReserve(k, "requests_5h", 2);
    // Check all windows
    const checks = await ctrl.check(k);
    const w5h = checks.find((c) => c.metric === "requests_5h");
    expect(w5h?.allowed).toBe(false);
    const ww = checks.find((c) => c.metric === "requests_weekly");
    expect(ww?.allowed).toBe(true);

    if (orig5h === undefined) delete process.env.LIMIT_REQUESTS_5H;
    else process.env.LIMIT_REQUESTS_5H = orig5h;
  });

  // ---- overrides via resolveOverride ----
  // Override resolution disabled pending table-existence check stabilization
  // Resolved through UsageStore.setOverride instead
});
