export type ProcessingAnimation = "shimmer" | "dots" | "line" | "ring";
export type HiveProcessingStatus = "queued" | "routing" | "searching" | "reading-files" | "reasoning" | "waiting-first-token" | "streaming" | "retrying" | "completed" | "cancelled" | "failed";
export type HiveProcessingStepStatus = "pending" | "active" | "completed" | "warning" | "failed" | "cancelled";

export interface HiveProcessingStep { id: string; label: string; status: HiveProcessingStepStatus; durationMs?: number; detail?: string; provider?: string; model?: string }
export interface HiveExecutionSummary { status: "completed" | "cancelled" | "failed"; startedAt?: string; completedAt?: string; durationMs?: number; searchActive?: boolean; citationCount?: number; preparedFileCount?: number; errorCode?: string }

const ACTIVE_STATUSES = new Set<HiveProcessingStatus>(["queued", "routing", "searching", "reading-files", "reasoning", "waiting-first-token", "streaming", "retrying"]);
export const SAFE_PROCESSING_ERROR_LABELS: Record<string, string> = {
  managed_credits_exhausted: "Managed credits exhausted", unsupported_capability: "Selected route does not support this request",
  rate_limited: "Provider rate limit reached", upstream_error: "Provider request failed", upstream_stream_error: "Stream interrupted",
  no_route: "No eligible route is available", offline: "HIVE is offline", internal_error: "HIVE could not complete the request",
};
export const ATTEMPT_REASON_LABELS: Record<string, string> = {
  provider_rate_limited: "Provider rate limit reached", provider_auth_failed: "Provider authentication failed", provider_timeout: "Provider timed out",
  provider_daily_quota_exhausted: "Provider daily quota exhausted", provider_quota_exhausted: "Provider quota exhausted", provider_cooldown: "Provider is cooling down",
  provider_unavailable: "Provider is unavailable", provider_temporarily_unavailable: "Provider is temporarily unavailable", provider_rejected_request: "Provider rejected the request",
  provider_network_error: "Provider connection failed", request_cancelled: "Request cancelled", context_window_exceeded: "Missing or invalid context window",
  unhealthy_status: "Unhealthy status", disabled_provider: "Disabled provider", unsupported_vision: "Unsupported vision", unsupported_tools: "Unsupported tools",
  provider_model_mismatch: "Strict provider/model mismatch", zero_managed_credits: "Zero managed credits", malformed_legacy_metadata: "Malformed legacy capability metadata",
};

export function isActiveProcessingStatus(status: HiveProcessingStatus) { return ACTIVE_STATUSES.has(status); }
export function safeProcessingErrorLabel(code?: string) { return code ? SAFE_PROCESSING_ERROR_LABELS[code] || "HIVE could not complete the request" : "HIVE could not complete the request"; }
export function formatProcessingDuration(durationMs: number) { const safe = Math.max(0, durationMs); if (safe < 60_000) return `${(safe / 1_000).toFixed(1)}s`; return `${Math.floor(safe / 60_000)}m ${Math.floor((safe % 60_000) / 1_000)}s`; }

export function processingFallbackPresentation(stage: HiveProcessingStatus, filesCount = 0, model?: string): { label: string; animations: ProcessingAnimation[] } {
  const presentations: Record<HiveProcessingStatus, { label: string; animations: ProcessingAnimation[] }> = {
    queued: { label: "Request queued…", animations: ["dots"] }, routing: { label: "HIVE is selecting a route…", animations: ["shimmer", "ring"] },
    "reading-files": { label: `Scout is analyzing ${filesCount} file${filesCount === 1 ? "" : "s"}…`, animations: ["shimmer", "line"] },
    searching: { label: "Searching cited sources…", animations: ["shimmer", "line"] }, reasoning: { label: "Reviewer is checking the response…", animations: ["shimmer", "ring"] },
    "waiting-first-token": { label: model ? `Waiting for ${model}…` : "Waiting for response…", animations: ["dots", "ring"] },
    retrying: { label: "Retrying route…", animations: ["line"] }, streaming: { label: "HIVE is responding…", animations: ["shimmer"] },
    completed: { label: "Response complete", animations: [] }, cancelled: { label: "Request cancelled", animations: [] }, failed: { label: "HIVE could not complete the request", animations: [] },
  };
  return presentations[stage];
}
