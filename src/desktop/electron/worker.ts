import { DefaultDesktopRunManager } from "../run-manager.js";
import type { DesktopCommand, DesktopEvent, DesktopRunReferenceRequest } from "../types.js";
import type { DesktopWorkerInbound, DesktopWorkerOutbound } from "./worker-supervisor.js";
import { redactDesktopFailure } from "./security.js";
import { validateDesktopCommand } from "./contracts.js";
import { createQueenSession } from "../../coding/runtime.js";
import type { QueenOrchestrator, QueenSessionOptions } from "../../coding/queen.js";
import { withDesktopCredentialRuntime, type DesktopWorkerCredential } from "./worker-credential.js";
import { randomUUID } from "node:crypto";
import { packagedSmokeLauncher } from "./packaged-smoke-runtime.js";

const port = process.parentPort;
if (!port) throw new Error("HIVE desktop worker requires an Electron utility-process parent port.");

let current: DesktopRunReferenceRequest | null = null;
let exiting = false;
let exitRequested = false;
let commandsInFlight = 0;
let activeCredential: DesktopWorkerCredential | undefined;
const credentialRequests = new Map<string, { resolve: (credential: DesktopWorkerCredential) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function send(message: DesktopWorkerOutbound): void { port.postMessage(message); }
function event(value: DesktopEvent): void {
  send({ type: "desktop-event", event: value });
  if (value.type === "worker.stopped") requestExit();
}

const manager = new DefaultDesktopRunManager({
  onEvent: event,
  launcher: packagedSmokeLauncher() ?? ((input) => {
    const credential = activeCredential;
    activeCredential = undefined;
    let resolveOrchestrator!: (orchestrator: QueenOrchestrator) => void;
    let rejectOrchestrator!: (error: unknown) => void;
    const orchestratorReady = new Promise<QueenOrchestrator>((resolve, reject) => { resolveOrchestrator = resolve; rejectOrchestrator = reject; });
    void orchestratorReady.catch(() => undefined);
    const completion = withDesktopCredentialRuntime(credential, async (registry) => {
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
        providerOverride: input.options.providerId ? { providerId: input.options.providerId, model: input.options.model } : undefined,
        providerRegistries: registry ? { project: registry } : undefined,
      };
      const { orchestrator } = await createQueenSession(queenOptions);
      resolveOrchestrator(orchestrator);
      return orchestrator.run();
    }).catch((error) => { rejectOrchestrator(error); throw error; });
    return { completion, requestPause: async (reason?: string) => (await orchestratorReady).requestPause(reason) };
  }),
});

port.on("message", (messageEvent) => {
  const message = messageEvent.data as DesktopWorkerInbound;
  if (message?.type === "credential-response") {
    const pending = credentialRequests.get(message.requestId);
    if (!pending) return;
    credentialRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.error || !message.credential) pending.reject(new Error(message.error ?? "Desktop credential response was empty."));
    else pending.resolve(message.credential);
    return;
  }
  commandsInFlight += 1;
  void handle(message).catch((error) => {
    if (message?.type === "run-command" && (message.command?.type === "run.pause" || message.command?.type === "run.cancel")) {
      event({ type: "request.failed", timestamp: new Date().toISOString(), requestId: message.command.requestId, repositoryRoot: message.command.input.repositoryRoot, message: redactDesktopFailure(error), recoverable: true });
      return;
    }
    wipeCredentialState();
    send({ type: "error", message: redactDesktopFailure(error) });
    requestExit();
  }).finally(() => {
    commandsInFlight -= 1;
    if (exitRequested && commandsInFlight === 0) scheduleExit();
  });
});

send({ type: "ready" });

async function handle(message: DesktopWorkerInbound): Promise<void> {
  if (!message || typeof message !== "object") throw new Error("Malformed desktop worker message.");
  if (message.type === "cancel-all") {
    if (current) await manager.cancel(current);
    requestExit();
    return;
  }
  if (message.type !== "run-command") throw new Error("Unsupported desktop worker message.");
  const validated = validateDesktopCommand(message.command);
  if (validated.type !== "run.start" && validated.type !== "run.pause" && validated.type !== "run.resume" && validated.type !== "run.cancel") throw new Error("Worker accepts only run commands.");
  const command: Extract<DesktopCommand, { type: "run.start" | "run.pause" | "run.resume" | "run.cancel" }> = validated;
  if (command.type === "run.start" || command.type === "run.resume") activeCredential = command.input.options.providerId ? await requestCredential(command.input.options.providerId) : undefined;
  if (command.type === "run.start") {
    const run = await manager.start(command.input);
    current = { repositoryRoot: command.input.repositoryRoot, threadId: command.input.threadId, codingSessionId: run.codingSessionId };
    event({ type: "worker.started", timestamp: new Date().toISOString(), codingSessionId: run.codingSessionId, processId: process.pid });
  } else if (command.type === "run.resume") {
    const run = await manager.resume(command.input);
    current = { repositoryRoot: command.input.repositoryRoot, threadId: command.input.threadId, codingSessionId: run.codingSessionId };
    event({ type: "worker.started", timestamp: new Date().toISOString(), codingSessionId: run.codingSessionId, processId: process.pid });
  } else if (command.type === "run.pause") {
    await manager.pause(command.input);
    wipeCredentialState();
    requestExit();
  } else {
    await manager.cancel(command.input);
    requestExit();
  }
  event({ type: "request.completed", timestamp: new Date().toISOString(), requestId: command.requestId });
}

function requestExit(): void {
  exitRequested = true;
  if (commandsInFlight === 0) scheduleExit();
}

function scheduleExit(): void {
  if (exiting) return;
  exiting = true;
  wipeCredentialState();
  setTimeout(() => process.exit(0), 20).unref();
}

function wipeCredentialState(): void {
  if (activeCredential?.secret) activeCredential.secret = undefined;
  activeCredential = undefined;
  for (const [requestId, pending] of credentialRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Desktop run ended before credential delivery."));
    credentialRequests.delete(requestId);
  }
}

function requestCredential(providerId: string): Promise<DesktopWorkerCredential> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      credentialRequests.delete(requestId);
      reject(new Error("Desktop credential request timed out."));
    }, 10_000);
    timer.unref();
    credentialRequests.set(requestId, { resolve, reject, timer });
    send({ type: "credential-request", requestId, providerId });
  });
}
