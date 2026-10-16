import assert from "node:assert/strict";
import test from "node:test";
import { TuiApp } from "../dist/tui/app.js";
import { renderTuiScreen } from "../dist/tui/renderer.js";
import { parseToolCard } from "../dist/tui/tool-card.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function feed(app, text) {
  app.inputBuffer += text;
  app.processInputBuffer();
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "lifecycle condition did not settle");
}

function quietApp(options) {
  const app = new TuiApp(process.cwd(), { readGitBranch: async () => "main\n", ...options });
  app.render = () => {};
  return app;
}

test("cancelled turn drains its queue once after actual settlement and preserves the draft", async () => {
  const first = deferred();
  const second = deferred();
  const started = [];
  const app = quietApp({
    runSession: ({ objective, signal, onText }) => {
      started.push({ objective, signal, onText });
      return started.length === 1 ? first.promise : second.promise;
    },
  });
  try {
    feed(app, "first task\r");
    await until(() => started.length === 1);
    feed(app, "next task\r");
    feed(app, "unfinished draft");
    feed(app, "\x1b");
    assert.equal(started[0].signal.aborted, true);
    assert.deepEqual(app.state.messageQueue, ["next task"]);
    assert.equal(started.length, 1, "cancellation must await the runner before starting another turn");
    started[0].onText("late cancelled text");
    assert.equal(app.state.liveText, undefined);
    first.resolve();
    await until(() => started.length === 2);
    assert.deepEqual(started.map(({ objective }) => objective), ["first task", "next task"]);
    assert.deepEqual(app.state.messageQueue, []);
    assert.equal(app.state.input, "unfinished draft");
    second.resolve();
    await until(() => !app.turnBusy());
    assert.equal(started.length, 2);
  } finally {
    first.resolve();
    second.resolve();
  }
});

for (const secondCancel of ["\x1b", "\x03"]) {
  test(`second ${secondCancel === "\x1b" ? "Esc" : "Ctrl+C"} clears the queue before cancellation settles`, async () => {
    const first = deferred();
    let started = 0;
    const app = quietApp({ runSession: () => { started += 1; return first.promise; } });
    try {
      feed(app, "first task\r");
      await until(() => started === 1);
      feed(app, "do not start\r\x1b");
      feed(app, secondCancel);
      assert.deepEqual(app.state.messageQueue, []);
      assert.equal(app.stopped, false);
      first.resolve();
      await until(() => !app.turnBusy());
      assert.equal(started, 1);
    } finally {
      first.resolve();
    }
  });
}

test("failed turn starts the queued draft and refreshes the branch on settlement", async () => {
  const first = deferred();
  const second = deferred();
  let branch = "main\n";
  let reads = 0;
  let started = 0;
  const app = quietApp({
    readGitBranch: async () => { reads += 1; return branch; },
    runSession: () => { started += 1; return started === 1 ? first.promise : second.promise; },
  });
  try {
    await app.hydrateSession();
    await until(() => app.state.gitBranch === "main");
    feed(app, "first task\r");
    await until(() => started === 1);
    feed(app, "retry task\r");
    assert.equal(reads, 1, "typing must not run git");
    branch = "feature/after-failure\n";
    first.reject(new Error("provider failed"));
    await until(() => started === 2 && app.state.gitBranch === "feature/after-failure");
    assert.match(renderTuiScreen({ ...app.state, width: 120, height: 30, colorEnabled: false }), /feature\/after-failure/);
    branch = "feature/after-success\n";
    second.resolve();
    await until(() => !app.turnBusy() && app.state.gitBranch === "feature/after-success");
    assert.equal(reads, 3);
    assert.equal(started, 2);
  } finally {
    first.resolve();
    second.resolve();
  }
});

test("Esc during command startup cannot start a cancelled provider turn or overlap its queue", async () => {
  const started = [];
  const app = quietApp({ runSession: async ({ objective }) => { started.push(objective); } });
  feed(app, "cancel before startup\r\x1b");
  feed(app, "kept after startup\r");
  assert.deepEqual(app.state.messageQueue, ["kept after startup"]);
  await until(() => !app.turnBusy());
  assert.deepEqual(started, ["kept after startup"]);
});

test("stale branch probes cannot overwrite newer results and failed probes clear the old label", async () => {
  const probes = [];
  const app = quietApp({ readGitBranch: () => { const probe = deferred(); probes.push(probe); return probe.promise; } });
  app.refreshGitBranch();
  app.refreshGitBranch();
  probes[1].resolve("new-branch\n");
  await until(() => app.state.gitBranch === "new-branch");
  probes[0].resolve("stale-branch\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state.gitBranch, "new-branch");
  app.refreshGitBranch();
  probes[2].reject(new Error("no repository"));
  await until(() => app.state.gitBranch === undefined);
});

test("stopping during startup cancels the runtime handle that arrives after stop", async () => {
  let started = 0;
  const app = quietApp({ runSession: async () => { started += 1; } });
  feed(app, "never start this turn\r");
  const write = process.stdout.write;
  try {
    process.stdout.write = () => true;
    app.stop();
  } finally {
    process.stdout.write = write;
  }
  // Let command construction and the adapter's deferred launch both finish.
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started, 0);
});

function pauseForApproval(onEvent) {
  onEvent({
    schemaVersion: 1, id: "pause-1", sequence: 1, sessionId: "guarded-session",
    timestamp: "2026-10-16T00:00:00.000Z", type: "session.paused",
    payload: { reason: "Repository changes require approval." },
  });
}

test("queued messages wait for a pending permission and start after rejection", async () => {
  const first = deferred();
  const started = [];
  let emit;
  const app = quietApp({ runSession: ({ objective, onEvent }) => {
    started.push(objective);
    emit = onEvent;
    return started.length === 1 ? first.promise : Promise.resolve();
  } });
  try {
    feed(app, "guarded task\r");
    await until(() => started.length === 1);
    feed(app, "queued task\r");
    pauseForApproval(emit);
    first.resolve();
    await until(() => app.activeRuntime === null);
    assert.ok(app.state.pendingPermission);
    assert.deepEqual(started, ["guarded task"]);
    feed(app, "n\r");
    await until(() => started.length === 2 && !app.turnBusy());
    assert.deepEqual(started, ["guarded task", "queued task"]);
    assert.equal(app.state.editsApproved, false);
  } finally {
    first.resolve();
  }
});

test("approval resumes the original objective after its runner settles, before queued messages", async () => {
  const first = deferred();
  const continued = deferred();
  const started = [];
  const app = quietApp({ runSession: (options) => {
    started.push(options);
    if (started.length === 1) return first.promise;
    if (started.length === 2) return continued.promise;
    return Promise.resolve();
  } });
  try {
    feed(app, "guarded task\r");
    await until(() => started.length === 1);
    feed(app, "queued task\r");
    pauseForApproval(started[0].onEvent);
    feed(app, "y\r");
    assert.equal(started.length, 1);
    assert.equal(started[0].signal.aborted, true);
    first.resolve();
    await until(() => started.length === 2);
    assert.deepEqual(started.map(({ objective }) => objective), ["guarded task", "guarded task"]);
    assert.equal(started[1].approvalPolicy, "changes");
    assert.deepEqual(app.state.messageQueue, ["queued task"]);
    continued.resolve();
    await until(() => started.length === 3 && !app.turnBusy());
    assert.deepEqual(started.map(({ objective }) => objective), ["guarded task", "guarded task", "queued task"]);
  } finally {
    first.resolve();
    continued.resolve();
  }
});

test("Esc closes the running tool card while late prose is suppressed", async () => {
  const gate = deferred();
  let emit;
  const app = quietApp({ runSession: ({ onEvent }) => { emit = onEvent; return gate.promise; } });
  try {
    feed(app, "inspect file\r");
    await until(() => emit !== undefined);
    emit({ schemaVersion: 1, id: "read-start", sequence: 1, sessionId: "tool-session", timestamp: "2026-10-16T00:00:00.000Z",
      type: "subagent.tool_call", payload: { subagentId: "bee-1", callId: "call-1", tool: "read_file", input: { path: "file.ts" } } });
    assert.equal(app.state.transcript.map(parseToolCard).find(Boolean).status, "running");
    feed(app, "\x1b");
    gate.resolve();
    await until(() => !app.turnBusy());
    assert.equal(app.state.transcript.map(parseToolCard).find(Boolean).status, "cancelled");
  } finally { gate.resolve(); }
});

test("terminal frames erase old row tails and rows below a shorter redraw", async () => {
  const { writeFrame } = await import("../dist/tui/terminal-control.js");
  const write = process.stdout.write;
  let output = "";
  try {
    process.stdout.write = (chunk) => { output += chunk; return true; };
    writeFrame("status\n> _");
  } finally { process.stdout.write = write; }
  assert.equal(output, "\x1b[Jstatus\n> _");
});

test("stop restores the main screen before leaving raw mode so the shell can redraw its prompt", () => {
  const app = quietApp();
  const write = process.stdout.write;
  const isTTY = process.stdin.isTTY;
  const setRawMode = process.stdin.setRawMode;
  const steps = [];
  try {
    process.stdout.write = (chunk) => { steps.push(JSON.stringify(String(chunk))); return true; };
    process.stdin.isTTY = true;
    process.stdin.setRawMode = (mode) => { steps.push(`raw:${mode}`); return process.stdin; };
    app.stop();
  } finally {
    process.stdout.write = write;
    process.stdin.isTTY = isTTY;
    process.stdin.setRawMode = setRawMode;
  }
  const leaveScreen = steps.findIndex((step) => step.includes("[?1049l"));
  const cooked = steps.indexOf("raw:false");
  assert.ok(leaveScreen >= 0 && cooked >= 0, JSON.stringify(steps));
  assert.ok(leaveScreen < cooked, `alternate screen must close before raw mode ends: ${JSON.stringify(steps)}`);
});
