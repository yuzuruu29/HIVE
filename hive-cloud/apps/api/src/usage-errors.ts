/** Stable error codes and response serialization for usage-control rejections. */

export type UsageErrorCode =
  | "usage_window_exceeded"
  | "usage_reservation_conflict"
  | "usage_policy_unavailable";

export class UsageError extends Error {
  constructor(
    public readonly code: UsageErrorCode,
    message: string,
    public readonly requestId: string,
    public readonly window?: string,
    public readonly scope?: string,
    public readonly limit?: number,
    public readonly used?: number,
    public readonly remaining?: number,
    public readonly resetAt?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

export interface UsageErrorResponse {
  error: {
    code: UsageErrorCode;
    message: string;
    requestId: string;
    window?: string;
    scope?: string;
    limit?: number;
    used?: number;
    remaining?: number;
    resetAt?: string;
    retryAfterSeconds?: number;
  };
}

export function serializeUsageError(err: UsageError): UsageErrorResponse {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId: err.requestId,
      ...(err.window !== undefined ? { window: err.window } : {}),
      ...(err.scope !== undefined ? { scope: err.scope } : {}),
      ...(err.limit !== undefined ? { limit: err.limit } : {}),
      ...(err.used !== undefined ? { used: err.used } : {}),
      ...(err.remaining !== undefined ? { remaining: err.remaining } : {}),
      ...(err.resetAt !== undefined ? { resetAt: err.resetAt } : {}),
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    },
  };
}

export const USAGE_HEADERS = [
  "Retry-After",
  "X-Usage-Window",
  "X-Usage-Limit",
  "X-Usage-Used",
  "X-Usage-Remaining",
  "X-Usage-Reset",
] as const;
