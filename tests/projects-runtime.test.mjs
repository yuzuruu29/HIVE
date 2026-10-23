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
test("council mode runs the hive skill roles, publishes their activity and returns the HIVE Review", async (t) => {
  const { input, directory } = await fixture(t); input.run.settings.mode = "council"; const published = [];
  const outputs = { Queen: "Run contract: inspect source.\nPRESET: quick", Forger: "--- a/source.txt\n+++ b/source.txt", Sentinel: "**Verdict:** PASS WITH LIMITATIONS\n- not executed" };
  const adapter = createProductionSessionEngine({ createChat: () => ({ async complete(request) { const agent = String(request.prompt).match(/\[HIVE\] role: (\w+)/)[1]; return { output: outputs[agent], receipt: { role: request.role, providerId: "fixture-provider", model: "fixture-model", totalTokens: 10 } }; } }) });
  const outcome = await (await adapter.start(input, { async persist(value) { published.push(value); }, async requestApproval() { throw new Error("Council must not request write permissions"); } })).completion;
  assert.equal(outcome.status, "completed");
  assert.match(outcome.summary, /Council complete · quick preset · Sentinel PASS WITH LIMITATIONS/);
  assert.match(outcome.text, /^## HIVE Review — Complete/);
  assert.match(outcome.text, /Proposed change \(Forger, not applied\)[\s\S]*\+\+\+ b\/source\.txt/);
  const roles = [...new Set(published.filter((event) => event.type === "activity").map((event) => event.role))];
  assert.deepEqual(roles, ["Queen", "Forger", "Sentinel"]);
  assert.ok(published.some((event) => event.type === "activity" && event.role === "Queen" && event.kind === "completed" && event.text.startsWith("Run contract: inspect source.")));
  assert.equal(await fs.readFile(path.join(directory, "source.txt"), "utf8"), "first\n", "council never writes the workspace");
  assert.equal(outcome.patches, undefined);
});

test("council mode refuses extension capabilities instead of silently dropping them", async (t) => {
  const { input } = await fixture(t); input.run.settings.mode = "council"; input.run.executionContext = { skillIds: ["some-skill"] };
  const adapter = createProductionSessionEngine({ createChat: () => { throw new Error("must not reach the engine"); } });
  await assert.rejects((await adapter.start(input, { async persist() {}, async requestApproval() { return false; } })).completion, /Council mode runs only the built-in HIVE council/);
});

test("chat accumulates real chunks, persists them before completion, and forwards conversation context", async (t) => {
  const { input } = await fixture(t); input.run.settings.mode = "chat"; input.session.messages.unshift({ id: "prior", role: "assistant", text: "Prior actual response", createdAt: now }); const published = []; let prompt;
  const adapter = createProductionSessionEngine({ createChat: () => ({ async complete(request) { prompt = request.prompt; request.onChunk("Hello"); request.onChunk(" world"); return { output: "Hello world", receipt: { role: "coding", providerId: "fixture-provider", model: "fixture-model" } }; } }) });
  const outcome = await (await adapter.start(input, { async persist(value) { await new Promise((resolve) => setTimeout(resolve, 2)); published.push(value); }, async requestApproval() { throw new Error("Chat must not request write permissions"); } })).completion;
  assert.equal(outcome.status, "completed"); assert.equal(outcome.text, "Hello world"); assert.match(prompt, /Prior actual response/); assert.equal(published.filter((event) => event.type === "text").at(-1).text, "Hello world"); assert.equal(outcome.checks, undefined);
});
