import { sql } from "drizzle-orm";
import type { HiveDatabase } from "@hive-cloud/database";

export interface UsageLimit {
  /** Maximum units allowed in the window. */
  max: number;
  /** Rolling window duration in milliseconds. */
  windowMs: number;
}

export interface UsageWindowKey {
  tenantId: string;
  userId?: string;
  ipHash?: string;
  provider?: string;
}

export interface UsageCounter {
  used: number;
  max: number;
  resetsAt: string; // ISO date when the window resets
}

export interface UsageEnforcement {
  allowed: boolean;
  status: "ok" | "usage_exceeded" | "concurrency_exceeded";
  retryAfterMs: number;
  limit: UsageLimit;
  current: UsageCounter;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

export function rollingWindow(now: number, windowMs: number): [number, number] {
  const start = now - (now % windowMs);
  return [start, start + windowMs];
}

export function windowKey(key: UsageWindowKey): string {
  return [key.tenantId, key.userId || "*", key.ipHash || "*", key.provider || "*"].join(":");
}

export function resolveLimits(): Record<string, UsageLimit> {
  return {
    requests_5h: { max: Number(process.env.LIMIT_REQUESTS_5H || 500), windowMs: DEFAULT_WINDOW_MS },
    requests_weekly: { max: Number(process.env.LIMIT_REQUESTS_WEEKLY || 5000), windowMs: WEEKLY_MS },
    tokens_input_5h: { max: Number(process.env.LIMIT_TOKENS_INPUT_5H || 1_000_000), windowMs: DEFAULT_WINDOW_MS },
    tokens_output_5h: { max: Number(process.env.LIMIT_TOKENS_OUTPUT_5H || 500_000), windowMs: DEFAULT_WINDOW_MS },
  };
}

export class UsageStore {
  constructor(private db: HiveDatabase) {}

  async ensureTable(): Promise<void> {
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
    // Partial index for cleanup queries
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_usage_windows_cleanup
      ON usage_windows (window_end)
    `);
  }

  /**
   * Atomically increment a usage counter for a rolling window.
   * Returns the updated count and the remaining budget.
   */
  async increment(
    key: UsageWindowKey,
    metric: string,
    amount = 1,
    windowMs = DEFAULT_WINDOW_MS,
  ): Promise<{ used: number; limit: number; remaining: number; resetsAt: string }> {
    const limits = resolveLimits();
    const limitDef = limits[metric];
    const max = limitDef?.max ?? 500;
    const window = limitDef?.windowMs ?? windowMs;
    const now = Date.now();
    const [winStart, winEnd] = rollingWindow(now, window);
    const wKey = windowKey(key);

    // Upsert with atomic increment (PostgreSQL 15+)
    await this.db.execute(sql`
      INSERT INTO usage_windows (window_key, metric, window_start, window_end, count)
      VALUES (${wKey}, ${metric}, ${winStart}, ${winEnd}, ${amount})
      ON CONFLICT (window_key, metric, window_start)
      DO UPDATE SET count = usage_windows.count + ${amount}, updated_at = now()
    `);

    // Read back the current count
    const row = await this.db.execute(sql`
      SELECT count FROM usage_windows
      WHERE window_key = ${wKey} AND metric = ${metric} AND window_start = ${winStart}
    `);
    const used = Number(row.rows[0]?.count ?? 0);
    return {
      used,
      limit: max,
      remaining: Math.max(0, max - used),
      resetsAt: new Date(winEnd).toISOString(),
    };
  }

  /**
   * Check all applicable limits for a request. Does NOT increment.
   */
  async check(key: UsageWindowKey): Promise<UsageEnforcement[]> {
    const limits = resolveLimits();
    const results: UsageEnforcement[] = [];
    const now = Date.now();

    for (const [metric, limitDef] of Object.entries(limits)) {
      const [winStart] = rollingWindow(now, limitDef.windowMs);
      const wKey = windowKey(key);
      const row = await this.db.execute(sql`
        SELECT count FROM usage_windows
        WHERE window_key = ${wKey} AND metric = ${metric} AND window_start = ${winStart}
      `);
      const used = Number(row.rows[0]?.count ?? 0);
      const allowed = used < limitDef.max;
      results.push({
        allowed,
        status: allowed ? "ok" : "usage_exceeded",
        retryAfterMs: allowed ? 0 : winStart + limitDef.windowMs - now,
        limit: limitDef,
        current: { used, max: limitDef.max, resetsAt: new Date(winStart + limitDef.windowMs).toISOString() },
      });
    }
    return results;
  }

  /**
   * Clean up expired windows to prevent unbounded table growth.
   */
  async cleanup(maxAgeMs = 14 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = await this.db.execute(sql`
      DELETE FROM usage_windows WHERE window_end < ${cutoff}
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Admin: get current usage summary for a tenant or all tenants.
   */
  async adminSummary(tenantId?: string): Promise<Array<Record<string, unknown>>> {
    if (tenantId) {
      const rows = await this.db.execute(sql`
        SELECT window_key, metric, window_start, window_end, count
        FROM usage_windows
        WHERE window_key LIKE ${tenantId + ":%"}
        ORDER BY window_start DESC
        LIMIT 100
      `);
      return rows.rows;
    }
    const rows = await this.db.execute(sql`
      SELECT window_key, metric, SUM(count)::BIGINT AS total
      FROM usage_windows
      WHERE window_end > ${Date.now() - 7 * 24 * 60 * 60 * 1000}
      GROUP BY window_key, metric
      ORDER BY total DESC
      LIMIT 100
    `);
    return rows.rows;
  }

  /**
   * Admin: override a limit (by setting env or toggling bypass).
   * For now, we support setting a per-tenant override stored in a simple table.
   */
  async setOverride(tenantId: string, metric: string, maxOverride: number | null): Promise<void> {
    if (maxOverride === null) {
      await this.db.execute(sql`
        DELETE FROM usage_overrides WHERE tenant_id = ${tenantId} AND metric = ${metric}
      `);
    } else {
      await this.db.execute(sql`
        INSERT INTO usage_overrides (tenant_id, metric, max_override)
        VALUES (${tenantId}, ${metric}, ${maxOverride})
        ON CONFLICT (tenant_id, metric) DO UPDATE SET max_override = ${maxOverride}
      `);
    }
  }
}
