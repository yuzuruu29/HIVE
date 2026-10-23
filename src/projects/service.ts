import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CodingSessionStore } from "../coding/session-store.js";
import { findRepositoryRoot } from "../coding/repository.js";
import { WorktreeManager } from "../worktree.js";
import { ProjectHistoryService, type HistoryImportPreview, type HistoryImportResult } from "./history.js";
import { redactKnownSecrets } from "../security/secrets.js";
import type { AcceptedRun, EngineHandle, EngineHooks, EngineOutcome, EngineUserEvent, ProjectAction, ProjectActionResponse, ProjectActionResult, ProjectSnapshot, SessionEngineAdapter, SessionSettings, SharedProject, SharedRun, SharedSession, WorkspaceRef } from "./types.js";
import { actionFingerprint, parseProjectAction, ProjectStore, publicProjectSnapshot, validateEngineOutcome, validateEngineUserEvent, type StoredProjectState } from "./store.js";
import { ACTIVE_RUN_STATUSES, identifyProject, ownerDefinitelyExited } from "./run-control.js";

export { parseProjectAction } from "./store.js";
export interface ProjectSessionServiceOptions { catalogPath?: string; engine?: SessionEngineAdapter; onSnapshot?: (snapshot: ProjectSnapshot) => void; pollMs?: number; closeTimeoutMs?: number; clock?: () => string }
const defaults: SessionSettings = { mode: "code", permissions: "guarded" };
function active(session: SharedSession): boolean { return session.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)); }
function requireSession(state: StoredProjectState, id: string): SharedSession { const session = state.sessions.find((entry) => entry.id === id); if (!session) throw new Error("Session not found."); return session; }
function requireRun(session: SharedSession, id: string): SharedRun { const run = session.runs.find((entry) => entry.id === id); if (!run) throw new Error("Run not found in this session."); return run; }
function safe(value: string): string { return redactKnownSecrets(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); }
export class ProjectSessionService {
  readonly store: ProjectStore;
  readonly #options: ProjectSessionServiceOptions;
  readonly #instanceId = `client-${randomUUID()}`;
  readonly #handles = new Map<string, EngineHandle>();
  readonly #starting = new Set<string>();
  readonly #cancelSent = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;
  #closed = false;
  #closing = false;
  #closeTask?: Promise<void>;
  #polling = false;
  #revision = -1;
  #lastSnapshot: ProjectSnapshot = { schemaVersion: 1, revision: 0, projects: [], sessions: [], warnings: [] };
  readonly #launches = new Map<string, Promise<void>>();
  readonly #actions = new Set<Promise<unknown>>();
  #pendingSends = 0;
  constructor(options: ProjectSessionServiceOptions = {}) {
    this.#options = options; this.store = new ProjectStore(options.catalogPath);
    this.#startPolling();
  }
  #startPolling(): void { if (this.#timer || this.#closed || this.#closing) return; this.#timer = setInterval(() => { void this.#poll().catch((error) => this.#report(error)); }, Math.max(50, this.#options.pollMs ?? 200)); this.#timer.unref(); }
  #now(): string { return this.#options.clock?.() ?? new Date().toISOString(); }
  #notify(snapshot: ProjectSnapshot): void { try { void Promise.resolve(this.#options.onSnapshot?.(snapshot)).catch(() => undefined); } catch { /* A presentation observer cannot own or interrupt durable execution. */ } }
  #publish(state: StoredProjectState): void { if (state.revision === this.#revision) return; this.#revision = state.revision; this.#lastSnapshot = publicProjectSnapshot(state); this.#notify(structuredClone(this.#lastSnapshot)); }
  #report(error: unknown): void { const message = safe(error instanceof Error ? error.message : String(error)); this.#notify({ ...structuredClone(this.#lastSnapshot), warnings: [...this.#lastSnapshot.warnings, `Shared project refresh failed: ${message}`] }); }
  hasOwnedRuns(): boolean { return this.#pendingSends > 0 || this.#launches.size > 0 || this.#starting.size > 0 || this.#handles.size > 0; }
  async snapshot(): Promise<ProjectSnapshot> { const state = await this.store.load(); this.#publish(state); return publicProjectSnapshot(state); }
  async previewImport(projectId: string, workspaceId?: string): Promise<HistoryImportPreview> { return new ProjectHistoryService(this).previewImport(projectId, workspaceId); }
  async importHistory(projectId: string, digest: string, workspaceId?: string): Promise<HistoryImportResult> {
    if (this.#closed || this.#closing) throw new Error("Project service is closing; history was not imported.");
    const promise = new ProjectHistoryService(this).importHistory(projectId, digest, workspaceId); this.#actions.add(promise);
    try { return await promise; } finally { this.#actions.delete(promise); }
  }
  async action(input: ProjectAction): Promise<ProjectActionResponse> {
    const send = input?.type === "session.send"; if (send) this.#pendingSends += 1;
    const promise = this.#act(input); this.#actions.add(promise);
    try { return await promise; } finally { this.#actions.delete(promise); if (send) this.#pendingSends -= 1; }
  }
  async #act(input: ProjectAction): Promise<ProjectActionResponse> {
    if (this.#closed || this.#closing) throw new Error(this.#closing ? "Project service is closing; retry when shutdown finishes." : "Project service is closed.");
    const action = parseProjectAction(input); const fingerprint = actionFingerprint(action);
    const location = action.type === "project.attach" ? await identifyProject(action.path) : undefined;
    let accepted: AcceptedRun | undefined;
    const mutation = await this.store.mutate(async (state): Promise<ProjectActionResult> => {
      if (this.#closed || this.#closing) throw new Error("Project service is closing; your action was not accepted.");
      const previous = state.requests[action.requestId];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Request identifier was already used for a different action."); return { ...previous.result, duplicate: true }; }
      const now = this.#now(); let result: ProjectActionResult = {};
      if (action.type === "project.attach" && location) {
        let project = state.projects.find((entry) => entry.id === location.id);
        if (!project) { project = { id: location.id, name: safe(action.name?.trim() || path.basename(location.workspace.path)), repositoryId: location.repositoryId, repositoryPath: location.repositoryPath, workspaces: [], lastSessionId: null, createdAt: now, updatedAt: now }; state.projects.push(project); }
        const workspace = project.workspaces.find((entry) => entry.id === location.workspace.id);
        if (workspace) Object.assign(workspace, location.workspace); else project.workspaces.push(location.workspace);
        if (project.workspaces.length === 1 || location.workspace.id === project.workspaces[0]?.id) project.repositoryPath = location.repositoryPath;
        project.updatedAt = now; result = { projectId: project.id };
      } else if (action.type === "project.rename") {
        const project = state.projects.find((entry) => entry.id === action.projectId); if (!project) throw new Error("Project not found."); project.name = safe(action.name.trim()); project.updatedAt = now; result = { projectId: project.id };
      } else if (action.type === "session.create") {
        const project = state.projects.find((entry) => entry.id === action.projectId); if (!project) throw new Error("Project not found."); const workspace = project.workspaces.find((entry) => !action.workspaceId || entry.id === action.workspaceId); if (!workspace) throw new Error("Project workspace not found.");
        const session: SharedSession = { id: `session-${randomUUID()}`, projectId: project.id, workspaceId: workspace.id, title: safe(action.title?.trim() || "New chat"), archived: false, createdAt: now, updatedAt: now, settings: { ...defaults, ...action.settings }, messages: [], runs: [], sources: [] };
        state.sessions.push(session); project.lastSessionId = session.id; result = { projectId: project.id, sessionId: session.id };
      } else if ("sessionId" in action) {
        const session = requireSession(state, action.sessionId); const project = state.projects.find((entry) => entry.id === session.projectId); if (!project) throw new Error("Session project not found.");
        result = { projectId: project.id, sessionId: session.id };
        switch (action.type) {
          case "session.select": project.lastSessionId = session.id; break;
          case "session.rename": session.title = safe(action.title.trim()); break;
          case "session.fork": {
            if (active(session)) throw new Error("Stop the active source run before forking its conversation.");
            const fork: SharedSession = { id: `session-${randomUUID()}`, projectId: session.projectId, workspaceId: session.workspaceId, title: safe(action.title?.trim() || `${session.title} (fork)`).slice(0, 200), archived: false, createdAt: now, updatedAt: now, settings: structuredClone(session.settings), messages: session.messages.map((message) => ({ id: `message-${randomUUID()}`, role: message.role, text: message.text, createdAt: message.createdAt })), runs: [], sources: structuredClone(session.sources), forkedFrom: session.id };
            state.sessions.push(fork); project.lastSessionId = fork.id; result.sessionId = fork.id; break;
          }
          case "session.archive": if (active(session)) throw new Error("Stop the active run before archiving this session."); session.archived = true; break;
          case "session.restore": session.archived = false; break;
          case "session.settings": if (active(session)) throw new Error("Session settings are locked during an active run."); session.settings = { ...session.settings, ...action.settings }; if (session.settings.providerId === "") delete session.settings.providerId; if (session.settings.model === "") delete session.settings.model; break;
          case "session.send": {
            if (session.archived) throw new Error("Restore this session before sending."); if (!this.#options.engine) throw new Error("The live engine adapter is unavailable; your draft was not accepted."); if (active(session)) throw new Error("This session already has an active run.");
            const workspace = project.workspaces.find((entry) => entry.id === session.workspaceId); if (!workspace) throw new Error("Session workspace not found.");
            const identity = await verifyWorkspace(project, workspace); workspace.branch = identity.workspace.branch;
            if (this.#closed || this.#closing) throw new Error("Project service is closing; your message was not accepted.");
            if (state.sessions.some((entry) => entry.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status) && samePath(run.workspace, workspace.path)))) throw new Error("Another HIVE run already owns this workspace.");
            if (action.parentRunId) { const parent = requireRun(session, action.parentRunId); if (ACTIVE_RUN_STATUSES.has(parent.status)) throw new Error("Stop the previous attempt before continuing."); }
            const run: SharedRun = { id: `run-${randomUUID()}`, sessionId: session.id, requestId: action.requestId, workspaceId: workspace.id, workspace: workspace.path, status: "queued", settings: structuredClone(session.settings), effectivePolicy: session.settings.permissions === "guarded" || ["plan", "review", "council"].includes(session.settings.mode) ? "safe" : "changes", startedAt: now, endedAt: null, summary: "Queued", events: [], patches: [], checks: [], engine: "live", approvals: [], ...(action.parentRunId ? { parentRunId: action.parentRunId } : {}) };
            if (action.executionContext) run.executionContext = structuredClone(action.executionContext);
            session.runs.push(run); session.messages.push({ id: `message-${randomUUID()}`, role: "user", text: safe(action.text), createdAt: now, runId: run.id }); if (session.messages.length === 1 && session.title === "New chat") session.title = safe(action.text.replace(/\s+/g, " ").trim().slice(0, 80));
            state.owners[run.id] = { instanceId: this.#instanceId, pid: process.pid, cancelRequested: false }; result.runId = run.id; accepted = structuredClone({ project, session, run, text: action.text }); break;
          }
          case "run.cancel": { const run = requireRun(session, action.runId); if (ACTIVE_RUN_STATUSES.has(run.status)) { const owner = state.owners[run.id]; if (!owner) throw new Error("The active run owner cannot be verified; inspect recovery state."); owner.cancelRequested = true; run.status = "stopping"; run.summary = "Stopping; awaiting engine acknowledgement"; } result.runId = run.id; break; }
          case "run.review": { const run = requireRun(session, action.runId); if (run.status !== "completed") throw new Error("Only a completed run can be marked reviewed."); run.reviewedAt = now; result.runId = run.id; break; }
          case "run.approve": { const run = requireRun(session, action.runId); const approval = run.approvals.find((entry) => entry.id === action.approvalId); if (!approval || approval.status !== "pending" || !ACTIVE_RUN_STATUSES.has(run.status) || run.status === "stopping") throw new Error("Approval is stale or already resolved."); if (Date.parse(approval.expiresAt) <= Date.now()) throw new Error("Approval has expired."); approval.status = action.approved ? "approved" : "declined"; run.status = "running"; result.runId = run.id; break; }
        }
        session.updatedAt = now; project.updatedAt = now;
      } else throw new Error("Unsupported shared action.");
      state.requests[action.requestId] = { fingerprint, result }; return result;
    });
    if (accepted) this.#starting.add(accepted.run.id);
    this.#publish(mutation.state);
    if (accepted) { const launch = accepted; this.#starting.add(launch.run.id); const completion = this.#launch(launch).catch((error) => this.#report(error)).finally(() => this.#launches.delete(launch.run.id)); this.#launches.set(launch.run.id, completion); }
    await this.#poll(); return { snapshot: await this.snapshot(), result: mutation.result };
  }
  async #launch(input: AcceptedRun): Promise<void> {
    const runId = input.run.id;
    try {
      await this.#updateRun(input.session.id, runId, (run) => { if (run.status !== "stopping") { run.status = "running"; run.summary = "Starting live engine"; } });
      if (this.#closed || this.#closing) { await this.#finish(input.session.id, runId, { status: "interrupted", summary: "Client closed before the live engine started." }); return; }
      const current = await this.store.load();
      if (current.owners[runId]?.cancelRequested) { await this.#finish(input.session.id, runId, { status: "cancelled", summary: "Cancelled before the live engine started." }); return; }
      const project = current.projects.find((entry) => entry.id === input.project.id); const workspace = project?.workspaces.find((entry) => entry.id === input.run.workspaceId);
      if (!project || !workspace || !samePath(workspace.path, input.run.workspace)) throw new Error("Execution workspace changed after acceptance; the engine was not started.");
      await verifyWorkspace(project, workspace);
      const hooks: EngineHooks = { persist: (event) => this.#persistEvent(input.session.id, runId, event), requestApproval: (request) => this.#requestApproval(input.session.id, runId, request) };
      const handle = await this.#options.engine!.start(input, hooks); this.#handles.set(runId, handle); this.#starting.delete(runId);
      try {
        if (this.#closed || this.#closing) await handle.cancel("HIVE client closed during engine startup.");
        await this.#poll();
      } catch (error) {
        this.#report(error);
        // Control/storage failure does not establish that a running engine stopped.
        try { await handle.cancel("HIVE could not verify run control state."); } catch (cancelError) { this.#report(cancelError); }
      }
      const outcome = validateEngineOutcome(await handle.completion); await this.#finish(input.session.id, runId, outcome);
    } catch (error) { await this.#finish(input.session.id, runId, { status: "failed", summary: safe(error instanceof Error ? error.message : String(error)) }); }
    finally { this.#starting.delete(runId); this.#handles.delete(runId); this.#cancelSent.delete(runId); }
  }
  async #updateRun(sessionId: string, runId: string, update: (run: SharedRun, session: SharedSession, state: StoredProjectState) => void): Promise<void> {
    const { state } = await this.store.mutate((state) => { const session = requireSession(state, sessionId); update(requireRun(session, runId), session, state); session.updatedAt = this.#now(); }); this.#publish(state);
  }
  async #persistEvent(sessionId: string, runId: string, event: EngineUserEvent): Promise<void> {
    event = validateEngineUserEvent(event);
    await this.#updateRun(sessionId, runId, (run, session) => {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return;
      if (event.type === "activity") { const source = event.source; if (source && run.events.some((entry) => entry.source?.codingSessionId === source.codingSessionId && entry.source?.sequence === source.sequence)) return; run.events.push({ id: `event-${randomUUID()}`, sequence: (run.events.at(-1)?.sequence ?? 0) + 1, role: safe(event.role), kind: safe(event.kind), text: safe(event.text), createdAt: this.#now(), ...(source ? { source } : {}) }); run.summary = safe(event.text); }
      if (event.type === "text") { const message = session.messages.find((entry) => entry.runId === runId && entry.role === "assistant"); if (message) message.text = safe(event.text); else session.messages.push({ id: `message-${randomUUID()}`, role: "assistant", text: safe(event.text), createdAt: this.#now(), runId }); }
      if (event.type === "evidence") { if (event.patches) run.patches = event.patches; if (event.checks) run.checks = event.checks; }
      if (event.type === "engine") { run.engineSessionId = event.engineSessionId; if (event.effectivePolicy) run.effectivePolicy = event.effectivePolicy; }
    });
  }
  async #finish(sessionId: string, runId: string, outcome: EngineOutcome): Promise<void> {
    await this.#updateRun(sessionId, runId, (run, session, state) => {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return;
      run.status = outcome.status; run.summary = safe(outcome.summary); run.endedAt = this.#now(); if (outcome.engineSessionId) run.engineSessionId = outcome.engineSessionId; if (outcome.patches) run.patches = outcome.patches; if (outcome.checks) run.checks = outcome.checks;
      if (outcome.text !== undefined) { const message = session.messages.find((entry) => entry.role === "assistant" && entry.runId === run.id); if (message) message.text = safe(outcome.text); else session.messages.push({ id: `message-${randomUUID()}`, role: "assistant", text: safe(outcome.text), createdAt: this.#now(), runId }); }
      for (const approval of run.approvals) if (approval.status === "pending") approval.status = "expired";
      delete state.owners[runId];
    });
  }
  async #requestApproval(sessionId: string, runId: string, request: Parameters<EngineHooks["requestApproval"]>[0]): Promise<boolean> {
    const id = `approval-${randomUUID()}`; const timeout = Math.max(1_000, Math.min(request.timeoutMs ?? 300_000, 600_000)); const expires = Date.now() + timeout;
    const state = await this.store.load(); const session = requireSession(state, sessionId); const run = requireRun(session, runId); const project = state.projects.find((entry) => entry.id === session.projectId); if (!project) throw new Error("Approval project is missing.");
    const workspace = await approvalWorkspace(project, run, request);
    await this.#updateRun(sessionId, runId, (run) => { if (!ACTIVE_RUN_STATUSES.has(run.status) || run.status === "stopping") throw new Error("Run is stopping."); run.approvals.push({ id, runId, tool: safe(request.tool), description: safe(request.description), input: request.input, workspace, external: request.external, createdAt: this.#now(), expiresAt: new Date(expires).toISOString(), status: "pending" }); run.status = "awaiting_approval"; run.summary = `Approval needed: ${safe(request.tool)}`; });
    while (!this.#closed && !this.#closing && Date.now() < expires) { const state = await this.store.load(); const run = requireRun(requireSession(state, sessionId), runId); const approval = run.approvals.find((entry) => entry.id === id); if (!approval || !ACTIVE_RUN_STATUSES.has(run.status) || run.status === "stopping") return false; if (approval.status !== "pending") return approval.status === "approved"; await new Promise<void>((resolve) => setTimeout(resolve, 100)); }
    await this.#updateRun(sessionId, runId, (run) => { const approval = run.approvals.find((entry) => entry.id === id); if (approval?.status === "pending") approval.status = "expired"; if (run.status === "awaiting_approval") run.status = "running"; }); return false;
  }
  async #poll(): Promise<void> {
    if (this.#closed || this.#closing || this.#polling) return; this.#polling = true;
    try {
      let state = await this.store.load();
      for (const [id, owner] of Object.entries(state.owners)) {
        const session = state.sessions.find((entry) => entry.runs.some((run) => run.id === id)); if (!session) continue;
        if (owner.instanceId === this.#instanceId && owner.cancelRequested && !this.#cancelSent.has(id)) { const handle = this.#handles.get(id); if (handle) { this.#cancelSent.add(id); try { await handle.cancel("Cancellation requested by a HIVE client."); } catch (error) { this.#cancelSent.delete(id); throw error; } } }
        else if (ownerDefinitelyExited(owner.pid)) { await this.#finish(session.id, id, { status: "interrupted", summary: "The owning HIVE process exited. Previous output and changes are preserved; start a new verified attempt." }); state = await this.store.load(); }
      }
      this.#publish(state);
    } finally { this.#polling = false; }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closeTask) return this.#closeTask;
    this.#closeTask = this.#attemptClose();
    try { await this.#closeTask; } finally { this.#closeTask = undefined; }
  }
  async #attemptClose(): Promise<void> {
    this.#closing = true; clearInterval(this.#timer); this.#timer = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = async (): Promise<void> => {
      await Promise.allSettled(this.#actions);
      const cancellations = await Promise.allSettled([...this.#handles].map(async ([id, handle]) => { this.#cancelSent.add(id); await handle.cancel("HIVE client is closing."); }));
      await Promise.allSettled(this.#launches.values());
      while (this.#polling) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const state = await this.store.load();
      const remaining = Object.entries(state.owners).filter(([, owner]) => owner.instanceId === this.#instanceId);
      if (remaining.length) throw new Error(`Live run completion could not be verified during shutdown (${remaining.map(([id]) => id).join(", ")}); durable state and ownership were preserved.`);
      const errors = cancellations.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "One or more live engines rejected shutdown cancellation.");
    };
    try { await Promise.race([settle(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Live engines did not acknowledge shutdown in time; HIVE must stay open and preserve their ownership.")), Math.max(1, this.#options.closeTimeoutMs ?? 40_000)); })]); this.#closed = true; }
    finally { if (timeout) clearTimeout(timeout); this.#closing = false; if (!this.#closed) this.#startPolling(); }
  }
}
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right); }
async function verifyWorkspace(project: SharedProject, workspace: WorkspaceRef): Promise<Awaited<ReturnType<typeof identifyProject>>> {
  let actual: Awaited<ReturnType<typeof identifyProject>>;
  try { actual = await identifyProject(workspace.path, { create: false }); }
  catch { throw new Error("Project workspace identity is missing or changed; reattach the correct folder before sending. No engine was started."); }
  if (actual.id !== project.id || actual.repositoryId !== project.repositoryId || actual.workspace.id !== workspace.id || !samePath(actual.workspace.path, workspace.path) || !samePath(actual.repositoryPath, workspace.path)) throw new Error("Project workspace identity changed; no engine was started.");
  return actual;
}
async function approvalWorkspace(project: SharedProject, run: SharedRun, request: Parameters<EngineHooks["requestApproval"]>[0]): Promise<string> {
  if (!run.engineSessionId) { if (request.workspace && !samePath(request.workspace, run.workspace)) throw new Error("Approval workspace has no verified coding provenance."); return run.workspace; }
  if (!request.workspace || !path.isAbsolute(request.workspace)) throw new Error("Coding approval requires an explicit execution workspace.");
  const root = await findRepositoryRoot(run.workspace); const record = await new CodingSessionStore(root).load(run.engineSessionId);
  if (!record || !samePath(await fs.realpath(record.repository.root), await fs.realpath(root))) throw new Error("Approval coding provenance could not be verified.");
  const planned = new WorktreeManager(root).getWorktreePath(record.id);
  const expected = record.repository.worktreePath ?? (request.tool === "apply_workspace_changes" || run.settings.mode === "code" ? planned : root);
  if (!samePath(request.workspace, expected)) throw new Error("Approval workspace does not match the coding execution scope.");
  try { const actual = await identifyProject(expected, { create: false }); if (actual.id !== project.id || !samePath(actual.workspace.path, expected) || expected !== root && actual.workspace.branch !== `hive-coder/${record.id}`) throw new Error("Coding approval belongs to a different workspace."); }
  catch (error) {
    if (!(request.tool === "apply_workspace_changes" && record.status === "paused" && samePath(expected, planned) && error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    let missingTarget = false;
    try { await fs.lstat(expected); } catch (missing) { if (!(missing instanceof Error && "code" in missing && missing.code === "ENOENT")) throw missing; missingTarget = true; }
    if (!missingTarget) throw error;
    let parent = path.dirname(expected);
    while (true) {
      try { const real = await fs.realpath(parent); const relative = path.relative(await fs.realpath(root), real); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Planned approval path escapes its repository."); break; }
      catch (missing) { if (!(missing instanceof Error && "code" in missing && missing.code === "ENOENT")) throw missing; const next = path.dirname(parent); if (next === parent) throw new Error("Planned approval has no verified repository parent."); parent = next; }
    }
  }
  return path.resolve(expected);
}
