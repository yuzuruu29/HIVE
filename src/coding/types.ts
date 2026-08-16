export const CODING_SESSION_SCHEMA_VERSION = 1 as const;

export const SUBAGENT_ROLES = [
  "planner",
  "scout",
  "builder",
  "validator",
  "reviewer",
  "fixer",
] as const;

export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const SUBAGENT_STATUSES = [
  "created",
  "queued",
  "waiting_for_dependencies",
  "starting",
  "working",
  "blocked",
  "retrying",
  "validating",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export const TERMINAL_SUBAGENT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type TerminalSubagentStatus =
  (typeof TERMINAL_SUBAGENT_STATUSES)[number];

export type CodeMode = "auto" | "plan" | "review";
export type ApprovalPolicy = "safe" | "changes" | "always";

export type CodingSessionStatus =
  | "created"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface SubagentTask {
  id: string;
  sessionId: string;
  parentTaskId?: string;
  role: SubagentRole;
  title: string;
  objective: string;
  status: SubagentStatus;
  providerId: string;
  model?: string;
  dependencies: string[];
  fileScope: string[];
  expectedOutput: string;
  completionCriteria: string[];
  validationCommands: string[];
  depth: number;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  error?: string;
  tokenUsage?: TokenUsage;
}

export interface RepositorySnapshot {
  root: string;
  worktreePath?: string;
  capturedAt: string;
  baseCommit?: string;
  branch?: string;
  dirty: boolean;
  changedFiles: string[];
  fingerprint?: string;
}

export const CHAT_BINDING_ROLES = [
  "planning",
  "coding",
  "heavyReasoning",
  "gameBuilder",
  "projectCoworker",
  "studyBuddy",
] as const;

export type ChatBindingRole = (typeof CHAT_BINDING_ROLES)[number];

export type ProviderBindingRole = "queen" | SubagentRole | ChatBindingRole;

export interface ProviderBinding {
  role: ProviderBindingRole;
  providerId: string;
  model?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
  degraded?: boolean;
}

export type ValidationStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export interface ValidationResult {
  id: string;
  taskId?: string;
  command: string;
  status: ValidationStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  output?: string;
}

export type ReviewSeverity = "critical" | "major" | "minor" | "note";

export interface ReviewFinding {
  severity: ReviewSeverity;
  summary: string;
  file?: string;
  line?: number;
  resolved?: boolean;
}

export interface ReviewResult {
  id: string;
  taskId?: string;
  status: "passed" | "changes_requested" | "failed";
  summary: string;
  findings: ReviewFinding[];
  completedAt: string;
}

export interface FileChangeRecord {
  path: string;
  operation: "created" | "modified" | "deleted" | "renamed";
  taskId?: string;
  previousPath?: string;
  recordedAt: string;
}

export interface CodingPlanRecord {
  summary: string;
  taskIds: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Verdict and failure types (Phase 7 / Phase 4)
// ---------------------------------------------------------------------------

export type HiveRunVerdict =
  | "ACCEPTED"
  | "REPAIRABLE"
  | "REJECTED"
  | "BLOCKED";

export type FailureClass =
  | "BUILD_FAILURE"
  | "TYPECHECK_FAILURE"
  | "TEST_FAILURE"
  | "SCOPE_VIOLATION"
  | "PROTECTED_PATH_VIOLATION"
  | "INTEGRATION_CONFLICT"
  | "MISSING_EVIDENCE"
  | "INVALID_PLAN"
  | "SECURITY_FINDING"
  | "ARCHITECTURE_REJECTION"
  | "PROVIDER_FAILURE"
  | "PROVIDER_TIMEOUT"
  | "INFRASTRUCTURE_BLOCKER"
  | "APPROVAL_DENIED"
  | "REPOSITORY_DRIFT"
  | "WORKTREE_MISSING"
  | "EVIDENCE_STALE"
  | "BUDGET_EXCEEDED"
  | "CANCELLED";

export type FailureAction =
  | "retry"
  | "route_provider_fallback"
  | "invoke_fixer"
  | "replan_affected_nodes"
  | "request_approval"
  | "reject_patch"
  | "mark_blocked"
  | "terminate_run";

export interface FailureRecord {
  failureClass: FailureClass;
  affectedNodeId?: string;
  attemptNumber: number;
  actionTaken: FailureAction;
  repairSucceeded?: boolean;
  description: string;
  remainingRisk?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Evidence status types (Phase 2)
// ---------------------------------------------------------------------------

export type EvidenceStatus =
  | "OBSERVED"
  | "EXECUTED"
  | "PASSED"
  | "FAILED"
  | "SKIPPED"
  | "UNAVAILABLE"
  | "AGENT_CLAIMED";

export interface EvidenceSummary {
  id: string;
  gateId?: string;
  category: string;
  status: EvidenceStatus;
  summary: string;
  valid: boolean;
  invalidationReason?: string;
}

// ---------------------------------------------------------------------------
// Integration record (Phase 5)
// ---------------------------------------------------------------------------

export interface IntegrationRecord {
  /** SHA of the integrated repository after patch application. */
  integratedSha: string;
  /** Files that were part of the integration. */
  integratedFiles: string[];
  /** Whether the integration had conflicts. */
  hadConflicts: boolean;
  /** Conflict details, if any. */
  conflicts?: string[];
  /** Timestamp of integration. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Session reconciliation (Phase 6)
// ---------------------------------------------------------------------------

export type NodeReconciliationState =
  | "reusable"
  | "stale"
  | "invalidated"
  | "missing"
  | "conflicted"
  | "completed";

export interface NodeReconciliation {
  nodeId: string;
  previousStatus: SubagentStatus;
  state: NodeReconciliationState;
  reason?: string;
}

export interface SessionReconciliation {
  baseCommitChanged: boolean;
  workingTreeChanged: boolean;
  reusableNodes: string[];
  staleNodes: string[];
  invalidatedNodes: string[];
  missingWorktrees: string[];
  externalConflicts: string[];
  requiredAction: string;
}

// ---------------------------------------------------------------------------
// Enhanced CodingFinalReport (Phase 8)
// ---------------------------------------------------------------------------

export interface CodingFinalReport {
  result: string;
  /** Final deterministic verdict. */
  verdict?: HiveRunVerdict;
  /** Reasons supporting the verdict. */
  verdictReasons?: string[];
  subagents: SubagentCounts;
  filesChanged: string[];
  validation: Array<{
    label: string;
    status: ValidationStatus;
  }>;
  review: string[];
  outstanding: string[];
  completedAt: string;
  /** Final integrated repository SHA. */
  finalSha?: string;
  /** Initial base SHA. */
  baseSha?: string;
  /** Failure history. */
  failures?: FailureRecord[];
  /** Evidence summary (not full ledger, for size). */
  evidenceSummary?: EvidenceSummary[];
  /** Integration history. */
  integrations?: IntegrationRecord[];
  /** Whether evidence is current. */
  evidenceCurrent?: boolean;
}

// ---------------------------------------------------------------------------
// Enhanced CodingSessionRecord
// ---------------------------------------------------------------------------

export interface CodingSessionRecord {
  schemaVersion: typeof CODING_SESSION_SCHEMA_VERSION;
  id: string;
  objective: string;
  mode: CodeMode;
  approvalPolicy: ApprovalPolicy;
  status: CodingSessionStatus;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  cancellationReason?: string;
  repository: RepositorySnapshot;
  plan?: CodingPlanRecord;
  tasks: SubagentTask[];
  events: RuntimeEvent[];
  providerBindings: ProviderBinding[];
  validationResults: ValidationResult[];
  reviewResults: ReviewResult[];
  files: FileChangeRecord[];
  finalReport?: CodingFinalReport;
  /** Final deterministic verdict. */
  verdict?: HiveRunVerdict;
  /** Failure history for the session. */
  failures?: FailureRecord[];
  /** Integration records. */
  integrations?: IntegrationRecord[];
  /** Session reconciliation result, if resumed. */
  reconciliation?: SessionReconciliation;
}

// ---------------------------------------------------------------------------
// Verdict-related events
// ---------------------------------------------------------------------------

export interface RuntimeEventPayloadMap {
  "session.created": {
    objective: string;
    mode: CodeMode;
    approvalPolicy: ApprovalPolicy;
  };
  "session.started": { repository: RepositorySnapshot };
  "session.paused": { reason: string };
  "session.resumed": {
    repository?: RepositorySnapshot;
    staleTaskIds?: string[];
  };
  "session.cancelled": { reason?: string };
  "session.completed": { report: CodingFinalReport };
  "plan.created": { summary: string; taskIds: string[] };
  "task.created": { task: SubagentTask };
  "task.ready": { taskId: string };
  "task.started": { taskId: string; attempt: number };
  "task.progress": { taskId: string; message: string; percent?: number };
  "task.blocked": { taskId: string; reason: string };
  "task.retrying": {
    taskId: string;
    attempt: number;
    delayMs: number;
    error: string;
  };
  "task.completed": { taskId: string; summary?: string };
  "task.failed": { taskId: string; error: string };
  "task.cancelled": { taskId: string; reason?: string };
  "task.skipped": { taskId: string; reason: string };
  "subagent.created": { subagentId: string; task: SubagentTask };
  "subagent.queued": { subagentId: string };
  "subagent.started": { subagentId: string; attempt: number };
  "subagent.progress": {
    subagentId: string;
    message: string;
    percent?: number;
  };
  "subagent.tool_call": {
    subagentId: string;
    tool: string;
    input?: JsonValue;
  };
  "subagent.file_changed": {
    subagentId: string;
    path: string;
    operation: FileChangeRecord["operation"];
  };
  "subagent.blocked": { subagentId: string; reason: string };
  "subagent.retrying": {
    subagentId: string;
    attempt: number;
    delayMs: number;
    error: string;
  };
  "subagent.validating": { subagentId: string; commands: string[] };
  "subagent.completed": { subagentId: string; summary?: string };
  "subagent.failed": { subagentId: string; error: string };
  "subagent.cancelled": { subagentId: string; reason?: string };
  "subagent.skipped": { subagentId: string; reason: string };
  "subagent.status_changed": {
    subagentId: string;
    previousStatus: SubagentStatus;
    status: SubagentStatus;
    task: SubagentTask;
    reason?: string;
  };
  "file.changed": { change: FileChangeRecord };
  "command.started": {
    commandId: string;
    taskId?: string;
    command: string;
    cwd: string;
  };
  "command.output": {
    commandId: string;
    stream: "stdout" | "stderr";
    chunk: string;
    truncated?: boolean;
  };
  "command.completed": {
    commandId: string;
    exitCode: number | null;
    signal?: string;
    durationMs: number;
  };
  "validation.started": {
    validationId: string;
    taskId?: string;
    command: string;
  };
  "validation.completed": { result: ValidationResult };
  "review.completed": { result: ReviewResult };
  "verdict.computed": { verdict: HiveRunVerdict; reasons: string[] };
  "failure.recorded": { failure: FailureRecord };
  "integration.completed": { record: IntegrationRecord };
  "evidence.invalidated": { evidenceId: string; reason: string };
  "session.reconciled": { reconciliation: SessionReconciliation };
}

export type RuntimeEventType = keyof RuntimeEventPayloadMap;

export type RuntimeEvent<
  TType extends RuntimeEventType = RuntimeEventType,
> = {
  [K in TType]: {
    schemaVersion: typeof CODING_SESSION_SCHEMA_VERSION;
    id: string;
    sequence: number;
    sessionId: string;
    timestamp: string;
    type: K;
    payload: RuntimeEventPayloadMap[K];
  };
}[TType];

export type RuntimeEventInput<
  TType extends RuntimeEventType = RuntimeEventType,
> = {
  [K in TType]: {
    id?: string;
    sessionId: string;
    timestamp?: string;
    type: K;
    payload: RuntimeEventPayloadMap[K];
  };
}[TType];

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface SubagentCounts {
  total: number;
  active: number;
  working: number;
  waiting: number;
  blocked: number;
  done: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

const legalTransitions = {
  created: ["queued", "cancelled"],
  queued: [
    "waiting_for_dependencies",
    "starting",
    "failed",
    "cancelled",
    "skipped",
  ],
  waiting_for_dependencies: ["starting", "failed", "cancelled", "skipped"],
  starting: ["working", "blocked", "retrying", "failed", "cancelled"],
  working: [
    "blocked",
    "retrying",
    "validating",
    "completed",
    "failed",
    "cancelled",
  ],
  blocked: ["working", "retrying", "failed", "cancelled", "skipped"],
  retrying: ["queued", "starting", "validating", "failed", "cancelled"],
  validating: ["completed", "blocked", "retrying", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
} satisfies Record<SubagentStatus, readonly SubagentStatus[]>;

const terminalStatuses = new Set<SubagentStatus>(TERMINAL_SUBAGENT_STATUSES);
const workingStatuses = new Set<SubagentStatus>([
  "starting",
  "working",
  "retrying",
  "validating",
]);
const waitingStatuses = new Set<SubagentStatus>([
  "created",
  "queued",
  "waiting_for_dependencies",
]);

export function makeBeeId(index: number, minimumWidth = 3): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("Bee ID index must be a non-negative integer");
  }
  if (!Number.isSafeInteger(minimumWidth) || minimumWidth < 1) {
    throw new RangeError("Bee ID width must be a positive integer");
  }
  return `bee-${String(index).padStart(minimumWidth, "0")}`;
}

export function createBeeIdFactory(startAt = 1): () => string {
  if (!Number.isSafeInteger(startAt) || startAt < 0) {
    throw new RangeError("Bee ID start must be a non-negative integer");
  }
  let next = startAt;
  return () => makeBeeId(next++);
}

export function isTerminalSubagentStatus(
  status: SubagentStatus,
): status is TerminalSubagentStatus {
  return terminalStatuses.has(status);
}

export function canTransitionSubagentStatus(
  from: SubagentStatus,
  to: SubagentStatus,
): boolean {
  const allowed: readonly SubagentStatus[] = legalTransitions[from];
  return allowed.includes(to);
}

export function assertSubagentTransition(
  from: SubagentStatus,
  to: SubagentStatus,
): void {
  if (!canTransitionSubagentStatus(from, to)) {
    throw new Error(`Illegal subagent transition: ${from} -> ${to}`);
  }
}

export function transitionSubagentTask(
  task: SubagentTask,
  status: SubagentStatus,
  timestamp: string,
  updates: Partial<Omit<SubagentTask, "id" | "sessionId" | "status">> = {},
): SubagentTask {
  assertSubagentTransition(task.status, status);
  const transitioned: SubagentTask = { ...task, ...updates, status };

  if (status === "queued" && transitioned.queuedAt === undefined) {
    transitioned.queuedAt = timestamp;
  }
  if (
    (status === "starting" || status === "working") &&
    transitioned.startedAt === undefined
  ) {
    transitioned.startedAt = timestamp;
  }
  if (isTerminalSubagentStatus(status)) {
    transitioned.completedAt = timestamp;
  }

  return transitioned;
}

export function aggregateSubagentCounts(
  tasks: readonly Pick<SubagentTask, "status">[],
): SubagentCounts {
  const counts: SubagentCounts = {
    total: tasks.length,
    active: 0,
    working: 0,
    waiting: 0,
    blocked: 0,
    done: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };

  for (const task of tasks) {
    if (workingStatuses.has(task.status)) {
      counts.working += 1;
      counts.active += 1;
    } else if (task.status === "blocked") {
      counts.blocked += 1;
      counts.active += 1;
    } else if (waitingStatuses.has(task.status)) {
      counts.waiting += 1;
    }

    if (isTerminalSubagentStatus(task.status)) {
      counts.done += 1;
      counts[task.status] += 1;
    }
  }

  return counts;
}
