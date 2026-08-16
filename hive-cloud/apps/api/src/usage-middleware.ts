import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import type { HiveDatabase } from "@hive-cloud/database";
import { UsageControl } from "./usage-control.js";
import type { UsageWindowKey, WindowCheck, UsagePolicy } from "./usage-control.js";

export type { UsageWindowKey, WindowCheck };
import { UsageError, serializeUsageError, USAGE_HEADERS } from "./usage-errors.js";

const EXEMPT_PREFIXES = ["/health", "/ready", "/api/billing/webhook", "/api/admin", "/api/internal"];

function isExempt(url: string): boolean {
  return EXEMPT_PREFIXES.some((p) => url.startsWith(p));
}

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.ip;
}

/** Normalize an IP address for consistent hashing. */
export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.substring(7);
  if (ip === "::1") return "127.0.0.1";
  return ip;
}

function ipHash(ip: string): string {
  return createHash("sha256").update(normalizeIp(ip)).digest("hex").substring(0, 16);
}

/** Build usage dimensions from trusted server-side context. */
export function buildUsageDimensions(
  auth: { tenantId: string; userId?: string; internal?: boolean } | undefined,
  requestIp: string,
  provider?: string,
): UsageWindowKey {
  return {
    tenantId: auth?.tenantId ?? "anonymous",
    ...(auth?.userId ? { userId: auth.userId } : {}),
    ipHash: ipHash(normalizeIp(requestIp)),
    ...(provider ? { provider } : {}),
  };
}

export class UsageMiddleware {
  public readonly control: UsageControl;

  constructor(db: HiveDatabase, policy?: UsagePolicy) {
    this.control = new UsageControl(db, policy ?? UsageControl.policyFromEnv());
  }

  /** Check if a route path should bypass usage enforcement. */
  static isExempt(url: string): boolean {
    return isExempt(url);
  }

  /**
   * Extract the normalized client IP from a request.
   * Uses the framework's trusted-proxy configuration.
   */
  static clientIp(request: FastifyRequest): string {
    return normalizeIp(clientIp(request));
  }

  /**
   * Build usage dimensions from an authenticated request.
   * Returns null for internal/system requests.
   */
  dimensions(request: FastifyRequest, auth?: { tenantId: string; userId?: string; internal?: boolean }, provider?: string): UsageWindowKey | null {
    if (auth?.internal) return null;
    return {
      tenantId: auth?.tenantId ?? "anonymous",
      ...(auth?.userId ? { userId: auth.userId } : {}),
      ipHash: ipHash(clientIp(request)),
      ...(provider ? { provider } : {}),
    };
  }

  /**
   * Pre-execution: check limits and atomically reserve capacity.
   * Sends 429 and returns false if any limit would be exceeded.
   */
  async checkAndReserve(
    request: FastifyRequest,
    reply: FastifyReply,
    dims: UsageWindowKey,
    overrides?: Record<string, number | null>,
  ): Promise<boolean> {
    if (isExempt(request.url)) return true;

    // Check all windows (requests)
    const checks = await this.control.check(dims);
    const binding = checks.find((c) => !c.allowed);
    if (binding) {
      await this.sendUsageExceeded(reply, request.id, binding);
      return false;
    }

    // Atomic reservation for both windows
    for (const metric of ["requests_5h", "requests_weekly"]) {
      const override = overrides?.[metric] ?? null;
      const result = await this.control.tryReserve(dims, metric, 1, override);
      if (!result.accepted) {
        // Release any already-reserved windows (rollback)
        for (const prev of ["requests_5h", "requests_weekly"]) {
          if (prev === metric) break;
          await this.control.release(dims, prev, 1);
        }
        const check: WindowCheck = {
          metric,
          label: metric === "requests_5h" ? "five_hour" : "weekly",
          used: result.used,
          limit: result.limit,
          remaining: result.remaining,
          allowed: false,
          resetsAt: result.resetsAt,
          retryAfterSeconds: Math.max(1, Math.ceil((result.windowEnd - Date.now()) / 1000)),
        };
        await this.sendUsageExceeded(reply, request.id, check);
        return false;
      }
    }

    return true;
  }

  /**
   * Post-execution: settle actual usage or release reservations.
   * Must be called in a `finally` block after provider execution.
   */
  async settle(request: FastifyRequest, dims: UsageWindowKey, actual: { inputTokens?: number; outputTokens?: number }): Promise<void> {
    if (isExempt(request.url)) return;
    // Requests are already counted by reservation; no additional increment needed.
    // Token settlement is a future enhancement.
  }

  /**
   * Release reservations on error or cancellation. Best-effort — errors
   * are silently caught since the pool may be shut down during cleanup.
   */
  async releaseOnError(request: FastifyRequest, dims: UsageWindowKey): Promise<void> {
    if (isExempt(request.url)) return;
    for (const metric of ["requests_5h", "requests_weekly"]) {
      try { await this.control.release(dims, metric, 1); } catch { /* best-effort */ }
    }
  }

  /**
   * Write usage-limit metadata headers for successful responses.
   */
  static writeHeaders(reply: FastifyReply, checks: WindowCheck[]): void {
    if (checks.length === 0) return;
    const c = checks[0]!;
    reply.header("X-Usage-Window", c.label);
    reply.header("X-Usage-Limit", String(c.limit));
    reply.header("X-Usage-Used", String(c.used));
    reply.header("X-Usage-Remaining", String(c.remaining));
    reply.header("X-Usage-Reset", c.resetsAt);
  }

  private async sendUsageExceeded(reply: FastifyReply, requestId: string, check: WindowCheck): Promise<void> {
    const err = new UsageError(
      "usage_window_exceeded",
      `The ${check.label} usage limit has been reached.`,
      requestId,
      check.label,
      "user",
      check.limit,
      check.used,
      check.remaining,
      check.resetsAt,
      check.retryAfterSeconds,
    );
    const body = serializeUsageError(err);
    reply.header("Retry-After", String(check.retryAfterSeconds));
    reply.header("X-Usage-Window", check.label);
    reply.header("X-Usage-Limit", String(check.limit));
    reply.header("X-Usage-Used", String(check.used));
    reply.header("X-Usage-Remaining", "0");
    reply.header("X-Usage-Reset", check.resetsAt);
    await reply.code(429).send(body);
  }
}
