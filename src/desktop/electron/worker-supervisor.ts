import path from "node:path";
import type { DesktopCommand, DesktopEvent } from "../types.js";
import { redactDesktopFailure } from "./security.js";
import { validateDesktopEvent } from "./contracts.js";
import type { DesktopWorkerCredential } from "./worker-credential.js";
import { JsonThreadStore } from "../thread-store.js";
import { CodingSessionStore } from "../../coding/session-store.js";
import type { CodingSessionStatus } from "../../coding/types.js";
import type { ThreadRecordV1, ThreadStore } from "../types.js";

export interface WorkerChildLike {
  pid?: number;
  postMessage(message: DesktopWorkerInbound): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(): void;
}

export type DesktopWorkerInbound =
  | { type: "run-command"; command: Extract<DesktopCommand, { type: "run.start" | "run.pause" | "run.resume" | "run.cancel" }> }
  | { type: "cancel-all" }
  | { type: "credential-response"; requestId: string; credential?: DesktopWorkerCredential; error?: string };

export type DesktopWorkerOutbound =
  | { type: "desktop-event"; event: DesktopEvent }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "credential-request"; requestId: string; providerId: string };

export interface WorkerProcessSupervisorOptions {
  spawn: (workerModule: string) => WorkerChildLike;
  workerModule: string;
  cancelTimeoutMs?: number;
  onEvent: (event: DesktopEvent) => void;
  clock?: () => string;
  canonicalize?: (repositoryRoot: string) => Promise<string>;
  resolveCredential?: (providerId: string) => Promise<DesktopWorkerCredential>;
  threadStoreFactory?: (repositoryRoot: string) => Pick<ThreadStore, "list" | "save"> & Partial<Pick<ThreadStore, "mutate">>;
  codingSessionStoreFactory?: (repositoryRoot: string) => Pick<CodingSessionStore, "load"> & Partial<Pick<CodingSessionStore, "save">>;
}

const MAX_PENDING_CONTROL_REQUESTS = 64;

type ControlCommandType = "run.pause" | "run.cancel";

interface PendingAck { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
interface OwnedWorker { repositoryRoot: string; threadId: string; codingSessionId?: string; runRequestId: string; pendingControlRequests: Map<string, ControlCommandType>; pendingAcks: Map<string, PendingAck>; child: WorkerChildLike; expectedExit: boolean; cancellationRequested: boolean; forcedCancellationPending: boolean; exitFailure?: Error; declaredProviderId?: string; credentialDelivered: boolean; exited: Promise<void>; resolveExit: () => void }

export class WorkerProcessSupervisor {
  readonly #workers = new Map<string, OwnedWorker>();
  readonly #cancelTimeoutMs: number;
  readonly #clock: () => string;

  public constructor(private readonly options: WorkerProcessSupervisorOptions) {
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? 35_000;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    if (!Number.isSafeInteger(this.#cancelTimeoutMs) || this.#cancelTimeoutMs < 1 || this.#cancelTimeoutMs > 60_000) throw new RangeError("cancelTimeoutMs is invalid.");
  }

  public hasActiveRuns(): boolean { return this.#workers.size > 0; }
  public hasActiveRepository(repositoryRoot: string): boolean { return this.#workers.has(this.#key(repositoryRoot)); }

  public async start(repositoryRoot: string, command: Extract<DesktopCommand, { type: "run.start" | "run.resume" }>): Promise<void> {
    await this.dispatch(repositoryRoot, command);
  }

  public async dispatchAndWait(repositoryRoot: string, command: Extract<DesktopCommand, { type: "run.start" | "run.pause" | "run.resume" | "run.cancel" }>): Promise<void> {
    await this.dispatch(repositoryRoot, command, true);
  }

  public async dispatch(repositoryRoot: string, command: Extract<DesktopCommand, { type: "run.start" | "run.pause" | "run.resume" | "run.cancel" }>, waitForAck = false): Promise<void> {
    repositoryRoot = await (this.options.canonicalize?.(repositoryRoot) ?? Promise.resolve(path.resolve(repositoryRoot)));
    const key = this.#key(repositoryRoot);
    const existing = this.#workers.get(key);
    if (existing) {
      if (command.type !== "run.cancel" && command.type !== "run.pause") throw new Error("A desktop worker is already active for this repository.");
      if (command.input.threadId !== existing.threadId || !existing.codingSessionId || command.input.codingSessionId !== existing.codingSessionId) {
        throw new Error(`${command.type === "run.pause" ? "Pause" : "Cancellation"} does not match the active worker thread and coding session.`);
      }
      if (command.requestId === existing.runRequestId) throw new Error("Control request id conflicts with the active run request id.");
      const pendingType = existing.pendingControlRequests.get(command.requestId);
      if (pendingType) {
        if (pendingType !== command.type) throw new Error("Control request id is already pending for a different command.");
        const pendingAck = existing.pendingAcks.get(command.requestId);
        if (!pendingAck) throw new Error("Pending worker request lost its acknowledgement handle.");
        if (waitForAck) await pendingAck.promise;
        return;
      }
      if (existing.pendingControlRequests.size >= MAX_PENDING_CONTROL_REQUESTS) throw new Error("Too many pending worker control requests.");
      existing.pendingControlRequests.set(command.requestId, command.type);
      const ack = this.#ack(existing, command.requestId);
      try { existing.child.postMessage({ type: "run-command", command }); }
      catch (error) { existing.pendingControlRequests.delete(command.requestId); existing.pendingAcks.delete(command.requestId); ack.reject(error instanceof Error ? error : new Error(String(error))); throw error; }
      if (waitForAck) await ack.promise;
      return;
    }
    if (command.type === "run.pause") throw new Error("Pause requires the active worker that owns this repository.");
    const child = this.options.spawn(this.options.workerModule);
    let resolveExit!: () => void;
    const owned: OwnedWorker = { repositoryRoot, threadId: command.input.threadId, codingSessionId: command.type === "run.resume" ? command.input.codingSessionId : undefined, runRequestId: command.requestId, pendingControlRequests: new Map(), pendingAcks: new Map(), child, expectedExit: false, cancellationRequested: false, forcedCancellationPending: false, declaredProviderId: command.type === "run.cancel" ? undefined : command.input.options.providerId, credentialDelivered: false, exited: new Promise((resolve) => { resolveExit = resolve; }), resolveExit };
    this.#workers.set(key, owned);
    const codingSessionId = command.type === "run.start" ? "pending" : command.input.codingSessionId;
    this.options.onEvent({ type: "worker.starting", timestamp: this.#clock(), codingSessionId, repositoryRoot, requestId: command.requestId });
    child.on("message", (message) => { void this.#onMessage(message, owned).catch((error) => this.options.onEvent({ type: "worker.failed", timestamp: this.#clock(), repositoryRoot: owned.repositoryRoot, requestId: owned.runRequestId, codingSessionId: owned.codingSessionId, message: redactDesktopFailure(error), recoverable: true })); });
    child.on("exit", (code) => {
      void this.#finishExit(key, owned, command, code);
    });
    const ack = this.#ack(owned, command.requestId);
    try { child.postMessage({ type: "run-command", command }); }
    catch (error) { this.#workers.delete(key); owned.pendingAcks.delete(command.requestId); ack.reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    if (waitForAck) await ack.promise;
  }

  public async cancelRepository(repositoryRoot: string): Promise<void> {
    repositoryRoot = await (this.options.canonicalize?.(repositoryRoot) ?? Promise.resolve(path.resolve(repositoryRoot)));
    const owned = this.#workers.get(this.#key(repositoryRoot));
    if (!owned) return;
    if (owned.forcedCancellationPending) {
      await this.#persistForcedCancellation(owned);
      owned.forcedCancellationPending = false;
      owned.exitFailure = undefined;
      if (this.#workers.get(this.#key(repositoryRoot)) === owned) this.#workers.delete(this.#key(repositoryRoot));
      return;
    }
    owned.cancellationRequested = true;
    owned.child.postMessage({ type: "cancel-all" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      owned.exited.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.#cancelTimeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (exited) {
      if (owned.exitFailure) throw owned.exitFailure;
      return;
    }
    if (!exited) {
      owned.forcedCancellationPending = true;
      owned.child.kill();
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([owned.exited, new Promise<void>((resolve) => { killTimer = setTimeout(resolve, 5_000); })]);
      if (killTimer) clearTimeout(killTimer);
      if (this.#workers.get(this.#key(repositoryRoot)) !== owned) return;
      if (owned.exitFailure) throw owned.exitFailure;
      await this.#persistForcedCancellation(owned);
      owned.forcedCancellationPending = false;
      if (this.#workers.get(this.#key(repositoryRoot)) === owned) this.#workers.delete(this.#key(repositoryRoot));
      owned.resolveExit();
    }
  }

  public async cancelAll(): Promise<void> { await Promise.all([...this.#workers.values()].map((worker) => this.cancelRepository(worker.repositoryRoot))); }

  public async reconcileRepositoryRuns(repositoryRoot: string): Promise<void> {
    repositoryRoot = await (this.options.canonicalize?.(repositoryRoot) ?? Promise.resolve(path.resolve(repositoryRoot)));
    if (this.#workers.has(this.#key(repositoryRoot))) throw new Error("Cannot reconcile a repository while its desktop worker is active.");
    await this.#reconcileCrash(repositoryRoot);
  }

  async #onMessage(message: unknown, owned: OwnedWorker): Promise<void> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const candidate = message as Partial<DesktopWorkerOutbound>;
    if (candidate.type === "credential-request") {
      const requestId = typeof candidate.requestId === "string" ? candidate.requestId : "invalid";
      try {
        if (!this.options.resolveCredential || typeof candidate.providerId !== "string") throw new Error("Desktop credential resolver is unavailable.");
        if (!owned.declaredProviderId || candidate.providerId !== owned.declaredProviderId) throw new Error("Credential request provider does not match the run's declared provider.");
        if (owned.credentialDelivered) throw new Error("Desktop credential was already delivered to this run.");
        owned.credentialDelivered = true;
        let credential: DesktopWorkerCredential;
        try { credential = await this.options.resolveCredential(candidate.providerId); }
        catch (error) { owned.credentialDelivered = false; throw error; }
        if (this.#workers.get(this.#key(owned.repositoryRoot)) !== owned) {
          if (credential.secret) credential.secret = undefined;
          return;
        }
        owned.child.postMessage({ type: "credential-response", requestId, credential });
      } catch (error) {
        if (this.#workers.get(this.#key(owned.repositoryRoot)) === owned) {
          owned.child.postMessage({ type: "credential-response", requestId, error: redactDesktopFailure(error) });
        }
      }
      return;
    }
    if (candidate.type === "desktop-event" && candidate.event) {
      try {
        const event = validateDesktopEvent(candidate.event);
        if (event.type === "worker.started") owned.codingSessionId = event.codingSessionId;
        if (event.type === "worker.stopped" && event.expected) owned.expectedExit = true;
        const childRequestId = event.requestId;
        if (childRequestId && childRequestId !== owned.runRequestId && !owned.pendingControlRequests.has(childRequestId)) {
          throw new Error("Worker event request id does not belong to the active run or a pending control request.");
        }
        if (childRequestId && (event.type === "request.completed" || event.type === "request.failed")) {
          const ack = owned.pendingAcks.get(childRequestId);
          if (!ack) throw new Error("Worker acknowledgement does not belong to a pending request.");
          owned.pendingAcks.delete(childRequestId);
          owned.pendingControlRequests.delete(childRequestId);
          if (event.type === "request.completed") ack.resolve();
          else ack.reject(new Error(event.message));
          return;
        }
        this.options.onEvent({ ...event, repositoryRoot: owned.repositoryRoot, requestId: childRequestId ?? owned.runRequestId });
      }
      catch (error) { this.options.onEvent({ type: "worker.failed", timestamp: this.#clock(), repositoryRoot: owned.repositoryRoot, requestId: owned.runRequestId, message: redactDesktopFailure(error), recoverable: true }); }
    }
    else if (candidate.type === "error") {
      this.options.onEvent({ type: "worker.failed", timestamp: this.#clock(), repositoryRoot: owned.repositoryRoot, requestId: owned.runRequestId, message: redactDesktopFailure(candidate.message), recoverable: true });
    }
  }

  #key(repositoryRoot: string): string { const resolved = path.resolve(repositoryRoot); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }

  #ack(owned: OwnedWorker, requestId: string): PendingAck {
    const existing = owned.pendingAcks.get(requestId);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    void promise.catch(() => undefined);
    const ack = { promise, resolve, reject };
    owned.pendingAcks.set(requestId, ack);
    return ack;
  }

  async #finishExit(
    key: string,
    owned: OwnedWorker,
    command: Extract<DesktopCommand, { type: "run.start" | "run.pause" | "run.resume" | "run.cancel" }>,
    code: number | null,
  ): Promise<void> {
    owned.pendingControlRequests.clear();
    const exitError = new Error(`Desktop worker exited before acknowledging request (code ${code ?? "unknown"}).`);
    for (const ack of owned.pendingAcks.values()) ack.reject(exitError);
    owned.pendingAcks.clear();
    if (owned.expectedExit) {
      if (!owned.forcedCancellationPending && this.#workers.get(key) === owned) this.#workers.delete(key);
      owned.resolveExit();
      return;
    }
    if (owned.cancellationRequested) {
      owned.forcedCancellationPending = true;
      try {
        await this.#persistForcedCancellation(owned);
        owned.forcedCancellationPending = false;
        owned.exitFailure = undefined;
        if (this.#workers.get(key) === owned) this.#workers.delete(key);
      } catch (error) {
        owned.exitFailure = error instanceof Error ? error : new Error(String(error));
        this.options.onEvent({ type: "worker.failed", timestamp: this.#clock(), repositoryRoot: owned.repositoryRoot, requestId: owned.runRequestId, codingSessionId: owned.codingSessionId, message: redactDesktopFailure(`Forced cancellation persistence failed: ${owned.exitFailure.message}`), recoverable: false });
      } finally {
        owned.resolveExit();
      }
      return;
    }
    let recoveryError: unknown;
    try {
      await this.#reconcileCrash(owned.repositoryRoot);
    } catch (error) {
      recoveryError = error;
    } finally {
      if (this.#workers.get(key) === owned) this.#workers.delete(key);
      owned.resolveExit();
    }
    if (recoveryError) {
      this.options.onEvent({ type: "worker.failed", timestamp: this.#clock(), repositoryRoot: owned.repositoryRoot, requestId: command.requestId, codingSessionId: command.type === "run.start" ? undefined : command.input.codingSessionId, message: redactDesktopFailure(`Worker crash recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`), recoverable: true });
      return;
    }
    this.options.onEvent({ type: "worker.failed", timestamp: this.#clock(), repositoryRoot: owned.repositoryRoot, requestId: command.requestId, codingSessionId: command.type === "run.start" ? undefined : command.input.codingSessionId, message: redactDesktopFailure(`Desktop worker exited unexpectedly with code ${code ?? "unknown"}.`), recoverable: true });
  }

  async #reconcileCrash(repositoryRoot: string): Promise<void> {
    const threads = this.options.threadStoreFactory?.(repositoryRoot) ?? new JsonThreadStore(repositoryRoot);
    const sessions = this.options.codingSessionStoreFactory?.(repositoryRoot) ?? new CodingSessionStore(repositoryRoot);
    const terminal = new Set<CodingSessionStatus>(["completed", "failed", "cancelled"]);
    for (const thread of await threads.list()) {
      let changed = false;
      const reconciled = [];
      for (const run of thread.runs) {
        if (terminal.has(run.status) || run.status === "paused") continue;
        const authoritative = await sessions.load(run.codingSessionId).catch(() => null);
        const status: CodingSessionStatus = authoritative && (authoritative.status === "paused" || terminal.has(authoritative.status)) ? authoritative.status : "failed";
        run.status = status;
        run.updatedAt = authoritative?.updatedAt ?? this.#clock();
        changed = true;
        reconciled.push({ ...run });
      }
      if (changed) {
        thread.updatedAt = this.#clock();
        await threads.save(thread);
        for (const run of reconciled) this.options.onEvent({ type: "run.changed", timestamp: run.updatedAt, repositoryRoot, requestId: "reconcile", run });
      }
    }
  }

  async #persistForcedCancellation(owned: OwnedWorker): Promise<void> {
    if (!owned.codingSessionId) throw new Error("Forced cancellation could not identify the coding session.");
    const timestamp = this.#clock();
    const threads = this.options.threadStoreFactory?.(owned.repositoryRoot) ?? new JsonThreadStore(owned.repositoryRoot);
    const thread = (await threads.list()).find((candidate) => candidate.id === owned.threadId);
    if (!thread) throw new Error("Forced cancellation could not find the owning thread.");
    const apply = (latest: ThreadRecordV1) => {
      const run = latest.runs.find((candidate) => candidate.codingSessionId === owned.codingSessionId);
      if (!run) throw new Error("Forced cancellation could not find the thread run.");
      run.status = "cancelled";
      run.updatedAt = timestamp;
      latest.updatedAt = timestamp;
      return latest;
    };
    const sessions = this.options.codingSessionStoreFactory?.(owned.repositoryRoot) ?? new CodingSessionStore(owned.repositoryRoot);
    const record = await sessions.load(owned.codingSessionId);
    if (!record || !sessions.save) throw new Error("Forced cancellation could not persist the coding session.");
    await sessions.save({ ...record, status: "cancelled", updatedAt: timestamp });
    const persistedThread = threads.mutate ? await threads.mutate(thread.id, apply) : await threads.save(apply(thread));
    this.options.onEvent({ type: "run.changed", timestamp, repositoryRoot: owned.repositoryRoot, requestId: owned.runRequestId, run: persistedThread.runs.find((candidate) => candidate.codingSessionId === owned.codingSessionId)! });
  }
}
