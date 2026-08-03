export const PLAN_IDS = [
  "community",
  "pro",
  "power",
  "team",
  "enterprise",
] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const COMMERCIAL_ENTITLEMENTS = [
  "cloud_sessions",
  "remote_runs",
  "github_automation",
  "scheduled_runs",
  "private_presets",
  "api_access",
  "webhooks",
  "team_workspaces",
  "shared_provider_registry",
  "approval_policies",
  "audit_logs",
  "managed_models",
  "self_hosted_control_plane",
] as const;

export type CommercialEntitlement = (typeof COMMERCIAL_ENTITLEMENTS)[number];

const planIds = new Set<string>(PLAN_IDS);
const commercialEntitlements = new Set<string>(COMMERCIAL_ENTITLEMENTS);

export function isPlanId(value: string): value is PlanId {
  return planIds.has(value);
}

export function isCommercialEntitlement(value: string): value is CommercialEntitlement {
  return commercialEntitlements.has(value);
}
