import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectAction, ProjectActionResponse, ProjectSnapshot, SharedExecutionContext, SharedSession, SessionMode, SessionPermissions } from "../projects/types.js";
import { replaceTranscript, withHistory, type TuiState } from "./state.js";
import { serializeToolCard } from "./tool-card.js";
import { glyphsFor } from "./glyphs.js";
import { providerCatalog, providerPublicText } from "../providers/commands.js";
import { discoverExtensions, loadSkill } from "../extensions/index.js";
import { loadPluginAgent } from "../extensions/catalog.js";
import { renderSkillArguments } from "../extensions/skill-arguments.js";
import type { ExtensionOptions } from "../extensions/types.js";
import { parseTuiCommand } from "./commands.js";
import { newConversation } from "./conversations.js";
import { copyToClipboard } from "./clipboard.js";
import { writeHiveRunReport } from "../coding/report.js";
import { redactKnownSecrets, redactStreamingText } from "../security/secrets.js";
import { HISTORY_CHAR_BUDGET, compactHistory } from "../chat/history.js";
import type { HistoryImportPreview, HistoryImportResult } from "../projects/history.js";

/** Structural port keeps the native client on the same service as Desktop. */
export interface TuiProjectService {
  snapshot(): ProjectSnapshot | Promise<ProjectSnapshot>;
  action(action: ProjectAction): Promise<ProjectActionResponse>;
  close(): void | Promise<void>;
  previewImport?(projectId: string, workspaceId?: string): Promise<HistoryImportPreview>;
  importHistory?(projectId: string, digest: string, workspaceId?: string): Promise<HistoryImportResult>;
}

const ACTIVE = new Set(["queued", "running", "awaiting_approval", "stopping"]);
type LocalView = Pick<TuiState, "input" | "cursor" | "history" | "historyIndex" | "scrollOffset" | "toolCardFocus" | "conversation"> & { activity: boolean; changes: boolean };
const HELP = [
  "/projects [attach <path> | select <id>] · /sessions [search text | archived | select <id>]",
  "/new [title] · /rename <title> · /archive · /restore [id]",
  "/mode code|plan|chat · /permissions guarded|standard|autonomous · /model <provider> <model>",
  "/activity · /diff · /review (mark completed run reviewed) · /review run [request] (read-only review)",
  "/stop · /quit · Ctrl+O activity · Shift+Tab workflow · PgUp/PgDn scroll",
  "Enter sends · Ctrl+J inserts a newline · bracketed paste stays text",
  "/fork [title] forks conversation history, not the previous managed worktree · /copy [all] · /export [path] · /context",
  "/import preview · /import confirm <digest> imports inspected legacy history with a backup",
];

/** Selection and edit state are deliberately local, never taken from remote lastSessionId updates. */
export class TuiProjectClient {
  private snapshot?: ProjectSnapshot;
  private sessionId?: string;
  private projectId?: string;
  private views = new Map<string, LocalView>();
  private notes: string[] = [];
  private activity = false;
  private changes = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private pendingSend = false;
  private cancelPendingSend = false;
  private approvalId?: string;
  private approvalDraft?: { input: string; cursor: number };
  private suspendedAt?: number;
  private navigationInput?: string;

  constructor(private readonly service: TuiProjectService, private readonly cwd: string,
    private readonly getState: () => TuiState, private readonly update: (state: TuiState) => void,
    private readonly extensionOptions?: ExtensionOptions,
    private readonly operations: { copyToClipboard?: typeof copyToClipboard; writeReport?: typeof writeHiveRunReport } = {}) {}

  async start(initialMode?: string): Promise<void> {
    await this.refresh();
    let project = this.snapshot?.projects.find((item) => item.workspaces.some((workspace) => path.resolve(workspace.path) === path.resolve(this.cwd)));
    if (!project) {
      const attached = await this.act({ type: "project.attach", path: this.cwd, requestId: randomUUID() });
      project = attached.snapshot.projects.find((item) => item.id === attached.result.projectId);
    }
    if (!project) throw new Error("The workspace could not be attached. Use /projects attach <path>.");
    this.projectId = project.id;
    const recent = this.snapshot?.sessions.find((session) => session.id === project.lastSessionId && !session.archived);
    if (recent) this.selectLocal(recent);
    else await this.createSession();
    if (initialMode) {
      const mode: SessionMode = initialMode === "plan" || initialMode === "review" ? initialMode : "code";
      const permissions: SessionPermissions = initialMode === "standard" || initialMode === "autonomous" ? initialMode : "guarded";
      await this.settings({ mode, permissions });
    }
    this.timer = setInterval(() => { void this.refresh().catch((error: unknown) => this.notice(`Shared history unavailable: ${message(error)}. Your draft is preserved.`)); }, 750);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.service.close();
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const snapshot = await this.service.snapshot();
      if (this.stopped || snapshot.revision < (this.snapshot?.revision ?? -1)) return;
      this.snapshot = snapshot;
      this.project();
    } finally { this.polling = false; }
  }

  busy(): boolean { return this.pendingSend || Boolean(this.current()?.runs.some((run) => ACTIVE.has(run.status))); }
  async cancel(): Promise<void> {
    const session = this.current();
    const run = session?.runs.find((item) => ACTIVE.has(item.status));
    if (session && run) await this.act({ type: "run.cancel", sessionId: session.id, runId: run.id, requestId: randomUUID() });
    else if (this.pendingSend) { this.cancelPendingSend = true; this.notice("Stopping as soon as the accepted run is available."); }
  }
  toggleActivity(): void { this.activity = !this.activity; this.project(); }
  suspendProjection(): void { this.suspendedAt ??= this.getState().transcript.length; }
  resumeProjection(): void {
    if (this.suspendedAt === undefined) return;
    this.notes.push(...this.getState().transcript.slice(this.suspendedAt));
    this.notes = this.notes.slice(-30);
    this.suspendedAt = undefined;
    this.project();
  }
  async cycleMode(): Promise<void> {
    const modes: SessionMode[] = ["code", "plan", "chat"];
    const current = this.current()?.settings.mode ?? "code";
    await this.settings({ mode: modes[(modes.indexOf(current) + 1) % modes.length] });
  }
  async approve(approved: boolean): Promise<void> {
    const session = this.current();
    const run = session?.runs.find((item) => ACTIVE.has(item.status));
    const approval = run?.approvals.find((item) => item.status === "pending");
    if (!session || !run || !approval) throw new Error("This approval has already been resolved. Refresh and try again.");
    await this.act({ type: "run.approve", sessionId: session.id, runId: run.id, approvalId: approval.id, approved, requestId: randomUUID() });
  }

  /** Returns false for existing provider/extension commands handled by TuiApp. */
  async submit(raw: string): Promise<boolean> {
    const navigation = /^\/(?:projects|sessions?|resume|continue|new|fork)(?:\s|$)/i.test(raw) ? raw : undefined;
    if (navigation) this.navigationInput = navigation;
    try { return await this.submitCommand(raw); }
    finally { if (navigation && this.navigationInput === navigation) this.navigationInput = undefined; }
  }

  private async submitCommand(raw: string): Promise<boolean> {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
    const command = match?.[1]?.toLowerCase();
    const args = match?.[2]?.trim() ?? "";
    switch (command) {
      case "help": this.notice(HELP.join("\n")); return true;
      case "projects": {
        if (args.startsWith("attach ")) {
          const response = await this.act({ type: "project.attach", path: unquote(args.slice(7)), requestId: randomUUID() });
          if (response.result.projectId) await this.selectProject(response.result.projectId);
        } else if (args.startsWith("select ")) await this.selectProject(args.slice(7));
        else this.openProjects();
        return true;
      }
      case "sessions": case "session": case "resume": case "continue": {
        if (args.startsWith("select ")) await this.selectSession(args.slice(7));
        else if (args && command === "resume") await this.selectSession(args);
        else if (command === "continue") {
          const previous = this.snapshot?.sessions.filter((session) => session.projectId === this.projectId && !session.archived && session.messages.length > 0).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
          if (!previous) throw new Error("No shared history to continue. /import preview inspects legacy histories; /new starts a new session.");
          await this.selectSession(previous.id);
        }
        else this.openSessions(args);
        return true;
      }
      case "new": await this.createSession(args); return true;
      case "rename": await this.sessionAction("session.rename", args); return true;
      case "archive": await this.sessionAction("session.archive"); return true;
      case "restore": await this.sessionAction("session.restore", args); return true;
      case "fork": {
        const source = this.requireSession();
        const configuration = this.getState().conversation;
        const response = await this.act({ type: "session.fork", sessionId: source.id, ...(args ? { title: args } : {}), requestId: randomUUID() });
        const fork = response.snapshot.sessions.find((session) => session.id === response.result.sessionId);
        if (!fork) throw new Error("The shared fork could not be verified.");
        this.selectLocal(fork);
        if (configuration) this.update({ ...this.getState(), conversation: { ...newConversation(this.getState().sharedContext?.path ?? this.cwd, fork.settings.permissions), skillIds: configuration.skillIds, mcpServerIds: configuration.mcpServerIds, lspServerIds: configuration.lspServerIds, pluginAgentId: configuration.pluginAgentId, outputStyleId: configuration.outputStyleId, imagePaths: configuration.imagePaths } });
        this.notice(`Forked conversation from ${source.title}. History and settings are preserved; future code runs start from the attached workspace. The previous managed worktree was not cloned.`);
        return true;
      }
      case "export": {
        const session = this.requireSession();
        if (!session.messages.length) throw new Error("This shared session has no messages to export.");
        const content = [`# ${session.title}`, `Session: ${session.id}`, ...(session.forkedFrom ? [`Forked from: ${session.forkedFrom}`] : []), "", ...session.messages.flatMap((message) => [`## ${message.role}`, "", message.text, ""])].join("\n");
        const destination = await (this.operations.writeReport ?? writeHiveRunReport)(this.getState().sharedContext?.path ?? this.cwd, unquote(args) || `${session.id}.md`, redactKnownSecrets(content));
        this.notice(`Exported ${session.messages.length} shared messages to ${destination}`);
        return true;
      }
      case "copy": {
        if (args && args !== "all") throw new Error("Use /copy for the last assistant response, or /copy all for the shared conversation.");
        const messages = this.requireSession().messages;
        const text = args === "all" ? messages.map((message) => `${message.role}:\n${message.text}`).join("\n\n") : [...messages].reverse().find((message) => message.role === "assistant")?.text;
        if (!text) throw new Error("There is no shared response to copy yet.");
        await (this.operations.copyToClipboard ?? copyToClipboard)(redactStreamingText(text));
        this.notice(`Copied ${args === "all" ? "shared conversation" : "last shared response"} to the clipboard.`);
        return true;
      }
      case "context": {
        const messages = this.requireSession().messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: message.text, at: message.createdAt }));
        const bounded = compactHistory(messages, HISTORY_CHAR_BUDGET);
        this.notice(`Shared history: ${messages.length} messages, ${messages.reduce((count, message) => count + message.content.length, 0)} characters. Current send preview: ${bounded.kept.length} recent messages within the ${HISTORY_CHAR_BUDGET}-character history budget. Full history remains saved; runtime token usage is unavailable.`);
        return true;
      }
      case "compact":
        this.notice(`Manual compaction is unavailable for shared sessions. The engine bounds history to recent messages at send time (${HISTORY_CHAR_BUDGET} characters); this command has not changed or deleted saved messages. /context shows the current preview.`);
        return true;
      case "import": {
        const session = this.requireSession();
        if (!this.service.previewImport || !this.service.importHistory) throw new Error("History import is unavailable in this embedded service.");
        if (args === "preview" || !args) {
          const preview = await this.service.previewImport(session.projectId, session.workspaceId);
          this.notice(`Legacy history preview: ${preview.counts.cli} CLI, ${preview.counts.thread} threads, ${preview.counts.chat} chats; ${preview.counts.messages} messages.\n${preview.sessions.slice(0, 5).map((item) => `${item.title} (${item.messages} messages)`).join("\n")}\n${preview.warnings.join("\n")}\n${preview.alreadyImported ? "This exact snapshot was already imported." : `Inspect these counts and titles, then /import confirm ${preview.digest}. A source backup is created before import; the original stores are preserved.`}`);
        } else if (args.startsWith("confirm ")) {
          const imported = await this.service.importHistory(session.projectId, args.slice(8).trim(), session.workspaceId);
          if (imported.snapshot.revision >= (this.snapshot?.revision ?? -1)) this.snapshot = imported.snapshot;
          this.notice(`${imported.duplicate ? "Already imported" : `Imported ${imported.imported} sessions`}. Backup: ${imported.backupDirectory}. /sessions selects imported history; your current focus and draft are preserved.`);
        } else throw new Error("Use /import preview, then /import confirm <digest> from the inspected preview.");
        return true;
      }
      case "activity": this.toggleActivity(); return true;
      case "diff": this.changes = !this.changes; this.project(); return true;
      case "review": {
        if (args && !/^run(?:\s|$)/.test(args)) throw new Error("Use /review to mark a completed run reviewed, or /review run <request> for a read-only model review.");
        if (/^run(?:\s|$)/.test(args)) {
          await this.settings({ mode: "review" });
          await this.send(args.slice(3).trim() || "Review the current workspace changes. Do not modify files or execute mutating commands.");
        } else {
          const session = this.requireSession();
          const run = [...session.runs].reverse().find((item) => item.status === "completed");
          if (!run) throw new Error("No completed run to mark reviewed. /review run starts a read-only model review.");
          await this.act({ type: "run.review", sessionId: session.id, runId: run.id, requestId: randomUUID() });
          this.notice("Completed run marked reviewed. This does not approve tools, commit, merge, or publish.");
        }
        return true;
      }
      case "permissions":
        if (!args) this.notice(`Effective permission: ${this.requireSession().runs.at(-1)?.effectivePolicy ?? this.requireSession().settings.permissions}. /permissions guarded|standard|autonomous`);
        else if (args === "guarded" || args === "standard" || args === "autonomous") await this.settings({ permissions: args });
        else throw new Error("Use /permissions guarded, standard, or autonomous.");
        return true;
      case "mode":
        if (!args) this.notice(`Workflow: ${this.requireSession().settings.mode}. /mode code|plan|chat. Safety is separate: /permissions.`);
        else if (args === "code" || args === "plan" || args === "chat" || args === "review") await this.settings({ mode: args });
        else if (args === "guarded" || args === "standard" || args === "autonomous") { await this.settings({ permissions: args }); this.notice("Legacy /mode safety alias accepted. Use /permissions for safety; Shift+Tab changes workflow."); }
        else throw new Error("Use /mode code, plan, or chat; /permissions changes tool policy.");
        return true;
      case "model": case "m": {
        if (!args) {
          const catalog = await providerCatalog(this.getState().sharedContext?.path ?? this.cwd);
          const items = catalog.rows.filter((row) => row.provider.approved).flatMap(({ provider }) => {
            const models = [...new Set([provider.defaultModel, provider.model, ...Object.values(catalog.roles).filter((binding) => binding?.provider === provider.id).map((binding) => binding?.model)].filter((model): model is string => Boolean(model)))];
            if (providerPublicText(provider.id, provider) !== provider.id) return [];
            return models.filter((model) => providerPublicText(model, provider) === model).map((model) => ({ label: model, detail: providerPublicText(provider.name, provider), insert: `/model ${provider.id}/${model}`, submit: true }));
          });
          if (!items.length) this.notice("No approved models configured. /connect adds a provider.");
          else this.update({ ...this.getState(), input: "", cursor: 0, picker: { kind: "model", query: "", selected: 0, items } });
          return true;
        }
        const separator = args.includes(" ") ? args.indexOf(" ") : args.indexOf("/");
        if (separator < 0) throw new Error("Use /model <approved-provider-id> <model>. /model lists configured models.");
        const providerId = args.slice(0, separator);
        const model = args.slice(separator + 1).trim();
        if (!providerId || !model || model.length > 256 || /[\x00-\x1f]/.test(model)) throw new Error("Use /model <approved-provider-id>/<model>.");
        const catalog = await providerCatalog(this.getState().sharedContext?.path ?? this.cwd);
        if (!catalog.rows.some((row) => row.provider.id === providerId && row.provider.approved)) throw new Error(`Provider ${providerId} is not configured and approved.`);
        await this.settings({ providerId, model });
        return true;
      }
      case "plan":
        await this.settings({ mode: "plan" });
        if (args) await this.send(args);
        return true;
      case "stop": await this.cancel(); return true;
      case "run": await this.send(args); return true;
      case undefined:
        if (raw.startsWith("!")) return false;
        await this.send(raw); return true;
      default: {
        if (command === "plugins" && /^run-agent(?:\s|$)/.test(args)) {
          const invocation = /^run-agent\s+(\S+)\s+([\s\S]+)$/.exec(args);
          if (!invocation) throw new Error("/plugins run-agent requires an agent id and objective.");
          const agent = await loadPluginAgent(this.getState().sharedContext?.path ?? this.cwd, invocation[1], this.extensionOptions);
          await this.send(invocation[2], { pluginAgentId: agent.id });
          return true;
        }
        if (parseTuiCommand(raw).kind !== "unknown") return false;
        const workspace = this.getState().sharedContext?.path ?? this.cwd;
        const catalog = await discoverExtensions(workspace, this.extensionOptions);
        const matches = catalog.skills.filter((skill) => {
          if (skill.name === command || skill.id === `skill:${command}`) return true;
          const plugin = catalog.plugins.find((item) => item.id === skill.pluginId);
          return plugin && (command === `${plugin.name}:${skill.name}` || command === `${plugin.sourceName ?? plugin.name}:${skill.name}`);
        });
        if (matches.length > 1) throw new Error("Ambiguous plugin command; use its full HIVE skill id.");
        if (!matches.length) { this.notice(`Unknown command: /${command}. /help shows commands.`); return true; }
        const skill = await loadSkill(workspace, matches[0].id, this.extensionOptions);
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill.text)?.[1] ?? "";
        if (/^user-invocable:\s*(?:false|"false"|'false')\s*$/im.test(frontmatter)) throw new Error("This skill is not available as a user-invoked slash command.");
        renderSkillArguments(skill.text, args);
        await this.send(args || `Apply the selected ${matches[0].name} skill to this workspace.`, { invokedSkills: [{ id: skill.id, arguments: args }] });
        return true;
      }
    }
  }

  private current(): SharedSession | undefined { return this.snapshot?.sessions.find((session) => session.id === this.sessionId); }
  private requireSession(): SharedSession { const session = this.current(); if (!session) throw new Error("Create a session with /new."); return session; }
  private async act(action: ProjectAction): Promise<ProjectActionResponse> {
    const response = await this.service.action(action);
    if (!this.stopped && response.snapshot.revision >= (this.snapshot?.revision ?? -1)) { this.snapshot = response.snapshot; this.project(); }
    return response;
  }
  private async settings(settings: Partial<SharedSession["settings"]>): Promise<void> {
    const session = this.requireSession();
    await this.act({ type: "session.settings", sessionId: session.id, settings, requestId: randomUUID() });
  }
  private async send(text: string, override?: Partial<SharedExecutionContext>): Promise<void> {
    if (!text.trim()) throw new Error("Type a request first.");
    if (this.busy()) throw new Error("A run is still active or stopping. Your draft is preserved; wait for it to settle, or use /stop.");
    const session = this.requireSession();
    const submittedDraft = this.getState().input;
    const conversation = this.getState().conversation;
    const executionContext: SharedExecutionContext = {
      ...(conversation ? { skillIds: conversation.skillIds ?? [], enabledMcpServers: conversation.mcpServerIds ?? [], enabledLspServers: conversation.lspServerIds ?? [], pluginAgentId: conversation.pluginAgentId ?? null, outputStyleId: conversation.outputStyleId ?? null, imagePaths: (conversation.imagePaths ?? []).map((file) => path.resolve(this.getState().sharedContext?.path ?? this.cwd, file)) } : session.runs.at(-1)?.executionContext),
      ...override,
    };
    this.pendingSend = true;
    try {
      const parent = [...session.runs].reverse().find((run) => ["cancelled", "interrupted", "failed"].includes(run.status));
      await this.act({ type: "session.send", sessionId: session.id, text, ...(parent ? { parentRunId: parent.id } : {}), ...(Object.keys(executionContext).length ? { executionContext } : {}), requestId: randomUUID() });
      if (this.cancelPendingSend) {
        const run = this.snapshot?.sessions.find((item) => item.id === session.id)?.runs.find((item) => ACTIVE.has(item.status));
        if (run) await this.act({ type: "run.cancel", sessionId: session.id, runId: run.id, requestId: randomUUID() });
      }
      if (this.sessionId === session.id && this.getState().input === submittedDraft) this.update(withHistory({ ...this.getState(), input: "", cursor: 0, picker: undefined }, text));
    } finally { this.pendingSend = false; this.cancelPendingSend = false; }
  }
  private saveLocal(): void {
    if (!this.sessionId) return;
    const { input, cursor, history, historyIndex, scrollOffset, toolCardFocus, conversation } = this.getState();
    const draft = this.approvalDraft?.input ?? input;
    const navigation = this.navigationInput !== undefined && draft.trim() === this.navigationInput.trim();
    this.views.set(this.sessionId, { input: navigation ? "" : draft, cursor: navigation ? 0 : this.approvalDraft?.cursor ?? cursor, history, historyIndex, scrollOffset, toolCardFocus, conversation, activity: this.activity, changes: this.changes });
  }
  private selectLocal(session: SharedSession): void {
    this.saveLocal(); this.sessionId = session.id; this.projectId = session.projectId; this.notes = [];
    this.approvalId = undefined; this.approvalDraft = undefined;
    const context = session.runs.at(-1)?.executionContext;
    const project = this.snapshot?.projects.find((item) => item.id === session.projectId);
    const workspace = project?.workspaces.find((item) => item.id === session.workspaceId)?.path ?? this.cwd;
    const conversation = context ? { ...newConversation(workspace, session.settings.permissions), skillIds: context.skillIds, mcpServerIds: context.enabledMcpServers, lspServerIds: context.enabledLspServers, pluginAgentId: context.pluginAgentId ?? undefined, outputStyleId: context.outputStyleId ?? undefined, imagePaths: context.imagePaths } : undefined;
    const local = this.views.get(session.id) ?? { input: "", cursor: 0, history: [], historyIndex: -1, scrollOffset: 0, toolCardFocus: undefined, conversation, activity: false, changes: false };
    this.activity = local.activity; this.changes = local.changes;
    this.update({ ...this.getState(), ...local, picker: undefined, pendingPermission: undefined, permissionPrompt: undefined });
    this.project();
  }
  private async selectSession(id: string): Promise<void> {
    const matches = this.snapshot?.sessions.filter((item) => item.id === id || item.sources.some((source) => source.id === id)) ?? [];
    if (matches.length > 1) throw new Error("This legacy source matches multiple shared sessions. Use the exact shared session ID.");
    const session = matches[0];
    if (!session || session.archived) throw new Error("Session unavailable. /sessions archived lists sessions you can restore.");
    await this.act({ type: "session.select", sessionId: session.id, requestId: randomUUID() });
    this.selectLocal(session);
  }
  private async selectProject(id: string): Promise<void> {
    const project = this.snapshot?.projects.find((item) => item.id === id);
    if (!project) throw new Error("Project not found. Use /projects.");
    const session = this.snapshot?.sessions.find((item) => item.id === project.lastSessionId && !item.archived)
      ?? this.snapshot?.sessions.find((item) => item.projectId === id && !item.archived);
    if (session) await this.selectSession(session.id);
    else { this.projectId = id; await this.createSession(); }
  }
  private async createSession(title?: string): Promise<void> {
    if (!this.projectId) throw new Error("Attach a project first: /projects attach <path>.");
    const project = this.snapshot?.projects.find((item) => item.id === this.projectId);
    const current = this.current();
    const workspaceId = current?.projectId === this.projectId ? current.workspaceId : project?.workspaces.find((workspace) => path.resolve(workspace.path) === path.resolve(this.cwd))?.id;
    const response = await this.act({ type: "session.create", projectId: this.projectId, ...(workspaceId ? { workspaceId } : {}), ...(title ? { title } : {}), requestId: randomUUID() });
    const session = response.snapshot.sessions.find((item) => item.id === response.result.sessionId);
    if (session) this.selectLocal(session);
  }
  private async sessionAction(type: "session.rename" | "session.archive" | "session.restore", value?: string): Promise<void> {
    const session = this.requireSession();
    if (type === "session.rename") { if (!value) throw new Error("Use /rename <title>."); await this.act({ type, sessionId: session.id, title: value, requestId: randomUUID() }); }
    else await this.act({ type, sessionId: type === "session.restore" && value ? value : session.id, requestId: randomUUID() });
    if (type === "session.archive") this.notice("Session archived. /restore restores it; /sessions selects another session.");
  }
  private openProjects(): void {
    this.update({ ...this.getState(), input: "", cursor: 0, picker: { kind: "project", query: "", selected: 0, items: (this.snapshot?.projects ?? []).map((project) => ({ label: project.name, detail: project.repositoryPath, insert: `/projects select ${project.id}`, submit: true })) } });
  }
  private openSessions(query: string): void {
    const archived = query === "archived";
    const needle = query.replace(/^search\s+/, "").toLowerCase();
    const sessions = (this.snapshot?.sessions ?? []).filter((session) => session.archived === archived && (needle && !archived ? session.title.toLowerCase().includes(needle) : session.projectId === this.projectId));
    if (!sessions.length) { this.notice(archived ? "No archived sessions in this project." : "No matching sessions. /new creates one."); return; }
    this.update({ ...this.getState(), input: "", cursor: 0, picker: { kind: "session", query, selected: 0, items: sessions.map((session) => ({ label: session.title, detail: `${this.snapshot?.projects.find((project) => project.id === session.projectId)?.name ?? "Project"} · ${session.id}`, insert: archived ? `/restore ${session.id}` : `/sessions select ${session.id}`, submit: true })) } });
  }
  notice(text: string): void { if (!this.stopped) { if (this.notes.at(-1) !== text) this.notes = [...this.notes, text].slice(-10); this.project(); } }
  private project(): void {
    if (this.stopped || this.suspendedAt !== undefined) return;
    const session = this.current();
    if (!session) return;
    const project = this.snapshot?.projects.find((item) => item.id === session.projectId);
    const workspace = project?.workspaces.find((item) => item.id === session.workspaceId);
    const lastRun = session.runs.at(-1);
    const active = session.runs.find((run) => ACTIVE.has(run.status));
    const entries: string[] = [];
    const disclosedRuns = new Set<string>();
    const g = glyphsFor(this.getState());
    const activityCard = (run: SharedSession["runs"][number]) => {
      const roles = new Set(run.events.map((event) => event.role)).size;
      return serializeToolCard({ id: `shared-${run.id}`, kind: "other", tool: "Activity", summary: `${roles} ${roles === 1 ? "role" : "roles"} · ${run.events.length} ${run.events.length === 1 ? "event" : "events"}`, status: run.status, expanded: this.activity, mutating: false, prompt: false, body: run.events.map((event) => `${event.role}: ${event.text}`) });
    };
    for (const item of session.messages) {
      entries.push(`${item.role === "user" ? "[User] " : item.role === "system" ? "  " : ""}${item.text}`);
      if (item.role !== "assistant" || !item.runId) continue;
      const run = session.runs.find((candidate) => candidate.id === item.runId);
      if (!run) continue;
      disclosedRuns.add(run.id);
      if (run.events.length) entries.push(activityCard(run));
      if (run.patches.length || run.checks.length) entries.push(`  ${run.patches.length} recorded change${run.patches.length === 1 ? "" : "s"} · ${run.checks.filter((check) => check.status === "passed").length} passed / ${run.checks.length} recorded checks · /diff`);
      if (run.reviewedAt) entries.push("  Reviewed · review marker only");
      if (["cancelled", "interrupted", "failed"].includes(run.status)) entries.push(`  ${run.status}: ${run.summary}. A new request starts a linked attempt; files are not rolled back.`);
    }
    for (const run of session.runs) {
      if (disclosedRuns.has(run.id) || !run.events.length) continue;
      entries.push(activityCard(run));
    }
    if (this.changes && lastRun) {
      entries.push(lastRun.patches.length ? "Recorded changes" : "No recorded changes for this run.");
      for (const patch of lastRun.patches) entries.push(`${patch.state}: ${patch.path} +${patch.additions} -${patch.deletions}${patch.stale ? " (stale)" : ""}\n${patch.diff ? ["```diff", patch.diff, "```"].join("\n") : patch.binary ? "Binary change" : "Diff unavailable"}`);
      for (const check of lastRun.checks) entries.push(`  ${check.status === "passed" ? g.pass : check.status === "failed" ? g.fail : g.dot} ${check.status.replace(/_/g, " ")}: ${check.command} · ${check.workspace} · exit ${check.exitCode ?? "not recorded"}`);
    }
    entries.push(...this.notes);
    let current = this.getState();
    // MCP answers stay in the private form until it settles; parallel approvals wait.
    const approval = current.mcpInput ? undefined : active?.approvals.find((item) => item.status === "pending");
    if (approval && approval.id !== this.approvalId) {
      if (!this.approvalDraft) this.approvalDraft = { input: current.input, cursor: current.cursor };
      current = { ...current, input: "", cursor: 0, picker: undefined };
    } else if (!approval && this.approvalDraft) {
      current = { ...current, ...this.approvalDraft, picker: undefined };
      this.approvalDraft = undefined;
    }
    this.approvalId = approval?.id;
    const next = replaceTranscript({ ...current, sharedContext: { project: project?.name ?? "Project", session: session.title, path: workspace?.path ?? this.cwd, status: active?.status ?? lastRun?.status ?? "idle", effectivePolicy: active?.effectivePolicy ?? session.settings.permissions, engine: lastRun?.engine, archived: session.archived }, workflowMode: session.settings.mode, workspaceName: project?.name, gitBranch: workspace?.branch, sessionId: session.id, provider: session.settings.providerId ?? "auto", model: session.settings.model ?? "configured model", sessionMode: session.settings.permissions, running: Boolean(active), taskStatus: active ? "running" : lastRun?.status === "failed" ? "error" : lastRun?.status === "completed" ? "complete" : "idle", liveText: undefined, outputLines: [], pendingPermission: approval ? { kind: "command", target: `${approval.tool}: ${approval.description} · workspace ${approval.workspace} · input ${JSON.stringify(approval.input)}`, outcome: "ask", canApply: true, reason: `Approval for this action only; expires ${approval.expiresAt}` } : undefined, permissionPrompt: approval ? `${approval.tool}: ${approval.description} · workspace ${approval.workspace} · input ${JSON.stringify(approval.input)} [y/n]` : undefined, permissionChoice: approval && current.pendingPermission ? current.permissionChoice : 0 }, entries);
    this.update(next);
  }
}

function unquote(value: string): string { return value.replace(/^"([\s\S]*)"$/, "$1"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
