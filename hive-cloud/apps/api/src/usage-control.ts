import { sql } from "drizzle-orm";
import type { HiveDatabase } from "@hive-cloud/database";

export interface UsageWindowKey {
  tenantId: string;
  userId?: string;
  ipHash?: string;
  provider?: string;
}

export interface UsageLimit {
  max: number;
  windowMs: number;
}

export interface ReservationResult {
  accepted: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
  windowStart: number;
  windowEnd: number;
}

export interface WindowCheck {
  metric: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  allowed: boolean;
  resetsAt: string;
  retryAfterSeconds: number;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

export function rollingWindow(now: number, windowMs: number): [number, number] {
  const start = now - (now % windowMs);
  return [start, start + windowMs];
}

export function windowKey(key: UsageWindowKey): string {
  return [key.tenantId, key.userId || "*", key.ipHash || "*", key.provider || "*"].join(":");
}

export interface UsagePolicy {
  requestLimit5h: number;
  requestLimitWeekly: number;
  tokenInputLimit5h: number;
  tokenOutputLimit5h: number;
}

export function resolvePolicy(): UsagePolicy {
  return {
    requestLimit5h: Number(process.env.LIMIT_REQUESTS_5H || 500),
    requestLimitWeekly: Number(process.env.LIMIT_REQUESTS_WEEKLY || 5000),
    tokenInputLimit5h: Number(process.env.LIMIT_TOKENS_INPUT_5H || 1_000_000),
    tokenOutputLimit5h: Number(process.env.LIMIT_TOKENS_OUTPUT_5H || 500_000),
  };
}

const WINDOW_DEFS: Array<{ metric: string; label: string; windowMs: number }> = [
  { metric: "requests_5h", label: "five_hour", windowMs: FIVE_HOURS_MS },
  { metric: "requests_weekly", label: "weekly", windowMs: WEEKLY_MS },
];

/**
 * Usage control engine backed by PostgreSQL.
 *
 * Uses pg_advisory_xact_lock to serialize concurrent operations on the same
 * window key, ensuring atomic reservation under concurrency.
 */
export class UsageControl {
  constructor(private db: HiveDatabase, public readonly policy: UsagePolicy) {}

  /** Create a UsagePolicy from environment variables. */
  static policyFromEnv(src: Record<string, string | undefined> = process.env): UsagePolicy {
    return {
      requestLimit5h: Number(src.LIMIT_REQUESTS_5H ?? 500),
      requestLimitWeekly: Number(src.LIMIT_REQUESTS_WEEKLY ?? 5000),
      tokenInputLimit5h: Number(src.LIMIT_TOKENS_INPUT_5H ?? 1_000_000),
      tokenOutputLimit5h: Number(src.LIMIT_TOKENS_OUTPUT_5H ?? 500_000),
    };
  }

  /** Ensure the underlying tables exist (idempotent). */
  async ensureTables(): Promise<void> {
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS usage_windows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        window_key TEXT NOT NULL,
        metric TEXT NOT NULL,
        window_start BIGINT NOT NULL,
        window_end BIGINT NOT NULL,
        count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_windows_lookup
      ON usage_windows (window_key, metric, window_start)
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS usage_overrides (
        tenant_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        max_override INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_overrides_lookup
      ON usage_overrides (tenant_id, metric)
    `);
  }

  /**
   * Check all applicable windows for a key. Does not reserve.
   * Used for pre-flight checks (non-critical path).
   */
  async check(key: UsageWindowKey): Promise<WindowCheck[]> {
    const results: WindowCheck[] = [];
    const now = Date.now();
    const wKey = windowKey(key);

    for (const wd of WINDOW_DEFS) {
      const [winStart] = rollingWindow(now, wd.windowMs);
      const limit = wd.metric === "requests_5h" ? this.policy.requestLimit5h : this.policy.requestLimitWeekly;
      const row = await this.db.execute(sql`
        SELECT count FROM usage_windows
        WHERE window_key = ${wKey} AND metric = ${wd.metric} AND window_start = ${winStart}
      `);
      const used = Number(row.rows[0]?.count ?? 0);
      const allowed = used < limit;
      results.push({
        metric: wd.metric,
        label: wd.label,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        allowed,
        resetsAt: new Date(winStart + wd.windowMs).toISOString(),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((winStart + wd.windowMs - now) / 1000)),
      });
    }
    return results;
  }

  /**
   * Atomically reserve a number of units from a rolling window.
   *
   * Uses pg_advisory_xact_lock on a hash of the window key to serialize
   * concurrent operations. Returns accepted=true only if the limit is not
   * exceeded after this reservation. This guarantees that the last available
  /**
   * Atomically reserve a number of units from a rolling window.
   *
   * Uses an atomic PostgreSQL UPDATE with a WHERE clause condition to guarantee
   * that concurrent requests cannot exceed effectiveMax. If the condition is met,
   * count is incremented atomically; otherwise 0 rows are updated and the reservation
   * is rejected.
   */
  async tryReserve(
    key: UsageWindowKey,
    metric: string,
    amount: number,
    maxOverride?: number | null,
  ): Promise<ReservationResult> {
    const wd = WINDOW_DEFS.find((d) => d.metric === metric);
    if (!wd) throw new Error(`Unknown usage metric: ${metric}`);
    const wKey = windowKey(key);
    const now = Date.now();
    const [winStart, winEnd] = rollingWindow(now, wd.windowMs);

    const effectiveMax = maxOverride ?? (metric === "requests_5h" ? this.policy.requestLimit5h : this.policy.requestLimitWeekly);

    // 1. Ensure a row exists atomically for this window key, metric, and start time
    await this.db.execute(sql`
      INSERT INTO usage_windows (window_key, metric, window_start, window_end, count)
      VALUES (${wKey}, ${metric}, ${winStart}, ${winEnd}, 0)
      ON CONFLICT (window_key, metric, window_start) DO NOTHING
    `);

    // 2. Atomically increment count ONLY IF count + amount <= effectiveMax
    const updateResult = await this.db.execute(sql`
      UPDATE usage_windows
      SET count = count + ${amount}, updated_at = now()
      WHERE window_key = ${wKey} AND metric = ${metric} AND window_start = ${winStart}
        AND count + ${amount} <= ${effectiveMax}
      RETURNING count
    `);

    if (updateResult.rows.length > 0) {
      const newCount = Number(updateResult.rows[0]?.count ?? 0);
      return {
        accepted: true,
        used: newCount,
        limit: effectiveMax,
        remaining: Math.max(0, effectiveMax - newCount),
        resetsAt: new Date(winEnd).toISOString(),
        windowStart: winStart,
        windowEnd: winEnd,
      };
    }

    // 3. If update failed (count + amount > effectiveMax), read current count for metadata
    const currentResult = await this.db.execute(sql`
      SELECT count FROM usage_windows
      WHERE window_key = ${wKey} AND metric = ${metric} AND window_start = ${winStart}
    `);
    const used = Number(currentResult.rows[0]?.count ?? 0);

    return {
      accepted: false,
      used,
      limit: effectiveMax,
      remaining: Math.max(0, effectiveMax - used),
      resetsAt: new Date(winEnd).toISOString(),
      windowStart: winStart,
      windowEnd: winEnd,
    };
  }


  /**
   * Release a previously reserved count. Called on errors or cancellation.
   * Uses an atomic UPDATE — PostgreSQL handles row-level locking internally,
   * so no explicit advisory lock or transaction is needed.
   */
  async release(key: UsageWindowKey, metric: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const wd = WINDOW_DEFS.find((d) => d.metric === metric);
    if (!wd) return;
    const wKey = windowKey(key);
    const now = Date.now();
    const [winStart] = rollingWindow(now, wd.windowMs);

    await this.db.execute(sql`
      UPDATE usage_windows SET count = GREATEST(0, count - ${amount}), updated_at = now()
      WHERE window_key = ${wKey} AND metric = ${metric} AND window_start = ${winStart}
    `);
  }

  /**
   * Override resolution: fetch the override for a tenant and metric, if any.
   * Returns null if no override exists.
   */
  async resolveOverride(tenantId: string, metric: string): Promise<number | null> {
    try {
      const row = await this.db.execute(sql`
        SELECT max_override FROM usage_overrides
        WHERE tenant_id = ${tenantId} AND metric = ${metric}
      `);
      const val = row.rows[0]?.max_override;
      return val != null ? Number(val) : null;
    } catch (e: unknown) {
      // If the table doesn't exist, treat as no override
      const msg = String((e as Error).message);
      if (msg.includes("does not exist") || msg.includes("usage_overrides")) return null;
      throw e;
    }
  }
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
