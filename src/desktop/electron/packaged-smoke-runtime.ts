import os from "node:os";
import path from "node:path";
import { CodingSessionStore } from "../../coding/session-store.js";
import { CODING_SESSION_SCHEMA_VERSION, type CodingFinalReport, type CodingSessionRecord } from "../../coding/types.js";
import type { DesktopRuntimeLaunchInput, DesktopRuntimeLauncher } from "../run-manager.js";

export const PACKAGED_SMOKE_PROVIDER_ID = "hive-packaged-smoke";
export const PACKAGED_SMOKE_MESSAGE = "Complete the internal packaged smoke diagnostic.";
export const PACKAGED_SMOKE_OBJECTIVE = `[user]\n${PACKAGED_SMOKE_MESSAGE}`;
export const PACKAGED_SMOKE_REPORT_RESULT = "Packaged utility process diagnostic completed without network access.";

export function isPackagedSmokeMode(environment: NodeJS.ProcessEnv = globalThis.process.env): boolean {
  if (environment.HIVE_DESKTOP_PACKAGED_SMOKE !== "1") return false;
  const userData = environment.HIVE_DESKTOP_SMOKE_USER_DATA;
  if (!userData || !path.isAbsolute(userData) || userData.includes("\0")) return false;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(userData));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function packagedSmokeLauncher(environment: NodeJS.ProcessEnv = globalThis.process.env): DesktopRuntimeLauncher | null {
  if (environment.HIVE_DESKTOP_PACKAGED_SMOKE !== "1") return null;
  if (!isPackagedSmokeMode(environment)) throw new Error("Packaged smoke utility mode requires temporary smoke user data.");
  return async (input: DesktopRuntimeLaunchInput): Promise<CodingSessionRecord> => {
    if (input.options.providerId !== PACKAGED_SMOKE_PROVIDER_ID || input.objective !== PACKAGED_SMOKE_OBJECTIVE) {
      throw new Error("Packaged smoke utility mode rejected a non-diagnostic run.");
    }
    const now = new Date().toISOString();
    const report: CodingFinalReport = {
      result: PACKAGED_SMOKE_REPORT_RESULT,
      subagents: { total: 0, active: 0, working: 0, waiting: 0, blocked: 0, done: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
      filesChanged: [],
      validation: [{ label: "Production utility process", status: "passed" }, { label: "Network adapter bypass", status: "passed" }],
      review: ["Diagnostic objective and provider matched exactly."],
      outstanding: [],
      completedAt: now,
    };
    const record: CodingSessionRecord = {
      schemaVersion: CODING_SESSION_SCHEMA_VERSION,
      id: input.sessionId,
      objective: input.objective,
      mode: input.options.mode,
      approvalPolicy: input.options.approvalPolicy,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      repository: { root: input.repositoryRoot, capturedAt: now, dirty: false, changedFiles: [] },
      tasks: [], events: [], providerBindings: [], validationResults: [], reviewResults: [], files: [], finalReport: report,
    };
    return new CodingSessionStore(input.repositoryRoot).save(record);
  };
}
