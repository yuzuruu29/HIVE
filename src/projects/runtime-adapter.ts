import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createChatEngine, type ChatEngine } from "../chat/engine.js";
import { CHAT_ROLE_META, classifyTask, normalizeChatRole } from "../chat/roles.js";
import { compactHistory, HISTORY_CHAR_BUDGET } from "../chat/history.js";
import { AGENT_LABEL, runHivebot } from "../chat/hivebot.js";
import { ProviderRouter } from "../coding/provider-router.js";
import { CodingSessionStore } from "../coding/session-store.js";
import { findRepositoryRoot } from "../coding/repository.js";
import type { QueenSessionOptions } from "../coding/queen.js";
import type { CodingSessionRecord, RuntimeEvent, ToolPermissionRequest } from "../coding/types.js";
import { loadProviderImage } from "../providers/images.js";
import { WorktreeManager } from "../worktree.js";
import { redactKnownSecrets } from "../security/secrets.js";
import { runQueenTuiSession, type TuiSessionRunner, type TuiSessionRunnerOptions } from "../tui/runtime-adapter.js";
import { ProjectSessionService, type ProjectSessionServiceOptions } from "./service.js";
import type { AcceptedRun, EngineHooks, EngineOutcome, EngineUserEvent, RunCheck, RunPatch, SessionEngineAdapter } from "./types.js";

const execute = promisify(execFile);
export interface ProductionSessionEngineOptions {
  providerRegistries?: QueenSessionOptions["providerRegistries"];
  /** Existing extension/runtime seam; never enables a demo in the default factory. */
  runCoding?: TuiSessionRunner;
  createChat?: (root: string, sessionId: string) => ChatEngine;
  requestMcpInput?: TuiSessionRunnerOptions["requestMcpInput"];
  extensionOptions?: TuiSessionRunnerOptions["extensionOptions"];
}
function clean(text: string): string { return redactKnownSecrets(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); }
function conversationPrompt(input: AcceptedRun): string {
  const history = input.session.messages.filter((message) => message.runId !== input.run.id && message.role !== "system").map((message) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: message.text, at: message.createdAt }));
  const context = compactHistory(history, HISTORY_CHAR_BUDGET).kept.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`).join("\n\n");
  return context ? `${context}\n\nUser: ${input.text}` : input.text;
}
function userEvent(event: RuntimeEvent, roles: Map<string, string>, commandRoles: Map<string, string>): EngineUserEvent | undefined {
  if (event.type === "subagent.created" || event.type === "task.created") roles.set(event.payload.task.id, roleName(event.payload.task.role));
  const role = "subagentId" in event.payload ? roles.get(event.payload.subagentId) ?? "HIVE" : "HIVE";
  const source = { codingSessionId: event.sessionId, sequence: event.sequence };
  const activity = (role: string, kind: string, text: string): EngineUserEvent => ({ type: "activity", role, kind, text: clean(text), source });
  switch (event.type) {
    case "session.created": return activity("HIVE", "status", "Live coding session created");
    case "session.started": return activity("HIVE", "status", `Inspecting ${event.payload.repository.branch ?? "workspace"}`);
    case "session.paused": return activity("HIVE", "paused", event.payload.reason);
    case "session.resumed": return activity("HIVE", "status", "Verified coding session resumed");
    case "session.cancelled": return activity("HIVE", "cancelled", event.payload.reason ?? "Coding run cancelled");
    case "plan.created": return activity("Planner", "summary", event.payload.summary);
    case "subagent.created": return activity(roleName(event.payload.task.role), "queued", event.payload.task.title);
    case "subagent.started": return activity(role, "running", `Started ${event.payload.subagentId}`);
    case "subagent.tool_call": return activity(role, "tool", `${event.payload.tool}${event.payload.input && typeof event.payload.input === "object" && "path" in event.payload.input ? ` ${String(event.payload.input.path)}` : ""}`);
    case "subagent.tool_result": return activity(role, event.payload.ok ? "tool_completed" : "tool_failed", `${event.payload.tool}: ${event.payload.ok ? "completed" : "failed"}`);
    case "subagent.completed": return activity(role, "completed", event.payload.summary ?? `Completed ${event.payload.subagentId}`);
    case "subagent.failed": return activity(role, "failed", event.payload.error);
    case "subagent.blocked": return activity(role, "blocked", event.payload.reason);
    case "validation.started": return activity("Validator", "command", event.payload.command);
    case "validation.completed": return activity("Validator", event.payload.result.status, `${event.payload.result.command}: ${event.payload.result.status}`);
    case "review.completed": return activity("Reviewer", event.payload.result.status, event.payload.result.summary);
    case "command.started": {
      const commandRole = event.payload.taskId ? roles.get(event.payload.taskId) ?? "HIVE" : "HIVE";
      commandRoles.set(event.payload.commandId, commandRole);
      return activity(commandRole, "command", `${event.payload.command} (${event.payload.cwd})`);
    }
    case "command.completed": return activity(commandRoles.get(event.payload.commandId) ?? "HIVE", "command_result", `Command ${event.payload.commandId}: ${event.payload.signal ? `stopped (${event.payload.signal})` : `exit ${event.payload.exitCode ?? "unavailable"}`}`);
    case "file.changed": return activity("HIVE", "file", `${event.payload.change.operation}: ${event.payload.change.path}`);
    case "failure.recorded": return activity("HIVE", "failure", event.payload.failure.description);
    case "evidence.invalidated": return activity("Validator", "stale", "Previous evidence was invalidated; verification is required again");
    case "session.reconciled": return activity("HIVE", "recovery", "Repository and saved task state reconciled");
    default: return undefined;
  }
}
function roleName(role: string): string { return role.charAt(0).toUpperCase() + role.slice(1); }
/** First meaningful line of a council handoff, without markdown markers. */
function stageHeadline(output: string): string {
  const prose = output.split("```").filter((_, index) => index % 2 === 0).join("\n");
  const line = prose.split("\n").map((entry) => entry.replace(/^[\s#>*_`-]+|[*_`]+$/g, "").trim()).find(Boolean) ?? "Proposal recorded";
  return clean(line.length > 160 ? `${line.slice(0, 159)}…` : line);
}
export function checksFromCodingRecord(record: CodingSessionRecord): RunCheck[] {
  const workspace = record.repository.worktreePath ?? record.repository.root;
  const checks = new Map<string, RunCheck>();
  for (const event of record.events.filter((event) => event.sequence >= (record.turnStartSequence ?? 1))) {
    if (event.type === "command.started") checks.set(event.payload.commandId, { id: event.payload.commandId, name: event.payload.command, command: event.payload.command, workspace: event.payload.cwd, status: "not_run", exitCode: null, startedAt: event.timestamp });
    if (event.type === "command.output") { const check = checks.get(event.payload.commandId); if (check) check.output = ((check.output ?? "") + clean(event.payload.chunk)).slice(-32_000); }
    if (event.type === "command.completed") { const check = checks.get(event.payload.commandId); if (check) { check.endedAt = event.timestamp; check.exitCode = event.payload.exitCode; check.status = event.payload.signal ? "cancelled" : event.payload.exitCode === 0 ? "passed" : "failed"; } }
  }
  for (const result of record.validationResults) {
    if ([...checks.values()].some((check) => check.command === result.command && check.startedAt === result.startedAt)) continue;
    checks.set(result.id, { id: result.id, name: result.command, command: result.command, workspace, status: result.status === "passed" && result.exitCode === 0 ? "passed" : result.status === "failed" ? "failed" : result.status === "cancelled" ? "cancelled" : "not_run", exitCode: result.exitCode ?? null, startedAt: result.startedAt, ...(result.completedAt ? { endedAt: result.completedAt } : {}), ...(result.output ? { output: clean(result.output).slice(-32_000) } : {}) });
  }
  return [...checks.values()];
}
async function patchesFromRecord(record: CodingSessionRecord): Promise<RunPatch[]> {
  const workspace = record.repository.worktreePath ?? record.repository.root;
  const root = await fs.realpath(workspace); const base = record.repository.worktreeBaseCommit ?? record.repository.baseCommit;
  const patches: RunPatch[] = []; const seen = new Set<string>();
  for (const file of record.files) {
    if (seen.has(file.path)) continue; seen.add(file.path);
    const relative = file.path.replaceAll("\\", "/"); if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split("/").some((part) => ["..", ".git", ".hivemind", ".hive"].includes(part))) throw new Error("Recorded patch path is unsafe.");
    const args = base ? [base] : [];
    const options = { cwd: root, encoding: "utf8" as const, windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
    const stats = String((await execute("git", ["diff", "--no-ext-diff", "--numstat", ...args, "--", relative], options)).stdout).trim();
    let diff = String((await execute("git", ["diff", "--no-ext-diff", "--unified=3", ...args, "--", relative], options)).stdout); let additions = 0; let deletions = 0; let binary = false;
    if (stats) { const [added, removed] = stats.split("\t"); binary = added === "-" || removed === "-"; additions = binary ? 0 : Number(added); deletions = binary ? 0 : Number(removed); }
    else if (file.operation === "created") {
      const target = path.join(root, relative); const real = await fs.realpath(target); const within = path.relative(root, real); if (within.startsWith("..") || path.isAbsolute(within)) throw new Error("Recorded file escapes the workspace.");
      const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) { binary = true; diff = "Binary or large new file; inspect it in the workspace."; }
      else { const bytes = await fs.readFile(target); binary = bytes.includes(0); if (binary) diff = "Binary new file"; else { const content = bytes.toString("utf8"); const lines = content.split(/\r?\n/); if (lines.at(-1) === "") lines.pop(); additions = lines.length; diff = `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`; } }
    }
    if (!diff && !stats) continue;
    patches.push({ path: relative, ...(file.previousPath ? { previousPath: file.previousPath } : {}), additions, deletions, state: "applied", workspace: root, ...(base ? { baseRevision: base } : {}), diff: clean(diff).slice(0, 128_000), ...(binary ? { binary: true } : {}), ...(diff.length > 128_000 ? { truncated: true } : {}) });
  }
  return patches;
}
export function createProductionSessionEngine(options: ProductionSessionEngineOptions = {}): SessionEngineAdapter {
  return { start(input, hooks) {
    const controller = new AbortController(); let persistence: Promise<void> = Promise.resolve(); let persistenceError: unknown;
    let pendingText: string | undefined; let textTimer: ReturnType<typeof setTimeout> | undefined;
    const enqueue = (event: EngineUserEvent): void => { persistence = persistence.then(() => hooks.persist(event)).catch((error) => { persistenceError = error; controller.abort("Durable event persistence failed."); }); };
    const flushText = (): void => { if (textTimer) clearTimeout(textTimer); textTimer = undefined; if (pendingText !== undefined) { const text = pendingText; pendingText = undefined; enqueue({ type: "text", text }); } };
    const publish = (event: EngineUserEvent): void => { if (event.type === "text") { pendingText = event.text; if (!textTimer) textTimer = setTimeout(flushText, 50); } else { flushText(); enqueue(event); } };
    const drain = async (): Promise<void> => { flushText(); await persistence; if (persistenceError) throw persistenceError; };
    const completion = (async (): Promise<EngineOutcome> => {
      try {
        if (input.run.settings.mode === "chat") {
          const context = input.run.executionContext;
          if (context && [context.skillIds, context.enabledMcpServers, context.enabledLspServers, context.invokedSkills].some((values) => values?.length) || context?.pluginAgentId || context?.outputStyleId) throw new Error("Selected extension capabilities require Code, Plan, or Review mode; switch mode to retain them.");
          const images = await Promise.all((context?.imagePaths ?? []).map((image) => loadProviderImage(input.run.workspace, image)));
          const router = new ProviderRouter({ projectRoot: input.run.workspace, sessionId: input.session.id, projectRegistry: options.providerRegistries?.project, globalRegistry: options.providerRegistries?.global });
          const engine = options.createChat?.(input.run.workspace, input.session.id) ?? createChatEngine(input.run.workspace, input.session.id, { router: images.length ? { resolve: (...args) => router.resolve(...args), complete: (request) => router.complete({ ...request, images }), streamComplete: (request, onChunk) => router.streamComplete({ ...request, images }, onChunk) } : router });
          const role = classifyTask(input.text); let cumulative = "";
          publish({ type: "activity", role: "HIVE", kind: "status", text: "Waiting for live provider response" }); await drain();
          const response = await engine.complete({ role: normalizeChatRole(role) ?? "coding", prompt: conversationPrompt(input), systemPrompt: CHAT_ROLE_META[role].systemPrompt, providerId: input.run.settings.providerId, model: input.run.settings.model, signal: controller.signal, onChunk: (chunk) => { cumulative += chunk; publish({ type: "text", text: cumulative }); } });
          publish({ type: "activity", role: "HIVE", kind: "receipt", text: `${response.receipt.providerId} / ${response.receipt.model}` }); publish({ type: "text", text: response.output }); await drain();
          return { status: controller.signal.aborted ? "cancelled" : "completed", summary: controller.signal.aborted ? "Cancelled after provider acknowledgment" : "Live response complete", text: response.output };
        }
        if (input.run.settings.mode === "council") {
          const context = input.run.executionContext;
          if (context && [context.skillIds, context.enabledMcpServers, context.enabledLspServers, context.invokedSkills, context.imagePaths].some((values) => values?.length) || context?.pluginAgentId || context?.outputStyleId) throw new Error("Council mode runs only the built-in HIVE council; switch to Code, Plan, or Review for extensions and images.");
          const router = new ProviderRouter({ projectRoot: input.run.workspace, sessionId: input.session.id, projectRegistry: options.providerRegistries?.project, globalRegistry: options.providerRegistries?.global });
          const engine = options.createChat?.(input.run.workspace, input.session.id) ?? createChatEngine(input.run.workspace, input.session.id, { router });
          publish({ type: "activity", role: "Queen", kind: "status", text: "Convening the HIVE council" }); await drain();
          const result = await runHivebot(input.text, {
            cwd: input.run.workspace, providerId: input.run.settings.providerId, model: input.run.settings.model, signal: controller.signal, createEngine: () => engine,
            onStage: (stage) => publish(stage.type === "stage-started"
              ? { type: "activity", role: stage.agent, kind: "running", text: `${AGENT_LABEL[stage.agent] ?? "Working"}${stage.attempt > 1 ? ` · repair attempt ${stage.attempt}` : ""}` }
              : { type: "activity", role: stage.agent, kind: "completed", text: `${stageHeadline(stage.output ?? "")}${stage.receipt ? ` · ${stage.receipt.providerId}/${stage.receipt.model}` : ""}` }),
          });
          await drain();
          if (controller.signal.aborted) return { status: "cancelled", summary: "Council cancelled; completed handoffs are kept in the run report" };
          const forger = [...result.stages].reverse().find((stage) => stage.agent === "Forger");
          const text = clean(forger && result.status === "COMPLETE" ? `${result.review}\n\n### Proposed change (Forger, not applied)\n\n${forger.output.trim()}` : result.review);
          publish({ type: "text", text }); await drain();
          const verdict = result.verdict ? ` · Sentinel ${result.verdict.replace(/_/g, " ")}` : "";
          return { status: result.status === "COMPLETE" ? "completed" : "failed", summary: `Council ${result.status.replace(/_/g, " ").toLowerCase()} · ${result.preset} preset${verdict}`, text };
        }
        const root = await findRepositoryRoot(input.run.workspace, controller.signal); const store = new CodingSessionStore(root);
        const roles = new Map<string, string>(); const commandRoles = new Map<string, string>();
        const previous = input.run.parentRunId ? input.session.runs.find((run) => run.id === input.run.parentRunId) : [...input.session.runs].reverse().find((run) => run.id !== input.run.id && run.engineSessionId);
        let resumeId: string | undefined; let continuationId: string | undefined;
        if (previous?.engineSessionId) { const saved = await store.load(previous.engineSessionId); for (const task of saved?.tasks ?? []) roles.set(task.id, roleName(task.role)); if (!saved) throw new Error("Linked coding history is missing; original conversation preserved."); if (saved.repository.worktreePath) { if (["completed", "failed", "cancelled"].includes(saved.status)) continuationId = saved.id; else resumeId = saved.id; } }
        const context = input.run.executionContext; const images = await Promise.all((context?.imagePaths ?? []).map((image) => loadProviderImage(input.run.workspace, image)));
        let prose = ""; let policy: "safe" | "changes" = input.run.effectivePolicy === "safe" ? "safe" : "changes"; let engineSessionId = resumeId ?? continuationId;
        const requestToolPermission = async (request: ToolPermissionRequest, signal: AbortSignal): Promise<boolean> => {
          if (signal.aborted || controller.signal.aborted) return false; await drain();
          if (input.run.settings.permissions === "autonomous" && !request.external && !request.alwaysAsk) return true;
          if (!engineSessionId) throw new Error("Tool approval has no coding session provenance.");
          const saved = await store.load(engineSessionId); if (!saved) throw new Error("Tool approval coding history is unavailable.");
          const workspace = saved.repository.worktreePath ?? (input.run.settings.mode === "code" ? new WorktreeManager(root).getWorktreePath(saved.id) : root);
          return hooks.requestApproval({ tool: request.tool, description: request.description, input: request.input, external: request.external, workspace });
        };
        const runner = options.runCoding ?? runQueenTuiSession;
        const run = async (resume?: string): Promise<CodingSessionRecord> => {
          if (resume || engineSessionId) {
            engineSessionId = resume ?? engineSessionId;
            publish({ type: "engine", engineSessionId: engineSessionId!, effectivePolicy: policy });
            await drain();
          }
          const value = await runner({ cwd: input.run.workspace, objective: input.text, context: conversationPrompt(input), signal: controller.signal, codeMode: input.run.settings.mode === "plan" ? "plan" : input.run.settings.mode === "review" ? "review" : "auto", approvalPolicy: policy, ...(resume ? { resumeId: resume } : resumeId ? { resumeId } : continuationId ? { continuationId } : {}), ...(input.run.settings.providerId ? { providerOverride: { providerId: input.run.settings.providerId, model: input.run.settings.model ?? "" } } : {}), skillIds: context?.skillIds, enabledMcpServers: context?.enabledMcpServers, enabledLspServers: context?.enabledLspServers, pluginAgentId: context?.pluginAgentId, outputStyleId: context?.outputStyleId, invokedSkills: context?.invokedSkills, images, providerRegistries: options.providerRegistries, requestToolPermission, requestMcpInput: options.requestMcpInput, extensionOptions: options.extensionOptions, onEvent: (event) => { if (event.type === "session.created") { engineSessionId = event.sessionId; publish({ type: "engine", engineSessionId: event.sessionId, effectivePolicy: event.payload.approvalPolicy }); } const projected = userEvent(event, roles, commandRoles); if (projected) publish(projected); }, onText: (text) => { prose = text; publish({ type: "text", text }); } });
          if (!value || typeof value !== "object" || !("id" in value) || !("status" in value)) throw new Error("Coding engine returned no authoritative session record.");
          return value as CodingSessionRecord;
        };
        let record = await run(); await drain();
        const lastEvent = record.events.at(-1);
        if (record.status === "paused" && policy === "safe" && input.run.settings.mode === "code" && lastEvent?.type === "session.paused" && lastEvent.payload.reason.includes("Repository changes require approval")) {
          const approved = await hooks.requestApproval({ tool: "apply_workspace_changes", description: "Apply the planned changes in this coding session's managed worktree. Commands will request their own approval.", input: { repository: root, baseCommit: record.repository.baseCommit ?? "", paths: [...new Set(record.tasks.flatMap((task) => task.fileScope))], tasks: record.tasks.map((task) => ({ title: task.title, paths: task.fileScope })) }, external: false, workspace: record.repository.worktreePath ?? new WorktreeManager(root).getWorktreePath(record.id) });
          if (!approved || controller.signal.aborted) return { status: "cancelled", summary: "Planned changes declined; saved plan and coding history preserved", engineSessionId: record.id, text: prose || record.plan?.summary || "Planned changes were not applied." };
          policy = "changes"; record = await run(record.id); await drain();
        }
        const checks = checksFromCodingRecord(record); const patches = await patchesFromRecord(record);
        const status = controller.signal.aborted || record.status === "cancelled" ? "cancelled" : record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : "interrupted";
        const text = prose || record.finalReport?.result || record.plan?.summary;
        return { status, summary: record.finalReport?.result ?? (record.status === "paused" ? "Coding engine paused; saved state requires inspection before a new attempt" : `Coding engine ${record.status}`), ...(text ? { text } : {}), engineSessionId: record.id, patches, checks };
      } catch (error) { await drain(); if (controller.signal.aborted && !persistenceError) return { status: "cancelled", summary: "Cancellation acknowledged by the live engine" }; throw error; }
    })();
    return { completion, cancel(reason) { controller.abort(reason); } };
  } };
}
export async function createProductionProjectSessionService(options: ProjectSessionServiceOptions & { engineOptions?: ProductionSessionEngineOptions } = {}): Promise<ProjectSessionService> {
  const catalogPath = options.catalogPath ?? process.env.HIVE_PROJECT_CATALOG;
  if (catalogPath !== undefined && (!path.isAbsolute(catalogPath) || /[\x00-\x1f]/.test(catalogPath))) throw new Error("HIVE project catalog path must be an absolute local path.");
  return new ProjectSessionService({ ...options, ...(catalogPath ? { catalogPath } : {}), engine: options.engine ?? createProductionSessionEngine(options.engineOptions) });
}
