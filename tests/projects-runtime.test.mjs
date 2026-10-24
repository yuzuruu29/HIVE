import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProductionSessionEngine, checksFromCodingRecord } from "../dist/projects/runtime-adapter.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";

const execute = promisify(execFile);
const now = "2026-10-18T00:00:00.000Z";
async function fixture(t) {
  const directory = path.join(os.tmpdir(), `hive-project-runtime-${randomUUID()}`); if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, directory + "\n"); await fs.mkdir(directory);
  await execute("git", ["init", "-b", "main"], { cwd: directory }); await execute("git", ["config", "user.name", "HIVE Test"], { cwd: directory }); await execute("git", ["config", "user.email", "hive@example.test"], { cwd: directory }); await fs.writeFile(path.join(directory, "source.txt"), "first\n"); await execute("git", ["add", "source.txt"], { cwd: directory }); await execute("git", ["commit", "-m", "fixture"], { cwd: directory });
  const baseCommit = String((await execute("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout).trim();
  t.after(async () => { await fs.rm(directory, { recursive: true }); });
  const settings = { mode: "code", permissions: "guarded" }; const workspace = { id: "workspace-fixture", path: directory, branch: "main", repositoryId: "project-fixture" };
  const project = { id: "project-fixture", name: "Fixture", repositoryId: "project-fixture", repositoryPath: directory, workspaces: [workspace], lastSessionId: "session-fixture", createdAt: now, updatedAt: now };
  const run = { id: "run-fixture", sessionId: "session-fixture", requestId: "request-fixture", workspaceId: workspace.id, workspace: directory, status: "queued", settings, effectivePolicy: "safe", startedAt: now, endedAt: null, summary: "Queued", events: [], patches: [], checks: [], engine: "live", approvals: [] };
  const session = { id: "session-fixture", projectId: project.id, workspaceId: workspace.id, title: "Fixture", archived: false, createdAt: now, updatedAt: now, settings, messages: [{ id: "message-fixture", role: "user", text: "Inspect source", createdAt: now, runId: run.id }], runs: [run], sources: [] };
  const record = { schemaVersion: 1, id: "coding-fixture", objective: "Inspect source", mode: "auto", approvalPolicy: "safe", status: "completed", createdAt: now, updatedAt: now, repository: { root: directory, capturedAt: now, dirty: false, changedFiles: [], baseCommit, branch: "main" }, events: [], tasks: [], providerBindings: [], validationResults: [], reviewResults: [], files: [] };
  return { directory, input: { project, session, run, text: "Inspect source" }, record };
}
const event = (sequence, type, payload) => ({ schemaVersion: 1, id: `event-${sequence}`, sequence, sessionId: "coding-fixture", timestamp: now, type, payload });
test("role activity follows the engine task rather than labelling every tool as Builder", async (t) => {
  const { input, record } = await fixture(t);
  const published = [];
  const adapter = createProductionSessionEngine({ runCoding: async (options) => {
    options.onEvent(event(1, "subagent.created", { subagentId: "validator-one", task: { id: "validator-one", title: "Run checks", role: "validator" } }));
    options.onEvent(event(2, "subagent.started", { subagentId: "validator-one", attempt: 1 }));
    options.onEvent(event(3, "subagent.tool_call", { subagentId: "validator-one", tool: "command" }));
    options.onEvent(event(4, "command.started", { commandId: "check-one", taskId: "validator-one", command: "node --test", cwd: input.run.workspace }));
    options.onEvent(event(5, "command.completed", { commandId: "check-one", exitCode: 0, durationMs: 1 }));
    return record;
  } });
  await adapter.start(input, { persist: async (value) => { published.push(value); }, requestApproval: async () => false }).completion;
  assert.equal(published.filter((value) => value.type === "activity").length, 5);
  assert.ok(published.every((value) => value.type !== "activity" || value.role === "Validator"));
});
test("verified resume persists coding identity before any managed-workspace permission", async (t) => {
  const { input, record, directory } = await fixture(t);
  const saved = { ...record, status: "paused", repository: { ...record.repository, worktreePath: directory } };
  await new CodingSessionStore(directory).save(saved);
  input.session.runs.unshift({ ...input.run, id: "previous-run", engineSessionId: saved.id, status: "interrupted" });
  input.run.parentRunId = "previous-run";
  const published = [];
  const adapter = createProductionSessionEngine({ runCoding: async (options) => {
    assert.equal(options.resumeId, saved.id);
    options.onEvent(event(2, "session.resumed", { repository: saved.repository }));
    await options.requestToolPermission({ tool: "command", description: "One fixture command", input: { command: "fixture" }, external: false, alwaysAsk: true }, options.signal);
    return saved;
  } });
  let approval = false;
  const handle = adapter.start(input, { persist: async (value) => { published.push(value); }, requestApproval: async (scope) => { approval = true; assert.ok(published.some((value) => value.type === "engine" && value.engineSessionId === saved.id)); assert.equal(scope.workspace, directory); return false; } });
  await handle.completion;
  assert.equal(approval, true);
});
test("production adapter retains runtime capabilities and resumes guarded changes only after scoped approval", async (t) => {
  const { input, record } = await fixture(t); const calls = []; const approvals = []; const published = []; const privateMcpInput = async () => ({ action: "decline" });
  input.run.executionContext = { skillIds: ["skill-one"], enabledMcpServers: ["server-one"], enabledLspServers: ["lsp-one"], pluginAgentId: "agent:trusted", outputStyleId: "style:trusted", invokedSkills: [{ id: "skill-one", arguments: "inspect" }] };
  const registry = { project: {} };
  const adapter = createProductionSessionEngine({ providerRegistries: registry, requestMcpInput: privateMcpInput, extensionOptions: { marker: "private" }, runCoding: async (options) => {
    calls.push(options); options.onEvent(event(calls.length * 3, "session.created", { objective: "Inspect", mode: "auto", approvalPolicy: options.approvalPolicy }));
    if (calls.length === 1) { const paused = event(4, "session.paused", { reason: "Repository changes require approval. Resume with --approval changes or always." }); options.onEvent(paused); return { ...record, status: "paused", events: [paused] }; }
    return { ...record, approvalPolicy: "changes", status: "completed" };
  } });
  const handle = await adapter.start(input, { async persist(value) { published.push(value); }, async requestApproval(value) { approvals.push(value); return true; } }); const outcome = await handle.completion;
  assert.equal(outcome.status, "completed"); assert.equal(calls.length, 2); assert.equal(calls[0].approvalPolicy, "safe"); assert.equal(calls[1].resumeId, record.id); assert.equal(calls[1].approvalPolicy, "changes"); assert.equal(calls[1].providerRegistries, registry); assert.equal(calls[1].requestMcpInput, privateMcpInput); assert.deepEqual(calls[1].skillIds, ["skill-one"]); assert.deepEqual(calls[1].enabledMcpServers, ["server-one"]); assert.equal(calls[1].pluginAgentId, "agent:trusted"); assert.equal(approvals[0].tool, "apply_workspace_changes"); assert.ok(published.some((value) => value.type === "engine" && value.engineSessionId === record.id));
});
test("a declined guarded plan never starts the writing attempt", async (t) => {
  const { input, record } = await fixture(t); let calls = 0;
  const adapter = createProductionSessionEngine({ runCoding: async () => { calls += 1; return { ...record, status: "paused", events: [event(1, "session.paused", { reason: "Repository changes require approval." })], plan: { summary: "Read-only plan", tasks: [] } }; } });
  const outcome = await (await adapter.start(input, { async persist() {}, async requestApproval() { return false; } })).completion; assert.equal(outcome.status, "cancelled"); assert.equal(calls, 1); assert.equal(outcome.engineSessionId, record.id); assert.deepEqual(outcome.patches, undefined);
});
test("current-attempt checks use actual command status and patches derive from actual file content", async (t) => {
  const { input, record, directory } = await fixture(t); input.run.settings.permissions = "standard"; input.run.effectivePolicy = "changes";
  await fs.writeFile(path.join(directory, "source.txt"), "first\nsecond\n");
  let code = 0; try { await execute(process.execPath, ["-e", "process.exit(1)"], { cwd: directory }); } catch (error) { code = error.code; }
  const events = [event(1, "command.started", { commandId: "old", command: "old check", cwd: directory }), event(2, "command.completed", { commandId: "old", exitCode: 0, durationMs: 1 }), event(3, "command.started", { commandId: "current", command: "node -e process.exit(1)", cwd: directory }), event(4, "command.completed", { commandId: "current", exitCode: code, durationMs: 1 })];
  const result = { ...record, status: "failed", turnStartSequence: 3, events, files: [{ path: "source.txt", operation: "modified", recordedAt: now }], validationResults: [{ id: "unsupported-claim", command: "claimed pass", status: "passed", startedAt: now }] };
  const checks = checksFromCodingRecord(result); assert.equal(checks.some((check) => check.id === "old"), false); assert.equal(checks[0].status, "failed"); assert.equal(checks[0].exitCode, 1); assert.equal(checks[1].status, "not_run");
  const adapter = createProductionSessionEngine({ runCoding: async () => result }); const outcome = await (await adapter.start(input, { async persist() {}, async requestApproval() { return true; } })).completion;
  assert.equal(outcome.status, "failed"); assert.equal(outcome.patches.length, 1); assert.equal(outcome.patches[0].additions, 1); assert.match(outcome.patches[0].diff, /\+second/); assert.equal(outcome.checks[0].workspace, directory);
});
test("linked coding attempts are passed to Queen's existing continuity verification", async (t) => {
  const { input, record, directory } = await fixture(t); const store = new CodingSessionStore(directory); await store.save({ ...record, repository: { ...record.repository, worktreePath: directory, worktreeFingerprint: "1".repeat(64) } });
  input.session.runs.unshift({ ...input.run, id: "previous-run", status: "completed", engineSessionId: record.id }); input.run.parentRunId = "previous-run";
  let received;
  const adapter = createProductionSessionEngine({ runCoding: async (options) => { received = options; return record; } }); await (await adapter.start(input, { async persist() {}, async requestApproval() { return false; } })).completion;
  assert.equal(received.continuationId, record.id); assert.equal(received.resumeId, undefined);
});
test("chat accumulates real chunks, persists them before completion, and forwards conversation context", async (t) => {
  const { input } = await fixture(t); input.run.settings.mode = "chat"; input.session.messages.unshift({ id: "prior", role: "assistant", text: "Prior actual response", createdAt: now }); const published = []; let prompt;
  const adapter = createProductionSessionEngine({ createChat: () => ({ async complete(request) { prompt = request.prompt; request.onChunk("Hello"); request.onChunk(" world"); return { output: "Hello world", receipt: { role: "coding", providerId: "fixture-provider", model: "fixture-model" } }; } }) });
  const outcome = await (await adapter.start(input, { async persist(value) { await new Promise((resolve) => setTimeout(resolve, 2)); published.push(value); }, async requestApproval() { throw new Error("Chat must not request write permissions"); } })).completion;
  assert.equal(outcome.status, "completed"); assert.equal(outcome.text, "Hello world"); assert.match(prompt, /Prior actual response/); assert.equal(published.filter((event) => event.type === "text").at(-1).text, "Hello world"); assert.equal(outcome.checks, undefined);
});

test("creating then deleting a temporary file completes with no projected patch", async (t) => {
  const { input, record, directory } = await fixture(t);
  const adapter = createProductionSessionEngine({ runCoding: async () => {
    const temporary = path.join(directory, "temporary.txt");
    await fs.writeFile(temporary, "temporary\n");
    await fs.unlink(temporary);
    return { ...record, files: [
      { path: "temporary.txt", operation: "created", recordedAt: now },
      { path: "temporary.txt", operation: "deleted", recordedAt: now },
    ] };
  } });
  const outcome = await adapter.start(input, { async persist() {}, async requestApproval() { return false; } }).completion;
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.patches, []);
});

test("patches retain a new file's final content after modification and recreation", async (t) => {
  const { input, record, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, "new.txt"), "final content\n");
  const adapter = createProductionSessionEngine({ runCoding: async () => ({ ...record, files: [
    { path: "new.txt", operation: "created", recordedAt: now },
    { path: "new.txt", operation: "modified", recordedAt: now },
    { path: "recreated.txt", operation: "created", recordedAt: now },
    { path: "recreated.txt", operation: "deleted", recordedAt: now },
    { path: "recreated.txt", operation: "created", recordedAt: now },
  ] }) });
  await fs.writeFile(path.join(directory, "recreated.txt"), "replacement\n");
  const outcome = await adapter.start(input, { async persist() {}, async requestApproval() { return false; } }).completion;
  assert.equal(outcome.patches.length, 2);
  assert.match(outcome.patches.find((patch) => patch.path === "new.txt").diff, /\+final content/);
  assert.match(outcome.patches.find((patch) => patch.path === "recreated.txt").diff, /\+replacement/);
});

test("the authoritative styled final report replaces intermediate prose and supplies follow-up history", async (t) => {
  const { input, record } = await fixture(t);
  const published = [];
  const finalText = "## Final answer\n\n**Verified result.**";
  let calls = 0;
  const adapter = createProductionSessionEngine({ runCoding: async (options) => {
    if (calls++ === 0) options.onText("Intermediate planner prose");
    else { assert.match(options.context, /\*\*Verified result\.\*\*/); assert.doesNotMatch(options.context, /Intermediate planner prose/); }
    return { ...record, finalReport: { result: finalText } };
  } });
  const hooks = { async persist(value) { published.push(value); }, async requestApproval() { return false; } };
  const outcome = await adapter.start(input, hooks).completion;
  assert.equal(outcome.text, finalText);
  assert.equal(outcome.summary, finalText);
  input.session.messages.push({ id: "final-message", role: "assistant", runId: input.run.id, text: outcome.text, createdAt: now });
  await adapter.start({ ...input, run: { ...input.run, id: "follow-up-run" }, text: "Continue" }, hooks).completion;
});

test("check projection deduplicates new and legacy validation despite normalized command text and timing", async (t) => {
  const { record, directory } = await fixture(t);
  const startedAt = "2026-10-18T00:00:00.005Z";
  const completedAt = "2026-10-18T00:00:00.100Z";
  for (const commandId of ["command-one", undefined]) {
    const result = { id: "validation-one", commandId, taskId: "validator", command: 'node --test "tests/check.test.mjs"', status: "passed", startedAt: now, completedAt, exitCode: 0 };
    const checks = checksFromCodingRecord({ ...record, events: [
    { ...event(1, "command.started", { commandId: "command-one", taskId: "validator", command: "node --test tests/check.test.mjs", cwd: directory }), timestamp: startedAt },
    { ...event(2, "command.completed", { commandId: "command-one", exitCode: 0, durationMs: 90 }), timestamp: completedAt },
    ], validationResults: [result] });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, "command-one");
    assert.equal(checks[0].status, "passed");
  }
});

test("legacy validation timing deduplicates one execution while retaining repeats and unexecuted checks", async (t) => {
  const { record, directory } = await fixture(t);
  const at = (milliseconds) => new Date(Date.parse(now) + milliseconds).toISOString();
  const checks = checksFromCodingRecord({ ...record, events: [
    { ...event(1, "command.started", { commandId: "first", taskId: "validator", command: "node --test", cwd: directory }), timestamp: at(5) },
    { ...event(2, "command.completed", { commandId: "first", exitCode: 0, durationMs: 5 }), timestamp: at(10) },
    { ...event(3, "command.started", { commandId: "second", taskId: "validator", command: "node --test", cwd: directory }), timestamp: at(25) },
    { ...event(4, "command.completed", { commandId: "second", exitCode: 1, durationMs: 5 }), timestamp: at(30) },
    { ...event(5, "command.started", { commandId: "other-workspace", taskId: "builder", command: "node --test", cwd: path.join(directory, "other") }), timestamp: at(5) },
    { ...event(6, "command.completed", { commandId: "other-workspace", exitCode: 0, durationMs: 5 }), timestamp: at(10) },
  ], validationResults: [
    { id: "validation-first", taskId: "validator", command: "node --test", status: "passed", startedAt: at(0), completedAt: at(12), exitCode: 0 },
    { id: "validation-second", taskId: "validator", command: "node --test", status: "failed", startedAt: at(20), completedAt: at(32), exitCode: 1 },
    { id: "unexecuted", command: "npm run missing", status: "failed", startedAt: at(40), completedAt: at(42) },
  ] });
  assert.deepEqual(checks.map(({ id, status }) => ({ id, status })), [
    { id: "first", status: "passed" }, { id: "second", status: "failed" },
    { id: "other-workspace", status: "passed" }, { id: "unexecuted", status: "failed" },
  ]);
});
