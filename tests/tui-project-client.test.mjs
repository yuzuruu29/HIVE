import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TuiProjectClient } from "../dist/tui/project-client.js";
import { initialState } from "../dist/tui/state.js";
import { renderTuiScreen } from "../dist/tui/renderer.js";
import { sanitizeTerminalText, terminalCellWidth } from "../dist/tui/display-text.js";

function fixture(operations = {}) {
  const cwd = path.resolve("workspace");
  const session = (id, title) => ({ id, title, projectId: "project", workspaceId: "worktree", archived: false, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z", settings: { mode: "code", permissions: "guarded" }, messages: [], runs: [], sources: [] });
  let snapshot = { schemaVersion: 1, revision: 1, projects: [{ id: "project", name: "HIVE", repositoryId: "repository", repositoryPath: cwd, workspaces: [{ id: "worktree", path: cwd, branch: "feature", repositoryId: "repository" }], lastSessionId: "session-1", createdAt: "now", updatedAt: "now" }], sessions: [session("session-1", "First"), session("session-2", "Second")], warnings: [] };
  let state = { ...initialState(), colorEnabled: false, motionEnabled: false, width: 80, height: 24 };
  let rejectSend = false;
  let holdSend;
  const actions = [];
  const port = {
    snapshot: async () => structuredClone(snapshot),
    close: async () => {},
    action: async (action) => {
      actions.push(structuredClone(action));
      const target = snapshot.sessions.find((item) => item.id === action.sessionId);
      if (action.type === "session.send") {
        if (rejectSend) throw new Error("workspace busy");
        if (holdSend) await holdSend;
        target.runs.push({ id: "run", sessionId: target.id, requestId: action.requestId, workspaceId: "worktree", workspace: cwd, status: "running", settings: { ...target.settings }, effectivePolicy: "safe", startedAt: "2026-10-18T00:00:00Z", endedAt: null, summary: "Running", events: [], patches: [], checks: [], engine: "live", approvals: [] });
        target.messages.push({ id: "user", role: "user", text: action.text, createdAt: "now", runId: "run" });
      }
      if (action.type === "session.select") snapshot.projects[0].lastSessionId = target.id;
      let resultSessionId = target?.id;
      if (action.type === "session.fork") {
        const fork = { ...structuredClone(target), id: "session-fork", title: action.title || `${target.title} (fork)`, forkedFrom: target.id, runs: [] };
        snapshot.sessions.push(fork); resultSessionId = fork.id;
      }
      if (action.type === "session.settings") target.settings = { ...target.settings, ...action.settings };
      if (action.type === "run.cancel") target.runs.find((item) => item.id === action.runId).status = "stopping";
      if (action.type === "run.approve") target.runs[0].approvals[0].status = action.approved ? "approved" : "declined";
      snapshot.revision += 1;
      return { snapshot: structuredClone(snapshot), result: { sessionId: resultSessionId, runId: action.type === "session.send" ? "run" : undefined } };
    },
  };
  const client = new TuiProjectClient(port, cwd, () => state, (value) => { state = value; }, undefined, operations);
  return { client, actions, port, get state() { return state; }, set state(value) { state = value; }, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; }, rejectSend() { rejectSend = true; }, hold(promise) { holdSend = promise; } };
}

test("shared TUI ignores another client's focus hint and preserves drafts, cursor and scroll by session", async () => {
  const f = fixture(); await f.client.start();
  try {
    f.state = { ...f.state, input: "first draft", cursor: 3, scrollOffset: 2 };
    f.snapshot.projects[0].lastSessionId = "session-2"; f.snapshot.revision++;
    await f.client.refresh();
    assert.equal(f.state.sessionId, "session-1"); assert.equal(f.state.input, "first draft"); assert.equal(f.state.cursor, 3);
    await f.client.submit("/sessions select session-2");
    f.state = { ...f.state, input: "second draft", cursor: 2 };
    await f.client.submit("/sessions select session-1");
    assert.equal(f.state.input, "first draft"); assert.equal(f.state.cursor, 3);
    await f.client.submit("/sessions select session-2");
    assert.equal(f.state.input, "second draft");
  } finally { await f.client.close(); }
});

test("accepted session navigation does not cache the typed command as a departed draft", async () => {
  const f = fixture(); await f.client.start();
  try {
    f.state = { ...f.state, input: "/sessions select session-2", cursor: 26 };
    await f.client.submit("/sessions select session-2");
    f.state = { ...f.state, input: "second draft", cursor: 4 };
    await f.client.submit("/sessions select session-1");
    assert.equal(f.state.input, ""); assert.equal(f.state.cursor, 0);
    await f.client.submit("/sessions select session-2");
    assert.equal(f.state.input, "second draft");
  } finally { await f.client.close(); }
});

test("shared startup uses a bounded loading frame before history hydrates", () => {
  for (const width of [12, 32, 80]) {
    const screen = sanitizeTerminalText(renderTuiScreen({ ...initialState(), sharedLoading: true, colorEnabled: false, motionEnabled: false, width, height: 24 }));
    assert.equal(screen.includes("Hyper Intelligence for Verified Engineering"), false);
    assert.ok(screen.split("\n").every((line) => terminalCellWidth(line) <= width));
  }
});

test("navigation acceptance preserves a newer command-shaped draft", async () => {
  const f = fixture(); await f.client.start();
  const action = f.port.action;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.port.action = async (input) => { if (input.type === "session.select") await gate; return action(input); };
  try {
    f.state = { ...f.state, input: "/sessions select session-2", cursor: 26 };
    const pending = f.client.submit("/sessions select session-2");
    f.state = { ...f.state, input: "/new a newer draft", cursor: 8 };
    release(); await pending;
    await f.client.submit("/sessions select session-1");
    assert.equal(f.state.input, "/new a newer draft"); assert.equal(f.state.cursor, 8);
  } finally { await f.client.close(); }
});

test("rejected shared sends retain input and successful sends never erase a newer draft", async () => {
  const f = fixture(); await f.client.start();
  try {
    f.state = { ...f.state, input: "my request", cursor: 4 }; f.rejectSend();
    await assert.rejects(f.client.submit("my request"), /workspace busy/);
    assert.equal(f.state.input, "my request"); assert.equal(f.state.cursor, 4);
  } finally { await f.client.close(); }
  const pending = fixture(); await pending.client.start();
  try {
    let release; pending.hold(new Promise((resolve) => { release = resolve; }));
    pending.state = { ...pending.state, input: "accepted", cursor: 8 };
    const send = pending.client.submit("accepted");
    pending.state = { ...pending.state, input: "next draft", cursor: 5 };
    release(); await send;
    assert.equal(pending.state.input, "next draft"); assert.equal(pending.state.cursor, 5);
  } finally { await pending.client.close(); }
});

test("stop during acceptance cancels that captured run and stopping rejects overlapping sends", async () => {
  const f = fixture(); await f.client.start();
  try {
    let release; f.hold(new Promise((resolve) => { release = resolve; }));
    const send = f.client.submit("request");
    await f.client.cancel(); release(); await send;
    assert.equal(f.actions.at(-1).type, "run.cancel"); assert.equal(f.actions.at(-1).sessionId, "session-1");
    await assert.rejects(f.client.submit("overlap"), /still active or stopping/);
    assert.equal(f.actions.filter((item) => item.type === "session.send").length, 1);
  } finally { await f.client.close(); }
});

test("workflow cycling never raises safety and approvals restore the private composer draft", async () => {
  const f = fixture(); await f.client.start();
  try {
    await f.client.cycleMode();
    assert.equal(f.state.workflowMode, "plan"); assert.equal(f.state.sessionMode, "guarded");
    assert.deepEqual(f.actions.at(-1).settings, { mode: "plan" });
    await f.client.submit("check");
    f.state = { ...f.state, input: "unsent private draft", cursor: 7 };
    const run = f.snapshot.sessions[0].runs[0]; run.status = "awaiting_approval";
    run.approvals.push({ id: "approval", runId: "run", tool: "write_file", description: "Write one file", input: { path: "file.ts" }, workspace: path.resolve("workspace"), external: false, createdAt: "now", expiresAt: "later", status: "pending" });
    f.snapshot.revision++; await f.client.refresh();
    assert.equal(f.state.input, ""); assert.match(f.state.permissionPrompt, /file.ts/);
    await f.client.approve(false);
    assert.equal(f.state.input, "unsent private draft"); assert.equal(f.state.cursor, 7);
  } finally { await f.client.close(); }
});

test("shared sends freeze configured extension references and keep them local to each session", async () => {
  const f = fixture(); await f.client.start();
  try {
    f.state = { ...f.state, conversation: { skillIds: ["skill:fixture"], mcpServerIds: ["mcp:fixture"], lspServerIds: ["lsp:fixture"], pluginAgentId: "agent:fixture", outputStyleId: "style:fixture", imagePaths: ["sample.png"] } };
    await f.client.submit("request");
    const sent = f.actions.find((item) => item.type === "session.send");
    assert.deepEqual(sent.executionContext, { skillIds: ["skill:fixture"], enabledMcpServers: ["mcp:fixture"], enabledLspServers: ["lsp:fixture"], pluginAgentId: "agent:fixture", outputStyleId: "style:fixture", imagePaths: [path.resolve("workspace", "sample.png")] });
    await f.client.submit("/sessions select session-2");
    assert.equal(f.state.conversation, undefined);
    await f.client.submit("/sessions select session-1");
    assert.deepEqual(f.state.conversation.skillIds, ["skill:fixture"]);
  } finally { await f.client.close(); }
});

test("shared refresh follows new output only at the bottom and keeps a reading viewport stable", async () => {
  const f = fixture();
  f.snapshot.sessions[0].messages = Array.from({ length: 25 }, (_, index) => ({ id: `message-${index}`, role: "assistant", text: `existing line ${index}`, createdAt: "now" }));
  await f.client.start();
  try {
    f.state = { ...f.state, scrollOffset: 5, input: "keep editing", cursor: 4 };
    f.snapshot.sessions[0].messages.push({ id: "late", role: "assistant", text: "new output one\nnew output two", createdAt: "now" });
    f.snapshot.revision++; await f.client.refresh();
    assert.equal(f.state.scrollOffset, 7);
    assert.equal(f.state.input, "keep editing"); assert.equal(f.state.cursor, 4);
    f.state = { ...f.state, scrollOffset: 0 };
    f.snapshot.sessions[0].messages.push({ id: "later", role: "assistant", text: "newest", createdAt: "now" });
    f.snapshot.revision++; await f.client.refresh();
    assert.equal(f.state.scrollOffset, 0);
  } finally { await f.client.close(); }
});

test("native shared layout stays bounded, sanitizes terminal controls, and uses hive-only empty fallback", async () => {
  const f = fixture(); await f.client.start();
  try {
    for (const [width, height] of [[80, 24], [40, 24], [24, 10], [12, 4]]) {
      const screen = sanitizeTerminalText(renderTuiScreen({ ...f.state, width, height }));
      assert.equal(screen.split("\n").length, height);
      for (const row of screen.split("\n")) assert.ok(terminalCellWidth(row) <= width);
      if (width === 80) { assert.match(screen, /\.---\./); assert.doesNotMatch(screen, /ʚ|ɞ|Queen Bee/); assert.match(screen, /Session: First/); }
    }
    f.snapshot.sessions[0].messages.push({ id: "unsafe", role: "assistant", text: "safe\x1b[2J\x07tail", createdAt: "now" }); f.snapshot.revision++;
    await f.client.refresh();
    const screen = renderTuiScreen({ ...f.state, colorEnabled: false });
    assert.doesNotMatch(screen, /\x1b|\x07/); assert.doesNotMatch(screen, /\.---\./);
  } finally { await f.client.close(); }
});

test("shared copy, export, context and compact read durable selected history without legacy mutations", async () => {
  const copied = []; const exported = [];
  const f = fixture({ copyToClipboard: async (text) => { copied.push(text); }, writeReport: async (...args) => { exported.push(args); return path.resolve("workspace", "history.md"); } });
  f.snapshot.sessions[0].messages = [{ id: "user", role: "user", text: "Question from Desktop", createdAt: "now" }, { id: "assistant", role: "assistant", text: "Shared answer", createdAt: "now" }];
  await f.client.start();
  try {
    await f.client.submit("/copy"); await f.client.submit("/copy all"); await f.client.submit("/export history.md");
    assert.equal(copied[0], "Shared answer"); assert.match(copied[1], /Question from Desktop/);
    assert.match(exported[0][2], /Question from Desktop/); assert.match(exported[0][2], /Shared answer/);
    const before = structuredClone(f.snapshot.sessions[0].messages);
    await f.client.submit("/context"); await f.client.submit("/compact");
    assert.match(f.state.transcript.join("\n"), /Shared history: 2 messages/);
    assert.match(f.state.transcript.join("\n"), /Manual compaction is unavailable/);
    assert.deepEqual(f.snapshot.sessions[0].messages, before); assert.equal(f.actions.length, 0);
    await f.client.submit("/sessions select session-2");
    await assert.rejects(f.client.submit("/export empty.md"), /no messages/);
  } finally { await f.client.close(); }
});

test("shared fork creates a new shared history branch and preserves client-local extension choices", async () => {
  const f = fixture();
  f.snapshot.sessions[0].messages = [{ id: "user", role: "user", text: "Original context", createdAt: "now" }];
  await f.client.start();
  try {
    f.state = { ...f.state, conversation: { skillIds: ["skill:chosen"] } };
    await f.client.submit("/fork Alternate approach");
    assert.equal(f.actions.at(-1).type, "session.fork");
    assert.equal(f.state.sessionId, "session-fork");
    assert.equal(f.snapshot.sessions.at(-1).forkedFrom, "session-1");
    assert.match(f.state.transcript.join("\n"), /Original context/);
    assert.match(f.state.transcript.join("\n"), /previous managed worktree was not cloned/);
    assert.deepEqual(f.state.conversation.skillIds, ["skill:chosen"]);
  } finally { await f.client.close(); }
});

test("legacy import requires explicit digest confirmation and preserves local focus and draft", async () => {
  const f = fixture(); const calls = [];
  f.port.previewImport = async (...args) => { calls.push(["preview", ...args]); return { projectId: "project", workspaceId: "worktree", digest: "a".repeat(64), counts: { cli: 2, thread: 1, chat: 1, messages: 8 }, warnings: ["One source was unreadable"], sessions: [{ id: "legacy", title: "Saved work", messages: 8 }], alreadyImported: false }; };
  f.port.importHistory = async (...args) => { calls.push(["import", ...args]); return { snapshot: structuredClone(f.snapshot), imported: 4, duplicate: false, backupDirectory: path.resolve("migration-backups", "snapshot") }; };
  await f.client.start();
  try {
    f.state = { ...f.state, input: "retained draft", cursor: 4 };
    await f.client.submit("/import preview");
    assert.equal(calls.length, 1); assert.match(f.state.transcript.join("\n"), /2 CLI, 1 threads, 1 chats; 8 messages/);
    assert.match(f.state.transcript.join("\n"), /Saved work/); assert.match(f.state.transcript.join("\n"), /One source was unreadable/);
    await f.client.submit(`/import confirm ${"a".repeat(64)}`);
    assert.deepEqual(calls[1], ["import", "project", "a".repeat(64), "worktree"]);
    assert.equal(f.state.sessionId, "session-1"); assert.equal(f.state.input, "retained draft"); assert.equal(f.state.cursor, 4);
    assert.match(f.state.transcript.join("\n"), /Backup:.*migration-backups/);
  } finally { await f.client.close(); }
});

test("a review prompt cannot silently mark a completed run reviewed", async () => {
  const f = fixture(); await f.client.start();
  try {
    await f.client.submit("request");
    f.snapshot.sessions[0].runs[0].status = "completed"; f.snapshot.revision++;
    await f.client.refresh();
    await assert.rejects(f.client.submit("/review inspect authorization"), /\/review run/);
    assert.equal(f.actions.filter((action) => action.type === "run.review").length, 0);
    await f.client.submit("/review");
    assert.equal(f.actions.at(-1).type, "run.review");
  } finally { await f.client.close(); }
});
