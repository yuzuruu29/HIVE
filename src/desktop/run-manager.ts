import { promises as fs } from "node:fs";
import { createCodingSessionId, type QueenSessionOptions } from "../coding/queen.js";
import { createQueenSession } from "../coding/runtime.js";
import { CodingSessionStore } from "../coding/session-store.js";
import type { CodingSessionRecord, CodingSessionStatus, RuntimeEvent } from "../coding/types.js";
import { redactKnownSecrets } from "../security/secrets.js";
import { buildThreadObjective } from "./context.js";
import { JsonThreadStore } from "./thread-store.js";
import type {
  DesktopEvent,
  DesktopRunManager,
  DesktopRunOptions,
  DesktopRunReferenceRequest,
  DesktopRunResumeRequest,
  DesktopRunStartRequest,
  ThreadRecordV1,
  ThreadRunRef,
  ThreadStore,
} from "./types.js";

const TERMINAL = new Set<CodingSessionStatus>(["completed", "failed", "cancelled"]);

export interface DesktopRuntimeLaunchInput {
  repositoryRoot: string;
  sessionId: string;
  objective?: string;
  resumeId?: string;
  options: DesktopRunOptions;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
}

export interface DesktopRuntimeHandle {
  completion: Promise<CodingSessionRecord>;
  requestPause?: (reason?: string) => boolean | Promise<boolean>;
  forceTerminate?: () => Promise<void> | void;
}

export type DesktopRuntimeLauncher = (
  input: DesktopRuntimeLaunchInput,
) => Promise<CodingSessionRecord> | DesktopRuntimeHandle;

export interface DefaultDesktopRunManagerOptions {
  launcher?: DesktopRuntimeLauncher;
  threadStoreFactory?: (repositoryRoot: string) => ThreadStore;
  sessionIdFactory?: () => string;
  clock?: () => string;
  onEvent?: (event: DesktopEvent) => void;
  cancelTimeoutMs?: number;
  codingSessionStoreFactory?: (repositoryRoot: string) => Pick<CodingSessionStore, "load">;
}

interface ActiveRun {
  repositoryRoot: string;
  threadId: string;
  sessionId: string;
  controller: AbortController;
  completion: Promise<void>;
  persistence: Promise<void>;
  forceTerminate?: () => Promise<void> | void;
  requestPause?: (reason?: string) => boolean | Promise<boolean>;
  terminalOverride: boolean;
}

function redactDesktopError(value: string): string {
  return redactKnownSecrets(value);
}

function isRuntimeHandle(value: Promise<CodingSessionRecord> | DesktopRuntimeHandle): value is DesktopRuntimeHandle {
  return typeof value === "object" && value !== null && "completion" in value;
}

function statusForEvent(event: RuntimeEvent): CodingSessionStatus | undefined {
  switch (event.type) {
    case "session.created": return "created";
    case "session.started": return "planning";
    case "session.paused": return "paused";
    case "session.resumed": return "running";
    case "session.cancelled": return "cancelled";
    case "session.completed": return "completed";
    default: return undefined;
  }
}

function defaultLauncher(input: DesktopRuntimeLaunchInput): DesktopRuntimeHandle {
  const queenOptions: QueenSessionOptions = {
    repositoryPath: input.repositoryRoot,
    sessionId: input.sessionId,
    resumeId: input.resumeId,
    objective: input.objective,
    mode: input.options.mode,
    approvalPolicy: input.options.approvalPolicy,
    maxAgents: input.options.maxAgents ?? 4,
    maxRetries: input.options.maxRetries ?? 1,
    signal: input.signal,
    onEvent: input.onEvent,
    providerOverride: input.options.providerId
      ? { providerId: input.options.providerId, model: input.options.model }
      : undefined,
  };
  const initialized = createQueenSession(queenOptions).then(({ orchestrator }) => orchestrator);
  return {
    completion: initialized.then((orchestrator) => orchestrator.run()),
    requestPause: async (reason) => (await initialized).requestPause(reason),
  };
}

export class DefaultDesktopRunManager implements DesktopRunManager {
  readonly #launcher: DesktopRuntimeLauncher;
  readonly #threadStoreFactory: (repositoryRoot: string) => ThreadStore;
  readonly #sessionIdFactory: () => string;
  readonly #clock: () => string;
  readonly #onEvent?: (event: DesktopEvent) => void;
  readonly #cancelTimeoutMs: number;
  readonly #codingSessionStoreFactory: (repositoryRoot: string) => Pick<CodingSessionStore, "load">;
  readonly #activeByRepository = new Map<string, ActiveRun>();
  readonly #setupLocks = new Map<string, Promise<void>>();

  public constructor(options: DefaultDesktopRunManagerOptions = {}) {
    this.#launcher = options.launcher ?? defaultLauncher;
    this.#threadStoreFactory = options.threadStoreFactory ?? ((root) => new JsonThreadStore(root));
    this.#sessionIdFactory = options.sessionIdFactory ?? createCodingSessionId;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#onEvent = options.onEvent;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000;
    this.#codingSessionStoreFactory = options.codingSessionStoreFactory ?? ((root) => new CodingSessionStore(root));
    if (!Number.isSafeInteger(this.#cancelTimeoutMs) || this.#cancelTimeoutMs < 1 || this.#cancelTimeoutMs > 60_000) {
      throw new RangeError("cancelTimeoutMs must be between 1 and 60,000 milliseconds.");
    }
  }

  public async start(request: DesktopRunStartRequest): Promise<ThreadRunRef> {
    const repositoryRoot = await this.#canonicalRepository(request.repositoryRoot);
    return this.#serializeSetup(repositoryRoot, async () => {
      const store = this.#threadStoreFactory(repositoryRoot);
      const thread = await this.#loadThread(store, request.threadId);
      if (thread.archived) throw new Error(`Desktop thread ${thread.id} is archived.`);
      if (thread.runs.some((run) => run.userMessageId === request.currentUserMessageId)) {
        throw new Error("The current user message already has a run.");
      }
      if (thread.runs.some((run) => !TERMINAL.has(run.status))) {
        throw new Error("The desktop thread already has a nonterminal run.");
      }
      const repositoryThreads = await store.list();
      if (repositoryThreads.some((candidate) => candidate.runs.some((run) => !TERMINAL.has(run.status)))) {
        throw new Error("The repository already has a persisted nonterminal desktop run.");
      }
      this.#assertRepositoryAvailable(repositoryRoot);

      const objective = buildThreadObjective(thread, request.currentUserMessageId);
      const sessionId = this.#sessionIdFactory();
      const timestamp = this.#clock();
      const run: ThreadRunRef = {
        userMessageId: request.currentUserMessageId,
        codingSessionId: sessionId,
        status: "created",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.#mutateThread(store, thread.id, (latest) => {
        if (latest.archived) throw new Error(`Desktop thread ${latest.id} is archived.`);
        if (latest.runs.some((candidate) => candidate.userMessageId === request.currentUserMessageId)) throw new Error("The current user message already has a run.");
        if (!latest.messages.some((message) => message.id === request.currentUserMessageId && message.role === "user")) throw new Error("The current user message is no longer available.");
        latest.runs.push(run);
      });
      this.#startBackground({
        repositoryRoot,
        threadId: thread.id,
        sessionId,
        objective,
        options: request.options,
      });
      this.#emit({ type: "run.changed", timestamp, run: { ...run } });
      return { ...run };
    });
  }

  public async resume(request: DesktopRunResumeRequest): Promise<ThreadRunRef> {
    const repositoryRoot = await this.#canonicalRepository(request.repositoryRoot);
    return this.#serializeSetup(repositoryRoot, async () => {
      const store = this.#threadStoreFactory(repositoryRoot);
      const thread = await this.#loadThread(store, request.threadId);
      if (thread.archived) throw new Error(`Desktop thread ${thread.id} is archived.`);
      const run = thread.runs.find((candidate) => candidate.codingSessionId === request.codingSessionId);
      if (!run) throw new Error(`Coding session ${request.codingSessionId} is not linked to thread ${thread.id}.`);
      if (run.status !== "paused") throw new Error("Only a paused coding session can be resumed.");
      if (thread.runs.some((candidate) => candidate !== run && !TERMINAL.has(candidate.status))) {
        throw new Error("The desktop thread already has another nonterminal run.");
      }
      const repositoryThreads = await store.list();
      if (repositoryThreads.some((candidate) =>
        candidate.id !== thread.id && candidate.runs.some((existing) => !TERMINAL.has(existing.status)))) {
        throw new Error("The repository already has another persisted nonterminal desktop run.");
      }
      this.#assertRepositoryAvailable(repositoryRoot);
      this.#startBackground({
        repositoryRoot,
        threadId: thread.id,
        sessionId: run.codingSessionId,
        resumeId: run.codingSessionId,
        options: request.options,
      });
      return { ...run };
    });
  }

  public async pause(request: DesktopRunReferenceRequest): Promise<void> {
    const repositoryRoot = await this.#canonicalRepository(request.repositoryRoot);
    const store = this.#threadStoreFactory(repositoryRoot);
    const thread = await this.#loadThread(store, request.threadId);
    const run = thread.runs.find((candidate) => candidate.codingSessionId === request.codingSessionId);
    if (!run) throw new Error(`Coding session ${request.codingSessionId} is not linked to thread ${thread.id}.`);
    if (run.status === "paused" || TERMINAL.has(run.status)) return;
    const active = this.#activeByRepository.get(repositoryRoot);
    if (!active || active.threadId !== request.threadId || active.sessionId !== request.codingSessionId) {
      throw new Error("Pause requires the active worker that owns this repository and coding session.");
    }
    if (!active.requestPause) await Promise.resolve();
    if (!active.requestPause) throw new Error("The active runtime does not support cooperative pause.");
    const accepted = await active.requestPause("Desktop pause requested.");
    if (!accepted) {
      const authoritative = await this.#codingSessionStoreFactory(repositoryRoot).load(request.codingSessionId).catch(() => null);
      if (authoritative && (authoritative.status === "paused" || TERMINAL.has(authoritative.status))) return;
      throw new Error("The coding session could not accept a cooperative pause.");
    }
    if (!(await this.#waitBounded(active.completion, this.#cancelTimeoutMs))) {
      throw new Error("The coding session did not reach a persisted pause boundary in time.");
    }
    await active.persistence;
    const authoritative = await this.#codingSessionStoreFactory(repositoryRoot).load(request.codingSessionId).catch(() => null);
    if (!authoritative || (authoritative.status !== "paused" && !TERMINAL.has(authoritative.status))) {
      throw new Error("The coding session stopped without persisting a paused or terminal state.");
    }
  }

  public async cancel(request: DesktopRunReferenceRequest): Promise<void> {
    const repositoryRoot = await this.#canonicalRepository(request.repositoryRoot);
    const store = this.#threadStoreFactory(repositoryRoot);
    const thread = await this.#loadThread(store, request.threadId);
    const run = thread.runs.find((candidate) => candidate.codingSessionId === request.codingSessionId);
    if (!run) throw new Error(`Coding session ${request.codingSessionId} is not linked to thread ${thread.id}.`);
    if (TERMINAL.has(run.status)) return;
    const active = this.#activeByRepository.get(repositoryRoot);
    if (!active || active.threadId !== request.threadId || active.sessionId !== request.codingSessionId) {
      const timestamp = this.#clock();
      this.#emit({
        type: "worker.failed",
        timestamp,
        codingSessionId: request.codingSessionId,
        message: "Cancellation could not verify worker completion; the run remains nonterminal.",
        recoverable: true,
      });
      throw new Error("Cancellation requires an active worker completion handle; the run remains nonterminal.");
    }
    active.controller.abort("User requested cancellation.");
    let completed = await this.#waitBounded(active.completion, this.#cancelTimeoutMs);
    let terminationFailure: string | undefined;
    if (!completed && active.forceTerminate) {
      const termination = Promise.resolve().then(() => active.forceTerminate?.());
      const terminationSettled = await this.#waitBounded(termination, this.#cancelTimeoutMs);
      if (terminationSettled) {
        await termination.catch((error) => {
          terminationFailure = redactDesktopError(error instanceof Error ? error.message : String(error));
        });
      } else {
        terminationFailure = "Force termination did not settle within the cancellation timeout.";
      }
    }
    if (!completed) completed = await this.#waitBounded(active.completion, this.#cancelTimeoutMs);
    if (!completed) {
      const timestamp = this.#clock();
      const detail = terminationFailure ? ` ${terminationFailure}` : "";
      this.#emit({
        type: "worker.failed",
        timestamp,
        codingSessionId: request.codingSessionId,
        message: redactDesktopError(`Worker did not stop after cancellation; the run remains nonterminal.${detail}`),
        recoverable: true,
      });
      throw new Error("Worker did not stop after cancellation; the run remains nonterminal.");
    }
    active.terminalOverride = true;
    await this.#persistStatus(active, "cancelled", this.#clock());
  }

  public async get(request: DesktopRunReferenceRequest): Promise<ThreadRunRef | null> {
    const repositoryRoot = await this.#canonicalRepository(request.repositoryRoot);
    const thread = await this.#loadThread(this.#threadStoreFactory(repositoryRoot), request.threadId);
    return thread.runs.find((run) => run.codingSessionId === request.codingSessionId) ?? null;
  }

  #startBackground(input: {
    repositoryRoot: string;
    threadId: string;
    sessionId: string;
    objective?: string;
    resumeId?: string;
    options: DesktopRunOptions;
  }): void {
    const controller = new AbortController();
    const active: ActiveRun = {
      repositoryRoot: input.repositoryRoot,
      threadId: input.threadId,
      sessionId: input.sessionId,
      controller,
      completion: Promise.resolve(),
      persistence: Promise.resolve(),
      terminalOverride: false,
    };
    this.#activeByRepository.set(input.repositoryRoot, active);
    active.completion = Promise.resolve().then(async () => {
      let expectedStop = true;
      let exitCode = 0;
      try {
        const launched = this.#launcher({
          repositoryRoot: input.repositoryRoot,
          sessionId: input.sessionId,
          objective: input.objective,
          resumeId: input.resumeId,
          options: input.options,
          signal: controller.signal,
          onEvent: (event) => {
            if (active.terminalOverride) return;
            this.#emit({ type: "runtime.event", timestamp: event.timestamp, event });
            const status = statusForEvent(event);
            if (status) this.#queueStatus(active, status, event.timestamp);
          },
        });
        if (isRuntimeHandle(launched)) {
          active.forceTerminate = launched.forceTerminate;
          active.requestPause = launched.requestPause;
        }
        const result = await (isRuntimeHandle(launched) ? launched.completion : launched);
        await active.persistence;
        if (!active.terminalOverride) await this.#persistStatus(active, result.status, result.updatedAt || this.#clock());
      } catch (error) {
        if (!controller.signal.aborted) {
          expectedStop = false;
          exitCode = 1;
        }
        await active.persistence;
        let status: CodingSessionStatus = controller.signal.aborted ? "cancelled" : "failed";
        if (!controller.signal.aborted) {
          const authoritative = await this.#codingSessionStoreFactory(input.repositoryRoot)
            .load(input.sessionId)
            .catch(() => null);
          if (authoritative && (authoritative.status === "paused" || TERMINAL.has(authoritative.status))) {
            status = authoritative.status;
          }
        }
        if (!active.terminalOverride) await this.#persistStatus(active, status, this.#clock());
        if (!controller.signal.aborted && !active.terminalOverride) {
          this.#emit({
            type: "worker.failed",
            timestamp: this.#clock(),
            codingSessionId: input.sessionId,
            message: redactDesktopError(error instanceof Error ? error.message : String(error)),
            recoverable: true,
          });
        }
      } finally {
        if (this.#activeByRepository.get(input.repositoryRoot) === active) {
          this.#activeByRepository.delete(input.repositoryRoot);
        }
        this.#emit({
          type: "worker.stopped",
          timestamp: this.#clock(),
          codingSessionId: input.sessionId,
          exitCode,
          expected: expectedStop,
        });
      }
    });
  }

  #queueStatus(active: ActiveRun, status: CodingSessionStatus, timestamp: string): void {
    if (active.terminalOverride) return;
    active.persistence = active.persistence.then(() => this.#persistStatus(active, status, timestamp));
  }

  async #persistStatus(active: ActiveRun, status: CodingSessionStatus, timestamp: string): Promise<void> {
    const store = this.#threadStoreFactory(active.repositoryRoot);
    const thread = await this.#mutateThread(store, active.threadId, (latest) => {
      const run = latest.runs.find((candidate) => candidate.codingSessionId === active.sessionId);
      if (!run) throw new Error(`Thread ${latest.id} lost coding session ${active.sessionId}.`);
      run.status = status;
      run.updatedAt = timestamp;
    });
    const run = thread.runs.find((candidate) => candidate.codingSessionId === active.sessionId)!;
    this.#emit({ type: "run.changed", timestamp, run: { ...run } });
  }

  async #loadThread(store: ThreadStore, threadId: string): Promise<ThreadRecordV1> {
    const thread = await store.load(threadId);
    if (!thread) throw new Error(`Desktop thread ${threadId} not found.`);
    return thread;
  }

  async #mutateThread(store: ThreadStore, threadId: string, update: (thread: ThreadRecordV1) => ThreadRecordV1 | void): Promise<ThreadRecordV1> {
    if (typeof store.mutate === "function") return store.mutate(threadId, update);
    const current = await this.#loadThread(store, threadId);
    const draft = structuredClone(current);
    return store.save(update(draft) ?? draft);
  }

  async #canonicalRepository(repositoryRoot: string): Promise<string> {
    if (typeof repositoryRoot !== "string" || repositoryRoot.trim().length === 0) {
      throw new Error("A repository root is required.");
    }
    const canonical = await fs.realpath(repositoryRoot);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error("The repository root must be a directory.");
    return canonical;
  }

  #assertRepositoryAvailable(repositoryRoot: string): void {
    if (this.#activeByRepository.has(repositoryRoot)) {
      throw new Error("An active desktop run already owns this repository.");
    }
  }

  async #serializeSetup<T>(repositoryRoot: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#setupLocks.get(repositoryRoot) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#setupLocks.set(repositoryRoot, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#setupLocks.get(repositoryRoot) === current) this.#setupLocks.delete(repositoryRoot);
    }
  }

  #emit(event: DesktopEvent): void {
    this.#onEvent?.(event);
  }

  async #waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
