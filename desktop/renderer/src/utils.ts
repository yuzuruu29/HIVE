import type { DesktopChangesDiff, DesktopProviderConfigurationInput, DesktopProviderMetadata } from "../../../src/desktop/types";

let sequence = 0;
export function identifier(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function phaseTone(status?: string): "neutral" | "success" | "warning" | "error" {
  if (!status) return "neutral";
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "paused") return "warning";
  return "neutral";
}

export function commitBlockedCopy(reason: DesktopChangesDiff["commitEligibility"]): string {
  switch (reason) {
    case "no-recorded-files": return "No reviewed session files are available to commit.";
    case "session-not-completed": return "The session must complete before commit.";
    case "validation-required": return "Session validation must pass before commit.";
    case "review-required": return "Session review must pass before commit.";
    case "eligible": return "";
  }
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function providerConfiguration(provider: DesktopProviderMetadata): DesktopProviderConfigurationInput {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    authType: provider.authType,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    approved: true,
  };
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
