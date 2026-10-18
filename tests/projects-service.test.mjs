import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ProjectSessionService, parseProjectAction } from "../dist/projects/service.js";
import { ProjectStore } from "../dist/projects/store.js";
import { identifyProject } from "../dist/projects/run-control.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";

const request = (type, fields) => ({ type, requestId: randomUUID(), ...fields });
test("a failed startup cancellation keeps the live engine owned until its completion", async (t) => {
  let releaseStart; let finish; let entered = false;
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  const completion = new Promise((resolve) => { finish = resolve; });
  const engine = { async start() { entered = true; await gate; return { completion, cancel() { throw new Error("Cancellation transport unavailable"); } }; } };
  const { service, peer, sessionId, projectId } = await fixture(t, engine, { closeTimeoutMs: 25 });
  await service.action(request("session.send", { sessionId, text: "Hold the owned run" }));
  await until(async () => entered, Boolean);
  const closing = service.close();
  releaseStart();
  await assert.rejects(closing, /timed out|ownership|acknowledg/i);
  const active = await service.snapshot();
  assert.ok(["running", "stopping"].includes(active.sessions[0].runs[0].status));
  assert.equal(Object.keys((await service.store.load()).owners).length, 1);
  const other = await peer.action(request("session.create", { projectId }));
  await assert.rejects(peer.action(request("session.send", { sessionId: other.result.sessionId, text: "Conflicting run" })), /owns this workspace/);
  finish({ status: "cancelled", summary: "Actual engine completion acknowledged" });
  await until(() => service.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "cancelled");
  assert.equal(Object.keys((await service.store.load()).owners).length, 0);
});
async function fixture(t, engine, additional = {}) {
  const directory = path.join(os.tmpdir(), `hive-project-service-${randomUUID()}`);
  if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, `${directory}\n`);
  await fs.mkdir(directory);
  const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace);
  if (additional.initializeGit) { execFileSync("git", ["init", "-b", "main"], { cwd: workspace }); execFileSync("git", ["config", "user.name", "HIVE Test"], { cwd: workspace }); execFileSync("git", ["config", "user.email", "hive@example.test"], { cwd: workspace }); await fs.writeFile(path.join(workspace, "source.txt"), "fixture\n"); execFileSync("git", ["add", "source.txt"], { cwd: workspace }); execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace }); }
  const options = { catalogPath: path.join(directory, "catalog.json"), pollMs: 50, engine, ...additional };
  const service = new ProjectSessionService(options); const peer = new ProjectSessionService(options);
  t.after(async () => { await service.close(); await peer.close(); await fs.rm(directory, { recursive: true }); });
  const { result } = await service.action(request("project.attach", { path: workspace }));
  const session = await service.action(request("session.create", { projectId: result.projectId }));
  return { directory, workspace, service, peer, projectId: result.projectId, sessionId: session.result.sessionId };
}
async function until(operation, predicate) { const deadline = Date.now() + 4_000; while (Date.now() < deadline) { const value = await operation(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); } assert.fail("Timed out waiting for shared run state"); }
function controlledEngine() {
  let resolve; let started = 0; let cancelled = 0; let hooks;
  return { engine: { start(_input, actualHooks) { hooks = actualHooks; started += 1; return { completion: new Promise((done) => { resolve = done; }), cancel() { cancelled += 1; resolve({ status: "cancelled", summary: "Cancelled with actual acknowledgment" }); } }; } }, get started() { return started; }, get cancelled() { return cancelled; }, get hooks() { return hooks; }, finish(value) { resolve(value); } };
}

test("two clients share stable project/session histories and selection is only an entry hint", async (t) => {
  const { service, peer, projectId, sessionId, directory, workspace } = await fixture(t);
  const other = await peer.action(request("session.create", { projectId, title: "Other client draft" }));
  await service.action(request("session.select", { sessionId }));
  await peer.action(request("session.rename", { sessionId: other.result.sessionId, title: "Renamed session" }));
  await peer.action(request("project.rename", { projectId, name: "Colony" }));
  const snapshot = await service.snapshot(); assert.equal(snapshot.projects[0].id, projectId); assert.equal(snapshot.projects[0].lastSessionId, sessionId); assert.equal(snapshot.sessions[1].title, "Renamed session");
  assert.equal("draft" in snapshot.sessions[0], false); assert.equal("selectedSessionId" in snapshot, false);
  const renamed = path.join(directory, "renamed-workspace"); await fs.rename(workspace, renamed);
  const attached = await peer.action(request("project.attach", { path: renamed })); assert.equal(attached.result.projectId, projectId); assert.equal(attached.snapshot.projects.length, 1); assert.equal(attached.snapshot.projects[0].workspaces.length, 1);
});
test("idempotent sends reject conflicting workspace execution and preserve accepted messages", async (t) => {
  const controlled = controlledEngine(); const { service, peer, sessionId, projectId } = await fixture(t, controlled.engine);
  const send = request("session.send", { sessionId, text: "Implement one change" });
  const [first, duplicate] = await Promise.all([service.action(send), peer.action({ text: send.text, requestId: send.requestId, sessionId, type: "session.send" })]);
  assert.equal(first.result.runId, duplicate.result.runId); assert.equal(duplicate.result.duplicate || first.result.duplicate, true);
  await until(() => service.snapshot(), (snapshot) => controlled.started === 1 && snapshot.sessions[0].runs[0].status === "running");
  await assert.rejects(peer.action({ ...send, text: "A different request using an old id" }), /different action/);
  const second = await peer.action(request("session.create", { projectId }));
  await assert.rejects(peer.action(request("session.send", { sessionId: second.result.sessionId, text: "Conflicting work" })), /owns this workspace/);
  await assert.rejects(peer.action(request("session.archive", { sessionId })), /active run/);
  await assert.rejects(peer.action(request("session.settings", { sessionId, settings: { permissions: "autonomous" } })), /locked/);
  await peer.action(request("run.cancel", { sessionId, runId: first.result.runId }));
  const cancelled = await until(() => peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "cancelled"); assert.equal(controlled.cancelled, 1); assert.equal(cancelled.sessions[0].messages.length, 1);
  await peer.action(request("session.archive", { sessionId })); await service.action(request("session.restore", { sessionId })); assert.equal((await service.snapshot()).sessions[0].archived, false);
});
test("activity persists before publication, replay dedupes, and cross-client approval resolves once", async (t) => {
  const controlled = controlledEngine(); const { service, peer, sessionId } = await fixture(t, controlled.engine);
  const send = await service.action(request("session.send", { sessionId, text: "Inspect workspace" }));
  await until(() => service.snapshot(), () => !!controlled.hooks);
  const event = { type: "activity", role: "Scout", kind: "tool", text: "Read source", source: { codingSessionId: "coding-1", sequence: 1 } };
  await controlled.hooks.persist(event); await controlled.hooks.persist(event);
  assert.equal((await peer.snapshot()).sessions[0].runs[0].events.length, 1);
  const decision = controlled.hooks.requestApproval({ tool: "run_command", description: "Run the bounded test", input: { command: "node --test" }, external: false });
  const pending = await until(() => peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "awaiting_approval");
  const approvalId = pending.sessions[0].runs[0].approvals[0].id;
  await peer.action(request("run.approve", { sessionId, runId: send.result.runId, approvalId, approved: true })); assert.equal(await decision, true);
  await assert.rejects(service.action(request("run.approve", { sessionId, runId: send.result.runId, approvalId, approved: true })), /stale/);
  controlled.finish({ status: "completed", summary: "Read complete", text: "Actual source inspected" });
  await until(() => peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "completed");
  await peer.action(request("run.review", { sessionId, runId: send.result.runId }));
  assert.ok((await service.snapshot()).sessions[0].runs[0].reviewedAt);
});
test("missing engine rejects before accepting a message and terminal checks retain actual exit status", async (t) => {
  const noEngine = await fixture(t); await assert.rejects(noEngine.service.action(request("session.send", { sessionId: noEngine.sessionId, text: "Draft stays local" })), /draft was not accepted/); assert.equal((await noEngine.peer.snapshot()).sessions[0].messages.length, 0);
  const controlled = controlledEngine(); const withEngine = await fixture(t, controlled.engine); await withEngine.service.action(request("session.send", { sessionId: withEngine.sessionId, text: "Test" })); await until(() => withEngine.service.snapshot(), () => !!controlled.hooks);
  const check = { id: "check-1", name: "Unit", command: "node --test", workspace: withEngine.workspace, status: "failed", exitCode: 1 }; await controlled.hooks.persist({ type: "evidence", checks: [check] }); controlled.finish({ status: "failed", summary: "Test failed", checks: [check] });
  const failed = await until(() => withEngine.peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "failed"); assert.equal(failed.sessions[0].runs[0].checks[0].exitCode, 1); await assert.rejects(withEngine.peer.action(request("run.review", { sessionId: withEngine.sessionId, runId: failed.sessions[0].runs[0].id })), /completed/);
});
test("a confirmed exited owner becomes interrupted without inventing success", async (t) => {
  const { service, peer, sessionId, directory, workspace } = await fixture(t);
  const childPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  const store = new ProjectStore(path.join(directory, "catalog.json"));
  await store.mutate((state) => { const session = state.sessions.find((entry) => entry.id === sessionId); session.runs.push({ id: "run-crashed", sessionId, requestId: "request-crashed", workspaceId: session.workspaceId, workspace, status: "running", settings: session.settings, effectivePolicy: "safe", startedAt: new Date().toISOString(), endedAt: null, summary: "Running", events: [], patches: [], checks: [], engine: "live", approvals: [] }); state.owners["run-crashed"] = { instanceId: "exited-client", pid: childPid, cancelRequested: false }; });
  const recovered = await until(() => peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0]?.status === "interrupted"); assert.match(recovered.sessions[0].runs[0].summary, /new verified attempt/); assert.equal(recovered.sessions[0].runs[0].checks.length, 0);
});
test("action validation rejects unknown privilege fields and unsafe identifiers", () => {
  assert.throws(() => parseProjectAction({ requestId: "one", type: "session.send", sessionId: "session-1", text: "hello", shell: "anything" }), /Unexpected/);
  assert.throws(() => parseProjectAction({ requestId: "../escape", type: "session.select", sessionId: "session-1" }), /identifier/);
});
test("concurrent first attachment publishes a complete exclusive project marker", async (t) => {
  const { workspace } = await fixture(t);
  const fresh = path.join(workspace, "fresh"); await fs.mkdir(fresh);
  const identities = await Promise.all(Array.from({ length: 12 }, () => identifyProject(fresh)));
  assert.equal(new Set(identities.map((identity) => identity.id)).size, 1);
  const directory = path.join(fresh, ".hivemind", "hive-interface-v1"); assert.deepEqual(await fs.readdir(directory), ["project.json"]); assert.equal((await fs.stat(path.join(directory, "project.json"))).nlink, 1);
  const empty = path.join(workspace, "read-only"); await fs.mkdir(empty); await assert.rejects(identifyProject(empty, { create: false })); assert.deepEqual(await fs.readdir(empty), []);
});
test("a replaced workspace is rejected without creating identity markers or accepting the draft", async (t) => {
  const controlled = controlledEngine(); const { service, sessionId, directory, workspace } = await fixture(t, controlled.engine);
  await fs.rename(workspace, path.join(directory, "original-workspace")); await fs.mkdir(workspace); execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
  await assert.rejects(service.action(request("session.send", { sessionId, text: "Do not execute in this replacement" })), /identity/);
  assert.equal(controlled.started, 0); assert.equal((await service.snapshot()).sessions[0].messages.length, 0); await assert.rejects(fs.stat(path.join(workspace, ".git", "hive-interface-v1")), { code: "ENOENT" });
});
test("identity is checked again between durable acceptance and engine launch", async (t) => {
  const controlled = controlledEngine(); const { service, sessionId, directory, workspace } = await fixture(t, controlled.engine);
  const mutate = service.store.mutate.bind(service.store); let replaced = false;
  t.mock.method(service.store, "mutate", async (update) => { const result = await mutate(update); if (!replaced && result.state.sessions.some((session) => session.runs.some((run) => run.status === "queued"))) { replaced = true; await fs.rename(workspace, path.join(directory, "accepted-workspace")); await fs.mkdir(workspace); } return result; });
  await service.action(request("session.send", { sessionId, text: "Accepted in the original workspace" }));
  const failed = await until(() => service.snapshot(), (snapshot) => snapshot.sessions[0].runs[0]?.status === "failed"); assert.match(failed.sessions[0].runs[0].summary, /identity/); assert.equal(controlled.started, 0); assert.equal(failed.sessions[0].messages.length, 1);
});
test("throwing observers cannot strand accepted runs or hide queued ownership", async (t) => {
  const controlled = controlledEngine(); let serviceReference; let queuedOwned = false;
  const { service, sessionId } = await fixture(t, controlled.engine, { onSnapshot(snapshot) { if (snapshot.sessions.some((session) => session.runs.length)) queuedOwned ||= serviceReference?.hasOwnedRuns() ?? false; throw new Error("Presentation observer failed"); } }); serviceReference = service;
  await service.action(request("session.send", { sessionId, text: "Run despite observer failure" })); await until(() => service.snapshot(), () => controlled.started === 1); assert.equal(queuedOwned, true);
  controlled.finish({ status: "completed", summary: "Actual engine completion" }); await until(() => service.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "completed");
});
test("failed shutdown restores actions and polling, and shutdown can be retried", async (t) => {
  let finish; let starts = 0; const revisions = [];
  const engine = { start() { starts += 1; return { completion: new Promise((resolve) => { finish = resolve; }), cancel() {} }; } };
  const { service, peer, projectId, sessionId } = await fixture(t, engine, { closeTimeoutMs: 30, onSnapshot(snapshot) { revisions.push(snapshot.revision); } });
  await service.action(request("session.send", { sessionId, text: "Wait for cancellation acknowledgment" })); await until(() => service.snapshot(), () => starts === 1);
  await assert.rejects(service.close(), /acknowledge shutdown/); assert.equal(service.hasOwnedRuns(), true);
  await service.action(request("session.create", { projectId, title: "Service is available again" }));
  const renamed = await peer.action(request("project.rename", { projectId, name: "Polling restored" })); await until(async () => revisions, (values) => values.includes(renamed.snapshot.revision));
  finish({ status: "cancelled", summary: "Engine acknowledged cancellation later" }); await until(() => peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "cancelled"); await service.close(); assert.equal(service.hasOwnedRuns(), false);
});
test("approval shows the planned coding workspace and rejects an arbitrary scope", async (t) => {
  const controlled = controlledEngine(); const { service, peer, sessionId, workspace, directory } = await fixture(t, controlled.engine, { initializeGit: true });
  const send = await service.action(request("session.send", { sessionId, text: "Plan one change" })); await until(() => service.snapshot(), () => !!controlled.hooks);
  const now = new Date().toISOString(); const id = "coding-approval-scope";
  await new CodingSessionStore(workspace).save({ schemaVersion: 1, id, objective: "One bounded change", mode: "auto", approvalPolicy: "safe", status: "paused", createdAt: now, updatedAt: now, repository: { root: workspace, capturedAt: now, dirty: false, changedFiles: [] }, tasks: [], events: [], providerBindings: [], validationResults: [], reviewResults: [], files: [] });
  await controlled.hooks.persist({ type: "engine", engineSessionId: id }); const planned = path.join(workspace, ".hivemind", "worktrees", id);
  await assert.rejects(controlled.hooks.requestApproval({ tool: "apply_workspace_changes", description: "Wrong scope", input: {}, external: false, workspace: path.join(directory, "other") }), /scope/);
  const decision = controlled.hooks.requestApproval({ tool: "apply_workspace_changes", description: "Create the planned worktree", input: { paths: ["source.txt"] }, external: false, workspace: planned });
  const pending = await until(() => peer.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].approvals.length === 1); const approval = pending.sessions[0].runs[0].approvals[0]; assert.equal(approval.workspace, planned); assert.notEqual(approval.workspace, workspace);
  await peer.action(request("run.approve", { sessionId, runId: send.result.runId, approvalId: approval.id, approved: false })); assert.equal(await decision, false); controlled.finish({ status: "cancelled", summary: "Changes declined" });
});
test("conversation fork preserves ancestry and messages without copying run claims or ownership", async (t) => {
  const controlled = controlledEngine(); const { service, peer, sessionId } = await fixture(t, controlled.engine);
  await service.action(request("session.send", { sessionId, text: "Source conversation" })); await until(() => service.snapshot(), () => !!controlled.hooks); await assert.rejects(peer.action(request("session.fork", { sessionId })), /active source/);
  controlled.finish({ status: "completed", summary: "Source complete", text: "Actual source reply" }); await until(() => service.snapshot(), (snapshot) => snapshot.sessions[0].runs[0].status === "completed");
  const fork = await peer.action(request("session.fork", { sessionId, title: "Explore another direction" })); const session = fork.snapshot.sessions.find((entry) => entry.id === fork.result.sessionId); assert.equal(session.forkedFrom, sessionId); assert.deepEqual(session.messages.map((message) => message.text), ["Source conversation", "Actual source reply"]); assert.equal(session.messages.some((message) => message.runId), false); assert.deepEqual(session.runs, []);
});
async function lockFixture(t) {
  const directory = path.join(os.tmpdir(), `hive-project-lock-${randomUUID()}`); if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, directory + "\n"); await fs.mkdir(directory); t.after(async () => { await fs.rm(directory, { recursive: true }); });
  const file = path.join(directory, "catalog.json"); const lock = `${file}.lock`;
  execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({token: require('node:crypto').randomUUID(), pid: process.pid}))", lock]);
  return { directory, file, lock };
}
test("a dead-owner catalog lock recovers once under concurrent mutations", async (t) => {
  const { file, lock } = await lockFixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, index) => new ProjectStore(file).mutate((state) => { state.warnings.push(`mutation-${index}`); })));
  const state = await new ProjectStore(file).load(); assert.equal(state.revision, 10); assert.equal(new Set(state.warnings).size, 10); await assert.rejects(fs.stat(lock), { code: "ENOENT" }); await assert.rejects(fs.stat(`${lock}.recovery`), { code: "ENOENT" });
});
test("a changed lock owner and an abandoned recovery guard are preserved", async (t) => {
  const first = await lockFixture(t); const liveContents = JSON.stringify({ token: randomUUID(), pid: process.pid }); const lstat = fs.lstat; let reads = 0;
  t.mock.method(fs, "lstat", async (...args) => { if (args[0] === first.lock && ++reads === 3) await fs.writeFile(first.lock, liveContents); return lstat(...args); });
  await assert.rejects(new ProjectStore(first.file).mutate((state) => { state.warnings.push("must not write"); }), /busy|preserved|recovery/); assert.equal(await fs.readFile(first.lock, "utf8"), liveContents);
  const second = await lockFixture(t); const original = await fs.readFile(second.lock, "utf8"); await fs.writeFile(`${second.lock}.recovery`, JSON.stringify({ token: randomUUID(), pid: process.pid }), { flag: "wx" });
  await assert.rejects(new ProjectStore(second.file).mutate((state) => { state.warnings.push("must not write"); }), /recovery guard preserved/); assert.equal(await fs.readFile(second.lock, "utf8"), original); assert.ok(await fs.stat(`${second.lock}.recovery`));
});
test("Windows sharing retries the same snapshot and preserves a changed persistence target", async (t) => {
  const { file } = await lockFixture(t); const store = new ProjectStore(file); await store.mutate((state) => { state.warnings.push("original"); });
  const rename = fs.rename; const sources = []; let replaceTarget = false;
  const foreign = JSON.stringify({ ...(await store.load()), warnings: ["changed by another writer"] });
  t.mock.method(fs, "rename", async (source, target) => {
    if (target !== file) return rename(source, target);
    sources.push(source);
    if (replaceTarget) { await fs.writeFile(file, foreign); throw Object.assign(new Error("Reader sharing violation"), { code: "EPERM" }); }
    if (sources.length === 1) throw Object.assign(new Error("Reader sharing violation"), { code: "EPERM" });
    return rename(source, target);
  });
  await store.mutate((state) => { state.warnings.push("published after retry"); }); assert.equal(sources.length, 2); assert.equal(sources[0], sources[1]); assert.equal((await store.load()).warnings.at(-1), "published after retry");
  replaceTarget = true; await assert.rejects(store.mutate((state) => { state.warnings.push("must not overwrite"); }), /newer file was preserved/); assert.equal(await fs.readFile(file, "utf8"), foreign);
});
