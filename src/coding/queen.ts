import { randomBytes } from "node:crypto";
import type {
  AgentCompletionClient,
  AgentLoopEvent,
  AgentLoopOptions,
  AgentToolExecutor,
  AgentToolResult,
} from "./agent-loop.js";
import { StructuredAgentLoop } from "./agent-loop.js";
import { loadPluginAgent, loadTrustedPluginOutputStyle } from "../extensions/catalog.js";
import { renderPluginOutputStyle } from "../extensions/plugin-output-styles.js";
import { runPluginAgent } from "../extensions/plugin-agents.js";
import type { McpUserInput } from "../extensions/mcp-client-host.js";
import { redactStreamingText } from "../security/secrets.js";
import {
  createDefaultTaskContract,
  validateTaskContract,
  type HiveTaskContract,
} from "./contracts.js";
import {
  createEvidenceLedger,
  addEvidence,
  createCommandEvidence,
  createBuildEvidence,
  createTypecheckEvidence,
  createTestEvidence,
  createScopeEvidence,
  createReviewEvidence,
  createShaEvidence,
  type EvidenceLedger,
} from "./evidence.js";
import { RuntimeEventBus } from "./events.js";
import {
  buildPlannerPrompt,
  materializeBuilderTasks,
  parseCodingPlan,
  type CodingPlan,
} from "./planner.js";
import {
  findDirtyScopeConflicts,
  inspectCodingRepository,
  loadScopedRepositoryContext,
  repositoryStillMatches,
  toPersistedRepositorySnapshot,
  type RepositoryContext,
} from "./repository.js";
import { SubagentScheduler } from "./scheduler.js";
import { SessionPersistenceConflictError, type CodingSessionStore } from "./session-store.js";
import { assertValidTaskGraph, serializeBuilderConflicts } from "./task-graph.js";
import {
  CODING_SESSION_SCHEMA_VERSION,
  aggregateSubagentCounts,
  createBeeIdFactory,
  isTerminalSubagentStatus,
  transitionSubagentTask,
  type ApprovalPolicy,
  type CodeMode,
  type CodingFinalReport,
  type CodingSessionRecord,
  type FailureRecord,
  type FileChangeRecord,
  type HiveRunVerdict,
  type IntegrationRecord,
  type JsonValue,
  type ProviderBinding,
  type ProviderBindingRole,
  type ReviewFinding,
  type ReviewResult,
  type RuntimeEvent,
  type RuntimeEventType,
  type SubagentRole,
  type SubagentStatus,
  type SubagentTask,
  type ValidationResult,
} from "./types.js";
import {
  computeVerdict,
  classifyFailure,
  actionForFailure,
  type FailureClass,
} from "./verdicts.js";
import type { ProviderRegistryLike } from "./provider-router.js";
import type { ExtensionOptions } from "../extensions/index.js";
import { runHooks, type HookEvent } from "../extensions/index.js";
import type { ProviderImageInput } from "../providers/types.js";
import type { ToolPermissionRequest } from "./types.js";
import { withCodingSessionLease } from "./session-lease.js";

export interface QueenProviderOverride {
  providerId?: string;
  model?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
}

export interface QueenProviderGateway extends AgentCompletionClient {
  bindingForRole(
    role: ProviderBindingRole,
    override?: QueenProviderOverride,
    signal?: AbortSignal,
  ): Promise<ProviderBinding>;
}

export interface QueenToolFactoryOptions {
  repositoryRoot: string;
  sessionId: string;
  approvalPolicy: ApprovalPolicy;
  signal: AbortSignal;
  emit: <TType extends RuntimeEventType>(
    type: TType,
    payload: RuntimeEvent<TType>["payload"],
  ) => RuntimeEvent<TType>;
}

export interface QueenToolFactory {
  create(options: QueenToolFactoryOptions): AgentToolExecutor | Promise<AgentToolExecutor>;
}

export interface QueenWorktreeGateway {
  create(repositoryRoot: string, sessionId: string, baseCommit: string): Promise<string>;
  inspect?(repositoryRoot: string, sessionId: string, worktreePath: string): Promise<{ fingerprint: string }>;
}

export interface QueenDependencies {
  store: CodingSessionStore;
  provider: QueenProviderGateway;
  tools: QueenToolFactory;
  worktrees: QueenWorktreeGateway;
  clock?: () => string;
  retryDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface QueenSessionOptions {
  repositoryPath: string;
  objective?: string;
  sessionId?: string;
  resumeId?: string;
  /** Start a fresh turn in a completed coding session's managed worktree. */
  continuationId?: string;
  mode: CodeMode;
  approvalPolicy: ApprovalPolicy;
  maxAgents: number;
  maxRetries: number;
  maxTasks?: number;
  maxDepth?: number;
  providerOverride?: QueenProviderOverride;
  roleOverrides?: Partial<Record<ProviderBindingRole, QueenProviderOverride>>;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
  /** Live assistant prose. Not persisted as a runtime event. */
  onAssistantText?: (text: string) => void;
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  requestMcpInput?: McpUserInput;
  enabledMcpServers?: readonly string[];
  enabledLspServers?: readonly string[];
  pluginAgentId?: string | null;
  outputStyleId?: string | null;
  enabledSkillIds?: readonly string[];
  /** Captured explicit invocation sources, revalidated before each provider request. */
  invokedSkillSources?: ReadonlyArray<{ id: string; text: string }>;
  extensionOptions?: ExtensionOptions;
  /** Ephemeral image payloads; never copied into records, events, or prompts. */
  images?: readonly ProviderImageInput[];
  providerRegistries?: {
    project?: ProviderRegistryLike;
    global?: ProviderRegistryLike;
  };
}

const MAX_PERSISTED_EVENTS = 2_000;
const INTERNAL_PROVIDER = "hive-local";

export function createCodingSessionId(): string {
  return `hive-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === "string" && reason.trim() ? reason : "Coding session cancelled.",
  );
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

async function defaultRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function eventPayload<TType extends RuntimeEventType>(
  payload: RuntimeEvent<TType>["payload"],
): RuntimeEvent<TType>["payload"] {
  return payload;
}

function jsonValue(value: unknown): JsonValue | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function latestValidationResults(results: readonly ValidationResult[]): ValidationResult[] {
  const latest = new Map<string, ValidationResult>();
  for (const result of results) latest.set(result.command, result);
  return [...latest.values()];
}

function reviewFindings(data: Record<string, unknown> | undefined): ReviewFinding[] {
  if (!Array.isArray(data?.findings)) return [];
  const findings: ReviewFinding[] = [];
  for (const item of data.findings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (
      !["critical", "major", "minor", "note"].includes(String(candidate.severity)) ||
      typeof candidate.summary !== "string" ||
      !candidate.summary.trim()
    ) {
      continue;
    }
    findings.push({
      severity: candidate.severity as ReviewFinding["severity"],
      summary: candidate.summary.trim(),
      file: typeof candidate.file === "string" ? candidate.file : undefined,
      line: Number.isSafeInteger(candidate.line) ? Number(candidate.line) : undefined,
      resolved: candidate.resolved === true,
    });
  }
  return findings;
}

/** One buffered planner completion, published whole. Not a fabricated token stream. */
function plannerVisibleText(plan: CodingPlan): string {
  const parts = [plan.summary, plan.architecture, ...plan.risks]
    .map((part) => part.trim())
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
  const prose = redactStreamingText(parts.join("\n\n")).trim();
  return prose === "[REDACTED]" ? "" : prose;
}

export class QueenOrchestrator {
  readonly #options: QueenSessionOptions;
  readonly #dependencies: QueenDependencies;
  readonly #controller = new AbortController();
  readonly #clock: () => string;
  readonly #retryDelay: (delayMs: number, signal: AbortSignal) => Promise<void>;
  #record?: CodingSessionRecord;
  #eventBus?: RuntimeEventBus;
  #nextBeeId = createBeeIdFactory(1);
  #activeScheduler?: SubagentScheduler;
  #pauseRequested = false;
  #pauseReason = "Desktop pause requested.";
  #pauseAcknowledged = false;
  #contract?: HiveTaskContract;
  #evidenceLedger?: EvidenceLedger;
  #failures: FailureRecord[] = [];
  #integrations: IntegrationRecord[] = [];
  #continuationOwnedPaths = new Set<string>();
  #stopContinuations = 0;
  readonly #subagentHookContext = new Map<string, string>();
  readonly #toolExecutors = new Set<AgentToolExecutor>();

  public constructor(options: QueenSessionOptions, dependencies: QueenDependencies) {
    if (options.resumeId && options.continuationId) {
      throw new Error("resumeId and continuationId select different operations and cannot be combined.");
    }
    const selectedId = options.resumeId ?? options.continuationId;
    if (selectedId && options.sessionId && selectedId !== options.sessionId) {
      throw new Error("The coding session id must match the resumed or continued session.");
    }
    if (!Number.isInteger(options.maxAgents) || options.maxAgents < 1) {
      throw new Error("maxAgents must be a positive integer.");
    }
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new Error("maxRetries must be a non-negative integer.");
    }
    this.#options = { ...options, sessionId: selectedId ?? options.sessionId ?? createCodingSessionId() };
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#retryDelay = dependencies.retryDelay ?? defaultRetryDelay;
    if (options.signal) {
      if (options.signal.aborted) this.#controller.abort(options.signal.reason);
      else options.signal.addEventListener(
        "abort",
        () => this.cancel(options.signal?.reason),
        { once: true },
      );
    }
  }

  public get record(): CodingSessionRecord | undefined {
    return this.#record;
  }

  public get eventBus(): RuntimeEventBus | undefined {
    return this.#eventBus;
  }

  public cancel(reason: unknown = "User requested cancellation."): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.#activeScheduler?.cancel(typeof reason === "string" ? reason : "Session cancelled");
  }

  public requestPause(reason = "Desktop pause requested."): boolean {
    const status = this.#record?.status;
    if (this.#controller.signal.aborted || status === "completed" || status === "failed" || status === "cancelled") {
      return false;
    }
    if (!this.#pauseRequested) this.#pauseReason = reason.trim() || "Desktop pause requested.";
    this.#pauseRequested = true;
    this.#activeScheduler?.requestPause(this.#pauseReason);
    return true;
  }

  public async run(): Promise<CodingSessionRecord> {
    const sessionId = this.#options.sessionId;
    if (!sessionId) throw new Error("A coding session id is required.");
    return withCodingSessionLease(this.#options.repositoryPath, sessionId, async () => {
      if (!this.#options.resumeId && !this.#options.continuationId && await this.#dependencies.store.load(sessionId)) {
        throw new Error(`Coding session ${sessionId} already exists; resume or continue it instead of overwriting it.`);
      }
      return this.#runWithLease();
    }, this.#controller.signal);
  }

  async #runWithLease(): Promise<CodingSessionRecord> {
    let persistenceFailure: SessionPersistenceConflictError | AggregateError | undefined;
    try {
      if (this.#options.resumeId) return await this.#resume();
      if (this.#options.continuationId) return await this.#continue();
      return await this.#start();
    } catch (error) {
      if (error instanceof SessionPersistenceConflictError) {
        persistenceFailure = error;
        throw error;
      }
      if (!this.#record || !this.#eventBus) throw error;
      try {
        if (this.#controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return await this.#finishCancelled(error);
        }
        return await this.#finishFailed(error);
      } catch (reportError) {
        if (reportError instanceof SessionPersistenceConflictError) {
          persistenceFailure = new AggregateError([error, reportError], "Coding session stopped and its terminal report conflicted with another writer.");
          throw persistenceFailure;
        }
        throw reportError;
      }
    } finally {
      const executors = [...this.#toolExecutors];
      this.#toolExecutors.clear();
      const closed = await Promise.allSettled(executors.map((tools) => Promise.resolve().then(() => tools.close?.())));
      const failures = closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) {
        const reason = `Tool cleanup failed: ${failures.map((failure) => redactStreamingText(failure instanceof Error ? failure.message : String(failure))).join("; ")}`;
        if (persistenceFailure) throw new AggregateError([persistenceFailure, new Error(reason)], "Coding session persistence and tool cleanup failed.");
        if (this.#record && this.#eventBus) {
          this.#recordFailure("INFRASTRUCTURE_BLOCKER", undefined, 0, reason);
          if (this.#record.status !== "cancelled") this.#record.status = "failed";
          this.#record.verdict = "BLOCKED";
          if (this.#record.finalReport) {
            this.#record.finalReport.verdict = "BLOCKED";
            this.#record.finalReport.verdictReasons = [reason];
            this.#record.finalReport.result = "Coding session finished with a tool cleanup failure.";
            this.#record.finalReport.outstanding = unique([...this.#record.finalReport.outstanding, reason]);
            this.#record.finalReport.failures = [...this.#failures];
          }
          await this.#persist(true, false);
        }
        throw new Error(reason);
      }
    }
  }

  async #start(): Promise<CodingSessionRecord> {
    if (!this.#options.objective?.trim()) throw new Error("A coding objective is required.");
    const context = await inspectCodingRepository(
      this.#options.repositoryPath,
      this.#options.objective,
      this.#controller.signal,
    );
    const now = this.#clock();
    this.#record = {
      schemaVersion: CODING_SESSION_SCHEMA_VERSION,
      id: this.#options.sessionId ?? createCodingSessionId(),
      objective: this.#options.objective.trim(),
      ...(this.#options.pluginAgentId ? { pluginAgentId: this.#options.pluginAgentId } : {}),
      ...(this.#options.outputStyleId ? { outputStyleId: this.#options.outputStyleId } : {}),
      mode: this.#options.mode,
      approvalPolicy: this.#options.approvalPolicy,
      status: "created",
      createdAt: now,
      updatedAt: now,
      repository: toPersistedRepositorySnapshot(context.snapshot),
      tasks: [],
      events: [],
      providerBindings: [],
      turnStartSequence: 1,
      validationResults: [],
      reviewResults: [],
      files: [],
      failures: [],
      integrations: [],
    };
    // Initialize evidence ledger
    this.#evidenceLedger = createEvidenceLedger(this.#record.id);
    this.#failures = [];
    this.#integrations = [];
    this.#attachEventBus();
    this.#emit("session.created", {
      objective: this.#record.objective,
      mode: this.#record.mode,
      approvalPolicy: this.#record.approvalPolicy,
    });
    this.#emit("session.started", { repository: this.#record.repository });
    // Record initial SHA evidence
    addEvidence(this.#evidenceLedger, createShaEvidence({
      sourceRole: "queen",
      sha: context.snapshot.baseCommit,
      branch: context.snapshot.branch,
    }));
    await this.#persist(true);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
    return this.#executeFresh(context);
  }

  async #resume(): Promise<CodingSessionRecord> {
    const sessionId = this.#options.resumeId as string;
    const loaded = await this.#dependencies.store.load(sessionId);
    if (!loaded) throw new Error(`Coding session ${sessionId} not found.`);
    if (loaded.archived) throw new Error(`Coding session ${sessionId} is archived.`);
    await this.#verifySavedWorktree(loaded);
    this.#continuationOwnedPaths = new Set(
      (loaded.turnHistory ?? []).flatMap((turn) => turn.files.map((file) => file.path)),
    );
    this.#record = loaded;
    this.#nextBeeId = createBeeIdFactory(this.#nextBeeNumber(loaded.tasks));
    // Initialize evidence ledger for resumed session
    this.#evidenceLedger = createEvidenceLedger(sessionId);
    this.#failures = loaded.failures ?? [];
    this.#integrations = loaded.integrations ?? [];
    this.#attachEventBus();
    if (loaded.status === "completed" || loaded.status === "cancelled") return loaded;

    const originalContext = await inspectCodingRepository(
      loaded.repository.root,
      loaded.objective,
      this.#controller.signal,
    );
    const savedSnapshot = {
      root: loaded.repository.root,
      capturedAt: loaded.repository.capturedAt,
      baseCommit: loaded.repository.baseCommit ?? "",
      branch: loaded.repository.branch ?? "detached",
      dirty: loaded.repository.dirty,
      dirtyFiles: loaded.repository.changedFiles,
      statusFingerprint: loaded.repository.fingerprint ?? "",
    };
    const comparison = await repositoryStillMatches(savedSnapshot, this.#controller.signal);
    const context = loaded.repository.worktreePath && this.#dependencies.worktrees.inspect
      ? await inspectCodingRepository(loaded.repository.worktreePath, loaded.objective, this.#controller.signal)
      : originalContext;
    this.#record.approvalPolicy = this.#options.approvalPolicy;
    this.#record.mode = this.#options.mode;
    if (!comparison.matches && this.#record.approvalPolicy !== "always") {
      this.#record.status = "paused";
      this.#emit("session.paused", {
        reason: "Repository state changed materially. Resume with --approval always to replan against the new state.",
      });
      await this.#persist(true);
      return this.#record;
    }

    if (!comparison.matches) {
      const staleTaskIds: string[] = [];
      for (const task of [...this.#record.tasks]) {
        if (isTerminalSubagentStatus(task.status)) continue;
        staleTaskIds.push(task.id);
        this.#forceTerminalTask(task.id, "skipped", "Repository state changed; task assumptions are stale.");
      }
      this.#record.repository = {
        ...toPersistedRepositorySnapshot(originalContext.snapshot),
        worktreePath: loaded.repository.worktreePath,
        worktreeFingerprint: loaded.repository.worktreeFingerprint,
        worktreeBaseCommit: loaded.repository.worktreeBaseCommit,
      };
      this.#record.plan = undefined;
      this.#emit("session.resumed", { repository: this.#record.repository, staleTaskIds });
      await this.#persist(true);
      return this.#executeFresh(context);
    }

    this.#emit("session.resumed", { repository: this.#record.repository, staleTaskIds: [] });
    const plannedTaskIds = new Set(this.#record.plan?.taskIds ?? []);
    const plannedBuilders = this.#record.tasks.filter(
      (task) => task.role === "builder" && (plannedTaskIds.size === 0 || plannedTaskIds.has(task.id)),
    );
    const pendingBuilders = plannedBuilders.filter((task) => !isTerminalSubagentStatus(task.status));
    for (const task of pendingBuilders) {
      if (task.status === "blocked") {
        this.#transitionTask(task.id, "retrying", "Approval policy updated.");
        this.#transitionTask(task.id, "queued");
      }
    }
    await this.#persist(true);
    if (pendingBuilders.length > 0) return this.#executeBuildersAndFinish(context, undefined);
    const repairFrontier = [
      ...plannedBuilders,
      ...this.#record.tasks.filter((task) => task.role === "fixer"),
    ];
    if (this.#record.plan && plannedBuilders.length > 0) {
      const targetRoot = this.#record.repository.worktreePath ?? context.snapshot.root;
      const repairAttempt = repairFrontier.filter((task) => task.role === "fixer").length;
      return this.#runValidationReviewAndFinish(context, targetRoot, undefined, repairFrontier, repairAttempt);
    }
    return this.#executeFresh(context);
  }

  async #continue(): Promise<CodingSessionRecord> {
    const sessionId = this.#options.continuationId as string;
    if (!this.#options.objective?.trim()) throw new Error("A coding objective is required for a follow-up turn.");
    const loaded = await this.#dependencies.store.load(sessionId);
    if (!loaded) throw new Error(`Coding session ${sessionId} not found.`);
    if (loaded.archived) throw new Error(`Coding session ${sessionId} is archived.`);
    if (!["completed", "failed", "cancelled"].includes(loaded.status)) {
      throw new Error(`Coding session ${sessionId} is ${loaded.status}; resume it before starting a follow-up turn.`);
    }
    await this.#verifySavedWorktree(loaded, true);
    const originalContext = await inspectCodingRepository(
      this.#options.repositoryPath,
      this.#options.objective,
      this.#controller.signal,
    );
    const context = loaded.repository.worktreePath
      ? await inspectCodingRepository(loaded.repository.worktreePath, this.#options.objective, this.#controller.signal)
      : originalContext;
    const { turnHistory: savedHistory = [], ...currentTurn } = loaded;
    let previousEndSequence = 0;
    const turnHistory = savedHistory.map((turn) => {
      const turnStartSequence = turn.turnStartSequence ?? previousEndSequence + 1;
      previousEndSequence = Math.max(previousEndSequence, turn.events.at(-1)?.sequence ?? 0);
      return { ...turn, turnStartSequence, events: turn.events.filter((event) => event.sequence >= turnStartSequence) };
    });
    const previousTurnStart = loaded.turnStartSequence ?? previousEndSequence + 1;
    const previousTurn = {
      ...currentTurn,
      turnStartSequence: previousTurnStart,
      events: loaded.events.filter((event) => event.sequence >= previousTurnStart),
    };
    this.#continuationOwnedPaths = new Set(
      [...turnHistory, previousTurn].flatMap((turn) => turn.files.map((file) => file.path)),
    );
    this.#nextBeeId = createBeeIdFactory(this.#nextBeeNumber(
      [...turnHistory, previousTurn].flatMap((turn) => turn.tasks),
    ));
    this.#record = {
      schemaVersion: CODING_SESSION_SCHEMA_VERSION,
      id: loaded.id,
      forkedFrom: loaded.forkedFrom,
      pluginAgentId: this.#options.pluginAgentId === null ? undefined : this.#options.pluginAgentId ?? loaded.pluginAgentId,
      outputStyleId: this.#options.outputStyleId === null ? undefined : this.#options.outputStyleId ?? loaded.outputStyleId,
      objective: this.#options.objective.trim(),
      mode: this.#options.mode,
      approvalPolicy: this.#options.approvalPolicy,
      status: "created",
      createdAt: loaded.createdAt,
      updatedAt: this.#clock(),
      repository: {
        ...toPersistedRepositorySnapshot(originalContext.snapshot),
        worktreePath: loaded.repository.worktreePath,
        worktreeFingerprint: loaded.repository.worktreeFingerprint,
        worktreeBaseCommit: loaded.repository.worktreePath ? context.snapshot.baseCommit : undefined,
      },
      turnHistory: [...turnHistory, previousTurn],
      turnStartSequence: (loaded.events.at(-1)?.sequence ?? previousEndSequence) + 1,
      tasks: [],
      events: [...loaded.events],
      providerBindings: [...loaded.providerBindings],
      validationResults: [],
      reviewResults: [],
      files: [...loaded.files],
      failures: [],
      integrations: [],
    };
    this.#evidenceLedger = createEvidenceLedger(sessionId);
    this.#attachEventBus();
    this.#emit("session.created", {
      objective: this.#record.objective,
      mode: this.#record.mode,
      approvalPolicy: this.#record.approvalPolicy,
    });
    this.#emit("session.started", { repository: this.#record.repository });
    addEvidence(this.#evidenceLedger, createShaEvidence({
      sourceRole: "queen",
      sha: context.snapshot.baseCommit,
      branch: context.snapshot.branch,
    }));
    await this.#persist(true);
    return this.#executeFresh(context);
  }

  async #verifySavedWorktree(record: CodingSessionRecord, continuation = false): Promise<void> {
    if (!record.repository.worktreePath) return;
    const inspect = this.#dependencies.worktrees.inspect;
    if (!inspect) {
      if (continuation) throw new Error("Follow-up turns require a managed worktree inspector.");
      return;
    }
    const current = await inspect(record.repository.root, record.id, record.repository.worktreePath);
    if (continuation && !record.repository.worktreeFingerprint) {
      throw new Error("The previous turn has no saved worktree content fingerprint; cannot continue safely.");
    }
    if (record.repository.worktreeFingerprint && current.fingerprint !== record.repository.worktreeFingerprint) {
      throw new Error("Managed worktree changed outside the coding session; inspect those changes before continuing.");
    }
  }

  async #executeFresh(context: RepositoryContext, continuationFeedback?: string): Promise<CodingSessionRecord> {
    assertNotAborted(this.#controller.signal);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
    this.#recordOrThrow().status = "planning";
    const scout = this.#recordOrThrow().tasks.find(
      (task) => task.role === "scout" && task.status === "completed",
    ) ?? await this.#runScout(context);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();

    if (this.#recordOrThrow().mode === "review") {
      this.#recordOrThrow().status = "running";
      return this.#runValidationReviewAndFinish(context, context.snapshot.root, undefined, []);
    }

    const plan = await this.#runPlanner(context, scout.id, continuationFeedback);
    const builderBinding = await this.#resolveBinding("builder");
    let builderTasks = materializeBuilderTasks({
      sessionId: this.#recordOrThrow().id,
      plan,
      providerForRole: () => ({ providerId: builderBinding.providerId, model: builderBinding.model }),
      maxAttempts: this.#options.maxRetries + 1,
      firstBeeNumber: this.#nextBeeNumber(this.#recordOrThrow().tasks),
      now: this.#clock,
    });
    builderTasks = serializeBuilderConflicts(builderTasks, {
      maxTasks: this.#options.maxTasks ?? 24,
      maxDepth: this.#options.maxDepth ?? 2,
    }).tasks;
    if (continuationFeedback && this.#recordOrThrow().tasks.length + builderTasks.length > (this.#options.maxTasks ?? 24)) throw new Error("Stop hook replanning would exceed the session task budget.");
    assertValidTaskGraph(builderTasks, {
      maxTasks: this.#options.maxTasks ?? 24,
      maxDepth: this.#options.maxDepth ?? 2,
      conflictPolicy: "serialize",
    });
    for (const task of builderTasks) this.#registerTask(task);
    this.#nextBeeId = createBeeIdFactory(this.#nextBeeNumber(this.#recordOrThrow().tasks));
    this.#recordOrThrow().plan = {
      summary: plan.summary,
      taskIds: builderTasks.map((task) => task.id),
      createdAt: this.#clock(),
    };
    // Create task contract from plan
    const allValidationCommands = unique([
      ...(plan.validationCommands ?? []),
      ...builderTasks.flatMap((task) => task.validationCommands),
      ...this.#defaultValidationCommands(context),
    ]);
    this.#contract = createDefaultTaskContract({
      objective: this.#recordOrThrow().objective,
      repositoryRoot: context.snapshot.root,
      baseCommit: context.snapshot.baseCommit,
      allowedPaths: unique([...this.#continuationOwnedPaths, ...builderTasks.flatMap((task) => task.fileScope)]),
      riskLevel: plan.risks.length > 2 ? "high" : plan.risks.length > 0 ? "medium" : "low",
      budget: {
        maxRepairAttempts: this.#options.maxRetries,
      },
      validationCommands: allValidationCommands,
    });
    const contractValidation = validateTaskContract(this.#contract);
    if (!contractValidation.valid) {
      throw new Error(`Invalid task contract: ${contractValidation.issues.map((i) => i.message).join("; ")}`);
    }
    this.#emit("plan.created", { summary: plan.summary, taskIds: builderTasks.map((task) => task.id) });
    await this.#persist(true);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();

    if (this.#recordOrThrow().mode === "plan") {
      for (const task of builderTasks) {
        this.#transitionTask(task.id, "queued");
        this.#transitionTask(task.id, "skipped", "Plan mode does not edit files.");
      }
      return this.#finish("Plan created; no files were edited.", ["Run the session in auto mode to implement the plan."]);
    }

    const scopes = builderTasks.flatMap((task) => task.fileScope);
    const conflicts = findDirtyScopeConflicts(
      context.snapshot.dirtyFiles.filter((file) => !this.#continuationOwnedPaths.has(file)),
      scopes,
    );
    if (conflicts.length > 0) {
      this.#recordOrThrow().status = "paused";
      for (const task of builderTasks) {
        this.#transitionTask(task.id, "queued");
        this.#transitionTask(task.id, "starting");
        this.#transitionTask(task.id, "blocked", "File scope overlaps pre-existing user changes.");
      }
      this.#emit("session.paused", {
        reason: `Builder scopes overlap pre-existing changes: ${conflicts.join(", ")}`,
      });
      await this.#persist(true);
      return this.#recordOrThrow();
    }

    if (this.#recordOrThrow().approvalPolicy === "safe") {
      this.#recordOrThrow().status = "paused";
      for (const task of builderTasks) {
        this.#transitionTask(task.id, "queued");
        this.#transitionTask(task.id, "starting");
        this.#transitionTask(task.id, "blocked", "Repository changes require approval.");
      }
      this.#emit("session.paused", {
        reason: "Repository changes require approval. Resume with --approval changes or always.",
      });
      await this.#persist(true);
      return this.#recordOrThrow();
    }

    return this.#executeBuildersAndFinish(context, plan);
  }

  async #executeBuildersAndFinish(
    context: RepositoryContext,
    plan?: CodingPlan,
  ): Promise<CodingSessionRecord> {
    const record = this.#recordOrThrow();
    if (await this.#pauseAtBoundary()) return record;
    record.status = "running";
    const worktreePath = record.repository.worktreePath ?? await this.#dependencies.worktrees.create(
      context.snapshot.root,
      record.id,
      context.snapshot.baseCommit,
    );
    record.repository.worktreePath = worktreePath;
    record.repository.worktreeBaseCommit = context.snapshot.baseCommit;

    const builders = record.tasks.filter(
      (task) => task.role === "builder" && !isTerminalSubagentStatus(task.status),
    );
    if (builders.length > 0) {
      const dependencyClosedBuilders = [...new Map(
        builders.flatMap((task) => this.#phaseGraph(task)).map((task) => [task.id, task]),
      ).values()];
      const result = await this.#runScheduledTasks(dependencyClosedBuilders, worktreePath, context);
      this.#mergeTasks(result);
    }
    await this.#persist(true);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();

    const failedBuilders = record.tasks.filter(
      (task) => task.role === "builder" && task.status !== "completed",
    );
    if (failedBuilders.length > 0) {
      return this.#finish(
        "Builder execution did not complete successfully.",
        failedBuilders.map((task) => `${task.id}: ${task.error ?? task.status}`),
        false,
      );
    }
    const completedBuilders = this.#recordOrThrow().tasks.filter(
      (task) => task.role === "builder" && task.status === "completed",
    );
    return this.#runValidationReviewAndFinish(context, worktreePath, plan, completedBuilders);
  }

  async #runValidationReviewAndFinish(
    context: RepositoryContext,
    targetRoot: string,
    plan: CodingPlan | undefined,
    builders: readonly SubagentTask[],
    repairAttempt = 0,
  ): Promise<CodingSessionRecord> {
    assertNotAborted(this.#controller.signal);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();

    // --- Scope verification (Phase 5) ---
    const changedFiles = this.#recordOrThrow().files.map((f) => f.path);
    const allowedPaths = this.#contract?.allowedPaths ?? [];
    const forbiddenPaths = this.#contract?.forbiddenPaths ?? [".git", ".hivemind", "node_modules", ".env"];
    const scopeViolations = changedFiles.filter((file) => {
      const isInForbidden = forbiddenPaths.some((fp) => file.startsWith(fp));
      if (isInForbidden) return true;
      // If no contract or no allowed paths, allow all non-forbidden files
      if (!this.#contract || allowedPaths.length === 0) return false;
      return !allowedPaths.some((ap) => file.startsWith(ap) || ap.startsWith(file));
    });
    if (this.#evidenceLedger) {
      const scopeEvidence = addEvidence(this.#evidenceLedger, createScopeEvidence({
        sourceRole: "queen",
        changedFiles,
        allowedPaths,
        violations: scopeViolations,
        repositorySha: context.snapshot.baseCommit,
      }));
      if (this.#contract && scopeViolations.length > 0) {
        this.#recordFailure("SCOPE_VIOLATION", undefined, repairAttempt,
          `Files outside allowed scope: ${scopeViolations.join(", ")}`);
      }
      this.#emit("evidence.invalidated", {
        evidenceId: scopeEvidence.id,
        reason: scopeViolations.length > 0 ? "scope_violation" : "scope_verified",
      });
    }

    // --- Reject if scope violations in auto mode ---
    if (scopeViolations.length > 0 && this.#recordOrThrow().mode === "auto") {
      return this.#finish(
        "Scope violation: files outside allowed scope were modified.",
        scopeViolations.map((f) => `Scope violation: ${f}`),
        false,
      );
    }

    const commands = unique([
      ...(plan?.validationCommands ?? []),
      ...this.#recordOrThrow().tasks.filter((task) => task.role === "validator").flatMap((task) => task.validationCommands),
      ...builders.flatMap((task) => task.validationCommands),
      ...this.#defaultValidationCommands(context),
    ]);
    const validationDependencyIds = builders.map((task) => task.id).sort();
    let validator = [...this.#recordOrThrow().tasks].reverse().find(
      (task) => task.role === "validator" &&
        task.dependencies.length === validationDependencyIds.length &&
        [...task.dependencies].sort().every((dependencyId, index) => dependencyId === validationDependencyIds[index]),
    );
    if (!validator) {
      const validatorBinding = await this.#resolveBinding("validator");
      validator = this.#newTask({
        role: "validator",
        title: repairAttempt === 0 ? "Validate implementation" : `Revalidate repair ${repairAttempt}`,
        objective: `Run approved checks and verify acceptance criteria for validation pass ${repairAttempt + 1}.`,
        provider: validatorBinding,
        dependencies: builders.map((task) => task.id),
        fileScope: [],
        expectedOutput: "Structured validation results and an acceptance-criteria verdict.",
        completionCriteria: ["Every selected command has a recorded result", "Acceptance criteria are evaluated"],
        validationCommands: commands,
        depth: 1,
      });
      this.#registerTask(validator);
    }
    if (!isTerminalSubagentStatus(validator.status)) {
      this.#mergeTasks(await this.#runScheduledTasks(
        this.#phaseGraph(validator),
        targetRoot,
        context,
      ));
      await this.#persist(true);
      if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
      validator = this.#task(validator.id);
    }

    // --- Record validation evidence ---
    const latestValidations = latestValidationResults(this.#recordOrThrow().validationResults);
    if (this.#evidenceLedger) {
      for (const validation of latestValidations) {
        const isBuild = /build/i.test(validation.command);
        const isTypecheck = /(?:typecheck|tsc|type-check)/i.test(validation.command);
        const isTest = /test/i.test(validation.command);

        if (isBuild) {
          addEvidence(this.#evidenceLedger, createBuildEvidence({
            sourceRole: "validator",
            taskId: validator.id,
            exitCode: validation.exitCode ?? (validation.status === "passed" ? 0 : 1),
            repositorySha: context.snapshot.baseCommit,
            worktreePath: targetRoot,
          }));
        } else if (isTypecheck) {
          addEvidence(this.#evidenceLedger, createTypecheckEvidence({
            sourceRole: "validator",
            taskId: validator.id,
            exitCode: validation.exitCode ?? (validation.status === "passed" ? 0 : 1),
            repositorySha: context.snapshot.baseCommit,
            worktreePath: targetRoot,
          }));
        } else if (isTest) {
          addEvidence(this.#evidenceLedger, createTestEvidence({
            sourceRole: "validator",
            taskId: validator.id,
            exitCode: validation.exitCode ?? (validation.status === "passed" ? 0 : 1),
            repositorySha: context.snapshot.baseCommit,
            worktreePath: targetRoot,
          }));
        } else {
          addEvidence(this.#evidenceLedger, createCommandEvidence({
            sourceRole: "validator",
            taskId: validator.id,
            command: validation.command,
            exitCode: validation.exitCode ?? (validation.status === "passed" ? 0 : 1),
            repositorySha: context.snapshot.baseCommit,
            worktreePath: targetRoot,
          }));
        }
      }
    }

    const failedValidations = latestValidations.filter((result) => result.status !== "passed");
    if (
      failedValidations.length > 0 &&
      this.#recordOrThrow().mode === "auto" &&
      repairAttempt < this.#options.maxRetries
    ) {
      const fixer = await this.#createFixer(
        `Repair these failed validation checks:\n${failedValidations
          .map((result) => `${result.command}: ${result.output ?? result.status}`)
          .join("\n")}`,
        validator.id,
        builders,
        repairAttempt + 1,
      );
      this.#mergeTasks(await this.#runScheduledTasks(
        this.#phaseGraph(fixer),
        targetRoot,
        context,
      ));
      await this.#persist(true);
      if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
      const repaired = this.#recordOrThrow().tasks.find((task) => task.id === fixer.id);
      if (repaired?.status === "completed") {
        return this.#runValidationReviewAndFinish(
          context,
          targetRoot,
          plan,
          [...builders, fixer],
          repairAttempt + 1,
        );
      }
    }

    // --- Independent review (Phase 3: Builder cannot self-approve) ---
    let reviewer = [...this.#recordOrThrow().tasks].reverse().find(
      (task) => task.role === "reviewer" && task.dependencies.includes(validator.id),
    );
    if (!reviewer) {
      const reviewerBinding = await this.#resolveBinding("reviewer");
      // Enforce independent provider for high-risk tasks
      if (this.#contract?.approvalPolicy.requireIndependentProvider) {
        const builderBinding = builders[0]?.providerId;
        if (reviewerBinding.providerId === builderBinding) {
          // Log that provider fallback was used
          this.#recordFailure("ARCHITECTURE_REJECTION", undefined, repairAttempt,
            "Reviewer must use a different provider than Builder for high-risk tasks");
        }
      }
      reviewer = this.#newTask({
        role: "reviewer",
        title: "Review resulting diff",
        objective: `Review the complete diff after repair pass ${repairAttempt} for correctness, maintainability, security, and architectural consistency. Evaluate the integrated repository state, not Builder summaries.`,
        provider: reviewerBinding,
        dependencies: [validator.id],
        fileScope: [],
        expectedOutput: "Severity-ranked review findings with file locations where applicable.",
        completionCriteria: ["Critical and major risks are explicitly identified", "The review has a clear verdict"],
        validationCommands: [],
        depth: 1,
      });
      this.#registerTask(reviewer);
    }
    if (!isTerminalSubagentStatus(reviewer.status)) {
      this.#mergeTasks(await this.#runScheduledTasks(
        this.#phaseGraph(reviewer),
        targetRoot,
        context,
      ));
      await this.#persist(true);
      if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
      reviewer = this.#task(reviewer.id);
    }

    // --- Record review evidence ---
    const latestReview = this.#recordOrThrow().reviewResults.at(-1);
      if (this.#evidenceLedger && latestReview) {
        addEvidence(this.#evidenceLedger, createReviewEvidence({
          sourceRole: "reviewer",
          taskId: reviewer.id,
          approved: latestReview.status === "passed",
          findings: latestReview.findings.map((f) => ({ severity: f.severity, summary: f.summary })),
          repositorySha: context.snapshot.baseCommit,
        }));
      }

    if (
      latestReview?.status === "changes_requested" &&
      this.#recordOrThrow().mode === "auto" &&
      repairAttempt < this.#options.maxRetries
    ) {
      const unresolved = latestReview.findings.filter((finding) => !finding.resolved);
      const fixer = await this.#createFixer(
        `Repair these reviewer findings:\n${unresolved
          .map((finding) => `${finding.severity}: ${finding.summary}${finding.file ? ` (${finding.file})` : ""}`)
          .join("\n")}`,
        reviewer.id,
        builders,
        repairAttempt + 1,
      );
      this.#mergeTasks(await this.#runScheduledTasks(
        this.#phaseGraph(fixer),
        targetRoot,
        context,
      ));
      await this.#persist(true);
      if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
      const repaired = this.#recordOrThrow().tasks.find((task) => task.id === fixer.id);
      if (repaired?.status === "completed") {
        return this.#runValidationReviewAndFinish(
          context,
          targetRoot,
          plan,
          [...builders, fixer],
          repairAttempt + 1,
        );
      }
    }

    // --- Record final SHA ---
    if (this.#evidenceLedger) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: targetRoot,
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        const finalSha = String(result.stdout).trim();
        addEvidence(this.#evidenceLedger, createShaEvidence({
          sourceRole: "queen",
          sha: finalSha,
          branch: context.snapshot.branch,
        }));
        // Record integration
        const integration: IntegrationRecord = {
          integratedSha: finalSha,
          integratedFiles: changedFiles,
          hadConflicts: false,
          timestamp: this.#clock(),
        };
        this.#integrations.push(integration);
        this.#emit("integration.completed", { record: integration });
      } catch {
        // SHA capture failure is non-fatal
      }
    }

    // --- Compute verdict (Phase 7) ---
    const currentValidation = latestValidationResults(this.#recordOrThrow().validationResults);
    const validationPassed = currentValidation.every((result) => result.status === "passed");
    const reviewPassed = !latestReview || latestReview.status === "passed";
    const outstanding = [
      ...currentValidation
        .filter((result) => result.status !== "passed")
        .map((result) => `${result.command}: ${result.status}`),
      ...(latestReview?.findings ?? [])
        .filter((finding) => !finding.resolved && (finding.severity === "critical" || finding.severity === "major"))
        .map((finding) => `${finding.severity}: ${finding.summary}`),
    ];

    // --- Record integrated validation evidence ---
    if (this.#evidenceLedger) {
      addEvidence(this.#evidenceLedger, createCommandEvidence({
        sourceRole: "queen",
        command: "integrated-validation",
        gateId: "gate-integrated-validation",
        exitCode: validationPassed ? 0 : 1,
        repositorySha: context.snapshot.baseCommit,
      }));
    }

    // Compute deterministic verdict
    let verdict: HiveRunVerdict;
    if (this.#contract && this.#evidenceLedger) {
      const verdictResult = computeVerdict(
        this.#contract,
        this.#evidenceLedger,
        {
          repairAttemptsUsed: repairAttempt,
          reviewerApproved: reviewPassed,
          hasCriticalSafetyViolation: scopeViolations.length > 0,
        },
      );
      verdict = verdictResult.verdict;
      this.#recordOrThrow().verdict = verdict;
      this.#emit("verdict.computed", { verdict, reasons: verdictResult.reasons });
    } else {
      // Fallback for sessions without contract/evidence (e.g. resumed legacy sessions)
      verdict = validationPassed && reviewPassed ? "ACCEPTED" : outstanding.length > 0 ? "REPAIRABLE" : "REJECTED";
    }

    return this.#finish(
      validationPassed && reviewPassed
        ? "Implementation, validation, and review completed successfully."
        : "Implementation completed with unresolved validation or review findings.",
      outstanding,
      verdict === "ACCEPTED",
      verdict,
    );
  }

  async #createFixer(
    objective: string,
    dependencyId: string,
    builders: readonly SubagentTask[],
    attempt: number,
  ): Promise<SubagentTask> {
    const binding = await this.#resolveBinding("fixer");
    const scopes = unique([
      ...this.#recordOrThrow().files.map((file) => file.path),
      ...builders.flatMap((task) => task.fileScope),
    ]);
    if (scopes.length === 0) {
      throw new Error("Cannot create a Fixer task without a bounded file scope.");
    }
    const fixer = this.#newTask({
      role: "fixer",
      title: `Repair failed criteria ${attempt}`,
      objective,
      provider: binding,
      parentTaskId: dependencyId,
      dependencies: [dependencyId],
      fileScope: scopes,
      expectedOutput: "A targeted repair addressing only the supplied failures.",
      completionCriteria: ["The supplied failure is repaired", "Affected checks are ready to rerun"],
      validationCommands: [],
      depth: 2,
    });
    this.#registerTask(fixer);
    return fixer;
  }

  async #runScheduledTasks(
    tasks: readonly SubagentTask[],
    targetRoot: string,
    context: RepositoryContext,
  ): Promise<SubagentTask[]> {
    if (tasks.length === 0) return [];
    const eventBus = this.#eventBusOrThrow();
    const providerConcurrency = Object.fromEntries(
      unique(tasks.map((task) => task.providerId)).map((providerId) => [providerId, this.#options.maxAgents]),
    );
    const scheduler = new SubagentScheduler(
      tasks,
      async (task, execution) => {
        const starting = await this.#runLifecycleHook("subagent_start", { taskId: task.id, role: task.role }, execution.signal);
        this.#subagentHookContext.set(task.id, starting.context);
        if (task.role === "validator") {
          return this.#runValidatorTask(task, execution.signal, targetRoot, context);
        }
        if (task.role === "reviewer") {
          return this.#runReviewerTask(task, execution.signal, targetRoot, context);
        }
        return this.#runStructuredTask(task, execution.signal, targetRoot, context);
      },
      {
        sessionId: this.#recordOrThrow().id,
        maxConcurrency: this.#options.maxAgents,
        providerConcurrency,
        maxRetries: this.#options.maxRetries,
        maxTasks: this.#options.maxTasks ?? 24,
        maxDepth: this.#options.maxDepth ?? 2,
        eventBus,
        clock: this.#clock,
        retryDelay: this.#retryDelay,
        queenApprovesTask: () => true,
      },
    );
    this.#activeScheduler = scheduler;
    if (this.#pauseRequested) scheduler.requestPause(this.#pauseReason);
    const onAbort = () => scheduler.cancel(
      typeof this.#controller.signal.reason === "string"
        ? this.#controller.signal.reason
        : "Session cancelled",
    );
    this.#controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await scheduler.run();
      if (result.cancelled) throw abortError(result.cancellationReason);
      if (result.paused) this.#pauseRequested = true;
      return result.tasks;
    } finally {
      this.#controller.signal.removeEventListener("abort", onAbort);
      this.#activeScheduler = undefined;
    }
  }

  async #runStructuredTask(
    task: SubagentTask,
    signal: AbortSignal,
    targetRoot: string,
    context: RepositoryContext,
  ): Promise<{ summary: string; tokenUsage?: SubagentTask["tokenUsage"] }> {
    const tools = await this.#createTools(targetRoot);
    const dependencyOutputs = Object.fromEntries(
      task.dependencies.map((id) => {
        const dependency = this.#recordOrThrow().tasks.find((candidate) => candidate.id === id);
        return [id, dependency?.summary ?? dependency?.error ?? dependency?.status ?? "unknown"];
      }),
    );
    const loopOptions = {
      task,
      cwd: targetRoot,
      sharedContext: await loadScopedRepositoryContext(context, this.#recordOrThrow().repository.root, task.fileScope),
      dependencyOutputs,
      completionClient: this.#dependencies.provider,
      images: this.#options.images,
      tools,
      signal,
      onEvent: (event: AgentLoopEvent) => this.#projectAgentLoopEvent(event),
    };
    const result = await this.#runProfiledAgentLoop(loopOptions);
    return { summary: result.summary, tokenUsage: result.usage };
  }

  async #runProfiledAgentLoop(options: AgentLoopOptions) {
    const selected = this.#options.pluginAgentId;
    const agent = selected ? await loadPluginAgent(this.#options.repositoryPath, selected, this.#options.extensionOptions) : undefined;
    let stopHookActive = false;
    const hookedOptions: AgentLoopOptions = { ...options,
      sharedContext: [options.sharedContext, this.#subagentHookContext.get(options.task.id)].filter(Boolean).join("\n\n"),
      beforeFinish: async (result) => {
        const previous = await options.beforeFinish?.(result);
        const ending = await this.#runLifecycleHook("subagent_stop", { taskId: options.task.id, role: options.task.role, lastAssistantMessage: result.summary, stop_hook_active: stopHookActive }, options.signal);
        const feedback = [previous, ending.continuation].filter(Boolean).join("\n\n") || undefined;
        if (feedback) stopHookActive = true;
        return feedback;
      },
    };
    return agent ? runPluginAgent({ ...hookedOptions, agent, revalidate: async () => {
      const current = await loadPluginAgent(this.#options.repositoryPath, agent.id, this.#options.extensionOptions);
      if (current.fingerprint !== agent.fingerprint) throw new Error("Selected plugin agent changed; inspect and trust it again");
    } }) : new StructuredAgentLoop().run(hookedOptions);
  }

  async #runValidatorTask(
    task: SubagentTask,
    signal: AbortSignal,
    targetRoot: string,
    context: RepositoryContext,
  ): Promise<{ summary: string; tokenUsage?: SubagentTask["tokenUsage"] }> {
    const tools = await this.#createTools(targetRoot);
    const results: ValidationResult[] = [];
    for (const [index, command] of task.validationCommands.entries()) {
      assertNotAborted(signal);
      const validationId = `val-${task.id}-${index + 1}`;
      const startedAt = this.#clock();
      this.#emit("validation.started", { validationId, taskId: task.id, command });
      const toolResult = await tools.execute(
        "run_test",
        { command, timeoutMs: 120_000 },
        task,
        signal,
      );
      const completedAt = this.#clock();
      const result: ValidationResult = {
        id: validationId,
        ...(typeof toolResult.metadata?.commandId === "string" ? { commandId: toolResult.metadata.commandId } : {}),
        taskId: task.id,
        command,
        status: toolResult.ok ? "passed" : signal.aborted ? "cancelled" : "failed",
        startedAt,
        completedAt,
        exitCode: typeof toolResult.metadata?.exitCode === "number"
          ? toolResult.metadata.exitCode
          : undefined,
        output: toolResult.output,
      };
      results.push(result);
      this.#recordOrThrow().validationResults.push(result);
      this.#emit("validation.completed", { result });
    }

    const analysis = await this.#runProfiledAgentLoop({
      task: { ...task, validationCommands: [] },
      cwd: targetRoot,
      sharedContext: await loadScopedRepositoryContext(context, this.#recordOrThrow().repository.root, task.fileScope),
      dependencyOutputs: {
        validationResults: JSON.stringify(results),
      },
      completionClient: this.#dependencies.provider,
      images: this.#options.images,
      tools,
      signal,
      onEvent: (event) => this.#projectAgentLoopEvent(event),
    });
    const passed = results.every((result) => result.status === "passed");
    return {
      summary: `${passed ? "Validation passed" : "Validation failed"}. ${analysis.summary}`,
      tokenUsage: analysis.usage,
    };
  }

  async #runReviewerTask(
    task: SubagentTask,
    signal: AbortSignal,
    targetRoot: string,
    context: RepositoryContext,
  ): Promise<{ summary: string; tokenUsage?: SubagentTask["tokenUsage"] }> {
    const tools = await this.#createTools(targetRoot);
    const diff = await tools.execute("inspect_diff", {}, task, signal);
    const analysis = await this.#runProfiledAgentLoop({
      task,
      cwd: targetRoot,
      sharedContext: await loadScopedRepositoryContext(context, this.#recordOrThrow().repository.root, task.fileScope),
      dependencyOutputs: { diff: diff.output || "No tracked diff." },
      completionClient: this.#dependencies.provider,
      images: this.#options.images,
      tools,
      signal,
      onEvent: (event) => this.#projectAgentLoopEvent(event),
    });
    const findings = reviewFindings(analysis.data);
    const explicitStatus = analysis.data?.status;
    const changesRequested = explicitStatus === "changes_requested" || findings.some(
      (finding) => !finding.resolved && (finding.severity === "critical" || finding.severity === "major"),
    );
    const review: ReviewResult = {
      id: `review-${task.id}`,
      taskId: task.id,
      status: changesRequested ? "changes_requested" : explicitStatus === "failed" ? "failed" : "passed",
      summary: analysis.summary,
      findings,
      completedAt: this.#clock(),
    };
    this.#recordOrThrow().reviewResults.push(review);
    this.#emit("review.completed", { result: review });
    return { summary: analysis.summary, tokenUsage: analysis.usage };
  }

  async #runScout(context: RepositoryContext): Promise<SubagentTask> {
    const task = this.#newTask({
      role: "scout",
      title: "Inspect repository",
      objective: "Build bounded repository context for the coding session.",
      provider: { role: "scout", providerId: INTERNAL_PROVIDER },
      dependencies: [],
      fileScope: [],
      expectedOutput: "A concise repository, instruction, script, and risk summary.",
      completionCriteria: ["Repository root and base state captured", "Relevant instructions and symbols indexed"],
      validationCommands: [],
      depth: 0,
    });
    this.#registerTask(task);
    this.#transitionTask(task.id, "queued");
    this.#transitionTask(task.id, "starting", undefined, { attempt: 1 });
    this.#transitionTask(task.id, "working");
    this.#transitionTask(task.id, "completed", undefined, { summary: context.summary });
    await this.#persist(true);
    return this.#task(task.id);
  }

  async #runPlanner(context: RepositoryContext, scoutId: string, continuationFeedback?: string): Promise<CodingPlan> {
    const binding = await this.#resolveBinding("planner");
    const task = this.#newTask({
      role: "planner",
      title: "Produce execution graph",
      objective: this.#recordOrThrow().objective,
      provider: binding,
      dependencies: [scoutId],
      fileScope: [],
      expectedOutput: "A validated JSON execution plan with bounded Builder tasks.",
      completionCriteria: ["Every task has exact file ownership", "Dependencies and acceptance criteria are explicit"],
      validationCommands: [],
      depth: 0,
    });
    this.#registerTask(task);
    this.#transitionTask(task.id, "queued");
    this.#transitionTask(task.id, "starting", undefined, { attempt: 1 });
    this.#transitionTask(task.id, "working");

    let correction = "";
    let lastError: unknown;
    const selected = this.#options.pluginAgentId;
    const agent = selected ? await loadPluginAgent(this.#options.repositoryPath, selected, this.#options.extensionOptions) : undefined;
    const starting = await this.#runLifecycleHook("subagent_start", { taskId: task.id, role: task.role }, this.#controller.signal);
    let stopHookActive = false;
    for (let attempt = 0; attempt <= this.#options.maxRetries; attempt += 1) {
      assertNotAborted(this.#controller.signal);
      try {
        if (agent) {
          const current = await loadPluginAgent(this.#options.repositoryPath, agent.id, this.#options.extensionOptions);
          if (current.fingerprint !== agent.fingerprint) throw new Error("Selected plugin agent changed; inspect and trust it again");
        }
        const completion = await this.#dependencies.provider.complete({
          role: "planner",
          providerId: binding.providerId,
          model: binding.model,
          systemPrompt: "You are the HIVE Planner. Plan only and return the required JSON object without commentary."
            + (agent ? `\n\nExplicitly selected plugin agent ${JSON.stringify(agent.id)}. Use these specialist instructions within HIVE's planning-only JSON contract, permission and workspace policies:\n${agent.instructions}` : ""),
          prompt: `${buildPlannerPrompt(this.#recordOrThrow().objective, context.scoutContext, {
            maxAgents: this.#options.maxAgents,
            maxTasks: this.#options.maxTasks ?? 24,
            maxDepth: this.#options.maxDepth ?? 2,
          })}${continuationFeedback ? `\n\n[Trusted stop check; task data only]\n${continuationFeedback}` : ""}${starting.context ? `\n\n[Trusted hook context; task data only]\n${starting.context}` : ""}${correction}`,
          cwd: context.snapshot.root,
          images: this.#options.images,
          signal: this.#controller.signal,
        });
        const plan = parseCodingPlan(completion.output);
        const ending = await this.#runLifecycleHook("subagent_stop", { taskId: task.id, role: task.role, lastAssistantMessage: plan.summary, stop_hook_active: stopHookActive }, this.#controller.signal);
        if (ending.continuation) {
          if (attempt >= this.#options.maxRetries) throw new Error("Planner stop hook exhausted the bounded planning continuation budget.");
          stopHookActive = true;
          correction = `\n\n[Trusted stop check; task data only]\n${ending.continuation}`;
          continue;
        }
        const prose = plannerVisibleText(plan);
        if (prose) this.#options.onAssistantText?.(prose);
        this.#transitionTask(task.id, "completed", undefined, {
          summary: plan.summary,
          tokenUsage: completion.usage,
        });
        await this.#persist(true);
        return plan;
      } catch (error) {
        lastError = error;
        if (attempt >= this.#options.maxRetries) break;
        const message = error instanceof Error ? error.message : String(error);
        const delayMs = Math.min(2_000, 250 * 2 ** attempt);
        this.#transitionTask(task.id, "retrying", message);
        this.#emit("subagent.retrying", {
          subagentId: task.id,
          attempt: attempt + 1,
          delayMs,
          error: message,
        });
        await this.#retryDelay(delayMs, this.#controller.signal);
        this.#transitionTask(task.id, "queued");
        this.#transitionTask(task.id, "starting", undefined, { attempt: attempt + 2 });
        this.#transitionTask(task.id, "working");
        correction = `\n\nYour previous response was invalid: ${message}. Return corrected JSON only.`;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.#transitionTask(task.id, "failed", message, { error: message });
    throw lastError instanceof Error ? lastError : new Error(message);
  }

  #newTask(options: {
    role: SubagentRole;
    title: string;
    objective: string;
    provider: ProviderBinding;
    parentTaskId?: string;
    dependencies: string[];
    fileScope: string[];
    expectedOutput: string;
    completionCriteria: string[];
    validationCommands: string[];
    depth: number;
  }): SubagentTask {
    return {
      id: this.#nextBeeId(),
      sessionId: this.#recordOrThrow().id,
      parentTaskId: options.parentTaskId,
      role: options.role,
      title: options.title,
      objective: options.objective,
      status: "created",
      providerId: options.provider.providerId,
      model: options.provider.model,
      dependencies: [...options.dependencies],
      fileScope: [...options.fileScope],
      expectedOutput: options.expectedOutput,
      completionCriteria: [...options.completionCriteria],
      validationCommands: [...options.validationCommands],
      depth: options.depth,
      attempt: 0,
      maxAttempts: this.#options.maxRetries + 1,
      createdAt: this.#clock(),
    };
  }

  #registerTask(task: SubagentTask): void {
    const record = this.#recordOrThrow();
    if (record.tasks.some((candidate) => candidate.id === task.id)) {
      throw new Error(`Duplicate subagent id ${task.id}.`);
    }
    record.tasks.push(task);
    this.#emit("task.created", { task });
    this.#emit("subagent.created", { subagentId: task.id, task });
  }

  #transitionTask(
    taskId: string,
    status: SubagentStatus,
    reason?: string,
    updates: Partial<Omit<SubagentTask, "id" | "sessionId" | "status">> = {},
  ): SubagentTask {
    const record = this.#recordOrThrow();
    const index = record.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error(`Unknown task ${taskId}.`);
    const previous = record.tasks[index];
    const next = transitionSubagentTask(previous, status, this.#clock(), updates);
    record.tasks[index] = next;
    this.#emit("subagent.status_changed", {
      subagentId: taskId,
      previousStatus: previous.status,
      status,
      task: next,
      reason,
    });
    switch (status) {
      case "queued":
        this.#emit("subagent.queued", { subagentId: taskId });
        break;
      case "starting":
        this.#emit("task.started", { taskId, attempt: next.attempt });
        this.#emit("subagent.started", { subagentId: taskId, attempt: next.attempt });
        break;
      case "blocked":
        this.#emit("task.blocked", { taskId, reason: reason ?? "Task blocked" });
        this.#emit("subagent.blocked", { subagentId: taskId, reason: reason ?? "Task blocked" });
        break;
      case "completed":
        this.#emit("task.completed", { taskId, summary: next.summary });
        this.#emit("subagent.completed", { subagentId: taskId, summary: next.summary });
        break;
      case "failed":
        this.#emit("task.failed", { taskId, error: next.error ?? reason ?? "Task failed" });
        this.#emit("subagent.failed", { subagentId: taskId, error: next.error ?? reason ?? "Task failed" });
        break;
      case "cancelled":
        this.#emit("task.cancelled", { taskId, reason });
        this.#emit("subagent.cancelled", { subagentId: taskId, reason });
        break;
      case "skipped":
        this.#emit("task.skipped", { taskId, reason: reason ?? "Task skipped" });
        this.#emit("subagent.skipped", { subagentId: taskId, reason: reason ?? "Task skipped" });
        break;
      case "retrying":
      case "validating":
      case "created":
      case "waiting_for_dependencies":
      case "working":
        break;
    }
    return next;
  }

  #forceTerminalTask(taskId: string, requested: "skipped" | "cancelled", reason: string): void {
    const task = this.#task(taskId);
    if (isTerminalSubagentStatus(task.status)) return;
    if (requested === "skipped") {
      if (task.status === "created") this.#transitionTask(taskId, "queued");
      const current = this.#task(taskId);
      if (["queued", "waiting_for_dependencies", "blocked"].includes(current.status)) {
        this.#transitionTask(taskId, "skipped", reason);
        return;
      }
    }
    const current = this.#task(taskId);
    if (current.status === "created") this.#transitionTask(taskId, "queued");
    this.#transitionTask(taskId, "cancelled", reason);
  }

  #mergeTasks(tasks: readonly SubagentTask[]): void {
    const record = this.#recordOrThrow();
    for (const task of tasks) {
      const index = record.tasks.findIndex((candidate) => candidate.id === task.id);
      if (index >= 0) record.tasks[index] = task;
      else record.tasks.push(task);
    }
  }

  #phaseGraph(task: SubagentTask): SubagentTask[] {
    const byId = new Map(this.#recordOrThrow().tasks.map((candidate) => [candidate.id, candidate]));
    const collected = new Map<string, SubagentTask>();
    const collect = (candidate: SubagentTask): void => {
      for (const dependencyId of candidate.dependencies) {
        const dependency = byId.get(dependencyId);
        if (!dependency) throw new Error(`Task ${candidate.id} depends on missing task ${dependencyId}.`);
        if (!collected.has(dependency.id)) collect(dependency);
      }
      collected.set(candidate.id, candidate);
    };
    collect(task);
    return [...collected.values()];
  }

  async #resolveBinding(role: ProviderBindingRole): Promise<ProviderBinding> {
    const override = this.#options.roleOverrides?.[role] ?? this.#options.providerOverride;
    const binding = await this.#dependencies.provider.bindingForRole(
      role,
      override,
      this.#controller.signal,
    );
    const bindings = this.#recordOrThrow().providerBindings;
    const index = bindings.findIndex((candidate) => candidate.role === role);
    if (index >= 0) bindings[index] = binding;
    else bindings.push(binding);
    return binding;
  }

  async #createTools(repositoryRoot: string): Promise<AgentToolExecutor> {
    const tools = await this.#dependencies.tools.create({
      repositoryRoot,
      sessionId: this.#recordOrThrow().id,
      approvalPolicy: this.#recordOrThrow().approvalPolicy,
      signal: this.#controller.signal,
      emit: (type, payload) => this.#emit(type, payload),
    });
    this.#toolExecutors.add(tools);
    return tools;
  }

  #projectAgentLoopEvent(event: AgentLoopEvent): void {
    if (event.type === "assistant.delta") {
      const text = event.payload.text;
      if (typeof text === "string" && text.trim()) this.#options.onAssistantText?.(text);
      return;
    }
    if (event.type === "subagent.progress") {
      this.#emit("subagent.progress", {
        subagentId: event.subagentId,
        message: typeof event.payload.activity === "string"
          ? event.payload.activity
          : "Processing assignment",
      });
      return;
    }
    if (event.type === "subagent.tool_call") {
      this.#emit("subagent.tool_call", {
        subagentId: event.subagentId,
        callId: typeof event.payload.callId === "string" ? event.payload.callId : undefined,
        tool: typeof event.payload.name === "string" ? event.payload.name : "unknown",
        input: jsonValue(event.payload.arguments),
      });
      return;
    }
    if (event.type === "subagent.tool_result") {
      const callId = event.payload.callId;
      if (typeof callId !== "string") return;
      this.#emit("subagent.tool_result", {
        subagentId: event.subagentId,
        callId,
        tool: typeof event.payload.name === "string" ? event.payload.name : "unknown",
        ok: event.payload.ok === true,
        output: typeof event.payload.output === "string" ? redactStreamingText(event.payload.output) : "",
        cancelled: event.payload.cancelled === true,
        ...(typeof event.payload.commandId === "string" ? { commandId: event.payload.commandId } : {}),
      });
      return;
    }
    if (event.type === "subagent.file_changed") {
      const filePath = typeof event.payload.path === "string" ? event.payload.path : undefined;
      const operation = event.payload.operation;
      if (!filePath || !["created", "modified", "deleted", "renamed"].includes(String(operation))) return;
      const change: FileChangeRecord = {
        path: filePath,
        operation: operation as FileChangeRecord["operation"],
        taskId: event.subagentId,
        recordedAt: this.#clock(),
      };
      this.#emit("file.changed", { change });
      this.#emit("subagent.file_changed", {
        subagentId: event.subagentId,
        path: filePath,
        operation: change.operation,
      });
    }
  }

  #defaultValidationCommands(context: RepositoryContext): string[] {
    const scripts = new Set(context.packageScripts);
    const commands: string[] = [];
    if (scripts.has("typecheck")) commands.push("npm run typecheck");
    if (scripts.has("lint")) commands.push("npm run lint");
    if (scripts.has("test")) commands.push("npm test");
    if (scripts.has("build")) commands.push("npm run build");
    return commands;
  }

  #attachEventBus(): void {
    const record = this.#recordOrThrow();
    this.#eventBus = new RuntimeEventBus({
      initialEvents: record.events,
      clock: this.#clock,
    });
    this.#eventBus.subscribe((event) => {
      const current = this.#recordOrThrow();
      current.events.push(event);
      if (current.events.length > MAX_PERSISTED_EVENTS) {
        current.events = current.events.slice(-MAX_PERSISTED_EVENTS);
      }
      if (event.type === "file.changed") {
        const change = event.payload.change;
        const duplicate = current.files.some(
          (candidate) =>
            candidate.path === change.path &&
            candidate.taskId === change.taskId &&
            candidate.operation === change.operation,
        );
        if (!duplicate) current.files.push(change);
      }
      this.#options.onEvent?.(event);
    });
  }

  #emit<TType extends RuntimeEventType>(
    type: TType,
    payload: RuntimeEvent<TType>["payload"],
  ): RuntimeEvent<TType> {
    return this.#eventBusOrThrow().emit({
      sessionId: this.#recordOrThrow().id,
      timestamp: this.#clock(),
      type,
      payload,
    } as Parameters<RuntimeEventBus["emit"]>[0]) as RuntimeEvent<TType>;
  }

  async #pauseAtBoundary(): Promise<boolean> {
    if (!this.#pauseRequested) return false;
    assertNotAborted(this.#controller.signal);
    const record = this.#recordOrThrow();
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      return false;
    }
    if (!this.#pauseAcknowledged) {
      record.status = "paused";
      await this.#persist(true);
      assertNotAborted(this.#controller.signal);
      if (this.#recordOrThrow().status !== "paused") return true;
      this.#emit("session.paused", { reason: this.#pauseReason });
      await this.#persist(true, false);
      assertNotAborted(this.#controller.signal);
      this.#pauseAcknowledged = true;
    }
    return true;
  }

  async #persist(active = false, verifyBoundary = true): Promise<void> {
    const record = this.#recordOrThrow();
    if (verifyBoundary && record.repository.worktreePath && this.#dependencies.worktrees.inspect &&
      ["paused", "completed", "failed", "cancelled"].includes(record.status)) {
      try {
        record.repository.worktreeFingerprint = (await this.#dependencies.worktrees.inspect(
          record.repository.root, record.id, record.repository.worktreePath,
        )).fingerprint;
      } catch (error) {
        delete record.repository.worktreeFingerprint;
        const reason = `Managed worktree could not be verified: ${error instanceof Error ? error.message : String(error)}`;
        if (record.status !== "cancelled") record.status = "failed";
        record.verdict = "BLOCKED";
        this.#recordFailure("REPOSITORY_DRIFT", undefined, 0, reason);
        if (record.finalReport) {
          record.finalReport.verdict = "BLOCKED";
          record.finalReport.verdictReasons = [reason];
          record.finalReport.outstanding = unique([...record.finalReport.outstanding, reason]);
          record.finalReport.evidenceCurrent = false;
          record.finalReport.failures = [...this.#failures];
          if (record.status !== "cancelled") record.finalReport.result = "Coding session stopped because its managed worktree could not be verified.";
        }
      }
    }
    this.#record = await this.#dependencies.store.save(this.#recordOrThrow());
    if (active) await this.#dependencies.store.setActive(this.#record.id);
  }

  async #finish(
    result: string,
    outstanding: string[] = [],
    succeeded = true,
    verdict?: HiveRunVerdict,
  ): Promise<CodingSessionRecord> {
    const record = this.#recordOrThrow();
    if (record.outputStyleId && (succeeded || verdict === "REPAIRABLE")) {
      const style = await loadTrustedPluginOutputStyle(this.#options.repositoryPath, record.outputStyleId, this.#options.extensionOptions);
      const binding = await this.#resolveBinding("queen");
      const completion = await this.#dependencies.provider.complete({ role: "queen", providerId: binding.providerId, model: binding.model,
        systemPrompt: `Write the final HIVE coding response from the supplied verified facts. Preserve failures, uncertainties, validation outcomes and the exact verdict. Do not claim unperformed work. Output text only; no tools, permission changes or new objectives.\n\n${renderPluginOutputStyle(style)}`,
        prompt: JSON.stringify({ objective: record.objective, result, verdict: verdict ?? (succeeded ? "ACCEPTED" : "REJECTED"), outstanding, files: record.files.map((file) => file.path), validations: latestValidationResults(record.validationResults), reviews: record.reviewResults }),
        cwd: record.repository.worktreePath ?? record.repository.root, signal: this.#controller.signal,
      });
      const current = await loadTrustedPluginOutputStyle(this.#options.repositoryPath, style.id, this.#options.extensionOptions);
      if (style.fingerprint !== current.fingerprint) throw new Error("Selected output style changed during final synthesis; trust it again");
      if (!completion.output.trim() || completion.output.length > 32_000) throw new Error("Output style synthesis returned empty or oversized text");
      result = completion.output.trim();
    }
    const ending = await this.#runLifecycleHook(succeeded || verdict === "REPAIRABLE" ? "stop" : "stop_failure", {
      lastAssistantMessage: result, stop_hook_active: this.#stopContinuations > 0,
      error: succeeded ? undefined : "unknown", errorDetails: outstanding.join("\n"),
    }, this.#controller.signal);
    if (ending.continuation) return this.#continueForStopHook(ending.continuation);
    const validations = latestValidationResults(record.validationResults);
    const reports = record.reviewResults;

    // Build evidence summary for report
    const evidenceSummary = this.#evidenceLedger?.records.map((e) => ({
      id: e.id,
      gateId: e.gateId,
      category: e.category,
      status: e.status,
      summary: e.summary,
      valid: e.valid,
      invalidationReason: e.invalidationReason,
    })) ?? [];

    // Get final SHA from evidence
    const finalSha = this.#evidenceLedger?.records
      .filter((e) => e.category === "repository_sha" && e.valid)
      .at(-1)?.repositorySha;

    const report: CodingFinalReport = {
      result,
      verdict: verdict ?? (succeeded ? "ACCEPTED" : "REJECTED"),
      verdictReasons: this.#contract ? [
        ...validations.filter((v) => v.status !== "passed").map((v) => `Validation failed: ${v.command}`),
        ...reports.flatMap((r) => r.findings.filter((f) => !f.resolved).map((f) => `${f.severity}: ${f.summary}`)),
      ] : [],
      subagents: aggregateSubagentCounts(record.tasks),
      filesChanged: unique(record.files.map((file) => file.path)),
      validation: validations.map((validation) => ({
        label: validation.command,
        status: validation.status,
      })),
      review: reports.flatMap((review) => [
        review.summary,
        ...review.findings.map((finding) => `${finding.severity}: ${finding.summary}`),
      ]),
      outstanding: unique(outstanding),
      completedAt: this.#clock(),
      finalSha,
      baseSha: record.repository.worktreeBaseCommit ?? record.repository.baseCommit,
      failures: [...this.#failures],
      evidenceSummary,
      integrations: [...this.#integrations],
      evidenceCurrent: this.#evidenceLedger
        ? !this.#evidenceLedger.records.some((e) => !e.valid)
        : undefined,
    };
    record.finalReport = report;
    record.verdict = verdict ?? (succeeded ? "ACCEPTED" : "REJECTED");
    record.failures = [...this.#failures];
    record.integrations = [...this.#integrations];
    // REPAIRABLE is a successful outcome — the run completed with actionable defects
    const effectiveSuccess = succeeded || verdict === "REPAIRABLE";
    record.status = effectiveSuccess ? "completed" : "failed";
    await this.#persist(true);
    this.#emit("session.completed", { report: this.#recordOrThrow().finalReport ?? report });
    await this.#persist(true, false);
    return this.#recordOrThrow();
  }

  async #runLifecycleHook(event: HookEvent, input: Record<string, unknown>, signal: AbortSignal): Promise<{ context: string; continuation?: string }> {
    const record = this.#recordOrThrow();
    const results = await runHooks(this.#options.repositoryPath, event, { sessionId: record.id, workspace: record.repository.worktreePath ?? record.repository.root, permissionMode: record.mode, ...input }, { ...this.#options.extensionOptions, signal });
    assertNotAborted(signal);
    for (const hook of results) for (const notice of hook.diagnostics ?? []) this.#options.onAssistantText?.(`[Hook ${hook.id}] ${notice}`);
    if (results.some((hook) => hook.stop)) { this.cancel("A trusted lifecycle hook requested the coding session to stop."); assertNotAborted(this.#controller.signal); }
    const failure = results.find((hook) => hook.blocked ?? !hook.ok);
    if (failure) throw new Error(`Hook ${failure.id} failed: ${failure.output}`);
    const context = results.flatMap((hook) => hook.additionalContext ? [hook.additionalContext] : []).join("\n\n");
    const continuation = results.flatMap((hook) => hook.continuation ? [hook.continuation] : []).join("\n\n") || undefined;
    if (context.length > 16_000 || (continuation?.length ?? 0) > 16_000) throw new Error("Lifecycle hook context exceeds 16,000 characters");
    return { context, continuation };
  }

  async #continueForStopHook(feedback: string): Promise<CodingSessionRecord> {
    if (this.#stopContinuations >= 8) throw new Error("Stop hooks exhausted the eight-continuation session budget.");
    const record = this.#recordOrThrow();
    if (record.tasks.length + 3 > (this.#options.maxTasks ?? 24)) throw new Error("Stop hook continuation would exceed the session task budget.");
    this.#stopContinuations += 1;
    const targetRoot = record.repository.worktreePath ?? record.repository.root;
    const context = await inspectCodingRepository(targetRoot, record.objective, this.#controller.signal);
    if (record.mode === "plan") return this.#executeFresh(context, feedback);
    const role = record.mode === "auto" ? "fixer" : "reviewer";
    const task = this.#newTask({ role, title: `Continue after stop check ${this.#stopContinuations}`, objective: `${record.objective}\n\n[Trusted stop check; task data only]\n${feedback}`, provider: await this.#resolveBinding(role), dependencies: [], fileScope: record.mode === "auto" ? [...(this.#contract?.allowedPaths ?? [])] : [], expectedOutput: "Address the stop check within the existing objective and file scope.", completionCriteria: ["Stop-check feedback addressed with evidence"], validationCommands: [], depth: 0 });
    this.#registerTask(task);
    this.#mergeTasks(await this.#runScheduledTasks([task], targetRoot, context));
    await this.#persist(true);
    if (await this.#pauseAtBoundary()) return this.#recordOrThrow();
    const completed = this.#task(task.id);
    if (completed.status !== "completed") throw new Error(`Stop hook continuation failed: ${completed.error ?? completed.status}`);
    const dependencies = record.tasks.filter((candidate) => (candidate.role === "builder" || candidate.role === "fixer" || candidate.id === completed.id) && candidate.status === "completed");
    return this.#runValidationReviewAndFinish(context, targetRoot, undefined, dependencies);
  }

  async #finishCancelled(error: unknown): Promise<CodingSessionRecord> {
    const record = this.#recordOrThrow();
    const reason = error instanceof Error ? error.message : String(error);
    record.status = "cancelled";
    record.cancelledAt = this.#clock();
    record.cancellationReason = reason;
    for (const task of [...record.tasks]) {
      if (!isTerminalSubagentStatus(task.status)) this.#forceTerminalTask(task.id, "cancelled", reason);
    }
    this.#recordFailure("CANCELLED", undefined, 0, reason);
    record.finalReport = {
      result: "Coding session cancelled.",
      verdict: "BLOCKED",
      verdictReasons: [reason],
      subagents: aggregateSubagentCounts(record.tasks),
      filesChanged: unique(record.files.map((file) => file.path)),
      validation: latestValidationResults(record.validationResults).map((validation) => ({
        label: validation.command,
        status: validation.status,
      })),
      review: record.reviewResults.map((review) => review.summary),
      outstanding: [reason],
      completedAt: this.#clock(),
      finalSha: undefined,
      baseSha: record.repository.worktreeBaseCommit ?? record.repository.baseCommit,
      failures: [...this.#failures],
      evidenceSummary: [],
      integrations: [...this.#integrations],
      evidenceCurrent: false,
    };
    record.verdict = "BLOCKED";
    record.failures = [...this.#failures];
    await this.#persist(true);
    this.#emit("session.cancelled", { reason });
    await this.#persist(true, false);
    return this.#recordOrThrow();
  }

  async #finishFailed(error: unknown): Promise<CodingSessionRecord> {
    const message = error instanceof Error ? error.message : String(error);
    return this.#finish("Coding session failed.", [message], false);
  }

  #recordFailure(
    failureClass: FailureClass,
    nodeId: string | undefined,
    attempt: number,
    description: string,
  ): void {
    const action = actionForFailure(failureClass);
    const failure: FailureRecord = {
      failureClass,
      affectedNodeId: nodeId,
      attemptNumber: attempt,
      actionTaken: action,
      description,
      timestamp: this.#clock(),
    };
    this.#failures.push(failure);
    if (this.#record) {
      this.#record.failures = [...this.#failures];
    }
    this.#emit("failure.recorded", { failure });
  }

  #nextBeeNumber(tasks: readonly SubagentTask[]): number {
    return tasks.reduce((maximum, task) => {
      const match = task.id.match(/^bee-(\d+)$/);
      return match ? Math.max(maximum, Number(match[1]) + 1) : maximum;
    }, 1);
  }

  #task(taskId: string): SubagentTask {
    const task = this.#recordOrThrow().tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Unknown task ${taskId}.`);
    return task;
  }

  #recordOrThrow(): CodingSessionRecord {
    if (!this.#record) throw new Error("Coding session record is not initialized.");
    return this.#record;
  }

  #eventBusOrThrow(): RuntimeEventBus {
    if (!this.#eventBus) throw new Error("Coding session event bus is not initialized.");
    return this.#eventBus;
  }
}
