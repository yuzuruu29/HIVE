import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DefaultDesktopRunManager } from "../../dist/desktop/run-manager.js";
import { CodingSessionStore } from "../../dist/coding/session-store.js";
import { WorktreeManager, branchNameForTask } from "../../dist/worktree.js";
import { validateDesktopCommand } from "../../dist/desktop/electron/contracts.js";

const port = process.parentPort;
if (!port) throw new Error("The deterministic desktop fixture requires an Electron utility-process parent port.");
let current = null;
let exiting = false;
let exitRequested = false;
let commandsInFlight = 0;

const manager = new DefaultDesktopRunManager({
  onEvent: emit,
  launcher: (input) => deterministicLaunch(input),
});

port.on("message", ({ data: message }) => {
  commandsInFlight += 1;
  void handle(message).catch((error) => {
    port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    requestExit();
  }).finally(() => {
    commandsInFlight -= 1;
    if (exitRequested && commandsInFlight === 0) scheduleExit();
  });
});
port.postMessage({ type: "ready" });

async function handle(message) {
  if (message?.type === "cancel-all") {
    if (current) await manager.cancel(current);
    requestExit();
    return;
  }
  if (message?.type !== "run-command") throw new Error("Unsupported deterministic fixture message.");
  const command = validateDesktopCommand(message.command);
  if (!["run.start", "run.pause", "run.resume", "run.cancel"].includes(command.type)) throw new Error("Fixture accepts only run commands.");
  if (command.type === "run.start") {
    const run = await manager.start(command.input);
    current = { repositoryRoot: command.input.repositoryRoot, threadId: command.input.threadId, codingSessionId: run.codingSessionId };
    emit({ type: "worker.started", timestamp: new Date().toISOString(), codingSessionId: run.codingSessionId, processId: process.pid });
  } else if (command.type === "run.resume") {
    const run = await manager.resume(command.input);
    current = { repositoryRoot: command.input.repositoryRoot, threadId: command.input.threadId, codingSessionId: run.codingSessionId };
    emit({ type: "worker.started", timestamp: new Date().toISOString(), codingSessionId: run.codingSessionId, processId: process.pid });
  } else if (command.type === "run.pause") {
    await manager.pause(command.input);
  } else {
    await manager.cancel(command.input);
  }
  emit({ type: "request.completed", timestamp: new Date().toISOString(), requestId: command.requestId });
}

function deterministicLaunch(input) {
  let settle;
  const gate = new Promise((resolve) => { settle = resolve; });
  // Desktop objectives render the current message first and append prior
  // conversation blocks. Only the current turn may control this fixture;
  // otherwise an earlier hold marker would stall every follow-up turn.
  const currentTurn = input.objective?.split("\n\n[prior", 1)[0] ?? "";
  const hold = currentTurn.includes("[hold]");
  const abort = () => settle("cancel");
  input.signal.addEventListener("abort", abort, { once: true });
  const completion = (async () => {
    const timestamp = new Date().toISOString();
    const worktrees = new WorktreeManager(input.repositoryRoot);
    const worktreePath = await worktrees.createWorktree(input.sessionId);
    const outputPath = path.join(worktreePath, "hive-desktop-fixture.txt");
    const previous = await readFile(outputPath, "utf8").catch(() => "");
    await writeFile(outputPath, `${previous}verified session ${input.sessionId}\n`, "utf8");
    const created = makeRecord(input, timestamp, worktreePath, previous ? "modified" : "created", "running");
    await new CodingSessionStore(input.repositoryRoot).save(created);
    input.onEvent(runtimeEvent(input.sessionId, 1, "session.started", { repository: created.repository }));
    const outcome = hold ? await gate : "complete";
    input.signal.removeEventListener("abort", abort);
    const completedAt = new Date().toISOString();
    if (outcome === "cancel") {
      const cancelled = { ...created, status: "cancelled", cancelledAt: completedAt, cancellationReason: "Deterministic cancellation", updatedAt: completedAt };
      await new CodingSessionStore(input.repositoryRoot).save(cancelled);
      throw new Error("Deterministic run cancelled.");
    }
    if (outcome === "pause") {
      const paused = { ...created, status: "paused", updatedAt: completedAt };
      await new CodingSessionStore(input.repositoryRoot).save(paused);
      input.onEvent(runtimeEvent(input.sessionId, 2, "session.paused", { reason: "Desktop pause requested." }));
      return paused;
    }
    const completed = {
      ...created,
      status: "completed",
      updatedAt: completedAt,
      finalReport: {
        result: "Deterministic desktop run complete",
        subagents: { total: 1, active: 0, working: 0, waiting: 0, blocked: 0, done: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
        filesChanged: ["hive-desktop-fixture.txt"],
        validation: [{ label: "deterministic fixture", status: "passed" }],
        review: ["Exact recorded file approved by deterministic reviewer."],
        outstanding: [], completedAt,
      },
    };
    await new CodingSessionStore(input.repositoryRoot).save(completed);
    input.onEvent(runtimeEvent(input.sessionId, 2, "session.completed", { report: completed.finalReport }));
    return completed;
  })();
  return { completion, requestPause: () => { if (!hold) return false; settle("pause"); return true; } };
}

function makeRecord(input, timestamp, worktreePath, operation, status) {
  return {
    schemaVersion: 1,
    id: input.sessionId,
    objective: input.objective ?? "Resume deterministic desktop run",
    mode: input.options.mode,
    approvalPolicy: input.options.approvalPolicy,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    repository: { root: input.repositoryRoot, worktreePath, capturedAt: timestamp, branch: branchNameForTask(input.sessionId), dirty: false, changedFiles: ["hive-desktop-fixture.txt"] },
    tasks: [], events: [], providerBindings: [],
    validationResults: [{ id: "fixture-validation", command: "fixture:validate", status: "passed", startedAt: timestamp, completedAt: timestamp, exitCode: 0, output: "passed" }],
    reviewResults: [{ id: "fixture-review", status: "passed", summary: "Deterministic review passed.", findings: [], completedAt: timestamp }],
    files: [{ path: "hive-desktop-fixture.txt", operation, recordedAt: timestamp }],
  };
}

function runtimeEvent(sessionId, sequence, type, payload) {
  return { schemaVersion: 1, id: `fixture-${sessionId}-${sequence}`, sequence, sessionId, timestamp: new Date().toISOString(), type, payload };
}

function emit(event) {
  port.postMessage({ type: "desktop-event", event });
  if (event.type === "worker.stopped") requestExit();
}
function requestExit() { exitRequested = true; if (commandsInFlight === 0) scheduleExit(); }
function scheduleExit() { if (exiting) return; exiting = true; setImmediate(() => process.exit(0)); }
