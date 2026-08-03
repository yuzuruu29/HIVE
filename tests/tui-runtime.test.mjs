import test from "node:test";
import assert from "node:assert/strict";

const NOW = "2026-07-11T00:00:00.000Z";

function subagent(status = "created") {
  return {
    id: "bee-014",
    sessionId: "session-001",
    role: "builder",
    title: "Wire the TUI",
    objective: "Project structured events",
    status,
    providerId: "mock",
    dependencies: [],
    fileScope: ["src/tui/commands.ts"],
    attempt: 0,
    maxAttempts: 2,
    createdAt: NOW,
  };
}

function event(sequence, type, payload) {
  return {
    schemaVersion: 1,
    id: `event-${sequence}`,
    sequence,
    sessionId: "session-001",
    timestamp: NOW,
    type,
    payload,
  };
}

test("TUI command projects every structured runtime event without parsing transcript text", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { initialState } = await import("../dist/tui/state.js");
  let projected = initialState();
  const updates = [];
  const onUpdate = (updater) => {
    updates.push(updater);
    projected = updater(projected);
  };
  const runSession = async ({ onEvent }) => {
    onEvent(event(1, "subagent.created", {
      subagentId: "bee-014",
      task: subagent(),
    }));
    onEvent(event(2, "subagent.status_changed", {
      subagentId: "bee-014",
      previousStatus: "created",
      status: "working",
      task: { ...subagent("working"), startedAt: NOW },
      message: "completed failed cancelled", // presentation text is deliberately misleading
    }));
    onEvent(event(3, "session.completed", { summary: "done" }));
    return { status: "completed" };
  };

  const result = await executeTuiCommand(
    parseTuiCommand("/run wire events"),
    projected,
    process.cwd(),
    onUpdate,
    { runSession },
  );
  projected = result.state;
  await result.runtime.completion;

  assert.equal(updates.length, 3);
  assert.equal(projected.subagents[0].status, "working");
  assert.equal(projected.recentRuntimeEvents.length, 3);
  assert.equal(projected.taskStatus, "complete");
  assert.ok(projected.transcript.some((line) => line.includes("completed failed cancelled")));
});

test("runTuiTask propagates cancellation through the injected runner signal", async () => {
  const { runTuiTask } = await import("../dist/tui/runtime-adapter.js");
  let observedSignal;
  let reportedError = "";
  const runSession = ({ signal }) => {
    observedSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error(String(signal.reason));
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const handle = runTuiTask(process.cwd(), "wait", {
    onEvent() {},
    onError(error) { reportedError = error; },
  }, { runSession });

  await new Promise((resolve) => setImmediate(resolve));
  handle.cancel("test cancellation");
  await handle.completion;

  assert.equal(handle.controller.signal, observedSignal);
  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason, "test cancellation");
  assert.equal(reportedError, "test cancellation");
});

test("Ctrl+C cancels the active runtime before terminal cleanup", async () => {
  const { TuiApp } = await import("../dist/tui/app.js");
  const app = new TuiApp(process.cwd());
  const order = [];
  app.state.taskStatus = "running";
  app.activeRuntime = {
    controller: new AbortController(),
    completion: Promise.resolve(),
    cancel() { order.push("cancel"); },
  };
  const originalWrite = process.stdout.write;
  const originalPause = process.stdin.pause;
  process.stdout.write = function () { order.push("cleanup"); return true; };
  process.stdin.pause = function () { return process.stdin; };
  try {
    app.handleChar("\x03");
  } finally {
    process.stdout.write = originalWrite;
    process.stdin.pause = originalPause;
  }

  assert.equal(order[0], "cancel");
  assert.equal(app.stopped, true);
});

test("/agents toggles, selects, collapses, and reports unknown ids", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { initialState } = await import("../dist/tui/state.js");
  let state = { ...initialState(), subagents: [subagent()] };

  state = (await executeTuiCommand(parseTuiCommand("/agents"), state, process.cwd())).state;
  assert.equal(state.subagentsExpanded, true);
  assert.equal(state.selectedSubagentId, "bee-014");

  state = (await executeTuiCommand(parseTuiCommand("/agents bee-014"), state, process.cwd())).state;
  assert.equal(state.subagentsExpanded, true);
  assert.equal(state.selectedSubagentId, "bee-014");

  state = (await executeTuiCommand(parseTuiCommand("/agents collapse"), state, process.cwd())).state;
  assert.equal(state.subagentsExpanded, false);
  assert.equal(state.selectedSubagentId, undefined);

  state = (await executeTuiCommand(parseTuiCommand("/agents missing"), state, process.cwd())).state;
  assert.match(state.outputLines.at(-1), /Subagent not found: missing/);
});
