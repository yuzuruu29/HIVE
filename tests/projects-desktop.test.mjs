import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { ProjectWorkerEngine } from "../dist/desktop/electron/project-worker.js";
import { validateDesktopCommand, validateDesktopEvent } from "../dist/desktop/electron/contracts.js";
import { DesktopShutdownGate } from "../dist/desktop/electron/shutdown.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const requestId = "request-desktop-shared";
const input = { project: { id: "project-fixture" }, session: { id: "session-fixture" }, run: { id: "run-fixture", settings: { mode: "code", permissions: "guarded" } }, text: "Fixture only" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
class Child extends EventEmitter {
  sent = [];
  killed = false;
  postMessage(message) { this.sent.push(structuredClone(message)); }
  kill() { this.killed = true; this.emit("exit", 9); }
}
test("shared IPC requires one request identity and exact action fields", () => {
  assert.equal(validateDesktopCommand({ type: "projects.snapshot", requestId }).type, "projects.snapshot");
  const command = { type: "projects.action", requestId, action: { type: "session.rename", requestId, sessionId: "session-fixture", title: "Renamed" } };
  assert.equal(validateDesktopCommand(command).action.title, "Renamed");
  assert.throws(() => validateDesktopCommand({ ...command, requestId: "different" }), /must match/);
  assert.throws(() => validateDesktopCommand({ ...command, action: { ...command.action, secret: "unexpected" } }), /Unexpected/);
  assert.throws(() => validateDesktopEvent({ type: "projects.snapshot", timestamp: new Date().toISOString(), snapshot: { schemaVersion: 1, revision: 0, projects: [], sessions: [], warnings: [], owners: {} } }), /unexpected/i);
});
test("worker completion waits for durable activity, and acknowledges only after persistence", async () => {
  const child = new Child();
  let release;
  const persisted = new Promise((resolve) => { release = resolve; });
  const engine = new ProjectWorkerEngine({ spawn: () => child, resolveCredential: async () => undefined });
  const handle = await engine.start(input, { persist: () => persisted, requestApproval: async () => false });
  child.emit("message", { type: "project.event", id: "12345678-1234-1234-1234-123456789012", event: { type: "text", text: "Durable answer" } });
  child.emit("message", { type: "project.completed", outcome: { status: "completed", summary: "Done" } });
  let settled = false;
  void handle.completion.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(child.sent.filter((message) => message.type === "project.ack").length, 0);
  release();
  assert.equal((await handle.completion).status, "completed");
  assert.equal(child.sent.at(-1).type, "project.ack");
  assert.equal(engine.hasActiveRuns(), false);
});
test("worker approvals stay scoped, and cancellation is held until acknowledgment", async () => {
  const child = new Child();
  let decide;
  const approval = new Promise((resolve) => { decide = resolve; });
  const engine = new ProjectWorkerEngine({ spawn: () => child, resolveCredential: async () => undefined });
  const handle = await engine.start(input, { persist: async () => {}, requestApproval: (scope) => { assert.equal(scope.tool, "command"); return approval; } });
  child.emit("message", { type: "project.approval", id: "12345678-1234-1234-1234-123456789012", input: { tool: "command", description: "One command", input: { command: "fixture" }, external: false } });
  await tick();
  await handle.cancel("User cancelled");
  assert.equal(engine.hasActiveRuns(), true);
  assert.equal(child.sent.at(-1).type, "project.cancel");
  decide(false);
  await tick();
  assert.equal(child.sent.at(-1).approved, false);
  child.emit("message", { type: "project.completed", outcome: { status: "cancelled", summary: "Acknowledged" } });
  assert.equal((await handle.completion).status, "cancelled");
});
test("worker crash and invalid completion cannot be reported as success", async () => {
  for (const malformed of [false, true]) {
    const child = new Child();
    const engine = new ProjectWorkerEngine({ spawn: () => child, resolveCredential: async () => undefined });
    const handle = await engine.start(input, { persist: async () => {}, requestApproval: async () => false });
    if (malformed) child.emit("message", { type: "project.completed", outcome: { status: "completed", summary: "Claim", checks: [{ status: "passed", exitCode: 3 }] } });
    else child.emit("exit", 9);
    assert.notEqual((await handle.completion).status, "completed");
  }
});
test("desktop accepts current canonical engine events and rejects invented verdicts", () => {
  const envelope = (type, payload) => ({ type: "runtime.event", timestamp: new Date().toISOString(), event: { schemaVersion: 1, id: "event-fixture", sequence: 1, sessionId: "coding-fixture", timestamp: new Date().toISOString(), type, payload } });
  assert.equal(validateDesktopEvent(envelope("verdict.computed", { verdict: "ACCEPTED", reasons: ["Executed checks passed"] })).type, "runtime.event");
  assert.throws(() => validateDesktopEvent(envelope("verdict.computed", { verdict: "looks-good", reasons: [] })), /verdict/);
  assert.throws(() => validateDesktopEvent(envelope("evidence.invalidated", { evidenceId: "evidence-fixture", reason: "Changed", ignored: true })), /unexpected/);
});
test("failed cancellation delivery or termination never releases a still-live worker", async () => {
  const child = new Child();
  child.postMessage = (message) => { if (message.type === "project.cancel") throw new Error("Port closed"); child.sent.push(message); };
  child.kill = () => false;
  const engine = new ProjectWorkerEngine({ spawn: () => child, resolveCredential: async () => undefined, cancellationTimeoutMs: 5 });
  const handle = await engine.start(input, { persist: async () => {}, requestApproval: async () => false });
  let settled = false;
  void handle.completion.then(() => { settled = true; });
  await handle.cancel("Stop");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(settled, false);
  assert.equal(engine.hasActiveRuns(), true);
  child.emit("exit", 9);
  assert.equal((await handle.completion).status, "interrupted");
});
test("native shutdown keeps active work untouched when exit is declined and awaits durable close", async () => {
  let approved = false;
  let closed = 0;
  let quit = 0;
  let release;
  const durableClose = new Promise((resolve) => { release = resolve; });
  const gate = new DesktopShutdownGate({ hasActiveRuns: () => true, confirmExit: async () => approved, close: async () => { closed++; await durableClose; }, quit: () => { quit++; }, onFailure: async () => assert.fail("Unexpected shutdown failure") });
  assert.equal(await gate.request(), false);
  assert.equal(closed, 0);
  approved = true;
  const first = gate.request();
  assert.equal(gate.request(), first);
  await tick();
  assert.equal(closed, 1);
  assert.equal(quit, 0);
  release();
  assert.equal(await first, true);
  assert.equal(quit, 1);
});
test("worker exit disarms cancellation while durable activity is still flushing", async () => {
  const child = new Child();
  let release;
  const persistence = new Promise((resolve) => { release = resolve; });
  const engine = new ProjectWorkerEngine({ spawn: () => child, resolveCredential: async () => undefined, cancellationTimeoutMs: 5 });
  const handle = await engine.start(input, { persist: () => persistence, requestApproval: async () => false });
  child.emit("message", { type: "project.event", id: "12345678-1234-1234-1234-123456789012", event: { type: "text", text: "Final activity" } });
  await tick();
  handle.cancel("Stop"); child.emit("exit", 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(child.killed, false);
  assert.equal(engine.hasActiveRuns(), true);
  release();
  assert.equal((await handle.completion).status, "cancelled");
});
test("failed durable shutdown leaves the application open and can be retried", async () => {
  let failures = 0;
  let quit = 0;
  const gate = new DesktopShutdownGate({ hasActiveRuns: () => false, confirmExit: async () => true, close: async () => { if (!failures) throw new Error("Owner still live"); }, quit: () => { quit++; }, onFailure: async () => { failures++; } });
  assert.equal(await gate.request(), false);
  assert.equal(quit, 0);
  assert.equal(await gate.request(), true);
  assert.equal(quit, 1);
});
test("reviewed icon sources generate identical Windows assets after LF or CRLF checkout", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = path.join(os.tmpdir(), `hive-icon-checkout-${randomUUID()}`);
  if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, temporary + "\n");
  await fs.mkdir(path.join(temporary, "desktop", "renderer"), { recursive: true });
  await fs.cp(path.join(root, "build", "desktop", "brand"), path.join(temporary, "build", "desktop", "brand"), { recursive: true });
  const favicon = await fs.readFile(path.join(root, "desktop", "renderer", "favicon.svg"), "utf8");
  const small = await fs.readFile(path.join(root, "build", "desktop", "brand", "hive-small.svg"), "utf8");
  const outputs = [];
  try {
    for (const newline of ["\n", "\r\n"]) {
      await fs.writeFile(path.join(temporary, "desktop", "renderer", "favicon.svg"), favicon.replace(/\r?\n/g, newline));
      await fs.writeFile(path.join(temporary, "build", "desktop", "brand", "hive-small.svg"), small.replace(/\r?\n/g, newline));
      execFileSync(process.execPath, [path.join(root, "scripts", "generate-desktop-icon.mjs")], { cwd: temporary, windowsHide: true, stdio: "pipe" });
      outputs.push(await fs.readFile(path.join(temporary, "build", "desktop", "icon.ico")));
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.equal(outputs[0].readUInt16LE(4), 7);
  } finally { await fs.rm(temporary, { recursive: true }); }
});
test("sandboxed preload accepts bounded shared history beyond the legacy one-megabyte limit", async () => {
  const source = await fs.readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  let api;
  let event = { type: "projects.snapshot", timestamp: new Date().toISOString(), snapshot: { schemaVersion: 1, revision: 1, projects: [], sessions: [], warnings: ["History-sized text ".repeat(70_000)] } };
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer: { invoke: async () => event } }) });
  assert.equal((await api.request({ type: "projects.snapshot", requestId })).type, "projects.snapshot");
  event = { type: "chat.failed", timestamp: new Date().toISOString(), message: "x".repeat(1_000_001) };
  await assert.rejects(api.request({ type: "projects.snapshot", requestId }), /too large/);
});
