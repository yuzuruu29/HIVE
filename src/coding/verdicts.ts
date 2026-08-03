/**
 * HIVE Verdicts — failure taxonomy and deterministic verdict computation.
 *
 * A run must never be considered complete solely because an agent claims
 * success. The final verdict is computed from the evidence ledger and
 * the task contract.
 */

import type { HiveTaskContract, AcceptanceRequirement } from "./contracts.js";
import { resolveGate } from "./contracts.js";
import type { EvidenceLedger, EvidenceRecord } from "./evidence.js";
import {
  canSatisfyGate,
  evidenceForGate,
  isPassingEvidence,
  isStaleEvidence,
  latestEvidenceForGate,
} from "./evidence.js";

// ---------------------------------------------------------------------------
// Run verdict
// ---------------------------------------------------------------------------

export type HiveRunVerdict =
  | "ACCEPTED"
  | "REPAIRABLE"
  | "REJECTED"
  | "BLOCKED";

// ---------------------------------------------------------------------------
// Failure classes
// ---------------------------------------------------------------------------

export const FAILURE_CLASSES = [
  "BUILD_FAILURE",
  "TYPECHECK_FAILURE",
  "TEST_FAILURE",
  "SCOPE_VIOLATION",
  "PROTECTED_PATH_VIOLATION",
  "INTEGRATION_CONFLICT",
  "MISSING_EVIDENCE",
  "INVALID_PLAN",
  "SECURITY_FINDING",
  "ARCHITECTURE_REJECTION",
  "PROVIDER_FAILURE",
  "PROVIDER_TIMEOUT",
  "INFRASTRUCTURE_BLOCKER",
  "APPROVAL_DENIED",
  "REPOSITORY_DRIFT",
  "WORKTREE_MISSING",
  "EVIDENCE_STALE",
  "BUDGET_EXCEEDED",
  "CANCELLED",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

// ---------------------------------------------------------------------------
// Failure actions
// ---------------------------------------------------------------------------

export type FailureAction =
  | "retry"
  | "route_provider_fallback"
  | "invoke_fixer"
  | "replan_affected_nodes"
  | "request_approval"
  | "reject_patch"
  | "mark_blocked"
  | "terminate_run";

/**
 * Maps each failure class to its deterministic default action.
 */
export const FAILURE_ACTION_MAP: Record<FailureClass, FailureAction> = {
  BUILD_FAILURE: "invoke_fixer",
  TYPECHECK_FAILURE: "invoke_fixer",
  TEST_FAILURE: "invoke_fixer",
  SCOPE_VIOLATION: "reject_patch",
  PROTECTED_PATH_VIOLATION: "reject_patch",
  INTEGRATION_CONFLICT: "replan_affected_nodes",
  MISSING_EVIDENCE: "mark_blocked",
  INVALID_PLAN: "terminate_run",
  SECURITY_FINDING: "reject_patch",
  ARCHITECTURE_REJECTION: "reject_patch",
  PROVIDER_FAILURE: "route_provider_fallback",
  PROVIDER_TIMEOUT: "retry",
  INFRASTRUCTURE_BLOCKER: "mark_blocked",
  APPROVAL_DENIED: "terminate_run",
  REPOSITORY_DRIFT: "replan_affected_nodes",
  WORKTREE_MISSING: "replan_affected_nodes",
  EVIDENCE_STALE: "replan_affected_nodes",
  BUDGET_EXCEEDED: "terminate_run",
  CANCELLED: "terminate_run",
};

// ---------------------------------------------------------------------------
// Failure record
// ---------------------------------------------------------------------------

export interface FailureRecord {
  /** The failure classification. */
  failureClass: FailureClass;
  /** The affected DAG node, if applicable. */
  affectedNodeId?: string;
  /** The attempt number when this failure occurred. */
  attemptNumber: number;
  /** The deterministic action taken. */
  actionTaken: FailureAction;
  /** Whether the repair succeeded. */
  repairSucceeded?: boolean;
  /** Human-readable description. */
  description: string;
  /** Remaining risk after action. */
  remainingRisk?: string;
  /** ISO timestamp. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

export interface VerdictComputation {
  /** The final verdict. */
  verdict: HiveRunVerdict;
  /** Reasons supporting the verdict. */
  reasons: string[];
  /** Unsatisfied required gates, if any. */
  unsatisfiedGates: string[];
  /** Missing required evidence, if any. */
  missingEvidence: string[];
  /** Stale evidence that invalidated results. */
  staleEvidenceCount: number;
  /** Whether the reviewer approved. */
  reviewerApproved: boolean;
  /** Whether user approval was required and granted. */
  userApprovalSatisfied: boolean;
  /** The final integrated repository SHA. */
  finalSha?: string;
}

/**
 * Computes the deterministic verdict for a run.
 *
 * Rules:
 * - ACCEPTED: all required gates passed, evidence is current, reviewer
 *   approved, no unresolved mandatory findings, user approval if required.
 * - REPAIRABLE: defects are actionable, repair budget remains, no critical
 *   safety violation.
 * - REJECTED: scope violation, architecture/security failure, budget
 *   exhausted, or user rejected.
 * - BLOCKED: infrastructure unavailable, credentials missing, required
 *   evidence cannot be collected for external reasons.
 */
export function computeVerdict(
  contract: HiveTaskContract,
  ledger: EvidenceLedger,
  options: {
    repairAttemptsUsed: number;
    userApprovalGranted?: boolean;
    reviewerApproved?: boolean;
    hasCriticalSafetyViolation?: boolean;
    isInfrastructureBlocked?: boolean;
    isCancelled?: boolean;
  },
): VerdictComputation {
  const reasons: string[] = [];
  const unsatisfiedGates: string[] = [];
  const missingEvidence: string[] = [];

  // Check for cancellation first
  if (options.isCancelled) {
    return {
      verdict: "BLOCKED",
      reasons: ["Run was cancelled"],
      unsatisfiedGates: [],
      missingEvidence: [],
      staleEvidenceCount: 0,
      reviewerApproved: false,
      userApprovalSatisfied: false,
    };
  }

  // Check infrastructure blocking
  if (options.isInfrastructureBlocked) {
    return {
      verdict: "BLOCKED",
      reasons: ["Infrastructure is unavailable"],
      unsatisfiedGates: [],
      missingEvidence: [],
      staleEvidenceCount: 0,
      reviewerApproved: false,
      userApprovalSatisfied: false,
    };
  }

  // Count stale evidence
  const staleCount = ledger.records.filter(isStaleEvidence).length;

  // Check each required gate — evidence is the sole source of truth
  for (const gate of contract.requiredBehaviors) {
    if (!gate.required) continue;

    // Evidence-derived gate resolution: derive state from the evidence ledger
    const resolvedState = resolveGate(gate.id, ledger, contract);
    if (resolvedState === "satisfied") {
      continue;
    }

    unsatisfiedGates.push(gate.id);
    if (resolvedState === "failed") {
      reasons.push(`Required gate '${gate.id}' failed based on evidence`);
    } else if (resolvedState === "unavailable") {
      reasons.push(`Required gate '${gate.id}' evidence is unavailable`);
    } else {
      reasons.push(`Required gate '${gate.id}' has no satisfying evidence`);
    }
  }

  // Check required evidence
  for (const req of contract.requiredEvidence) {
    if (!req.required) continue;
    const matching = ledger.records.filter(
      (e) => e.category === req.evidenceType && e.valid && canSatisfyGate(e.status),
    );
    if (matching.length === 0) {
      missingEvidence.push(req.id);
      reasons.push(`Required evidence '${req.id}' is missing`);
    }
  }

  // Check reviewer approval
  const reviewerApproved =
    options.reviewerApproved ??
    ledger.records.some(
      (e) =>
        e.category === "reviewer_finding" &&
        e.valid &&
        e.status === "PASSED",
    );

  if (!reviewerApproved) {
    reasons.push("Independent reviewer has not approved");
  }

  // Check user approval if required
  const userApprovalSatisfied = contract.approvalPolicy.requireUserApproval
    ? options.userApprovalGranted === true
    : true;

  if (contract.approvalPolicy.requireUserApproval && !userApprovalSatisfied) {
    reasons.push("User approval is required but not granted");
  }

  // Get final SHA
  const shaEvidence = ledger.records
    .filter((e) => e.category === "repository_sha" && e.valid)
    .at(-1);
  const finalSha = shaEvidence?.repositorySha;

  // Determine verdict
  const hasCriticalViolation = options.hasCriticalSafetyViolation === true;
  const budgetRemaining =
    options.repairAttemptsUsed < contract.budget.maxRepairAttempts;

  // REJECTED: critical safety violation, scope violation, or architecture rejection
  if (hasCriticalViolation) {
    return {
      verdict: "REJECTED",
      reasons: ["Critical safety violation detected", ...reasons],
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // Check for scope violations (always reject)
  const scopeViolations = ledger.records.filter(
    (e) =>
      e.category === "scope_verification" &&
      e.valid &&
      e.status === "FAILED",
  );
  if (scopeViolations.length > 0) {
    return {
      verdict: "REJECTED",
      reasons: [
        "Scope or protected-path policy was violated",
        ...reasons,
      ],
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // BLOCKED: missing evidence due to external reasons (only if gates are also unsatisfied)
  if (missingEvidence.length > 0 && unsatisfiedGates.length > 0 && options.isInfrastructureBlocked) {
    return {
      verdict: "BLOCKED",
      reasons: [
        "Required evidence cannot be collected",
        ...reasons,
      ],
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // REJECTED: budget exhausted with unsatisfied gates
  if (unsatisfiedGates.length > 0 && !budgetRemaining) {
    return {
      verdict: "REJECTED",
      reasons: [
        "Repair budget exhausted with unsatisfied gates",
        ...reasons,
      ],
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // REJECTED: reviewer did not approve (for required gates)
  if (
    !reviewerApproved &&
    contract.requiredBehaviors.some(
      (b) => b.id === "gate-reviewer-approved" && b.required,
    )
  ) {
    return {
      verdict: "REJECTED",
      reasons: ["Reviewer did not approve", ...reasons],
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // REPAIRABLE: unsatisfied gates but budget remains
  if (unsatisfiedGates.length > 0 && budgetRemaining) {
    return {
      verdict: "REPAIRABLE",
      reasons: [
        `${unsatisfiedGates.length} gate(s) unsatisfied, repair budget available`,
        ...reasons,
      ],
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // ACCEPTED: all gates satisfied
  if (unsatisfiedGates.length === 0 && reviewerApproved && userApprovalSatisfied) {
    return {
      verdict: "ACCEPTED",
      reasons: ["All required gates satisfied", "Evidence is current"],
      unsatisfiedGates: [],
      missingEvidence: [],
      staleEvidenceCount: staleCount,
      reviewerApproved: true,
      userApprovalSatisfied: true,
      finalSha,
    };
  }

  // Fallback: if we have unsatisfied gates, it's REPAIRABLE or REJECTED
  if (unsatisfiedGates.length > 0) {
    return {
      verdict: budgetRemaining ? "REPAIRABLE" : "REJECTED",
      reasons,
      unsatisfiedGates,
      missingEvidence,
      staleEvidenceCount: staleCount,
      reviewerApproved,
      userApprovalSatisfied,
      finalSha,
    };
  }

  // Should not reach here, but default to BLOCKED
  return {
    verdict: "BLOCKED",
    reasons: ["Unable to determine verdict"],
    unsatisfiedGates,
    missingEvidence,
    staleEvidenceCount: staleCount,
    reviewerApproved,
    userApprovalSatisfied,
    finalSha,
  };
}

/**
 * Classifies a failure from its description and context.
 */
export function classifyFailure(options: {
  description: string;
  exitCode?: number;
  command?: string;
  isScopeViolation?: boolean;
  isProtectedPath?: boolean;
  isTimeout?: boolean;
  isProviderError?: boolean;
  isInfrastructure?: boolean;
  isCancelled?: boolean;
}): FailureClass {
  if (options.isCancelled) return "CANCELLED";
  if (options.isScopeViolation) return "SCOPE_VIOLATION";
  if (options.isProtectedPath) return "PROTECTED_PATH_VIOLATION";
  if (options.isInfrastructure) return "INFRASTRUCTURE_BLOCKER";
  if (options.isTimeout) return "PROVIDER_TIMEOUT";
  if (options.isProviderError) return "PROVIDER_FAILURE";

  const desc = options.description.toLowerCase();
  if (desc.includes("build")) return "BUILD_FAILURE";
  if (desc.includes("typecheck") || desc.includes("tsc")) return "TYPECHECK_FAILURE";
  if (desc.includes("test")) return "TEST_FAILURE";
  if (desc.includes("security") || desc.includes("vulnerability")) return "SECURITY_FINDING";
  if (desc.includes("conflict")) return "INTEGRATION_CONFLICT";
  if (desc.includes("drift")) return "REPOSITORY_DRIFT";
  if (desc.includes("worktree")) return "WORKTREE_MISSING";
  if (desc.includes("stale")) return "EVIDENCE_STALE";
  if (desc.includes("budget")) return "BUDGET_EXCEEDED";
  if (desc.includes("approval") || desc.includes("denied")) return "APPROVAL_DENIED";
  if (desc.includes("missing") || desc.includes("evidence")) return "MISSING_EVIDENCE";
  if (desc.includes("plan")) return "INVALID_PLAN";
  if (desc.includes("architecture")) return "ARCHITECTURE_REJECTION";

  return "PROVIDER_FAILURE";
}

/**
 * Returns the deterministic action for a failure class.
 */
export function actionForFailure(failureClass: FailureClass): FailureAction {
  return FAILURE_ACTION_MAP[failureClass];
}
