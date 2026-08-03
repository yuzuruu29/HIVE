/**
 * HIVE Task Contracts — versioned machine-readable acceptance agreements.
 *
 * A task contract defines what the system must prove before a run can be
 * accepted. Every required gate must have a stable identifier, a clear
 * evidence type, and a deterministic satisfaction state.
 *
 * ARCHITECTURE: Evidence is the sole authority for mandatory gate
 * satisfaction. Gate state is never set directly — it is always derived
 * from the evidence ledger via `resolveGate`. Risk policies impose
 * minimum acceptance requirements that cannot be bypassed by omitting
 * validation commands.
 */

import { CODING_SESSION_SCHEMA_VERSION } from "./types.js";
import {
  type EvidenceLedger,
  evidenceForGate,
  canSatisfyGate,
  isPassingEvidence,
  isFailingEvidence,
} from "./evidence.js";

// ---------------------------------------------------------------------------
// Contract schema version
// ---------------------------------------------------------------------------

export const TASK_CONTRACT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Risk and approval
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ApprovalPolicy {
  /** Whether user approval is required before accepting. */
  requireUserApproval: boolean;
  /** Whether the Reviewer must use a different provider than the Builder. */
  requireIndependentProvider: boolean;
  /** Minimum risk level that triggers independent provider requirement. */
  independentProviderThreshold: RiskLevel;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface TaskBudget {
  /** Maximum number of model calls across all agents. */
  maxModelCalls: number;
  /** Maximum number of shell commands across all agents. */
  maxCommands: number;
  /** Maximum wall-clock minutes. */
  maxMinutes: number;
  /** Maximum Fixer repair attempts. */
  maxRepairAttempts: number;
}

// ---------------------------------------------------------------------------
// Acceptance requirements
// ---------------------------------------------------------------------------

export type RequirementCategory =
  | "behavior"
  | "evidence"
  | "security"
  | "architecture"
  | "performance"
  | "custom";

export type SatisfactionState =
  | "pending"
  | "satisfied"
  | "failed"
  | "skipped"
  | "unavailable";

export interface AcceptanceRequirement {
  /** Stable unique identifier, e.g. "gate-build-pass". */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Whether this requirement is mandatory for ACCEPTED verdict. */
  required: boolean;
  /** Category for reporting grouping. */
  category: RequirementCategory;
  /** Current satisfaction state. */
  state: SatisfactionState;
  /** References to evidence records that contributed to the state. */
  evidenceIds: string[];
  /** Reason for failure, if applicable. */
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Evidence requirements
// ---------------------------------------------------------------------------

export type EvidenceType =
  | "build_result"
  | "typecheck_result"
  | "test_result"
  | "scope_verification"
  | "diff_inspection"
  | "security_check"
  | "reviewer_approval"
  | "user_approval"
  | "repository_sha"
  | "command_execution"
  | "file_inspection"
  | "provider_receipt";

/**
 * Evidence applicability determines whether evidence can satisfy a gate.
 *
 * - REQUIRED: evidence must be present and passing for the gate to be satisfied.
 * - OPTIONAL: evidence is nice to have but not mandatory.
 * - NOT_APPLICABLE: evidence is not relevant to this task.
 * - UNAVAILABLE: evidence cannot be collected for external reasons.
 */
export type EvidenceApplicability = "required" | "optional" | "not_applicable" | "unavailable";

export interface EvidenceRequirement {
  /** Stable unique identifier. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Whether this evidence is mandatory. */
  required: boolean;
  /** The kind of evidence expected. */
  evidenceType: EvidenceType;
  /** The gate this evidence is associated with. */
  gateId?: string;
  /** Applicability of this evidence requirement. */
  applicability: EvidenceApplicability;
}

// ---------------------------------------------------------------------------
// Task contract
// ---------------------------------------------------------------------------

export interface HiveTaskContract {
  /** Contract schema version for forward compatibility. */
  version: typeof TASK_CONTRACT_SCHEMA_VERSION;
  /** The coding session schema version this contract targets. */
  sessionSchemaVersion: typeof CODING_SESSION_SCHEMA_VERSION;
  /** Human-readable objective. */
  objective: string;
  /** Absolute path to the repository root. */
  repositoryRoot: string;
  /** Git SHA at the start of the run. */
  baseCommit: string;
  /** Paths Builders are allowed to modify. */
  allowedPaths: string[];
  /** Paths no agent may touch. */
  forbiddenPaths: string[];
  /** Behavioral requirements that must be demonstrated. */
  requiredBehaviors: AcceptanceRequirement[];
  /** Evidence that must be collected. */
  requiredEvidence: EvidenceRequirement[];
  /** File patterns that must not appear in any diff. */
  forbiddenChanges: string[];
  /** Overall risk classification. */
  riskLevel: RiskLevel;
  /** Approval and independence policies. */
  approvalPolicy: ApprovalPolicy;
  /** Resource budget. */
  budget: TaskBudget;
}

// ---------------------------------------------------------------------------
// Risk-based minimum acceptance gates
// ---------------------------------------------------------------------------

/**
 * Minimum gates required regardless of which validation commands are configured.
 * Risk policies impose these requirements and they cannot be bypassed by
 * omitting commands.
 */
export const RISK_MINIMUM_GATES: Record<RiskLevel, string[]> = {
  low: ["gate-scope-verified", "gate-reviewer-approved"],
  medium: ["gate-scope-verified", "gate-reviewer-approved"],
  high: ["gate-scope-verified", "gate-reviewer-approved"],
  critical: ["gate-scope-verified", "gate-reviewer-approved"],
};

// ---------------------------------------------------------------------------
// Evidence-derived gate resolution
// ---------------------------------------------------------------------------

/**
 * Derives the satisfaction state of a gate from the evidence ledger.
 * Evidence is the sole source of truth — gate state is never set directly.
 */
export function resolveGate(
  gateId: string,
  ledger: EvidenceLedger,
  contract: HiveTaskContract,
): SatisfactionState {
  const gate = contract.requiredBehaviors.find((b) => b.id === gateId);
  if (!gate) return "pending";

  // Check ALL evidence for this gate (including invalid) to detect unavailable
  const allEvidence = ledger.records.filter((r) => r.gateId === gateId);
  // Only valid evidence can satisfy or fail gates
  const validEvidence = allEvidence.filter((e) => e.valid);
  const satisfyingEvidence = validEvidence.filter(
    (e) => canSatisfyGate(e.status) && isPassingEvidence(e.status),
  );
  const failingEvidence = validEvidence.filter(
    (e) => canSatisfyGate(e.status) && isFailingEvidence(e.status),
  );

  if (satisfyingEvidence.length > 0) return "satisfied";
  if (failingEvidence.length > 0) return "failed";
  // All evidence is invalidated — the gate result is unavailable
  if (allEvidence.length > 0 && validEvidence.length === 0) return "unavailable";
  return "pending";
}

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

export interface ContractValidationIssue {
  code: string;
  message: string;
}

export interface ContractValidationResult {
  valid: boolean;
  issues: ContractValidationIssue[];
}

/**
 * Validates that a task contract is structurally sound.
 */
export function validateTaskContract(
  contract: HiveTaskContract,
): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];

  if (contract.version !== TASK_CONTRACT_SCHEMA_VERSION) {
    issues.push({
      code: "invalid_version",
      message: `Contract version ${contract.version} is not supported.`,
    });
  }

  if (!contract.objective.trim()) {
    issues.push({
      code: "empty_objective",
      message: "Contract objective must not be empty.",
    });
  }

  if (!contract.repositoryRoot.trim()) {
    issues.push({
      code: "missing_repository_root",
      message: "Contract must specify a repository root.",
    });
  }

  if (!contract.baseCommit.trim()) {
    issues.push({
      code: "missing_base_commit",
      message: "Contract must specify a base commit.",
    });
  }

  // Gates must have stable IDs
  const gateIds = new Set<string>();
  for (const behavior of contract.requiredBehaviors) {
    if (!behavior.id.trim()) {
      issues.push({
        code: "missing_gate_id",
        message: "Every acceptance requirement must have a stable ID.",
      });
    } else if (gateIds.has(behavior.id)) {
      issues.push({
        code: "duplicate_gate_id",
        message: `Duplicate gate ID: ${behavior.id}`,
      });
    } else {
      gateIds.add(behavior.id);
    }
  }

  // Evidence requirements must have stable IDs
  const evidenceIds = new Set<string>();
  for (const evidence of contract.requiredEvidence) {
    if (!evidence.id.trim()) {
      issues.push({
        code: "missing_evidence_id",
        message: "Every evidence requirement must have a stable ID.",
      });
    } else if (evidenceIds.has(evidence.id)) {
      issues.push({
        code: "duplicate_evidence_id",
        message: `Duplicate evidence requirement ID: ${evidence.id}`,
      });
    } else {
      evidenceIds.add(evidence.id);
    }
  }

  // Budget must be sane
  if (contract.budget.maxRepairAttempts < 0) {
    issues.push({
      code: "invalid_budget",
      message: "maxRepairAttempts must be non-negative.",
    });
  }

  if (contract.budget.maxModelCalls < 1) {
    issues.push({
      code: "invalid_budget",
      message: "maxModelCalls must be at least 1.",
    });
  }

  // Must have at least one required gate for meaningful acceptance
  const hasRequiredGate = contract.requiredBehaviors.some((b) => b.required);
  if (!hasRequiredGate) {
    issues.push({
      code: "no_required_gates",
      message:
        "Contract must have at least one required acceptance gate.",
    });
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Default contract builder
// ---------------------------------------------------------------------------

const PROTECTED_PATHS = [
  ".git",
  ".hivemind",
  "node_modules",
  ".env",
  ".env.local",
  ".env.production",
];

const DEFAULT_FORBIDDEN_CHANGES = [
  ".git/**",
  ".hivemind/**",
  "node_modules/**",
  ".env*",
];

/**
 * Creates a default task contract with standard gates.
 *
 * ARCHITECTURE: Scope verification and reviewer approval are ALWAYS required
 * regardless of validation commands. Risk policies impose minimum acceptance
 * requirements that cannot be bypassed by omitting commands.
 *
 * Build/typecheck/test gates are always defined (non-adaptive) so that
 * omitted validation commands do not silently bypass mandatory checks.
 * When a gate's evidence is not applicable (e.g., no build command exists),
 * the evidence requirement is marked as NOT_APPLICABLE and the gate is
 * resolved accordingly.
 */
export function createDefaultTaskContract(options: {
  objective: string;
  repositoryRoot: string;
  baseCommit: string;
  allowedPaths: string[];
  riskLevel?: RiskLevel;
  budget?: Partial<TaskBudget>;
  /** Validation commands that will be run. */
  validationCommands?: string[];
}): HiveTaskContract {
  const riskLevel = options.riskLevel ?? "medium";
  const commands = options.validationCommands ?? [];

  // Detect which validation categories are present
  const hasBuild = commands.some((c) => /build/i.test(c));
  const hasTypecheck = commands.some((c) => /(?:typecheck|tsc|type-check)/i.test(c));
  const hasTest = commands.some((c) => /test/i.test(c));
  const hasAnyValidation = commands.length > 0;

  // Get minimum gates from risk policy
  const minimumGateIds = new Set(RISK_MINIMUM_GATES[riskLevel] ?? []);

  // Scope and reviewer are ALWAYS required (risk policy minimum)
  // Build/typecheck/test gates are always defined but marked as
  // not_applicable when no corresponding command is configured
  const behaviors: AcceptanceRequirement[] = [
    {
      id: "gate-scope-verified",
      description: "All file changes must be within allowed scopes",
      required: minimumGateIds.has("gate-scope-verified"),
      category: "security",
      state: "pending",
      evidenceIds: [],
    },
    {
      id: "gate-integrated-validation",
      description:
        "Validation must run against the integrated repository state",
      required: hasAnyValidation,
      category: "behavior",
      state: "pending",
      evidenceIds: [],
    },
    {
      id: "gate-reviewer-approved",
      description: "Independent reviewer must approve the result",
      required: minimumGateIds.has("gate-reviewer-approved"),
      category: "architecture",
      state: "pending",
      evidenceIds: [],
    },
    // Build/typecheck/test gates are always defined (non-adaptive)
    // so that omitting commands does not bypass mandatory checks.
    // When no command is configured, the gate is defined but not required
    // (evidence is NOT_APPLICABLE and resolveGate returns "pending",
    // but computeVerdict skips non-required gates).
    {
      id: "gate-build-pass",
      description: "Project must build without errors",
      required: hasBuild,
      category: "behavior",
      state: "pending",
      evidenceIds: [],
    },
    {
      id: "gate-typecheck-pass",
      description: "TypeScript type checking must pass",
      required: hasTypecheck,
      category: "behavior",
      state: "pending",
      evidenceIds: [],
    },
    {
      id: "gate-tests-pass",
      description: "All tests must pass",
      required: hasTest,
      category: "behavior",
      state: "pending",
      evidenceIds: [],
    },
  ];

  const evidence: EvidenceRequirement[] = [
    {
      id: "evidence-final-sha",
      description: "Final integrated repository SHA",
      required: true,
      evidenceType: "repository_sha",
      applicability: "required",
    },
    {
      id: "evidence-scope",
      description: "Scope verification for all changed files",
      required: true,
      evidenceType: "scope_verification",
      gateId: "gate-scope-verified",
      applicability: "required",
    },
    {
      id: "evidence-review",
      description: "Reviewer approval evidence",
      required: true,
      evidenceType: "reviewer_approval",
      gateId: "gate-reviewer-approved",
      applicability: "required",
    },
    // Build evidence: required when build command is present, not_applicable otherwise
    {
      id: "evidence-build",
      description: "Build result from integrated state",
      required: hasBuild,
      evidenceType: "build_result",
      gateId: "gate-build-pass",
      applicability: hasBuild ? "required" : "not_applicable",
    },
    // Typecheck evidence: required when typecheck command is present
    {
      id: "evidence-typecheck",
      description: "Typecheck result from integrated state",
      required: hasTypecheck,
      evidenceType: "typecheck_result",
      gateId: "gate-typecheck-pass",
      applicability: hasTypecheck ? "required" : "not_applicable",
    },
    // Test evidence: required when test command is present
    {
      id: "evidence-tests",
      description: "Test result from integrated state",
      required: hasTest,
      evidenceType: "test_result",
      gateId: "gate-tests-pass",
      applicability: hasTest ? "required" : "not_applicable",
    },
  ];

  return {
    version: TASK_CONTRACT_SCHEMA_VERSION,
    sessionSchemaVersion: CODING_SESSION_SCHEMA_VERSION,
    objective: options.objective,
    repositoryRoot: options.repositoryRoot,
    baseCommit: options.baseCommit,
    allowedPaths: options.allowedPaths,
    forbiddenPaths: PROTECTED_PATHS,
    requiredBehaviors: behaviors,
    requiredEvidence: evidence,
    forbiddenChanges: DEFAULT_FORBIDDEN_CHANGES,
    riskLevel,
    approvalPolicy: {
      requireUserApproval: riskLevel === "critical",
      requireIndependentProvider:
        riskLevel === "high" || riskLevel === "critical",
      independentProviderThreshold: "high",
    },
    budget: {
      maxModelCalls: options.budget?.maxModelCalls ?? 100,
      maxCommands: options.budget?.maxCommands ?? 200,
      maxMinutes: options.budget?.maxMinutes ?? 30,
      maxRepairAttempts: options.budget?.maxRepairAttempts ?? 3,
      ...options.budget,
    },
  };
}

/**
 * Returns all required gates that are not satisfied, using evidence-derived
 * resolution. Gate state is never checked directly — evidence is the sole
 * authority for gate satisfaction.
 */
export function unsatisfiedRequiredGates(
  contract: HiveTaskContract,
  ledger: EvidenceLedger,
): AcceptanceRequirement[] {
  return contract.requiredBehaviors.filter(
    (b) => b.required && resolveGate(b.id, ledger, contract) !== "satisfied",
  );
}
