/**
 * HIVE Evidence Ledger — canonical evidence model for verified engineering.
 *
 * Every piece of evidence that contributes to a verdict must be recorded here.
 * Evidence distinguishes observations from claims: agent-claimed evidence
 * never satisfies mandatory gates.
 */

import { CODING_SESSION_SCHEMA_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Evidence schema version
// ---------------------------------------------------------------------------

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Evidence statuses
// ---------------------------------------------------------------------------

export const EVIDENCE_STATUSES = [
  "OBSERVED",
  "EXECUTED",
  "PASSED",
  "FAILED",
  "SKIPPED",
  "UNAVAILABLE",
  "AGENT_CLAIMED",
] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Evidence categories
// ---------------------------------------------------------------------------

export type EvidenceCategory =
  | "repository_observation"
  | "file_inspection"
  | "command_execution"
  | "test_discovery"
  | "test_result"
  | "build_result"
  | "typecheck_result"
  | "diff_inspection"
  | "scope_verification"
  | "security_check"
  | "reviewer_finding"
  | "approval_decision"
  | "repository_sha"
  | "provider_receipt";

// ---------------------------------------------------------------------------
// Evidence record
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
  /** Schema version for forward compatibility. */
  version: typeof EVIDENCE_SCHEMA_VERSION;
  /** Stable unique evidence ID. */
  id: string;
  /** ISO timestamp when evidence was collected. */
  timestamp: string;
  /** The role that produced this evidence. */
  sourceRole: string;
  /** The task or DAG node this evidence is associated with. */
  taskId?: string;
  /** The acceptance gate this evidence is linked to. */
  gateId?: string;
  /** Category of evidence. */
  category: EvidenceCategory;
  /** Current validity status. */
  status: EvidenceStatus;
  /** Human-safe summary (no secrets). */
  summary: string;
  /** Reference to raw artifact (e.g. file path, not content). */
  artifactRef?: string;
  /** Repository SHA at the time evidence was collected. */
  repositorySha?: string;
  /** Worktree path if evidence was collected in isolation. */
  worktreePath?: string;
  /** Whether this evidence is still valid. */
  valid: boolean;
  /** Reason for invalidation, if applicable. */
  invalidationReason?: string;
  /** Exit code for command-based evidence. */
  exitCode?: number;
  /** Duration in milliseconds for timed evidence. */
  durationMs?: number;
  /** Provider that produced this evidence, if applicable. */
  providerId?: string;
  /** Model that produced this evidence, if applicable. */
  model?: string;
  /** Additional structured metadata. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

export interface EvidenceLedger {
  /** Schema version. */
  version: typeof EVIDENCE_SCHEMA_VERSION;
  /** Session this ledger belongs to. */
  sessionId: string;
  /** All evidence records in collection order. */
  records: EvidenceRecord[];
}

// ---------------------------------------------------------------------------
// Evidence status checks
// ---------------------------------------------------------------------------

/**
 * AGENT_CLAIMED evidence never satisfies mandatory gates.
 */
export function canSatisfyGate(status: EvidenceStatus): boolean {
  return status !== "AGENT_CLAIMED" && status !== "UNAVAILABLE" && status !== "SKIPPED";
}

/**
 * Returns true if the evidence represents a passing result.
 */
export function isPassingEvidence(status: EvidenceStatus): boolean {
  return status === "PASSED" || status === "OBSERVED" || status === "EXECUTED";
}

/**
 * Returns true if the evidence represents a failure.
 */
export function isFailingEvidence(status: EvidenceStatus): boolean {
  return status === "FAILED";
}

/**
 * Returns true if the evidence is no longer valid.
 */
export function isStaleEvidence(record: EvidenceRecord): boolean {
  return !record.valid;
}

// ---------------------------------------------------------------------------
// Evidence ledger operations
// ---------------------------------------------------------------------------

/**
 * Creates a new empty evidence ledger.
 */
export function createEvidenceLedger(sessionId: string): EvidenceLedger {
  return {
    version: EVIDENCE_SCHEMA_VERSION,
    sessionId,
    records: [],
  };
}

/**
 * Adds an evidence record to the ledger.
 */
export function addEvidence(
  ledger: EvidenceLedger,
  record: Omit<EvidenceRecord, "version">,
): EvidenceRecord {
  const full: EvidenceRecord = {
    ...record,
    version: EVIDENCE_SCHEMA_VERSION,
  };
  ledger.records.push(full);
  return full;
}

/**
 * Invalidates all evidence tied to a specific repository SHA.
 * Used when the repository state changes after evidence was collected.
 */
export function invalidateEvidenceBySha(
  ledger: EvidenceLedger,
  sha: string,
  reason: string,
): number {
  let count = 0;
  for (const record of ledger.records) {
    if (record.repositorySha === sha && record.valid) {
      record.valid = false;
      record.invalidationReason = reason;
      count += 1;
    }
  }
  return count;
}

/**
 * Invalidates all evidence tied to a specific worktree.
 * Used when a worktree is lost or corrupted.
 */
export function invalidateEvidenceByWorktree(
  ledger: EvidenceLedger,
  worktreePath: string,
  reason: string,
): number {
  let count = 0;
  for (const record of ledger.records) {
    if (record.worktreePath === worktreePath && record.valid) {
      record.valid = false;
      record.invalidationReason = reason;
      count += 1;
    }
  }
  return count;
}

/**
 * Returns all valid evidence records for a specific gate.
 */
export function evidenceForGate(
  ledger: EvidenceLedger,
  gateId: string,
): EvidenceRecord[] {
  return ledger.records.filter(
    (record) => record.gateId === gateId && record.valid,
  );
}

/**
 * Returns all evidence records with a specific status.
 */
export function evidenceByStatus(
  ledger: EvidenceLedger,
  status: EvidenceStatus,
): EvidenceRecord[] {
  return ledger.records.filter((record) => record.status === status);
}

/**
 * Returns all stale (invalidated) evidence records.
 */
export function staleEvidence(ledger: EvidenceLedger): EvidenceRecord[] {
  return ledger.records.filter((record) => !record.valid);
}

/**
 * Returns the latest valid evidence for a gate, or undefined.
 */
export function latestEvidenceForGate(
  ledger: EvidenceLedger,
  gateId: string,
): EvidenceRecord | undefined {
  const matching = evidenceForGate(ledger, gateId);
  return matching.length > 0 ? matching[matching.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// Evidence record factories
// ---------------------------------------------------------------------------

let evidenceCounter = 0;

/**
 * Creates a unique evidence ID.
 */
export function createEvidenceId(prefix = "ev"): string {
  evidenceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${evidenceCounter.toString(36)}`;
}

/**
 * Creates a command execution evidence record.
 */
export function createCommandEvidence(options: {
  sourceRole: string;
  taskId?: string;
  gateId?: string;
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  repositorySha?: string;
  worktreePath?: string;
}): Omit<EvidenceRecord, "version"> {
  const passed = options.exitCode === 0;
  return {
    id: createEvidenceId("cmd"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: options.gateId,
    category: "command_execution",
    status: passed ? "PASSED" : "FAILED",
    summary: `Command '${options.command}' exited with code ${options.exitCode}`,
    artifactRef: undefined,
    repositorySha: options.repositorySha,
    worktreePath: options.worktreePath,
    valid: true,
    exitCode: options.exitCode,
    durationMs: options.durationMs,
  };
}

/**
 * Creates a build result evidence record.
 */
export function createBuildEvidence(options: {
  sourceRole: string;
  taskId?: string;
  exitCode: number;
  durationMs?: number;
  repositorySha?: string;
  worktreePath?: string;
}): Omit<EvidenceRecord, "version"> {
  return {
    id: createEvidenceId("build"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: "gate-build-pass",
    category: "build_result",
    status: options.exitCode === 0 ? "PASSED" : "FAILED",
    summary: options.exitCode === 0 ? "Build passed" : `Build failed (exit ${options.exitCode})`,
    repositorySha: options.repositorySha,
    worktreePath: options.worktreePath,
    valid: true,
    exitCode: options.exitCode,
    durationMs: options.durationMs,
  };
}

/**
 * Creates a typecheck result evidence record.
 */
export function createTypecheckEvidence(options: {
  sourceRole: string;
  taskId?: string;
  exitCode: number;
  durationMs?: number;
  repositorySha?: string;
  worktreePath?: string;
}): Omit<EvidenceRecord, "version"> {
  return {
    id: createEvidenceId("tsc"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: "gate-typecheck-pass",
    category: "typecheck_result",
    status: options.exitCode === 0 ? "PASSED" : "FAILED",
    summary: options.exitCode === 0 ? "Typecheck passed" : `Typecheck failed (exit ${options.exitCode})`,
    repositorySha: options.repositorySha,
    worktreePath: options.worktreePath,
    valid: true,
    exitCode: options.exitCode,
    durationMs: options.durationMs,
  };
}

/**
 * Creates a test result evidence record.
 */
export function createTestEvidence(options: {
  sourceRole: string;
  taskId?: string;
  exitCode: number;
  durationMs?: number;
  repositorySha?: string;
  worktreePath?: string;
}): Omit<EvidenceRecord, "version"> {
  return {
    id: createEvidenceId("test"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: "gate-tests-pass",
    category: "test_result",
    status: options.exitCode === 0 ? "PASSED" : "FAILED",
    summary: options.exitCode === 0 ? "Tests passed" : `Tests failed (exit ${options.exitCode})`,
    repositorySha: options.repositorySha,
    worktreePath: options.worktreePath,
    valid: true,
    exitCode: options.exitCode,
    durationMs: options.durationMs,
  };
}

/**
 * Creates a scope verification evidence record.
 */
export function createScopeEvidence(options: {
  sourceRole: string;
  taskId?: string;
  changedFiles: string[];
  allowedPaths: string[];
  violations: string[];
  repositorySha?: string;
}): Omit<EvidenceRecord, "version"> {
  const passed = options.violations.length === 0;
  return {
    id: createEvidenceId("scope"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: "gate-scope-verified",
    category: "scope_verification",
    status: passed ? "PASSED" : "FAILED",
    summary: passed
      ? `All ${options.changedFiles.length} changed files are within allowed scope`
      : `Scope violation: ${options.violations.join(", ")}`,
    repositorySha: options.repositorySha,
    valid: true,
    metadata: {
      changedFiles: options.changedFiles.join(","),
      allowedPaths: options.allowedPaths.join(","),
      violations: options.violations.join(","),
    },
  };
}

/**
 * Creates a reviewer approval evidence record.
 */
export function createReviewEvidence(options: {
  sourceRole: string;
  taskId?: string;
  approved: boolean;
  findings: Array<{ severity: string; summary: string }>;
  repositorySha?: string;
}): Omit<EvidenceRecord, "version"> {
  return {
    id: createEvidenceId("review"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: "gate-reviewer-approved",
    category: "reviewer_finding",
    status: options.approved ? "PASSED" : "FAILED",
    summary: options.approved
      ? "Reviewer approved the implementation"
      : `Reviewer found ${options.findings.length} issue(s)`,
    repositorySha: options.repositorySha,
    valid: true,
    metadata: {
      findings: JSON.stringify(options.findings),
    },
  };
}

/**
 * Creates a repository SHA evidence record.
 */
export function createShaEvidence(options: {
  sourceRole: string;
  sha: string;
  branch: string;
}): Omit<EvidenceRecord, "version"> {
  return {
    id: createEvidenceId("sha"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    category: "repository_sha",
    status: "OBSERVED",
    summary: `Repository at ${options.sha} on branch ${options.branch}`,
    repositorySha: options.sha,
    valid: true,
    metadata: {
      sha: options.sha,
      branch: options.branch,
    },
  };
}

/**
 * Creates an agent-claimed evidence record.
 * This type of evidence never satisfies mandatory gates.
 */
export function createAgentClaimedEvidence(options: {
  sourceRole: string;
  taskId?: string;
  gateId?: string;
  claim: string;
  repositorySha?: string;
}): Omit<EvidenceRecord, "version"> {
  return {
    id: createEvidenceId("claim"),
    timestamp: new Date().toISOString(),
    sourceRole: options.sourceRole,
    taskId: options.taskId,
    gateId: options.gateId,
    category: "command_execution",
    status: "AGENT_CLAIMED",
    summary: `Agent claims: ${options.claim}`,
    repositorySha: options.repositorySha,
    valid: true,
  };
}
