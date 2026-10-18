import { randomUUID } from "node:crypto";
import type { AcceptedRun, EngineHandle, EngineHooks, EngineOutcome, EngineUserEvent, SessionEngineAdapter } from "../../projects/types.js";
import type { DesktopWorkerCredential } from "./worker-credential.js";
import { redactDesktopFailure } from "./security.js";
import { validateEngineOutcome, validateEngineUserEvent } from "../../projects/store.js";

export type ProjectWorkerInbound =
  | { type: "project.start"; input: AcceptedRun; credential?: DesktopWorkerCredential }
  | { type: "project.cancel"; reason: string }
  | { type: "project.ack"; id: string; approved?: boolean; error?: string };
export type ProjectWorkerOutbound =
  | { type: "project.event"; id: string; event: EngineUserEvent }
  | { type: "project.approval"; id: string; input: Parameters<EngineHooks["requestApproval"]>[0] }
  | { type: "project.completed"; outcome: EngineOutcome }
  | { type: "project.failed"; message: string };
export interface ProjectWorkerChild {
  pid?: number;
  postMessage(message: ProjectWorkerInbound): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(): boolean | void;
}

/** Each run has one utility process. Only its declared provider credential crosses this boundary. */
export class ProjectWorkerEngine implements SessionEngineAdapter {
  readonly #runs = new Map<string, { cancel: (reason: string) => void; completion: Promise<EngineOutcome> }>();
  constructor(private readonly options: {
    spawn(): ProjectWorkerChild;
    resolveCredential(providerId: string): Promise<DesktopWorkerCredential | undefined>;
    cancellationTimeoutMs?: number;
    terminateTree?: (child: ProjectWorkerChild) => Promise<void>;
  }) {}
  hasActiveRuns(): boolean { return this.#runs.size > 0; }
  async close(): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) run.cancel("Desktop closed");
    await Promise.allSettled(runs.map((run) => run.completion));
  }
  async start(input: AcceptedRun, hooks: EngineHooks): Promise<EngineHandle> {
    const credential = input.run.settings.providerId ? await this.options.resolveCredential(input.run.settings.providerId) : undefined;
    const child = this.options.spawn();
    let settled = false;
    let exited = false;
    let cancelled = false;
    let forced = false;
    let deliveryFailed = false;
    let fatalMessage: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (outcome: EngineOutcome) => void;
    const completion = new Promise<EngineOutcome>((done) => { resolve = done; });
    const finish = (outcome: EngineOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      this.#runs.delete(input.run.id);
      resolve(outcome);
    };
    const reply = (message: ProjectWorkerInbound) => { if (!settled && !exited) child.postMessage(message); };
    const terminate = (error?: unknown) => {
      if (settled || exited) return;
      forced = true;
      if (error) fatalMessage = redactDesktopFailure(error);
      // A kill request is not proof of exit. Keep ownership until exit is observed.
      void (async () => {
        if (this.options.terminateTree) await this.options.terminateTree(child);
        else if (child.kill() === false) throw new Error("Worker refused termination; cancellation remains unconfirmed.");
      })().catch((failure) => { fatalMessage = redactDesktopFailure(failure); });
    };
    // Serial persistence acknowledgements prevent completion from overtaking durable activity.
    let pending = Promise.resolve();
    child.on("message", (untrusted) => {
      if (!untrusted || typeof untrusted !== "object" || Array.isArray(untrusted)) return;
      const message = untrusted as ProjectWorkerOutbound;
      if (message.type === "project.event" || message.type === "project.approval") {
        const operation = async () => {
          if (settled) return;
          try {
            if (typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id)) throw new Error("Invalid project worker acknowledgement id.");
            if (message.type === "project.event") { await hooks.persist(validateEngineUserEvent(message.event)); reply({ type: "project.ack", id: message.id }); }
            else {
              // Approval waits must not block cancellation or other already persisted events.
              void hooks.requestApproval(message.input).then((approved) => reply({ type: "project.ack", id: message.id, approved }), (error) => reply({ type: "project.ack", id: message.id, error: redactDesktopFailure(error) })).catch(terminate);
            }
          } catch (error) { reply({ type: "project.ack", id: message.id, error: redactDesktopFailure(error) }); }
        };
        pending = pending.then(operation).catch(terminate);
      } else if (message.type === "project.completed") {
        pending = pending.then(() => finish(validateEngineOutcome(message.outcome))).catch(terminate);
      } else if (message.type === "project.failed") {
        // Failure messages precede worker shutdown; only exit releases ownership.
        pending = pending.then(() => { fatalMessage = redactDesktopFailure(message.message); });
      }
    });
    child.on("exit", (code) => {
      exited = true;
      if (timer) clearTimeout(timer);
      void pending.then(() => finish({ status: cancelled && !forced && !deliveryFailed ? "cancelled" : fatalMessage && !forced ? "failed" : "interrupted", summary: fatalMessage ?? `Runtime exited before completion (code ${code ?? "unknown"}).` }));
    });
    const cancel = (reason: string) => {
      if (settled || exited || cancelled) return;
      cancelled = true;
      try { child.postMessage({ type: "project.cancel", reason }); }
      catch (error) { deliveryFailed = true; fatalMessage = redactDesktopFailure(error); }
      timer = setTimeout(() => {
        terminate(new Error("Runtime did not acknowledge cancellation; waiting for verified worker exit."));
      }, this.options.cancellationTimeoutMs ?? 35_000);
      timer.unref();
    };
    this.#runs.set(input.run.id, { cancel, completion });
    try { child.postMessage({ type: "project.start", input, credential }); }
    catch (error) { terminate(error); }
    finally { if (credential?.secret) credential.secret = undefined; }
    return { completion, cancel };
  }
}

export const projectWorkerMessageId = (): string => randomUUID();
