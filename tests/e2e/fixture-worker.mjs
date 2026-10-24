import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DefaultDesktopRunManager } from "../../dist/desktop/run-manager.js";
import { CodingSessionStore } from "../../dist/coding/session-store.js";
import { WorktreeManager, branchNameForTask } from "../../dist/worktree.js";
import { validateDesktopCommand } from "../../dist/desktop/electron/contracts.js";
import { createProjectWorkerHost } from "../../dist/desktop/electron/project-worker-host.js";
import { randomUUID } from "node:crypto";
import { createChatEngine } from "../../dist/chat/engine.js";

const COUNCIL_SCRIPT = {
  Queen: "Run contract: append a council note to hive-desktop-fixture.txt.\nPRESET: standard",
  Scout: "hive-desktop-fixture.txt is the only relevant file; no tests cover it.",
  Architect: "Append one line to hive-desktop-fixture.txt, then check it with fixture:validate.",
  Forger: "```diff\n--- a/hive-desktop-fixture.txt\n+++ b/hive-desktop-fixture.txt\n@@ -1 +1,2 @@\n baseline\n+council note\n```",
  Sentinel: "The proposal matches the plan and stays in scope. Nothing was executed.\nVERDICT: PASS_WITH_LIMITATIONS",
  Scribe: "## HIVE Review — Complete\n\n**Goal:** Append a council note\n**Result:** One-line proposal ready to apply\n**Verification:** The council executed no commands.\n**Limitations:** fixture:validate has not run.\n**Final status:** Complete",
};

const port = process.parentPort;
if (!port) throw new Error("The deterministic desktop fixture requires an Electron utility-process parent port.");
let current = null;
let exiting = false;
let exitRequested = false;
let commandsInFlight = 0;
const handleProject = createProjectWorkerHost((message) => port.postMessage(message), requestExit, {
  runCoding: async (options) => {
    const currentText = options.objective ?? "";
    if (currentText.includes("[crash]")) process.exit(9);
    if (currentText.includes("[fail]")) throw new Error("Deterministic fixture provider failure");
    const sessionId = options.resumeId ?? `fixture-${randomUUID()}`;
    const input = { repositoryRoot: options.cwd, objective: currentText, sessionId, options: { mode: options.codeMode ?? "auto", approvalPolicy: options.approvalPolicy ?? "safe" }, signal: options.signal, onEvent: options.onEvent };
    if (!options.resumeId) {
      const approvalWorktree = currentText.includes("[approval]") ? await new WorktreeManager(options.cwd).createWorktree(sessionId) : undefined;
      const initial = makeRecord(input, new Date().toISOString(), approvalWorktree, "modified", "created");
      if (!approvalWorktree) initial.repository.branch = "main";
      initial.validationResults = []; initial.reviewResults = []; initial.files = [];
      await new CodingSessionStore(options.cwd).save(initial);
      options.onEvent(runtimeEvent(sessionId, 1, "session.created", { objective: currentText, mode: input.options.mode, approvalPolicy: input.options.approvalPolicy }));
    }
    if (currentText.includes("[approval]")) {
      const approved = await options.requestToolPermission({ tool: "fixture_command", description: "Deterministic fixture command in the selected test workspace", input: { command: "fixture:validate", cwd: path.join(options.cwd, ".hivemind", "worktrees", sessionId) }, external: false, alwaysAsk: true }, options.signal);
      if (!approved) throw new Error("Deterministic fixture approval declined");
    }
    return deterministicLaunch(input).completion;
  },
  // Council stages answer from a script; every other chat prompt keeps the real engine.
  createChat: (root, sessionId) => {
    const real = createChatEngine(root, sessionId);
    return {
      async complete(request) {
        const agent = /\[HIVE\] role: (\w+)/.exec(String(request.prompt))?.[1];
        if (!agent || !COUNCIL_SCRIPT[agent]) return real.complete(request);
        // Hold after a completed Queen so cancellation checks do not depend on polling speed.
        if (agent !== "Queen" && String(request.prompt).includes("[hold-after-queen]")) {
          if (request.signal?.aborted) throw new Error("Deterministic council cancelled.");
          await new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("Deterministic council cancelled.")), { once: true }));
        }
        // "[slow]" spaces the stages out so a visual check can catch the rail mid-run.
        if (String(request.prompt).includes("[slow]")) await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (request.signal?.aborted) throw new Error("Deterministic council cancelled.");
        return { output: COUNCIL_SCRIPT[agent], receipt: { role: request.role, providerId: "fixture", model: "deterministic-council", source: "fixture", degraded: false, totalTokens: 12 } };
      },
      resolveRoute: (role, override) => real.resolveRoute(role, override),
    };
  },
});

const manager = new DefaultDesktopRunManager({
  onEvent: emit,
  launcher: (input) => deterministicLaunch(input),
});

port.on("message", ({ data: message }) => {
  if (handleProject(message)) return;
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
    input.onEvent(runtimeEvent(input.sessionId, 2, "session.started", { repository: created.repository }));
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
      input.onEvent(runtimeEvent(input.sessionId, 3, "session.paused", { reason: "Desktop pause requested." }));
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
    input.onEvent(runtimeEvent(input.sessionId, 3, "session.completed", { report: completed.finalReport }));
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
// Same delay as src/desktop/electron/worker.ts: an immediate exit can drop the final acknowledgement still queued on the parent port.
function scheduleExit() { if (exiting) return; exiting = true; setTimeout(() => process.exit(0), 20).unref(); }
