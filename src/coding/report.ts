import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../runner.js";
import type {
  CodingSessionRecord,
  FileChangeRecord,
  ReviewFinding,
  RuntimeEvent,
  SubagentStatus,
  ValidationStatus,
} from "./types.js";

export const HIVE_RUN_REPORT_SCHEMA_VERSION = "1.0" as const;

export type UsageProvenance = "measured" | "provider_reported" | "estimated" | "unavailable";

export interface UsageValue {
  value?: number;
  unit: string;
  provenance: UsageProvenance;
  source?: string;
}

export type MonetaryUsageValue =
  | {
      unit: "currency";
      provenance: "unavailable";
      billingGrade: false;
    }
  | {
      decimalValue: string;
      currency: string;
      unit: "currency";
      provenance: "measured" | "provider_reported";
      source: string;
      billingGrade: false;
    }
  | {
      decimalValue: string;
      currency: string;
      unit: "currency";
      provenance: "estimated";
      source: string;
      pricingVersion?: string;
      pricingTimestamp: string;
      confidence: "low" | "medium" | "high";
      billingGrade: false;
    };

export interface HiveAgentRunSummary {
  id: string;
  role: string;
  provider: string;
  model?: string;
  status: SubagentStatus;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  usage: {
    inputTokens: UsageValue;
    outputTokens: UsageValue;
    totalTokens: UsageValue;
    estimatedCost: MonetaryUsageValue;
  };
  fileScope: string[];
  validationStatus?: ValidationStatus;
  errorCategory?: string;
  emptyOutput?: boolean;
  structurallyInvalidOutput?: boolean;
}

export interface CommandSummary {
  id: string;
  taskId?: string;
  command: string;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number | null;
  signal?: string;
  durationMs?: number;
}

export interface HiveRunReport {
  schemaVersion: typeof HIVE_RUN_REPORT_SCHEMA_VERSION;
  reportId: string;
  sessionId: string;
  repository: {
    identifier?: string;
    rootHash?: string;
    branchBefore?: string;
    commitBefore?: string;
    dirtyBefore?: boolean;
    /** Final integrated repository SHA. */
    commitAfter?: string;
  };
  task: { title?: string; objective?: string; mode?: string };
  timing: { startedAt: string; completedAt?: string; durationMs?: number };
  outcome: {
    status: "pending" | "running" | "completed" | "failed" | "cancelled" | "partial";
    /** Final deterministic verdict. */
    verdict?: string;
    /** Reasons supporting the verdict. */
    verdictReasons?: string[];
    summary?: string;
    failureCategory?: string;
  };
  agents: HiveAgentRunSummary[];
  usage: {
    inputTokens: UsageValue;
    outputTokens: UsageValue;
    totalTokens: UsageValue;
    providerCost: MonetaryUsageValue;
    infrastructureCost: MonetaryUsageValue;
    totalEstimatedCost: MonetaryUsageValue;
  };
  engineering: {
    changedFiles: FileChangeRecord[];
    commands: CommandSummary[];
    validation: CodingSessionRecord["validationResults"];
    tests: CodingSessionRecord["validationResults"];
    reviewFindings: ReviewFinding[];
    fixerAttempts: Array<{ agentId: string; attempt: number; status: SubagentStatus; summary?: string }>;
  };
  /** Acceptance gate matrix. */
  acceptanceGates: Array<{
    id: string;
    description: string;
    required: boolean;
    state: string;
    evidenceIds: string[];
    failureReason?: string;
  }>;
  /** Evidence ledger summary. */
  evidence: Array<{
    id: string;
    category: string;
    status: string;
    summary: string;
    valid: boolean;
    invalidationReason?: string;
  }>;
  /** Failure history. */
  failures: Array<{
    failureClass: string;
    affectedNodeId?: string;
    attemptNumber: number;
    actionTaken: string;
    repairSucceeded?: boolean;
    description: string;
  }>;
  /** Integration history. */
  integrations: Array<{
    integratedSha: string;
    integratedFiles: string[];
    hadConflicts: boolean;
    timestamp: string;
  }>;
  safety: {
    approvalsRequested?: number;
    approvalsDenied?: number;
    redactionsApplied?: number;
    destructiveOperationsRejected?: number;
    scopeViolationsRejected?: number;
  };
  limitations: string[];
}

const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/gu;

export function sanitizeReportText(value: string): string {
  return redactSecrets(value).replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTERS, "");
}

function sanitizeReportValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeReportText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeReportValue(entry)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeReportValue(entry)]),
    ) as T;
  }
  return value;
}

function clean(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeReportText(value);
}

function tokenValue(value: number | undefined): UsageValue {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? { value, unit: "tokens", provenance: "provider_reported", source: "persisted provider response usage" }
    : { unit: "tokens", provenance: "unavailable" };
}

function unavailableCost(): MonetaryUsageValue {
  return { unit: "currency", provenance: "unavailable", billingGrade: false };
}

function sumToken(records: CodingSessionRecord["tasks"], key: "input" | "output" | "total"): number | undefined {
  const values = records.map((task) => task.tokenUsage?.[key]).filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

function reportStatus(status: CodingSessionRecord["status"]): HiveRunReport["outcome"]["status"] {
  if (status === "created" || status === "planning") return "pending";
  if (status === "running") return "running";
  if (status === "paused") return "partial";
  return status;
}

function errorCategory(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("empty")) return "empty_output";
  if (normalized.includes("json") || normalized.includes("structure")) return "invalid_structure";
  return "execution_error";
}

function commandSummaries(events: readonly RuntimeEvent[]): CommandSummary[] {
  const commands = new Map<string, CommandSummary>();
  for (const event of events) {
    if (event.type === "command.started") {
      commands.set(event.payload.commandId, {
        id: event.payload.commandId,
        taskId: event.payload.taskId,
        command: sanitizeReportText(event.payload.command),
        status: "running",
      });
    } else if (event.type === "command.completed") {
      const existing = commands.get(event.payload.commandId);
      if (!existing) continue;
      existing.exitCode = event.payload.exitCode;
      existing.signal = clean(event.payload.signal);
      existing.durationMs = event.payload.durationMs;
      existing.status = event.payload.signal
        ? "cancelled"
        : event.payload.exitCode === 0
          ? "completed"
          : "failed";
    }
  }
  return [...commands.values()];
}

function durationMs(startedAt: string, completedAt: string | undefined): number | undefined {
  if (!completedAt) return undefined;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function createHiveRunReport(session: CodingSessionRecord): HiveRunReport {
  const completedAt = session.finalReport?.completedAt ?? session.cancelledAt;
  const commands = commandSummaries(session.events ?? []);
  const validation = (session.validationResults ?? []).map((result) => ({
    ...result,
    command: sanitizeReportText(result.command),
    output: result.output === undefined ? undefined : "[OMITTED FROM REPORT]",
  }));
  const reviewFindings = (session.reviewResults ?? []).flatMap((review) => review.findings).map((finding) => ({
    ...finding,
    summary: sanitizeReportText(finding.summary),
    file: clean(finding.file),
  }));
  const agents = (session.tasks ?? []).map((task): HiveAgentRunSummary => {
    const category = errorCategory(task.error);
    const agentValidation = validation.filter((result) => result.taskId === task.id).at(-1)?.status;
    return {
      id: sanitizeReportText(task.id),
      role: task.role,
      provider: sanitizeReportText(task.providerId),
      model: clean(task.model),
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      retryCount: Math.max(0, task.attempt - 1),
      usage: {
        inputTokens: tokenValue(task.tokenUsage?.input),
        outputTokens: tokenValue(task.tokenUsage?.output),
        totalTokens: tokenValue(task.tokenUsage?.total),
        estimatedCost: unavailableCost(),
      },
      fileScope: task.fileScope.map(sanitizeReportText),
      validationStatus: agentValidation,
      errorCategory: category,
      emptyOutput: category === "empty_output" ? true : undefined,
      structurallyInvalidOutput: category === "invalid_structure" ? true : undefined,
    };
  });
  const limitations = [
    "Provider and infrastructure cost are unavailable because no configured pricing source is persisted.",
    "Safety counters are omitted when the session event schema does not record them.",
    "Raw command output and absolute repository paths are intentionally excluded.",
  ];
  if (agents.some((agent) => agent.usage.totalTokens.provenance === "unavailable")) {
    limitations.push("One or more providers did not report token usage.");
  }
  const root = session.repository.root;
  const report: HiveRunReport = {
    schemaVersion: HIVE_RUN_REPORT_SCHEMA_VERSION,
    reportId: `report-${createHash("sha256").update(session.id).digest("hex").slice(0, 20)}`,
    sessionId: sanitizeReportText(session.id),
    repository: {
      identifier: sanitizeReportText(path.basename(root)),
      rootHash: createHash("sha256").update(path.resolve(root)).digest("hex"),
      branchBefore: clean(session.repository.branch),
      commitBefore: clean(session.repository.baseCommit),
      dirtyBefore: session.repository.dirty,
      commitAfter: clean(session.finalReport?.finalSha),
    },
    task: { objective: clean(session.objective), mode: session.mode },
    timing: { startedAt: session.createdAt, completedAt, durationMs: durationMs(session.createdAt, completedAt) },
    outcome: {
      status: reportStatus(session.status),
      verdict: session.verdict ?? session.finalReport?.verdict,
      verdictReasons: session.finalReport?.verdictReasons,
      summary: clean(session.finalReport?.result),
      failureCategory: session.status === "failed" ? "runtime_failure" : undefined,
    },
    agents,
    usage: {
      inputTokens: tokenValue(sumToken(session.tasks ?? [], "input")),
      outputTokens: tokenValue(sumToken(session.tasks ?? [], "output")),
      totalTokens: tokenValue(sumToken(session.tasks ?? [], "total")),
      providerCost: unavailableCost(),
      infrastructureCost: unavailableCost(),
      totalEstimatedCost: unavailableCost(),
    },
    engineering: {
      changedFiles: (session.files ?? []).map((file) => ({ ...file, path: sanitizeReportText(file.path), previousPath: clean(file.previousPath) })),
      commands,
      validation,
      tests: validation.filter((result) => /(?:^|\s)(?:npm|pnpm|yarn|node|npx|bun|pytest|cargo|go|dotnet).*test|\btest\b/iu.test(result.command)),
      reviewFindings,
      fixerAttempts: (session.tasks ?? []).filter((task) => task.role === "fixer").map((task) => ({
        agentId: task.id,
        attempt: task.attempt,
        status: task.status,
        summary: clean(task.summary),
      })),
    },
    acceptanceGates: (session.finalReport?.evidenceSummary ?? []).filter((e) => e.gateId).map((e) => ({
      id: e.gateId!,
      description: e.summary,
      required: true,
      state: e.valid ? e.status : "invalidated",
      evidenceIds: [e.id],
      failureReason: e.invalidationReason,
    })),
    evidence: (session.finalReport?.evidenceSummary ?? []).map((e) => ({
      id: sanitizeReportText(e.id),
      category: e.category,
      status: e.status,
      summary: sanitizeReportText(e.summary),
      valid: e.valid,
      invalidationReason: clean(e.invalidationReason),
    })),
    failures: (session.failures ?? session.finalReport?.failures ?? []).map((f) => ({
      failureClass: f.failureClass,
      affectedNodeId: f.affectedNodeId,
      attemptNumber: f.attemptNumber,
      actionTaken: f.actionTaken,
      repairSucceeded: f.repairSucceeded,
      description: sanitizeReportText(f.description),
    })),
    integrations: (session.integrations ?? session.finalReport?.integrations ?? []).map((i) => ({
      integratedSha: i.integratedSha,
      integratedFiles: i.integratedFiles.map(sanitizeReportText),
      hadConflicts: i.hadConflicts,
      timestamp: i.timestamp,
    })),
    safety: {},
    limitations,
  };
  return sanitizeReportValue(report);
}

function markdownText(value: string): string {
  return sanitizeReportText(value)
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .replace(/([\\`*_{}\[\]()<>#+.!|-])/gu, "\\$1");
}

function usageText(value: UsageValue): string {
  return value.value === undefined ? "Unavailable" : `${value.value} ${value.unit} (${value.provenance})`;
}

function monetaryText(value: MonetaryUsageValue): string {
  if (value.provenance === "unavailable") return "Unavailable";
  const estimate = value.provenance === "estimated"
    ? `; pricing ${value.pricingVersion ?? value.pricingTimestamp}; confidence ${value.confidence}`
    : "";
  return `${value.currency} ${value.decimalValue} (${value.provenance}; source ${markdownText(value.source)}${estimate})`;
}

export function formatHiveRunReportMarkdown(report: HiveRunReport): string {
  const lines = [
    `# HIVE run report: ${markdownText(report.sessionId)}`,
    "",
    `- Status: ${report.outcome.status}`,
    `- Verdict: ${report.outcome.verdict ?? "Not computed"}`,
    `- Objective: ${markdownText(report.task.objective ?? "Unavailable")}`,
    `- Started: ${report.timing.startedAt}`,
    `- Completed: ${report.timing.completedAt ?? "Unavailable"}`,
    "",
  ];

  // Verdict reasons
  if (report.outcome.verdictReasons && report.outcome.verdictReasons.length > 0) {
    lines.push("## Verdict reasons", "");
    for (const reason of report.outcome.verdictReasons) {
      lines.push(`- ${markdownText(reason)}`);
    }
    lines.push("");
  }

  // Repository state
  lines.push(
    "## Repository state",
    "",
    `- Base commit: ${markdownText(report.repository.commitBefore ?? "Unavailable")}`,
    `- Final commit: ${markdownText(report.repository.commitAfter ?? "Unavailable")}`,
    `- Branch: ${markdownText(report.repository.branchBefore ?? "Unavailable")}`,
    "",
  );

  // Usage
  lines.push(
    "## Usage",
    "",
    `- Input: ${usageText(report.usage.inputTokens)}`,
    `- Output: ${usageText(report.usage.outputTokens)}`,
    `- Total: ${usageText(report.usage.totalTokens)}`,
    `- Provider cost: ${monetaryText(report.usage.providerCost)}`,
    `- Infrastructure cost: ${monetaryText(report.usage.infrastructureCost)}`,
    "",
  );

  // Acceptance gates
  if (report.acceptanceGates.length > 0) {
    lines.push("## Acceptance gates", "");
    for (const gate of report.acceptanceGates) {
      const icon = gate.state === "satisfied" ? "PASS" : gate.state === "failed" ? "FAIL" : "PEND";
      lines.push(`- [${icon}] ${gate.id}: ${markdownText(gate.description)}${gate.failureReason ? ` — ${markdownText(gate.failureReason)}` : ""}`);
    }
    lines.push("");
  }

  // Evidence ledger
  if (report.evidence.length > 0) {
    lines.push("## Evidence ledger", "");
    const valid = report.evidence.filter((e) => e.valid);
    const invalid = report.evidence.filter((e) => !e.valid);
    lines.push(`- Valid evidence: ${valid.length}`);
    lines.push(`- Invalidated evidence: ${invalid.length}`);
    lines.push("");
    for (const ev of report.evidence) {
      const status = ev.valid ? ev.status : `INVALIDATED (${ev.invalidationReason ?? "stale"})`;
      lines.push(`- [${status}] ${ev.category}: ${markdownText(ev.summary)}`);
    }
    lines.push("");
  }

  // Failure history
  if (report.failures.length > 0) {
    lines.push("## Failure history", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure.failureClass} (attempt ${failure.attemptNumber}): ${markdownText(failure.description)} → ${failure.actionTaken}`);
    }
    lines.push("");
  }

  // Integration history
  if (report.integrations.length > 0) {
    lines.push("## Integration history", "");
    for (const integration of report.integrations) {
      lines.push(`- SHA ${markdownText(integration.integratedSha)}: ${integration.integratedFiles.length} file(s), conflicts: ${integration.hadConflicts ? "yes" : "no"}`);
    }
    lines.push("");
  }

  // Engineering evidence
  lines.push(
    "## Engineering evidence",
    "",
    `- Agents: ${report.agents.length}`,
    `- Files changed: ${report.engineering.changedFiles.length}`,
    `- Commands recorded: ${report.engineering.commands.length}`,
    `- Validations recorded: ${report.engineering.validation.length}`,
    `- Review findings: ${report.engineering.reviewFindings.length}`,
    "",
    "### Changed files",
    "",
    ...(report.engineering.changedFiles.length > 0
      ? report.engineering.changedFiles.map((file) => `- ${file.operation}: ${markdownText(file.path)}`)
      : ["- None recorded"]),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${markdownText(item)}`),
    "",
  );
  return lines.join("\n");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeOutputLeaf(root: string, target: string): void {
  const relative = path.relative(root, target);
  const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === "." || segment === "..") continue;
    if (segment.includes(":")) throw new Error("Report output may not use filesystem stream syntax.");
    if (reservedWindowsName.test(segment)) throw new Error("Report output uses a reserved filesystem name.");
    if (/[. ]$/u.test(segment)) throw new Error("Report output path segments may not end in a dot or space.");
  }
}

export async function writeHiveRunReport(
  repositoryRoot: string,
  outputPath: string,
  content: string,
): Promise<string> {
  const root = await fs.realpath(repositoryRoot);
  const target = path.resolve(root, outputPath);
  if (!isWithin(root, target)) throw new Error("Report output must remain inside the repository root.");
  assertSafeOutputLeaf(root, target);
  const parent = await fs.realpath(path.dirname(target)).catch(() => {
    throw new Error("Report output parent directory must already exist.");
  });
  if (!isWithin(root, parent)) throw new Error("Report output parent escapes the repository root.");
  try {
    await fs.lstat(target);
    throw new Error("Report output already exists; refusing to overwrite it.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return target;
}
