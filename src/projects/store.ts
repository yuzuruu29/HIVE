import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { constants, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactKnownSecrets } from "../security/secrets.js";
import type { EngineOutcome, EngineUserEvent, ProjectAction, ProjectActionResult, ProjectSnapshot, SessionSettings, SharedExecutionContext } from "./types.js";

export interface RunOwner { instanceId: string; pid: number; cancelRequested: boolean }
export interface StoredProjectState extends ProjectSnapshot {
  requests: Record<string, { fingerprint: string; result: ProjectActionResult }>;
  owners: Record<string, RunOwner>;
  migrations: Record<string, string>;
}
export const emptyProjectState = (): StoredProjectState => ({ schemaVersion: 1, revision: 0, projects: [], sessions: [], warnings: [], requests: {}, owners: {}, migrations: {} });
const LIMIT = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface LockSnapshot { identity: Stats; contents: string; pid: number }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function definitelyExited(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; } }
async function readLock(file: string): Promise<LockSnapshot | undefined> {
  let stat: Stats;
  try { stat = await fs.lstat(file); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1_024) throw new Error(`Unsafe or incomplete project lock; preserved ${file}.`);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(stat, await handle.stat())) throw new Error(`Project lock changed while opening; preserved ${file}.`);
    const bytes = Buffer.alloc(1_025); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length !== stat.size || !sameFile(stat, await handle.stat())) throw new Error(`Project lock changed while reading; preserved ${file}.`);
    const contents = bytes.subarray(0, length).toString("utf8"); const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("token" in value) || typeof value.token !== "string" || !LOCK_TOKEN.test(value.token) || !("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2_147_483_647) throw new Error(`Invalid project lock owner; preserved ${file}.`);
    return { identity: stat, contents, pid: value.pid };
  } finally { await handle.close(); }
}
/** Recover only a demonstrably exited owner, under a separately owned exclusive guard. */
async function recoverDeadLock(file: string): Promise<boolean> {
  const original = await readLock(file); if (!original || !definitelyExited(original.pid)) return !original;
  const guard = `${file}.recovery`; let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(guard, "wx+", 0o600); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return false; throw error; }
  const contents = JSON.stringify({ token: randomUUID(), pid: process.pid });
  try {
    await handle.writeFile(contents); await handle.sync();
    const current = await readLock(file);
    if (!current) return true;
    if (!sameFile(original.identity, current.identity) || current.contents !== original.contents) throw new Error(`Project lock ownership changed during recovery; preserved ${file}.`);
    if (!definitelyExited(current.pid)) return false;
    const final = await readLock(file);
    if (!final || !sameFile(current.identity, final.identity) || current.contents !== final.contents || !definitelyExited(final.pid)) throw new Error(`Project lock changed before recovery; preserved ${file}.`);
    await fs.unlink(file); return true;
  } finally {
    try { const owned = await handle.stat(); const current = await readLock(guard); if (!current || !sameFile(owned, current.identity) || current.contents !== contents) throw new Error(`Project recovery guard ownership changed; preserved ${guard}.`); await fs.unlink(guard); }
    finally { await handle.close(); }
  }
}
async function snapshotIdentity(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT) throw new Error("Shared project state must remain a bounded regular file.");
    const content = await fs.readFile(file);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}:${createHash("sha256").update(content).digest("hex")}`;
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}
export function assertProjectId(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid project/session/request identifier."); }
function record(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object."); }
function text(value: unknown, maximum: number, label: string): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Invalid ${label}.`); }
function exact(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unexpected action field."); }
function date(value: unknown, label: string): void { text(value, 64, label); if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}.`); }
function count(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${label}.`); }
function validatePatch(value: unknown): void {
  record(value); exact(value, ["path", "previousPath", "additions", "deletions", "state", "workspace", "baseRevision", "diff", "binary", "truncated", "stale"]);
  text(value.path, 32_768, "patch path"); text(value.workspace, 32_768, "patch workspace");
  if (path.posix.isAbsolute(value.path) || path.win32.isAbsolute(value.path) || value.path.split(/[\\/]/).includes("..") || !path.isAbsolute(value.workspace) || !["proposed", "applied"].includes(String(value.state))) throw new Error("Invalid patch scope.");
  count(value.additions, "patch additions"); count(value.deletions, "patch deletions");
  if (value.previousPath !== undefined) text(value.previousPath, 32_768, "previous patch path"); if (value.baseRevision !== undefined) text(value.baseRevision, 128, "patch base revision");
  if (value.diff !== undefined && (typeof value.diff !== "string" || value.diff.length > 2_000_000)) throw new Error("Invalid patch content.");
  for (const key of ["binary", "truncated", "stale"]) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error("Invalid patch flag.");
}
function validateCheck(value: unknown): void {
  record(value); exact(value, ["id", "name", "command", "workspace", "status", "exitCode", "startedAt", "endedAt", "output"]);
  assertProjectId(value.id); text(value.name, 1_024, "check name"); text(value.command, 32_768, "check command"); text(value.workspace, 32_768, "check workspace");
  if (!path.isAbsolute(value.workspace) || !["passed", "failed", "not_run", "cancelled"].includes(String(value.status)) || !(value.exitCode === null || Number.isInteger(value.exitCode)) || value.status === "passed" && value.exitCode !== 0) throw new Error("Check result has no valid command execution evidence.");
  if (value.startedAt !== undefined) date(value.startedAt, "check start timestamp"); if (value.endedAt !== undefined) date(value.endedAt, "check end timestamp"); if (value.output !== undefined && (typeof value.output !== "string" || value.output.length > 2_000_000)) throw new Error("Invalid check output.");
}
export function validateEngineUserEvent(value: unknown): EngineUserEvent {
  boundedJson(value); record(value);
  switch (value.type) {
    case "activity": exact(value, ["type", "role", "kind", "text", "source"]); text(value.role, 96, "activity role"); text(value.kind, 96, "activity kind"); if (typeof value.text !== "string" || value.text.length > 100_000) throw new Error("Invalid activity text."); if (value.source !== undefined) { record(value.source); exact(value.source, ["codingSessionId", "sequence"]); assertProjectId(value.source.codingSessionId); count(value.source.sequence, "event source sequence"); if (value.source.sequence === 0) throw new Error("Invalid event sequence."); } break;
    case "text": exact(value, ["type", "text"]); if (typeof value.text !== "string" || value.text.length > 2_000_000) throw new Error("Invalid assistant text."); break;
    case "evidence": exact(value, ["type", "patches", "checks"]); if (value.patches !== undefined) { if (!Array.isArray(value.patches)) throw new Error("Invalid patch list."); value.patches.forEach(validatePatch); } if (value.checks !== undefined) { if (!Array.isArray(value.checks)) throw new Error("Invalid check list."); value.checks.forEach(validateCheck); } break;
    case "engine": exact(value, ["type", "engineSessionId", "effectivePolicy"]); assertProjectId(value.engineSessionId); if (value.effectivePolicy !== undefined) text(value.effectivePolicy, 128, "effective policy"); break;
    default: throw new Error("Unsupported engine event.");
  }
  return structuredClone(value) as EngineUserEvent;
}
export function validateEngineOutcome(value: unknown): EngineOutcome {
  boundedJson(value); record(value); exact(value, ["status", "summary", "text", "engineSessionId", "patches", "checks"]);
  if (!["completed", "cancelled", "failed", "interrupted"].includes(String(value.status))) throw new Error("Invalid engine outcome."); text(value.summary, 100_000, "outcome summary");
  if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 2_000_000)) throw new Error("Invalid outcome text."); if (value.engineSessionId !== undefined) assertProjectId(value.engineSessionId);
  if (value.patches !== undefined) { if (!Array.isArray(value.patches)) throw new Error("Invalid outcome patches."); value.patches.forEach(validatePatch); } if (value.checks !== undefined) { if (!Array.isArray(value.checks)) throw new Error("Invalid outcome checks."); value.checks.forEach(validateCheck); }
  return structuredClone(value) as unknown as EngineOutcome;
}
export function parseExecutionContext(value: unknown): SharedExecutionContext {
  record(value); exact(value, ["skillIds", "enabledMcpServers", "enabledLspServers", "pluginAgentId", "outputStyleId", "invokedSkills", "imagePaths"]);
  for (const key of ["skillIds", "enabledMcpServers", "enabledLspServers", "imagePaths"]) {
    const entries = value[key]; if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 16) throw new Error("Too many selected execution capabilities.");
    for (const entry of entries) { text(entry, 1_024, "execution capability"); if (key === "imagePaths" && !path.isAbsolute(entry)) throw new Error("Image references must be absolute local paths."); }
  }
  for (const key of ["pluginAgentId", "outputStyleId"]) if (value[key] !== undefined && value[key] !== null) text(value[key], 1_024, key);
  if (value.invokedSkills !== undefined) { if (!Array.isArray(value.invokedSkills) || value.invokedSkills.length > 16) throw new Error("Too many invoked skills."); for (const entry of value.invokedSkills) { record(entry); exact(entry, ["id", "arguments"]); text(entry.id, 1_024, "invoked skill id"); if (typeof entry.arguments !== "string" || entry.arguments.length > 8_000 || entry.arguments.includes("\0")) throw new Error("Invalid skill arguments."); } }
  return structuredClone(value) as SharedExecutionContext;
}
export function assertCouncilExecutionContext(context: SharedExecutionContext | undefined): void {
  if (context && [context.skillIds, context.enabledMcpServers, context.enabledLspServers, context.invokedSkills, context.imagePaths].some((values) => values?.length)
    || context?.pluginAgentId || context?.outputStyleId) {
    throw new Error("Council mode runs only the built-in HIVE council; switch to Code, Plan, or Review for extensions and images.");
  }
}
export function parseSessionSettings(value: unknown, partial = false): Partial<SessionSettings> {
  record(value); exact(value, ["mode", "permissions", "providerId", "model"]);
  if ((!partial || value.mode !== undefined) && !["chat", "code", "plan", "review", "council"].includes(String(value.mode))) throw new Error("Invalid session mode.");
  if ((!partial || value.permissions !== undefined) && !["guarded", "standard", "autonomous"].includes(String(value.permissions))) throw new Error("Invalid session permissions.");
  if (value.providerId !== undefined && !(partial && value.providerId === "")) { assertProjectId(value.providerId); }
  if (value.model !== undefined && !(partial && value.model === "")) text(value.model, 256, "model");
  return { ...(value.mode !== undefined ? { mode: value.mode as SessionSettings["mode"] } : {}), ...(value.permissions !== undefined ? { permissions: value.permissions as SessionSettings["permissions"] } : {}), ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}), ...(typeof value.model === "string" ? { model: value.model } : {}) };
}
export function parseProjectAction(value: unknown): ProjectAction {
  record(value); assertProjectId(value.requestId); text(value.type, 40, "action type");
  let allowed = ["requestId", "type"];
  switch (value.type) {
    case "project.attach": text(value.path, 32_768, "project path"); if (!path.isAbsolute(value.path)) throw new Error("Project path must be absolute."); if (value.name !== undefined) text(value.name, 200, "project name"); allowed.push("path", "name"); break;
    case "project.rename": assertProjectId(value.projectId); text(value.name, 200, "project name"); allowed.push("projectId", "name"); break;
    case "session.create": assertProjectId(value.projectId); if (value.workspaceId !== undefined) assertProjectId(value.workspaceId); if (value.title !== undefined) text(value.title, 200, "session title"); if (value.settings !== undefined) parseSessionSettings(value.settings, true); allowed.push("projectId", "workspaceId", "title", "settings"); break;
    case "session.select": case "session.archive": case "session.restore": assertProjectId(value.sessionId); allowed.push("sessionId"); break;
    case "session.rename": assertProjectId(value.sessionId); text(value.title, 200, "session title"); allowed.push("sessionId", "title"); break;
    case "session.fork": assertProjectId(value.sessionId); if (value.title !== undefined) text(value.title, 200, "session title"); allowed.push("sessionId", "title"); break;
    case "session.settings": assertProjectId(value.sessionId); parseSessionSettings(value.settings, true); allowed.push("sessionId", "settings"); break;
    case "session.send": assertProjectId(value.sessionId); text(value.text, 24_000, "message"); if (value.parentRunId !== undefined) assertProjectId(value.parentRunId); if (value.executionContext !== undefined) parseExecutionContext(value.executionContext); allowed.push("sessionId", "text", "parentRunId", "executionContext"); break;
    case "run.cancel": case "run.review": assertProjectId(value.sessionId); assertProjectId(value.runId); allowed.push("sessionId", "runId"); break;
    case "run.approve": assertProjectId(value.sessionId); assertProjectId(value.runId); assertProjectId(value.approvalId); if (typeof value.approved !== "boolean") throw new Error("Approval decision must be a boolean."); allowed.push("sessionId", "runId", "approvalId", "approved"); break;
    default: throw new Error("Unsupported project action.");
  }
  exact(value, allowed);
  return structuredClone(value) as ProjectAction;
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 500_000 || depth > 32) throw new Error("Project state is too complex.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 2_000_000 && !value.includes("\0")) return;
  if (Array.isArray(value)) { for (const item of value) boundedJson(item, depth + 1, budget); return; }
  record(value); for (const [key, item] of Object.entries(value)) { if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe project state key."); boundedJson(item, depth + 1, budget); }
}
export function validateStoredProjectState(value: unknown): StoredProjectState {
  boundedJson(value); record(value);
  exact(value, ["schemaVersion", "revision", "projects", "sessions", "warnings", "requests", "owners", "migrations"]);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.projects) || !Array.isArray(value.sessions) || !Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string")) throw new Error("Invalid shared project state.");
  record(value.requests); record(value.owners); record(value.migrations);
  const projects = new Set<string>(); const sessions = new Set<string>(); const runs = new Set<string>();
  for (const project of value.projects) {
    record(project); exact(project, ["id", "name", "repositoryId", "repositoryPath", "workspaces", "lastSessionId", "createdAt", "updatedAt"]); assertProjectId(project.id); if (projects.has(project.id)) throw new Error("Duplicate project identity."); projects.add(project.id);
    text(project.name, 200, "project name"); text(project.repositoryId, 128, "repository identity"); text(project.repositoryPath, 32_768, "repository path"); if (!path.isAbsolute(project.repositoryPath) || !Array.isArray(project.workspaces)) throw new Error("Invalid project workspace.");
    const workspaceIds = new Set<string>();
    for (const workspace of project.workspaces) { record(workspace); exact(workspace, ["id", "path", "branch", "repositoryId"]); assertProjectId(workspace.id); if (workspaceIds.has(workspace.id)) throw new Error("Duplicate workspace identity."); workspaceIds.add(workspace.id); text(workspace.path, 32_768, "workspace path"); text(workspace.branch, 1_024, "workspace branch"); if (!path.isAbsolute(workspace.path) || workspace.repositoryId !== project.repositoryId) throw new Error("Workspace repository mismatch."); }
    if (project.lastSessionId !== null) assertProjectId(project.lastSessionId);
    date(project.createdAt, "project created timestamp"); date(project.updatedAt, "project updated timestamp");
  }
  for (const session of value.sessions) {
    record(session); exact(session, ["id", "projectId", "workspaceId", "title", "archived", "createdAt", "updatedAt", "settings", "messages", "runs", "sources", "forkedFrom"]); assertProjectId(session.id); assertProjectId(session.projectId); assertProjectId(session.workspaceId); if (sessions.has(session.id) || !projects.has(session.projectId)) throw new Error("Invalid session relationship."); sessions.add(session.id);
    if (session.forkedFrom !== undefined) { assertProjectId(session.forkedFrom); if (session.forkedFrom === session.id || !value.sessions.some((source) => objectWithId(source, session.forkedFrom) && source.projectId === session.projectId)) throw new Error("Invalid conversation fork ancestry."); }
    const project = value.projects.find((entry) => objectWithId(entry, session.projectId)); if (!project || !objectWithWorkspace(project, session.workspaceId)) throw new Error("Session workspace is not in its project.");
    text(session.title, 200, "session title"); if (typeof session.archived !== "boolean" || !Array.isArray(session.messages) || !Array.isArray(session.runs) || !Array.isArray(session.sources)) throw new Error("Invalid session contents."); parseSessionSettings(session.settings);
    date(session.createdAt, "session timestamp"); date(session.updatedAt, "session timestamp"); const messageIds = new Set<string>();
    for (const message of session.messages) { record(message); exact(message, ["id", "role", "text", "createdAt", "runId"]); assertProjectId(message.id); if (messageIds.has(message.id)) throw new Error("Duplicate message identity."); messageIds.add(message.id); if (!["user", "assistant", "system"].includes(String(message.role)) || typeof message.text !== "string") throw new Error("Invalid shared message."); date(message.createdAt, "message timestamp"); if (message.runId !== undefined) assertProjectId(message.runId); }
    for (const run of session.runs) {
      record(run); exact(run, ["id", "sessionId", "requestId", "workspaceId", "workspace", "status", "settings", "effectivePolicy", "startedAt", "endedAt", "summary", "events", "patches", "checks", "reviewedAt", "engine", "engineSessionId", "parentRunId", "approvals", "executionContext"]); assertProjectId(run.id); if (runs.has(run.id) || run.sessionId !== session.id) throw new Error("Invalid run relationship."); runs.add(run.id); assertProjectId(run.requestId); assertProjectId(run.workspaceId); text(run.workspace, 32_768, "run workspace"); if (!path.isAbsolute(run.workspace)) throw new Error("Run workspace must be absolute."); parseSessionSettings(run.settings); text(run.effectivePolicy, 128, "effective policy"); date(run.startedAt, "run start timestamp"); if (run.endedAt !== null) date(run.endedAt, "run end timestamp"); if (typeof run.summary !== "string") throw new Error("Invalid run summary."); if (run.reviewedAt !== undefined) date(run.reviewedAt, "review timestamp"); if (run.engineSessionId !== undefined) assertProjectId(run.engineSessionId); if (run.parentRunId !== undefined) assertProjectId(run.parentRunId);
      if (!["queued", "running", "awaiting_approval", "stopping", "completed", "cancelled", "failed", "interrupted"].includes(String(run.status)) || !["live", "imported", "unavailable"].includes(String(run.engine)) || !Array.isArray(run.events) || !Array.isArray(run.patches) || !Array.isArray(run.checks) || !Array.isArray(run.approvals)) throw new Error("Invalid shared run.");
      if (run.executionContext !== undefined) parseExecutionContext(run.executionContext);
      let sequence = 0;
      for (const event of run.events) { record(event); exact(event, ["id", "sequence", "role", "kind", "text", "createdAt", "source"]); assertProjectId(event.id); if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) <= sequence) throw new Error("Run event sequence is not monotonic."); sequence = Number(event.sequence); validateEngineUserEvent({ type: "activity", role: event.role, kind: event.kind, text: event.text, ...(event.source !== undefined ? { source: event.source } : {}) }); date(event.createdAt, "activity timestamp"); }
      run.checks.forEach(validateCheck); run.patches.forEach(validatePatch);
      for (const approval of run.approvals) { record(approval); exact(approval, ["id", "runId", "tool", "description", "input", "workspace", "external", "createdAt", "expiresAt", "status"]); assertProjectId(approval.id); if (approval.runId !== run.id || !["pending", "approved", "declined", "expired"].includes(String(approval.status)) || typeof approval.external !== "boolean") throw new Error("Invalid approval scope."); text(approval.tool, 128, "approval tool"); if (typeof approval.description !== "string") throw new Error("Invalid approval description."); text(approval.workspace, 32_768, "approval workspace"); const approvedPath = path.resolve(approval.workspace); const rootPath = path.resolve(run.workspace); const expectedPath = typeof run.engineSessionId === "string" ? path.resolve(run.workspace, ".hivemind", "worktrees", run.engineSessionId) : rootPath; const normalized = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value; if (!path.isAbsolute(approval.workspace) || ![normalized(rootPath), normalized(expectedPath)].includes(normalized(approvedPath))) throw new Error("Invalid approval workspace."); date(approval.createdAt, "approval timestamp"); date(approval.expiresAt, "approval expiry"); record(approval.input); }
    }
    for (const source of session.sources) { record(source); exact(source, ["kind", "id", "path", "digest"]); if (!["cli", "thread", "chat", "coding"].includes(String(source.kind))) throw new Error("Invalid legacy source."); text(source.id, 128, "source id"); text(source.path, 32_768, "source path"); text(source.digest, 64, "source digest"); if (!path.isAbsolute(source.path) || !/^[0-9a-f]{64}$/.test(source.digest)) throw new Error("Invalid legacy source provenance."); }
    for (const message of session.messages) if (message.runId !== undefined && !session.runs.some((run) => objectWithId(run, message.runId))) throw new Error("Message references a missing run.");
  }
  for (const project of value.projects) if (project.lastSessionId !== null && !value.sessions.some((session) => objectWithId(session, project.lastSessionId) && session.projectId === project.id)) throw new Error("Project entry hint references a missing session.");
  for (const [runId, owner] of Object.entries(value.owners)) { assertProjectId(runId); record(owner); exact(owner, ["instanceId", "pid", "cancelRequested"]); assertProjectId(owner.instanceId); if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.cancelRequested !== "boolean" || !runs.has(runId)) throw new Error("Invalid run owner."); }
  for (const [id, request] of Object.entries(value.requests)) { assertProjectId(id); record(request); exact(request, ["fingerprint", "result"]); if (typeof request.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(request.fingerprint)) throw new Error("Invalid accepted request fingerprint."); record(request.result); exact(request.result, ["projectId", "sessionId", "runId", "duplicate"]); for (const key of ["projectId", "sessionId", "runId"]) if (request.result[key] !== undefined) assertProjectId(request.result[key]); if (request.result.duplicate !== undefined && typeof request.result.duplicate !== "boolean") throw new Error("Invalid accepted request result."); }
  for (const directory of Object.values(value.migrations)) { text(directory, 32_768, "migration backup directory"); if (!path.isAbsolute(directory)) throw new Error("Invalid migration backup location."); }
  return value as unknown as StoredProjectState;
}
function objectWithId(value: unknown, id: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && "id" in value && value.id === id; }
function objectWithWorkspace(value: Record<string, unknown>, id: unknown): boolean { return Array.isArray(value.workspaces) && value.workspaces.some((workspace) => objectWithId(workspace, id)); }
export function validateProjectSnapshot(value: unknown): ProjectSnapshot { record(value); exact(value, ["schemaVersion", "revision", "projects", "sessions", "warnings"]); return publicProjectSnapshot(validateStoredProjectState({ ...value, requests: {}, owners: {}, migrations: {} })); }
export function publicProjectSnapshot(state: StoredProjectState): ProjectSnapshot { return structuredClone({ schemaVersion: state.schemaVersion, revision: state.revision, projects: state.projects, sessions: state.sessions, warnings: state.warnings }); }
export function actionFingerprint(action: ProjectAction): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(action))).digest("hex");
}
export class ProjectStore {
  readonly file: string;
  constructor(file = path.join(os.homedir(), ".hive", "interface-v1", "catalog.json")) { this.file = path.resolve(file); }
  async load(): Promise<StoredProjectState> {
    try { const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT) throw new Error("Shared project state must be a bounded regular file."); return validateStoredProjectState(JSON.parse(await fs.readFile(this.file, "utf8"))); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyProjectState(); throw error; }
  }
  async mutate<T>(update: (state: StoredProjectState) => T | Promise<T>): Promise<{ state: StoredProjectState; result: T }> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`; const token = randomUUID(); const contents = JSON.stringify({ token, pid: process.pid });
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const deadline = Date.now() + 5_000;
    while (!handle) {
      try { handle = await fs.open(lock, "wx+", 0o600); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        // A creator can hold the file before its small owner record has been written.
        try { if (await recoverDeadLock(lock)) continue; }
        catch (error) { if (Date.now() >= deadline) throw error; }
        if (Date.now() >= deadline) throw new Error(`Shared project storage is busy or needs recovery. Existing lock and recovery guard preserved: ${lock}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    const identity = await handle.stat();
    try {
      await handle.writeFile(contents); await handle.sync();
      const expectedTarget = await snapshotIdentity(this.file);
      const state = await this.load(); const result = await update(state); state.revision += 1;
      validateStoredProjectState(state);
      const serialized = redactKnownSecrets(JSON.stringify(state, null, 2)) + "\n";
      if (Buffer.byteLength(serialized) > LIMIT) throw new Error("Shared project history exceeds 32 MiB; preserve and export it before continuing.");
      const temporary = `${this.file}.${process.pid}.${token}.tmp`;
      let pending: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        pending = await fs.open(temporary, "wx", 0o600); await pending.writeFile(serialized, "utf8"); await pending.sync(); await pending.close(); pending = undefined;
        for (let attempt = 0; ; attempt += 1) {
          if (await snapshotIdentity(this.file) !== expectedTarget) throw new Error("Shared project state changed during atomic replacement; the newer file was preserved.");
          try { await fs.rename(temporary, this.file); break; }
          catch (error) { if (!(error instanceof Error && "code" in error && ["EPERM", "EBUSY"].includes(String(error.code))) || attempt >= 5) throw error; await new Promise<void>((resolve) => setTimeout(resolve, 20 * 2 ** attempt)); }
        }
      }
      finally { await pending?.close(); await fs.rm(temporary, { force: true }); }
      return { state: validateStoredProjectState(JSON.parse(serialized)), result };
    } finally {
      try { const stat = await fs.lstat(lock); if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino || await fs.readFile(lock, "utf8") !== contents) throw new Error(`Project lock ownership changed; preserved ${lock}.`); await fs.unlink(lock); } finally { await handle.close(); }
    }
  }
}
