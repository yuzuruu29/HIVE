import { createProductionSessionEngine, type ProductionSessionEngineOptions } from "../../projects/runtime-adapter.js";
import type { EngineHandle, EngineHooks } from "../../projects/types.js";
import { withDesktopCredentialRuntime } from "./worker-credential.js";
import { projectWorkerMessageId, type ProjectWorkerInbound, type ProjectWorkerOutbound } from "./project-worker.js";
import { redactDesktopFailure } from "./security.js";

export function createProjectWorkerHost(send: (message: ProjectWorkerOutbound) => void, exit: () => void, options: ProductionSessionEngineOptions = {}): (message: unknown) => boolean {
  let started = false;
  let cancelled: string | undefined;
  let handle: EngineHandle | undefined;
  const acknowledgements = new Map<string, { approval: boolean; resolve(value: boolean): void; reject(error: Error): void }>();
  const request = (message: Extract<ProjectWorkerOutbound, { id: string }>): Promise<boolean> => new Promise((resolve, reject) => {
    acknowledgements.set(message.id, { approval: message.type === "project.approval", resolve, reject });
    send(message);
  });
  return (untrusted) => {
    if (!untrusted || typeof untrusted !== "object" || Array.isArray(untrusted)) return false;
    const message = untrusted as ProjectWorkerInbound;
    if (message.type === "project.ack") {
      const pending = acknowledgements.get(message.id);
      if (pending) {
        acknowledgements.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.approved ?? true);
      }
      return true;
    }
    if (message.type === "project.cancel") {
      cancelled = typeof message.reason === "string" ? message.reason : "Cancelled";
      void Promise.resolve(handle?.cancel(cancelled)).catch((error) => send({ type: "project.failed", message: redactDesktopFailure(error) }));
      // Cancellation declines approvals; durable event writes must still acknowledge or fail honestly.
      for (const [id, pending] of acknowledgements) if (pending.approval) {
        acknowledgements.delete(id);
        pending.resolve(false);
      }
      return true;
    }
    if (message.type !== "project.start") return false;
    if (started) { send({ type: "project.failed", message: "Worker already owns a run." }); return true; }
    started = true;
    const hooks: EngineHooks = {
      persist: async (event) => { await request({ type: "project.event", id: projectWorkerMessageId(), event }); },
      requestApproval: (input) => request({ type: "project.approval", id: projectWorkerMessageId(), input }),
    };
    void withDesktopCredentialRuntime(message.credential, async (registry) => {
      handle = await createProductionSessionEngine({ ...options, providerRegistries: registry ? { project: registry } : options.providerRegistries }).start(message.input, hooks);
      if (cancelled) await handle.cancel(cancelled);
      send({ type: "project.completed", outcome: await handle.completion });
    }).catch((error) => send({ type: "project.failed", message: redactDesktopFailure(error) })).finally(() => {
      for (const pending of acknowledgements.values()) pending.reject(new Error("Runtime ended"));
      acknowledgements.clear();
      exit();
    });
    return true;
  };
}
