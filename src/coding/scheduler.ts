import { RuntimeEventBus } from "./events.js";
import {
  TaskGraphValidationError,
  fileScopesOverlap,
  normalizeFileScope,
  validateTaskGraph,
} from "./task-graph.js";
import {
  aggregateSubagentCounts,
  canTransitionSubagentStatus,
  isTerminalSubagentStatus,
  transitionSubagentTask,
  type RuntimeEvent,
  type SubagentCounts,
  type SubagentStatus,
  type SubagentTask,
  type TokenUsage,
} from "./types.js";

export interface TaskExecutionResult {
  summary?: string;
  tokenUsage?: TokenUsage;
}

export interface TaskExecutionContext {
  signal: AbortSignal;
  attempt: number;
  eventBus: RuntimeEventBus;
  reportProgress: (message: string, percent?: number) => void;
}

export type SubagentTaskExecutor = (
  task: Readonly<SubagentTask>,
  context: TaskExecutionContext,
) => Promise<TaskExecutionResult | void>;

export type DependencyFailureBehavior = "skip" | "fail";

export type QueenTaskApproval = (
  task: Readonly<SubagentTask>,
  parent: Readonly<SubagentTask> | undefined,
) => boolean | Promise<boolean>;

export interface SubagentSchedulerOptions {
  sessionId?: string;
  maxConcurrency?: number;
  providerConcurrency?: Readonly<Record<string, number>>;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  retryDelay?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  shouldRetry?: (
    error: unknown,
    task: Readonly<SubagentTask>,
    attempt: number,
  ) => boolean | Promise<boolean>;
  dependencyFailure?: DependencyFailureBehavior;
  maxTasks?: number;
  maxDepth?: number;
  queenApprovesTask?: QueenTaskApproval;
  eventBus?: RuntimeEventBus;
  clock?: () => string;
}

export interface SchedulerResult {
  tasks: SubagentTask[];
  counts: SubagentCounts;
  paused: boolean;
  cancelled: boolean;
  cancellationReason?: string;
  events: RuntimeEvent[];
}

type TaskUpdates = Partial<
  Omit<SubagentTask, "id" | "sessionId" | "status">
>;

interface TransitionMetadata {
  reason?: string;
  error?: string;
  delayMs?: number;
}

type DependencyState =
  | { state: "ready" }
  | { state: "waiting" }
  | { state: "failed"; dependencyIds: string[] };

const editingRoles = new Set<SubagentTask["role"]>(["builder", "fixer"]);

function cloneTask(task: SubagentTask): SubagentTask {
  return {
    ...task,
    dependencies: [...task.dependencies],
    fileScope: [...task.fileScope],
    completionCriteria: [...task.completionCriteria],
    validationCommands: [...task.validationCommands],
    tokenUsage:
      task.tokenUsage === undefined ? undefined : { ...task.tokenUsage },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown task execution failure";
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error(
    typeof signal.reason === "string" ? signal.reason : "Operation cancelled",
  );
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

export class SubagentScheduler {
  public readonly eventBus: RuntimeEventBus;

  readonly #executor: SubagentTaskExecutor;
  readonly #maxConcurrency: number;
  readonly #providerConcurrency: Readonly<Record<string, number>>;
  readonly #maxRetries: number;
  readonly #baseRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #retryDelay: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly #shouldRetry: NonNullable<SubagentSchedulerOptions["shouldRetry"]>;
  readonly #dependencyFailure: DependencyFailureBehavior;
  readonly #maxTasks: number;
  readonly #maxDepth: number;
  readonly #queenApprovesTask?: QueenTaskApproval;
  readonly #clock: () => string;
  readonly #controller = new AbortController();
  readonly #tasks = new Map<string, SubagentTask>();
  readonly #taskOrder: string[] = [];
  readonly #active = new Map<string, Promise<void>>();
  readonly #providerActive = new Map<string, number>();
  readonly #fileLeases = new Map<string, string[]>();
  readonly #changeWaiters = new Set<() => void>();

  #sessionId?: string;
  #changeVersion = 0;
  #started = false;
  #finished = false;
  #cancelled = false;
  #pauseRequested = false;
  #paused = false;
  #cancellationReason?: string;
  #runPromise?: Promise<SchedulerResult>;

  public constructor(
    tasks: readonly SubagentTask[],
    executor: SubagentTaskExecutor,
    options: SubagentSchedulerOptions = {},
  ) {
    this.#executor = executor;
    this.#maxConcurrency = options.maxConcurrency ?? 4;
    this.#providerConcurrency = options.providerConcurrency ?? {};
    this.#maxRetries = options.maxRetries ?? 2;
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 250;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.#retryDelay = options.retryDelay ?? abortableDelay;
    this.#shouldRetry = options.shouldRetry ?? (() => true);
    this.#dependencyFailure = options.dependencyFailure ?? "skip";
    this.#maxTasks = options.maxTasks ?? 24;
    this.#maxDepth = options.maxDepth ?? 2;
    this.#queenApprovesTask = options.queenApprovesTask;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.eventBus = options.eventBus ?? new RuntimeEventBus({ clock: this.#clock });
    this.#sessionId = options.sessionId ?? tasks[0]?.sessionId;

    requirePositiveInteger(this.#maxConcurrency, "maxConcurrency");
    requireNonNegativeInteger(this.#maxRetries, "maxRetries");
    requireNonNegativeInteger(this.#baseRetryDelayMs, "baseRetryDelayMs");
    requireNonNegativeInteger(this.#maxRetryDelayMs, "maxRetryDelayMs");
    requirePositiveInteger(this.#maxTasks, "maxTasks");
    requireNonNegativeInteger(this.#maxDepth, "maxDepth");
    for (const [providerId, limit] of Object.entries(
      this.#providerConcurrency,
    )) {
      requirePositiveInteger(limit, `providerConcurrency.${providerId}`);
    }

    if (
      this.#sessionId !== undefined &&
      tasks.some((task) => task.sessionId !== this.#sessionId)
    ) {
      throw new Error("All scheduled tasks must belong to the same session");
    }

    const graph = validateTaskGraph(tasks, {
      maxTasks: this.#maxTasks,
      maxDepth: this.#maxDepth,
      conflictPolicy: "serialize",
    });
    if (!graph.valid) {
      throw new TaskGraphValidationError(graph);
    }

    for (const task of tasks) {
      const stored = cloneTask(task);
      this.#tasks.set(stored.id, stored);
      this.#taskOrder.push(stored.id);
      this.#emitCreated(stored);
    }
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  public get cancelled(): boolean {
    return this.#cancelled;
  }

  public get paused(): boolean {
    return this.#paused;
  }

  public getTasks(): SubagentTask[] {
    return this.#taskOrder.map((taskId) => cloneTask(this.#requireTask(taskId)));
  }

  public getTask(taskId: string): SubagentTask | undefined {
    const task = this.#tasks.get(taskId);
    return task === undefined ? undefined : cloneTask(task);
  }

  public run(): Promise<SchedulerResult> {
    if (this.#runPromise !== undefined) {
      return this.#runPromise;
    }
    this.#started = true;
    this.#runPromise = this.#runLoop();
    return this.#runPromise;
  }

  public cancel(reason = "Session cancelled"): void {
    if (this.#cancelled || this.#finished) {
      return;
    }
    this.#cancelled = true;
    this.#cancellationReason = reason;
    this.#controller.abort(new Error(reason));

    for (const taskId of this.#taskOrder) {
      const task = this.#requireTask(taskId);
      if (
        !isTerminalSubagentStatus(task.status) &&
        canTransitionSubagentStatus(task.status, "cancelled")
      ) {
        this.#transition(taskId, "cancelled", { reason });
      }
    }
    if (this.#sessionId !== undefined) {
      this.eventBus.emit({
        sessionId: this.#sessionId,
        timestamp: this.#clock(),
        type: "session.cancelled",
        payload: { reason },
      });
    }
    this.#signalChange();
  }

  public requestPause(_reason = "Pause requested"): boolean {
    if (this.#cancelled || this.#finished) return false;
    this.#pauseRequested = true;
    this.#signalChange();
    return true;
  }

  public async addTask(task: SubagentTask): Promise<boolean> {
    if (this.#cancelled) {
      throw new Error("Cannot add a task after the scheduler was cancelled");
    }
    if (this.#pauseRequested) {
      throw new Error("Cannot add a task after the scheduler was asked to pause");
    }
    if (this.#finished) {
      throw new Error("Cannot add a task after the scheduler finished");
    }
    if (task.status !== "created") {
      throw new Error("Dynamically added tasks must have created status");
    }
    if (this.#tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists`);
    }
    if (this.#tasks.size >= this.#maxTasks) {
      throw new Error(`Session task budget of ${this.#maxTasks} was reached`);
    }
    if (this.#sessionId !== undefined && task.sessionId !== this.#sessionId) {
      throw new Error("Dynamic task belongs to a different session");
    }

    let parent: SubagentTask | undefined;
    if (task.parentTaskId !== undefined) {
      parent = this.#tasks.get(task.parentTaskId);
      if (!parent) {
        throw new Error(`Parent task ${task.parentTaskId} does not exist`);
      }
      if (task.depth !== parent.depth + 1) {
        throw new Error(
          `Child task ${task.id} must have depth ${parent.depth + 1}`,
        );
      }
    }
    if (task.depth > this.#maxDepth) {
      throw new Error(
        `Task ${task.id} depth ${task.depth} exceeds limit ${this.#maxDepth}`,
      );
    }
    if (!this.#queenApprovesTask) {
      throw new Error("Queen approval is required for dynamic tasks");
    }

    const approved = await this.#queenApprovesTask(
      cloneTask(task),
      parent === undefined ? undefined : cloneTask(parent),
    );
    if (!approved) {
      return false;
    }
    if (this.#cancelled) {
      throw new Error("Cannot add a task after the scheduler was cancelled");
    }
    if (this.#pauseRequested) {
      throw new Error("Cannot add a task after the scheduler was asked to pause");
    }
    if (this.#finished) {
      throw new Error("Cannot add a task after the scheduler finished");
    }

    const candidateTasks = [...this.#tasks.values(), task];
    const graph = validateTaskGraph(candidateTasks, {
      maxTasks: this.#maxTasks,
      maxDepth: this.#maxDepth,
      conflictPolicy: "serialize",
    });
    if (!graph.valid) {
      throw new TaskGraphValidationError(graph);
    }

    const stored = cloneTask(task);
    this.#sessionId ??= stored.sessionId;
    this.#tasks.set(stored.id, stored);
    this.#taskOrder.push(stored.id);
    this.#emitCreated(stored);
    if (this.#started) {
      this.#transition(stored.id, "queued");
    }
    this.#signalChange();
    return true;
  }

  async #runLoop(): Promise<SchedulerResult> {
    for (const taskId of this.#taskOrder) {
      const task = this.#requireTask(taskId);
      if (task.status === "created" && !this.#cancelled) {
        this.#transition(taskId, "queued");
      }
    }

    while (true) {
      this.#resolveDependencyStates();

      if (this.#allTasksTerminal() && this.#active.size === 0) {
        break;
      }

      if (this.#pauseRequested && this.#active.size === 0) {
        this.#paused = true;
        break;
      }

      let launched = false;
      if (!this.#cancelled && !this.#pauseRequested) {
        for (const taskId of this.#taskOrder) {
          if (this.#active.size >= this.#maxConcurrency) {
            break;
          }
          const task = this.#requireTask(taskId);
          if (!this.#isLaunchable(task)) {
            continue;
          }
          this.#launch(task);
          launched = true;
        }
      }

      if (this.#allTasksTerminal() && this.#active.size === 0) {
        break;
      }
      if (this.#active.size === 0 && !launched && !this.#pauseRequested) {
        this.#failDeadlockedTasks();
        continue;
      }

      const observedVersion = this.#changeVersion;
      await this.#waitForChange(observedVersion);
    }

    if (this.#active.size > 0) {
      await Promise.allSettled(this.#active.values());
    }
    this.#finished = true;
    return this.#result();
  }

  #resolveDependencyStates(): void {
    for (const taskId of this.#taskOrder) {
      const task = this.#requireTask(taskId);
      if (task.status !== "queued" && task.status !== "waiting_for_dependencies") {
        continue;
      }
      const dependencyState = this.#dependencyState(task);
      if (dependencyState.state === "waiting") {
        if (task.status === "queued") {
          this.#transition(taskId, "waiting_for_dependencies");
        }
        continue;
      }
      if (dependencyState.state === "failed") {
        const reason = `Dependency failure: ${dependencyState.dependencyIds.join(
          ", ",
        )}`;
        this.#transition(
          taskId,
          this.#dependencyFailure === "skip" ? "skipped" : "failed",
          this.#dependencyFailure === "skip"
            ? { reason }
            : { reason, error: reason },
          this.#dependencyFailure === "fail" ? { error: reason } : {},
        );
      }
    }
  }

  #dependencyState(task: SubagentTask): DependencyState {
    const failed: string[] = [];
    let waiting = false;
    for (const dependencyId of task.dependencies) {
      const dependency = this.#requireTask(dependencyId);
      if (dependency.status === "completed") {
        continue;
      }
      if (isTerminalSubagentStatus(dependency.status)) {
        failed.push(dependencyId);
      } else {
        waiting = true;
      }
    }
    if (failed.length > 0) {
      return { state: "failed", dependencyIds: failed };
    }
    return waiting ? { state: "waiting" } : { state: "ready" };
  }

  #isLaunchable(task: SubagentTask): boolean {
    if (this.#cancelled || this.#pauseRequested || this.#active.has(task.id)) {
      return false;
    }
    if (task.status !== "queued" && task.status !== "waiting_for_dependencies") {
      return false;
    }
    if (this.#dependencyState(task).state !== "ready") {
      return false;
    }
    const providerLimit =
      this.#providerConcurrency[task.providerId] ?? this.#maxConcurrency;
    if ((this.#providerActive.get(task.providerId) ?? 0) >= providerLimit) {
      return false;
    }
    return this.#canAcquireFileLease(task);
  }

  #canAcquireFileLease(task: SubagentTask): boolean {
    if (!editingRoles.has(task.role) || task.fileScope.length === 0) {
      return true;
    }
    return [...this.#fileLeases.values()].every((leasedScopes) =>
      task.fileScope.every((scope) =>
        leasedScopes.every((leasedScope) =>
          !fileScopesOverlap(scope, leasedScope),
        ),
      ),
    );
  }

  #launch(task: SubagentTask): void {
    if (this.#cancelled || this.#pauseRequested) {
      return;
    }
    const timestamp = this.#clock();
    this.eventBus.emit({
      sessionId: task.sessionId,
      timestamp,
      type: "task.ready",
      payload: { taskId: task.id },
    });
    this.#providerActive.set(
      task.providerId,
      (this.#providerActive.get(task.providerId) ?? 0) + 1,
    );
    if (editingRoles.has(task.role) && task.fileScope.length > 0) {
      this.#fileLeases.set(task.id, task.fileScope.map(normalizeFileScope));
    }

    const execution = this.#executeTask(task.id)
      .catch((error: unknown) => {
        const current = this.#requireTask(task.id);
        if (
          !isTerminalSubagentStatus(current.status) &&
          canTransitionSubagentStatus(current.status, "failed")
        ) {
          const message = errorMessage(error);
          this.#transition(
            task.id,
            "failed",
            { error: message },
            { error: message },
          );
        }
      })
      .finally(() => {
        this.#active.delete(task.id);
        this.#fileLeases.delete(task.id);
        const remaining = (this.#providerActive.get(task.providerId) ?? 1) - 1;
        if (remaining <= 0) {
          this.#providerActive.delete(task.providerId);
        } else {
          this.#providerActive.set(task.providerId, remaining);
        }
        this.#signalChange();
      });
    this.#active.set(task.id, execution);
  }

  async #executeTask(taskId: string): Promise<void> {
    while (!this.#cancelled) {
      let task = this.#requireTask(taskId);
      this.#transition(
        taskId,
        "starting",
        undefined,
        { attempt: task.attempt + 1 },
      );
      this.#transition(taskId, "working");
      task = this.#requireTask(taskId);

      try {
        const result = await this.#executor(cloneTask(task), {
          signal: this.#controller.signal,
          attempt: task.attempt,
          eventBus: this.eventBus,
          reportProgress: (message, percent) => {
            this.#reportProgress(taskId, message, percent);
          },
        });
        if (this.#cancelled || this.#controller.signal.aborted) {
          return;
        }
        const current = this.#requireTask(taskId);
        if (isTerminalSubagentStatus(current.status)) {
          return;
        }
        const updates: TaskUpdates = {};
        if (result !== undefined) {
          updates.summary = result.summary;
          updates.tokenUsage = result.tokenUsage;
        }
        updates.error = undefined;
        if (current.validationCommands.length > 0) {
          this.#transition(taskId, "validating", undefined, updates);
          this.#transition(taskId, "completed", undefined, updates);
        } else {
          this.#transition(taskId, "completed", undefined, updates);
        }
        return;
      } catch (error) {
        if (this.#cancelled || this.#controller.signal.aborted) {
          const current = this.#requireTask(taskId);
          if (
            !isTerminalSubagentStatus(current.status) &&
            canTransitionSubagentStatus(current.status, "cancelled")
          ) {
            this.#transition(taskId, "cancelled", {
              reason: this.#cancellationReason ?? "Session cancelled",
            });
          }
          return;
        }

        const current = this.#requireTask(taskId);
        const message = errorMessage(error);
        if (this.#pauseRequested) {
          this.#transition(taskId, "retrying", { error: message, delayMs: 0 }, { error: message });
          this.#transition(taskId, "queued", undefined, { error: undefined });
          return;
        }
        const attemptLimit = Math.max(
          1,
          Math.min(current.maxAttempts, this.#maxRetries + 1),
        );
        const retryApproved =
          current.attempt < attemptLimit &&
          (await this.#shouldRetry(error, cloneTask(current), current.attempt));
        if (!retryApproved) {
          this.#transition(
            taskId,
            "failed",
            { error: message },
            { error: message },
          );
          return;
        }

        const delayMs = Math.min(
          this.#maxRetryDelayMs,
          this.#baseRetryDelayMs * 2 ** Math.max(0, current.attempt - 1),
        );
        this.#transition(
          taskId,
          "retrying",
          { error: message, delayMs },
          { error: message },
        );
        try {
          await this.#retryDelay(delayMs, this.#controller.signal);
        } catch (delayError) {
          if (this.#cancelled || this.#controller.signal.aborted) {
            const retrying = this.#requireTask(taskId);
            if (
              !isTerminalSubagentStatus(retrying.status) &&
              canTransitionSubagentStatus(retrying.status, "cancelled")
            ) {
              this.#transition(taskId, "cancelled", {
                reason: this.#cancellationReason ?? "Session cancelled",
              });
            }
          } else {
            const delayMessage = errorMessage(delayError);
            this.#transition(
              taskId,
              "failed",
              { error: delayMessage },
              { error: delayMessage },
            );
          }
          return;
        }
        if (this.#cancelled) {
          return;
        }
        this.#transition(taskId, "queued", undefined, { error: undefined });
      }
    }
  }

  #reportProgress(taskId: string, message: string, percent?: number): void {
    if (percent !== undefined && (percent < 0 || percent > 100)) {
      throw new RangeError("Task progress percent must be between 0 and 100");
    }
    const task = this.#requireTask(taskId);
    if (isTerminalSubagentStatus(task.status)) {
      return;
    }
    const timestamp = this.#clock();
    this.eventBus.emit({
      sessionId: task.sessionId,
      timestamp,
      type: "task.progress",
      payload: { taskId, message, percent },
    });
    this.eventBus.emit({
      sessionId: task.sessionId,
      timestamp,
      type: "subagent.progress",
      payload: { subagentId: taskId, message, percent },
    });
  }

  #transition(
    taskId: string,
    status: SubagentStatus,
    metadata: TransitionMetadata = {},
    updates: TaskUpdates = {},
  ): SubagentTask {
    const previous = this.#requireTask(taskId);
    const timestamp = this.#clock();
    const next = transitionSubagentTask(previous, status, timestamp, updates);
    this.#tasks.set(taskId, next);
    this.eventBus.emit({
      sessionId: next.sessionId,
      timestamp,
      type: "subagent.status_changed",
      payload: {
        subagentId: next.id,
        previousStatus: previous.status,
        status,
        task: cloneTask(next),
        reason: metadata.reason,
      },
    });

    switch (status) {
      case "queued":
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.queued",
          payload: { subagentId: next.id },
        });
        break;
      case "starting":
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.started",
          payload: { taskId: next.id, attempt: next.attempt },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.started",
          payload: { subagentId: next.id, attempt: next.attempt },
        });
        break;
      case "blocked": {
        const reason = metadata.reason ?? "Task blocked";
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.blocked",
          payload: { taskId: next.id, reason },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.blocked",
          payload: { subagentId: next.id, reason },
        });
        break;
      }
      case "retrying": {
        const error = metadata.error ?? next.error ?? "Task failed";
        const delayMs = metadata.delayMs ?? 0;
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.retrying",
          payload: { taskId: next.id, attempt: next.attempt, delayMs, error },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.retrying",
          payload: {
            subagentId: next.id,
            attempt: next.attempt,
            delayMs,
            error,
          },
        });
        break;
      }
      case "validating":
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.validating",
          payload: {
            subagentId: next.id,
            commands: [...next.validationCommands],
          },
        });
        break;
      case "completed":
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.completed",
          payload: { taskId: next.id, summary: next.summary },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.completed",
          payload: { subagentId: next.id, summary: next.summary },
        });
        break;
      case "failed": {
        const error = metadata.error ?? next.error ?? "Task failed";
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.failed",
          payload: { taskId: next.id, error },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.failed",
          payload: { subagentId: next.id, error },
        });
        break;
      }
      case "cancelled":
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.cancelled",
          payload: { taskId: next.id, reason: metadata.reason },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.cancelled",
          payload: { subagentId: next.id, reason: metadata.reason },
        });
        break;
      case "skipped": {
        const reason = metadata.reason ?? "Task skipped";
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "task.skipped",
          payload: { taskId: next.id, reason },
        });
        this.eventBus.emit({
          sessionId: next.sessionId,
          timestamp,
          type: "subagent.skipped",
          payload: { subagentId: next.id, reason },
        });
        break;
      }
      case "created":
      case "waiting_for_dependencies":
      case "working":
        break;
    }
    this.#signalChange();
    return next;
  }

  #emitCreated(task: SubagentTask): void {
    const timestamp = this.#clock();
    this.eventBus.emit({
      sessionId: task.sessionId,
      timestamp,
      type: "task.created",
      payload: { task: cloneTask(task) },
    });
    this.eventBus.emit({
      sessionId: task.sessionId,
      timestamp,
      type: "subagent.created",
      payload: { subagentId: task.id, task: cloneTask(task) },
    });
  }

  #failDeadlockedTasks(): void {
    for (const taskId of this.#taskOrder) {
      const task = this.#requireTask(taskId);
      if (
        !isTerminalSubagentStatus(task.status) &&
        canTransitionSubagentStatus(task.status, "failed")
      ) {
        const error = "Scheduler could not make progress";
        this.#transition(taskId, "failed", { error }, { error });
      }
    }
  }

  #allTasksTerminal(): boolean {
    return this.#taskOrder.every((taskId) =>
      isTerminalSubagentStatus(this.#requireTask(taskId).status),
    );
  }

  #requireTask(taskId: string): SubagentTask {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId}`);
    }
    return task;
  }

  #signalChange(): void {
    this.#changeVersion += 1;
    for (const resolve of this.#changeWaiters) {
      resolve();
    }
    this.#changeWaiters.clear();
  }

  #waitForChange(observedVersion: number): Promise<void> {
    if (this.#changeVersion !== observedVersion) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#changeWaiters.add(resolve);
    });
  }

  #result(): SchedulerResult {
    const tasks = this.getTasks();
    return {
      tasks,
      counts: aggregateSubagentCounts(tasks),
      paused: this.#paused && !this.#cancelled,
      cancelled: this.#cancelled,
      cancellationReason: this.#cancellationReason,
      events:
        this.#sessionId === undefined
          ? this.eventBus.replay()
          : this.eventBus.replay({ sessionId: this.#sessionId }),
    };
  }
}
