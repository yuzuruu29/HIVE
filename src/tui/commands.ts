/**
 * commands.ts
 * Command parser and executor for the HIVE TUI cockpit.
 */

import { redactKnownSecrets, redactStreamingText } from "../security/secrets.js";
import { formatRuntimeEventText } from "../coding/output.js";
import type { RuntimeEvent } from "../coding/types.js";
import type { ToolPermissionRequest } from "../coding/types.js";
import { diffLinesForRuntimeEvent } from "./diff-view.js";
import {
  activityLineForRuntimeEvent,
  commandTextFromEvent,
  describeMode,
  extractFileMentions,
  formatDecisionLine,
  formatSessionList,
  isHiveMode,
  permissionDecisionForRuntimeEvent,
  readResultPreview,
  resolveSessionPosture,
  rewindTranscript,
  sessionHelpLines,
  toolCardDraft,
  type SessionPosture,
} from "./interaction.js";
import {
  TuiState,
  withOutput,
  withMode,
  withClear,
  appendTranscriptLine,
  setTaskStatus,
  clearTranscript,
  withSelectedSubagent,
  withSubagentsExpanded,
  reduceTuiRuntimeEvent,
  withPendingPermission,
  withSessionId,
  withSessionMode,
  withLiveText,
  withTranscript,
  commitLiveText,
  replaceTranscript,
} from "./state.js";
import {
  appendCommandCardOutput,
  collapseToolCards,
  parseToolCard,
  promptNewestMutatingCard,
  serializeToolCard,
  toolCallCardId,
  updateToolCard,
  type ToolCard,
} from "./tool-card.js";
import type { TuiRuntimeHandle, TuiSessionRunner } from "./runtime-adapter.js";
import { CliConversationStore, newConversation, conversationContext, persistConversation, CONTEXT_CHAR_BUDGET } from "./conversations.js";
import { attachFileContext } from "./prompt-context.js";
import { ProviderRegistry } from "../providers/registry.js";
import { providerCatalog, providerCommand, providerCommandArguments, providerConfigRoot, providerPublicText, type ProviderCommandOptions, type ProviderCommandResult } from "../providers/commands.js";
import { PROVIDER_SETUP_PRESETS } from "../providers/setup.js";
import { writeHiveRunReport } from "../coding/report.js";
import { getCodingWorkspace } from "../coding/runtime.js";
import { RepositoryToolService } from "../coding/tools.js";
import { CodingSessionStore } from "../coding/session-store.js";
import { findRepositoryRoot } from "../coding/repository.js";
import { extensionCommand, discoverExtensions, loadSkill, loadTrustedPluginOutputStyle } from "../extensions/index.js";
import { renderSkillArguments } from "../extensions/skill-arguments.js";
import { loadProviderImage, validateProviderImages } from "../providers/images.js";
import { runTuiTask } from "./runtime-adapter.js";
import { runLocalCommand, rewindLocalFiles } from "./local-command.js";
import { CheckpointStore } from "../coding/checkpoints.js";
import { copyToClipboard } from "./clipboard.js";
import { forkCodingSession } from "../coding/fork.js";
import type { ExtensionOptions } from "../extensions/types.js";
import type { McpUserInput } from "../extensions/mcp-client-host.js";
import { createCodingMcpHostFactory } from "../coding/mcp-host.js";
import { loadPluginAgent } from "../extensions/catalog.js";

// -- Command Types -------------------------------------------------------------

export type TuiCommandKind =
  | "help"
  | "providers"
  | "status"
  | "model"
  | "new"
  | "resume"
  | "continue"
  | "rename"
  | "fork"
  | "export"
  | "copy"
  | "compact"
  | "context"
  | "diff"
  | "review"
  | "find"
  | "mcp" | "skills" | "skill" | "plugins" | "hooks" | "image" | "lsp"
  | "shell"
  | "checkpoints"
  | "agents"
  | "run"
  | "clear"
  | "exit"
  | "mode"
  | "plan"
  | "sessions"
  | "rewind"
  | "unknown"
  | "task";

export interface TuiCommand {
  kind: TuiCommandKind;
  args: string;
  raw: string;
}

// -- Parser --------------------------------------------------------------------

export function parseTuiCommand(input: string): TuiCommand {
  const trimmed = input.trim();
  const raw = trimmed;

  if (trimmed.startsWith("!")) return { kind: "shell", args: trimmed.slice(1).trim(), raw };

  if (!trimmed.startsWith("/")) {
    // Plain text - treat as a task
    return { kind: "task", args: trimmed, raw };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const slashCmd =
    spaceIdx === -1
      ? trimmed.slice(1).toLowerCase()
      : trimmed.slice(1, spaceIdx).toLowerCase();
  const args =
    spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (slashCmd) {
    case "help":
      return { kind: "help", args, raw };
    case "providers":
      return { kind: "providers", args, raw };
    case "connect":
      return { kind: "providers", args: `setup${args ? ` ${args}` : ""}`, raw };
    case "status":
      return { kind: "status", args, raw };
    case "model":
    case "m":
      return { kind: "model", args, raw };
    case "new": case "resume": case "continue": case "rename": case "fork":
    case "export": case "copy": case "compact": case "context": case "diff": case "review": case "find":
    case "mcp": case "skills": case "skill": case "plugins": case "hooks": case "image": case "lsp":
    case "shell":
    case "checkpoints":
      return { kind: slashCmd, args, raw };
    case "permissions":
      return { kind: "mode", args, raw };
    case "agents":
    case "subagents":
      return { kind: "agents", args, raw };
    case "run":
      return { kind: "run", args, raw };
    case "clear":
      return { kind: "clear", args, raw };
    case "mode":
      return { kind: "mode", args, raw };
    case "plan":
      return { kind: "plan", args, raw };
    case "sessions":
    case "session":
      return { kind: "sessions", args, raw };
    case "rewind":
      return { kind: "rewind", args, raw };
    case "exit":
    case "quit":
    case "q":
      return { kind: "exit", args, raw };
    default:
      return { kind: "unknown", args: slashCmd, raw };
  }
}

// -- Executor ------------------------------------------------------------------

export interface ExecuteResult {
  state: TuiState;
  shouldExit: boolean;
  runtime?: TuiRuntimeHandle;
}

export interface ExecuteTuiCommandOptions {
  invokedSkills?: ReadonlyArray<{ id: string; arguments: string }>;
  runSession?: TuiSessionRunner;
  posture?: Partial<SessionPosture>;
  continuation?: boolean;
  persistSession?: boolean;
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  requestMcpInput?: McpUserInput;
  copyToClipboard?: (text: string) => Promise<void>;
  forkSession?: typeof forkCodingSession;
  extensionOptions?: ExtensionOptions;
  providerOptions?: Pick<ProviderCommandOptions, "globalRoot" | "chatgptOptions">;
}

function streamedProgress(state: TuiState, event: RuntimeEvent): boolean {
  if (event.type !== "subagent.progress" && event.type !== "task.progress") return false;
  const message = "message" in event.payload && typeof event.payload.message === "string"
    ? event.payload.message
    : "";
  const live = state.liveText?.trim();
  return Boolean(live && message.trim() && live === redactKnownSecrets(message).trim());
}

function commandCardKey(sessionId: string, commandId: string): string {
  return JSON.stringify([sessionId, commandId]);
}

function appendCommandChunk(state: TuiState, event: RuntimeEvent<"command.output">): TuiState {
  const next = commitLiveText(state);
  const redacted = redactKnownSecrets(event.payload.chunk).replace(/\s+/g, " ").trim();
  if (!redacted || redacted === "[REDACTED]") return next;
  const clipped = redacted.length > 160 ? `${redacted.slice(0, 157)}...` : redacted;
  const label = event.payload.stream === "stderr" ? "stderr" : "stdout";
  const line = `${label} ${clipped}`;
  const id = next.commandCardIds?.[commandCardKey(event.sessionId, event.payload.commandId)];
  const attached = id ? appendCommandCardOutput(next.transcript, id, line) : null;
  if (!attached) return appendTranscriptLine(next, line);
  return replaceTranscript(next, attached);
}

function cardStatusFor(
  decision: { outcome: string; canApply: boolean } | null,
  willAsk: boolean,
  mode: TuiState["sessionMode"],
): string {
  if (!decision || decision.outcome === "allow") return "done";
  if (decision.outcome === "deny") return "denied";
  if (!decision.canApply) return "planned";
  if (willAsk && mode === "guarded") return "asking";
  return "running";
}

function pushToolCard(state: TuiState, card: ToolCard): TuiState {
  const transcript = [...collapseToolCards(state.transcript), serializeToolCard(card)];
  return replaceTranscript(state, transcript);
}

function projectRuntimeEvent(state: TuiState, event: RuntimeEvent): TuiState {
  let next = reduceTuiRuntimeEvent(state, event);
  if (event.sessionId) next = withSessionId(next, event.sessionId);
  if (next.conversation && event.type.startsWith("session.") && next.conversation.detachedCodingSessionId !== event.sessionId) {
    next = { ...next, conversation: { ...next.conversation, codingSessionId: event.sessionId,
      codingStatus: event.type === "session.completed" ? "completed" : event.type === "session.paused" ? "paused" : event.type === "session.cancelled" ? "cancelled" : "running" } };
  }

  if (event.type === "command.output") {
    return appendCommandChunk(next, event);
  }
  if (event.type === "subagent.tool_result") {
    const id = toolCallCardId(event.sessionId, event.payload.subagentId, event.payload.callId);
    const card = next.transcript.map(parseToolCard).find((entry) => entry?.id === id && entry.tool === event.payload.tool);
    if (!card) return next;
    const output = redactKnownSecrets(event.payload.output).replace(/\r\n?/g, "\n");
    const preview = card.tool === "read_file" || card.tool === "read"
      ? readResultPreview(event)
      : output ? output.replace(/\n$/, "").split("\n") : [];
    const body = card.kind === "edit" && event.payload.ok
      ? card.body
      : [...card.body.slice(0, 1), ...preview];
    const status = event.payload.cancelled ? "cancelled" : event.payload.ok ? "done" : "failed";
    return replaceTranscript(next, updateToolCard(next.transcript, id, status, body));
  }
  if (event.type === "command.completed") {
    const id = next.commandCardIds?.[commandCardKey(event.sessionId, event.payload.commandId)];
    if (id) {
      const status = event.payload.signal === "ABORT" ? "cancelled" : event.payload.exitCode === 0 && !event.payload.signal ? "done" : "failed";
      return replaceTranscript(next, updateToolCard(next.transcript, id, status));
    }
  }

  const decision = permissionDecisionForRuntimeEvent(next.sessionMode, event, {
    editsApproved: next.editsApproved,
  });
  const askOnPause = event.type === "session.paused";
  const askOnPlan = next.sessionMode === "plan" &&
    (event.type === "subagent.tool_call" || event.type === "command.started" || event.type === "file.changed");
  const willAsk = Boolean(
    decision && decision.outcome === "ask" && !next.pendingPermission && (askOnPause || askOnPlan),
  );
  const prompt = Boolean(willAsk && decision?.canApply && next.sessionMode === "guarded");

  const duplicateProgress = streamedProgress(next, event);
  next = commitLiveText(next);
  const draft = duplicateProgress ? null : toolCardDraft(event);
  if (draft) {
    const diffLines = diffLinesForRuntimeEvent(event).map((line) => redactKnownSecrets(line));
    const commandPreview = commandTextFromEvent(event);
    const readPreview = readResultPreview(event);
    const body = [redactKnownSecrets(draft.activity), ...readPreview, ...diffLines];
    let id = draft.id.trim() || `card-${next.transcript.length + 1}`;
    let existing = false;
    if (event.type === "subagent.tool_call" && event.payload.callId) {
      id = toolCallCardId(event.sessionId, event.payload.subagentId, event.payload.callId);
    }
    if (event.type === "command.started") {
      const { toolCallId, taskId, commandId } = event.payload;
      const owner = toolCallId && taskId ? toolCallCardId(event.sessionId, taskId, toolCallId) : undefined;
      if (owner && next.transcript.some((entry) => parseToolCard(entry)?.id === owner)) {
        id = owner;
        existing = true;
      }
      next = { ...next, commandCardIds: { ...next.commandCardIds, [commandCardKey(event.sessionId, commandId)]: id } };
    }
    const status = cardStatusFor(decision, willAsk, next.sessionMode);
    if (!existing) next = pushToolCard(next, {
      id,
      kind: draft.kind,
      tool: draft.tool,
      summary: commandPreview || draft.summary,
      status: (event.type === "subagent.tool_call" || event.type === "command.started") && status === "done" && readPreview.length === 0 ? "running" : status,
      expanded: true,
      mutating: draft.mutating,
      prompt: false,
      body,
    });
  } else if (!duplicateProgress) {
    const activity = activityLineForRuntimeEvent(event);
    const line = redactKnownSecrets(activity ?? formatRuntimeEventText(event));
    next = appendTranscriptLine(next, line);
    for (const diffLine of diffLinesForRuntimeEvent(event)) {
      next = appendTranscriptLine(next, redactKnownSecrets(diffLine));
    }
  }

  switch (event.type) {
    case "session.created":
    case "session.started":
      next = setTaskStatus(withMode(next, "running"), "running");
      break;
    case "validation.started":
      next = setTaskStatus(next, "verifying");
      break;
    case "session.completed":
      next = setTaskStatus(withMode(next, "default"), "complete");
      if (next.sessionMode === "plan") {
        next = appendTranscriptLine(next, "Plan mode did not apply edits.");
      } else if (next.sessionMode === "review") {
        next = appendTranscriptLine(next, "Review mode did not apply edits.");
      }
      break;
    case "session.cancelled":
    case "session.paused":
      next = setTaskStatus(withMode(next, "default"), "idle");
      break;
    default:
      break;
  }

  if (prompt) {
    next = replaceTranscript(next, promptNewestMutatingCard(next.transcript, "asking"));
  }
  if (!decision || decision.outcome === "allow") return next;

  if (decision.outcome === "deny" || willAsk) {
    next = appendTranscriptLine(next, formatDecisionLine(decision));
  }
  if (willAsk) next = withPendingPermission(next, decision);
  return next;
}

async function beginTask(
  state: TuiState,
  task: string,
  cwd: string,
  onUpdate: ((updater: (current: TuiState) => TuiState) => void) | undefined,
  options: ExecuteTuiCommandOptions,
): Promise<ExecuteResult> {
  if (state.taskStatus === "running") {
    return {
      state: withOutput(state, ["  A turn is already running. Press Esc to interrupt it."]),
      shouldExit: false,
    };
  }

  const mentions = extractFileMentions(task);
  let nextState = withOutput(withMode(state, "running"), [`  Working: ${task}`]);
  nextState = setTaskStatus(nextState, "running");
  if (!options.continuation) nextState = appendTranscriptLine(nextState, `[User] ${task}`);
  for (const file of mentions) {
    nextState = appendTranscriptLine(nextState, `context ${file}`);
  }

  if (!onUpdate) return { state: nextState, shouldExit: false };

  const conversation = state.conversation ?? newConversation(cwd, state.sessionMode);
  const currentConversation = options.continuation ? conversation : {
    ...conversation,
    title: conversation.messages.length === 0 ? redactKnownSecrets(task.split(/\r?\n/, 1)[0]).slice(0, 200) : conversation.title,
    messages: [...conversation.messages, { role: "user" as const, content: redactKnownSecrets(task) }],
  };
  const workspace = conversation.codingSessionId && !options.runSession ? await getCodingWorkspace(cwd, conversation.codingSessionId) : cwd;
  const attached = await attachFileContext(workspace, task);
  const images = validateProviderImages(await Promise.all((conversation.imagePaths ?? []).map((file) => loadProviderImage(cwd, file))));
  const objective = options.continuation ? undefined : conversationContext(conversation, attached.prompt);
  nextState = { ...nextState, conversation: currentConversation, contextChars: objective?.length ?? 0 };
  if (options.persistSession ?? !options.runSession) await persistConversation(cwd, nextState);

  const posture = resolveSessionPosture(nextState.sessionMode, options.posture);
  const { runTuiTask } = await import("./runtime-adapter.js");
  let latestAssistant = "";
  const assistantSegments: string[] = [];
  const runtime = runTuiTask(cwd, task, {
    onEvent: (event) => {
      onUpdate((current) => projectRuntimeEvent(current, event));
    },
    onText: (text) => {
      const publicText = redactStreamingText(text);
      if (latestAssistant && !publicText.startsWith(latestAssistant)) assistantSegments.push(latestAssistant);
      latestAssistant = publicText;
      onUpdate((current) => withLiveText(current, text));
    },
    onError: (error) => {
      onUpdate((current) => {
        let next = commitLiveText(current);
        next = appendTranscriptLine(next, `[Error] ${redactKnownSecrets(error)}`);
        next = setTaskStatus(next, "error");
        return withMode(next, "error");
      });
    },
    onComplete: async (result) => {
      let snapshot: TuiState | undefined;
      onUpdate((current) => {
        let updated = commitLiveText(current);
        const coding = result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result : undefined;
        const status = result && typeof result === "object" && "status" in result && typeof result.status === "string" ? result.status : undefined;
        const report = coding && "finalReport" in coding && coding.finalReport && typeof coding.finalReport === "object" ? coding.finalReport : undefined;
        const statusText = report && "result" in report && typeof report.result === "string" ? redactKnownSecrets(report.result) : undefined;
        const plan = coding && "plan" in coding && coding.plan && typeof coding.plan === "object" && "summary" in coding.plan && typeof coding.plan.summary === "string" ? coding.plan.summary : undefined;
        const summary = [...new Set([...assistantSegments, latestAssistant, plan, statusText].filter((text): text is string => Boolean(text?.trim())))].map(redactKnownSecrets).join("\n\n").slice(0, 20_000);
        updated = setTaskStatus(updated, status === "completed" ? "complete" : status === "failed" ? "error" : status || updated.taskStatus === "running" || updated.taskStatus === "verifying" ? "idle" : updated.taskStatus);
        if (updated.conversation) {
          updated = { ...updated, conversation: { ...updated.conversation,
            codingSessionId: coding && typeof coding.id === "string" && updated.conversation.detachedCodingSessionId !== coding.id ? coding.id : updated.conversation.codingSessionId,
            codingStatus: coding && updated.conversation.detachedCodingSessionId === coding.id ? undefined : status ?? updated.conversation.codingStatus,
            messages: summary ? [...updated.conversation.messages, { role: "assistant", content: summary }] : updated.conversation.messages } };
        }
        snapshot = updated;
        return updated;
      });
      if (snapshot && (options.persistSession ?? !options.runSession)) await persistConversation(cwd, snapshot);
    },
  }, {
    runSession: options.runSession,
    codeMode: posture.mode,
    approvalPolicy: posture.approvalPolicy,
    resumeId: options.continuation ? conversation.codingSessionId : undefined,
    continuationId: !options.continuation ? conversation.codingSessionId : undefined,
    providerOverride: conversation.model,
    context: objective,
    skillIds: conversation.skillIds,
    enabledMcpServers: conversation.mcpServerIds,
    enabledLspServers: conversation.lspServerIds,
    pluginAgentId: conversation.pluginAgentId ?? null,
    outputStyleId: conversation.outputStyleId ?? null,
    invokedSkills: options.invokedSkills,
    images,
    requestToolPermission: options.requestToolPermission,
    requestMcpInput: options.requestMcpInput,
    extensionOptions: options.extensionOptions,
  });

  return { state: nextState, shouldExit: false, runtime };
}

export async function executeTuiCommand(
  cmd: TuiCommand,
  state: TuiState,
  cwd: string,
  onUpdate?: (updater: (s: TuiState) => TuiState) => void,
  options: ExecuteTuiCommandOptions = {},
): Promise<ExecuteResult> {
  if (cmd.kind === "mcp") options = { ...options, extensionOptions: { ...options.extensionOptions,
    mcpHost: options.extensionOptions?.mcpHost ?? createCodingMcpHostFactory({ cwd,
      provider: state.conversation?.model ?? (state.selectedProvider && state.selectedModel ? { providerId: state.selectedProvider, model: state.selectedModel } : undefined),
      requestPermission: options.requestToolPermission, requestInput: options.requestMcpInput }),
  } };
  switch (cmd.kind) {
    case "exit":
      return { state, shouldExit: true };

    case "clear":
      return { state: clearTranscript(withClear(state)), shouldExit: false };

    case "new": {
      await persistConversation(cwd, state);
      const fresh = newConversation(cwd, state.sessionMode);
      fresh.model = state.conversation?.model;
      return { state: { ...clearTranscript(withClear(state)), conversation: fresh, sessionId: undefined,
        subagents: [], recentRuntimeEvents: [], commandCardIds: {}, pendingPermission: undefined,
        permissionPrompt: undefined, history: [], historyIndex: -1, editsApproved: false, contextChars: undefined,
        taskStatus: "idle", scrollOffset: 0 }, shouldExit: false };
    }

    case "resume": case "continue": {
      const store = new CliConversationStore(cwd);
      if (!cmd.args && cmd.kind === "resume") {
        const { records, warnings } = await store.list();
        return { state: { ...withOutput(state, [...warnings.map((line) => `  ${line}`), records.length ? "  Choose a saved conversation:" : "  No saved CLI conversations."]),
          picker: records.length ? { kind: "session", query: "", selected: 0, items: records.slice(0, 8).map((item) => ({ label: item.title, detail: item.id, insert: `/resume ${item.id}`, submit: true })) } : undefined }, shouldExit: false };
      }
      const id = cmd.args.trim() || (await store.list()).records[0]?.id;
      if (!id) return { state: withOutput(state, ["  No saved CLI conversations."]), shouldExit: false };
      const conversation = await store.load(id);
      if (!conversation) throw new Error(`CLI conversation ${id} not found.`);
      await persistConversation(cwd, state);
      const restored: TuiState = { ...state, conversation, transcript: conversation.transcript, outputLines: [], history: conversation.history,
        historyIndex: -1, input: "", cursor: 0, sessionMode: conversation.mode, sessionId: conversation.codingSessionId,
        provider: conversation.model?.providerId ?? state.provider, model: conversation.model?.model ?? state.model,
        taskStatus: "idle", running: false, editsApproved: false, picker: undefined, scrollOffset: 0,
        pendingPermission: undefined, permissionPrompt: undefined, subagents: [], recentRuntimeEvents: [], commandCardIds: {} };
      let next = restored;
      if (conversation.codingStatus === "paused" && conversation.codingSessionId && !options.runSession) {
        const root = await findRepositoryRoot(cwd);
        const coding = await new CodingSessionStore(root).load(conversation.codingSessionId);
        const paused = [...(coding?.events ?? [])].reverse().find((event) => event.type === "session.paused");
        if (paused) {
          const decision = permissionDecisionForRuntimeEvent(next.sessionMode, paused);
          if (decision?.outcome === "ask") next = withPendingPermission(next, decision);
        }
      }
      return { state: withOutput(next, [`  Resumed ${conversation.title} (${conversation.id}).`]), shouldExit: false };
    }

    case "rename": {
      if (!state.conversation) throw new Error("Start a conversation first.");
      const title = redactKnownSecrets(cmd.args.trim());
      if (!title || title.length > 200 || /[\r\n\x00-\x1f]/.test(title)) throw new Error("Use a single-line title of 1-200 characters.");
      const renamed = { ...state, conversation: { ...state.conversation, title } };
      await persistConversation(cwd, renamed);
      return { state: withOutput(renamed, [`  Conversation renamed: ${title}`]), shouldExit: false };
    }

    case "fork": {
      if (!state.conversation) throw new Error("Start a conversation first.");
      const source = state.conversation;
      const title = redactKnownSecrets(cmd.args.trim()).slice(0, 200) || `${source.title.slice(0, 190)} (fork)`;
      if (/[\x00-\x1f\x7f]/.test(title)) throw new Error("Use a single-line fork title without control characters.");
      await persistConversation(cwd, state);
      const createFork = async (signal?: AbortSignal): Promise<TuiState> => {
        const coding = source.codingSessionId ? await (options.forkSession ?? forkCodingSession)(cwd, source.codingSessionId, { signal }) : undefined;
        const conversation = { ...source, ...newConversation(cwd, state.sessionMode), title,
          messages: [...source.messages], summary: source.summary, transcript: [...state.transcript], history: [...state.history],
          model: source.model, forkedFrom: source.id, detachedCodingSessionId: undefined,
          codingSessionId: coding?.id, codingStatus: coding?.status };
        const next = { ...state, conversation, sessionId: coding?.id, editsApproved: false, pendingPermission: undefined, permissionPrompt: undefined,
          subagents: [], recentRuntimeEvents: [], commandCardIds: {}, taskStatus: "complete" as const };
        try { await persistConversation(cwd, next); }
        catch (error) { throw new Error(coding ? `Coding fork ${coding.id} was created, but saving its CLI conversation failed. The saved coding session and worktree were preserved.` : "Saving the forked conversation failed.", { cause: error }); }
        return withOutput(next, [coding?.repository.worktreePath
          ? `  Forked into independent worktree ${coding.repository.worktreePath}. Index and file changes were copied; prior checks must run again.`
          : "  Forked conversation and saved planning context. Its implementation turn will create an independent worktree."]);
      };
      if (!onUpdate) return { state: await createFork(), shouldExit: false };
      const runtime = runTuiTask(cwd, cmd.raw, { onEvent: () => {},
        onError: (error) => onUpdate((current) => withOutput(setTaskStatus(current, "error"), [`  ${redactStreamingText(error)}`])),
      }, { runSession: async ({ signal }) => {
        const next = await createFork(signal);
        onUpdate((current) => ({ ...next, input: current.input, cursor: current.cursor, picker: current.picker,
          history: current.history, historyIndex: current.historyIndex, messageQueue: current.messageQueue }));
      } });
      return { state: setTaskStatus(state, "running"), shouldExit: false, runtime };
    }

    case "compact": {
      if (!state.conversation) throw new Error("Start a conversation first.");
      const conversation = state.conversation;
      const boundary = Math.max(conversation.contextStart ?? 0, conversation.messages.length - 8);
      const earlier = conversation.messages.slice(conversation.contextStart ?? 0, boundary);
      const summary = [conversation.summary, ...earlier.map((message) => `${message.role}: ${message.content.slice(0, 700)}`)].filter(Boolean).join("\n").slice(-12_000);
      const next = { ...state, conversation: { ...conversation, contextStart: boundary, summary }, contextChars: undefined };
      await persistConversation(cwd, next);
      return { state: withOutput(next, [`  Local extractive compaction: ${earlier.length} earlier messages summarized; full messages remain saved.`, ...(cmd.args ? [`  Focus note: ${redactKnownSecrets(cmd.args)}`] : [])]), shouldExit: false };
    }

    case "export": {
      if (!state.conversation) throw new Error("Start a conversation first.");
      const conversation = state.conversation;
      const content = [`# ${conversation.title}`, `Session: ${conversation.id}`, "", ...conversation.messages.flatMap((message) => [`## ${message.role}`, "", message.content, ""])].join("\n");
      const destination = await writeHiveRunReport(cwd, cmd.args.trim() || `${conversation.id}.md`, redactKnownSecrets(content));
      return { state: withOutput(state, [`  Exported conversation to ${destination}`]), shouldExit: false };
    }

    case "copy": {
      if (cmd.args && cmd.args !== "all") throw new Error("Usage: /copy (last assistant response) or /copy all (conversation).");
      const messages = state.conversation?.messages ?? [];
      const text = cmd.args === "all" ? messages.map((message) => `${message.role}:\n${message.content}`).join("\n\n")
        : [...messages].reverse().find((message) => message.role === "assistant")?.content;
      if (!text) throw new Error("There is no saved assistant response to copy yet.");
      await (options.copyToClipboard ?? copyToClipboard)(redactStreamingText(text));
      return { state: withOutput(state, [`  Copied ${cmd.args === "all" ? "conversation" : "last response"} to the clipboard.`]), shouldExit: false };
    }

    case "context": {
      const count = state.contextChars;
      return { state: withOutput(state, ["  Conversation context", `  Messages: ${state.conversation?.messages.length ?? 0}`,
        count === undefined ? "  Last prompt size: unavailable" : `  Last prompt: ${count} characters (~${Math.ceil(count / 4)} tokens, estimate)` ,
        `  History budget: ${CONTEXT_CHAR_BUDGET} characters; oldest messages are bounded.`, "  /compact summarizes earlier turns without deleting saved messages."]), shouldExit: false };
    }

    case "diff": {
      const workspace = state.conversation?.codingSessionId ? await getCodingWorkspace(cwd, state.conversation.codingSessionId) : cwd;
      const result = await new RepositoryToolService({ repositoryRoot: workspace, sessionId: "cli-diff", approvalPolicy: "safe" }).inspectDiff();
      return { state: withOutput(state, ["```diff", result.output || "No tracked changes.", "```"]), shouldExit: false };
    }

    case "review":
      return beginTask({ ...state, sessionMode: "review" }, cmd.args.trim() || "Review the current changes for correctness, security, and regressions. Report actionable findings with file locations; do not edit files.", cwd, onUpdate, { ...options, posture: { mode: "review", approvalPolicy: "safe" } });

    case "find": {
      if (!cmd.args.trim()) throw new Error("Usage: /find <text>");
      const needle = cmd.args.toLocaleLowerCase();
      const matches = state.transcript.flatMap((entry, index) => entry.toLocaleLowerCase().includes(needle) ? [`  ${index + 1}: ${entry}`] : []);
      return { state: withOutput(state, matches.length ? matches.slice(-20) : ["  No matching transcript entries."]), shouldExit: false };
    }

    case "mcp": case "skills": case "plugins": case "hooks": case "lsp": {
      if (cmd.kind === "plugins" && /^use-style(?:\s|$)/u.test(cmd.args)) {
        const selected = cmd.args.slice("use-style".length).trim();
        if (!selected) return { state: withOutput(state, [`Selected output style: ${state.conversation?.outputStyleId ?? "none"}`, "/plugins use-style <id> | off"]), shouldExit: false };
        const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)) };
        conversation.outputStyleId = selected === "off" ? undefined : (await loadTrustedPluginOutputStyle(cwd, selected, options.extensionOptions)).id;
        const next = { ...state, conversation }; if (options.persistSession !== false) await persistConversation(cwd, next);
        return { state: withOutput(next, [`Selected final-response style: ${conversation.outputStyleId ?? "none"}`]), shouldExit: false };
      }
      if (cmd.kind === "plugins" && /^use-agent(?:\s|$)/u.test(cmd.args)) {
        const selected = cmd.args.slice("use-agent".length).trim();
        if (!selected) return { state: withOutput(state, [`Selected plugin agent: ${state.conversation?.pluginAgentId ?? "none"}`, "/plugins use-agent <id> | off"]), shouldExit: false };
        const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)) };
        conversation.pluginAgentId = selected === "off" ? undefined : (await loadPluginAgent(cwd, selected, options.extensionOptions)).id;
        const next = { ...state, conversation }; if (options.persistSession !== false) await persistConversation(cwd, next);
        return { state: withOutput(next, [`Selected plugin agent: ${conversation.pluginAgentId ?? "none"}`]), shouldExit: false };
      }
      if (cmd.kind === "plugins" && /^run-agent(?:\s|$)/u.test(cmd.args)) {
        const invocation = /^run-agent\s+(\S+)\s+([\s\S]+)$/u.exec(cmd.args);
        if (!invocation) throw new Error("/plugins run-agent requires an agent id and objective");
        const agent = await loadPluginAgent(cwd, invocation[1], options.extensionOptions);
        const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)), pluginAgentId: agent.id };
        return beginTask({ ...state, conversation }, invocation[2], cwd, onUpdate, options);
      }
      if (cmd.kind === "lsp" && /^use(?:\s|$)/u.test(cmd.args)) {
        const id = cmd.args.slice(3).trim();
        const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)) };
        if (!id) return { state: withOutput(state, [`Attached LSP servers: ${conversation.lspServerIds?.join(", ") || "none"}`, "/lsp use <trusted-enabled-id> | off"]), shouldExit: false };
        if (id === "off") conversation.lspServerIds = [];
        else {
          const { loadLspServer } = await import("../extensions/catalog.js");
          const server = await loadLspServer(cwd, id, options.extensionOptions);
          conversation.lspServerIds = [...new Set([...(conversation.lspServerIds ?? []), server.id])];
        }
        const next = { ...state, conversation }; if (options.persistSession !== false) await persistConversation(cwd, next);
        return { state: withOutput(next, [`Attached LSP servers: ${conversation.lspServerIds.join(", ") || "none"}. Processes start only for an approved query.`]), shouldExit: false };
      }
      if (cmd.kind === "mcp" && /^use(?:\s|$)/.test(cmd.args)) {
        const id = cmd.args.slice(3).trim();
        const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)) };
        if (!id) return { state: withOutput(state, [`  Attached MCP servers: ${conversation.mcpServerIds?.join(", ") || "none"}`, "  /mcp use <trusted-enabled-server> or /mcp use off"]), shouldExit: false };
        if (id === "off") conversation.mcpServerIds = [];
        else {
          const server = (await discoverExtensions(cwd, options.extensionOptions)).servers.find((entry) => entry.id === id || entry.id === `mcp:${id}`);
          if (!server?.enabled || !server.trusted) throw new Error("MCP server must be configured, trusted and enabled before attaching it.");
          conversation.mcpServerIds = [...new Set([...(conversation.mcpServerIds ?? []), server.id])];
        }
        const next = { ...state, conversation: { ...conversation } };
        if (options.persistSession !== false) await persistConversation(cwd, next);
        return { state: withOutput(next, [`  Attached MCP servers: ${conversation.mcpServerIds.join(", ") || "none"}. External calls require approval.`]), shouldExit: false };
      }
      const needsRuntime = cmd.kind === "mcp" && /^(?:doctor|tools|call|login|resources|resource-templates|read|prompts|prompt|complete|watch|subscribe|task-call|tasks|task|task-result|task-cancel|task-continue|task-subscribe)(?:\s|$)/.test(cmd.args)
        || cmd.kind === "lsp" && /^(?:doctor|diagnostics|hover|definition|references|symbols|workspace-symbols)(?:\s|$)/u.test(cmd.args)
        || cmd.kind === "plugins" && /^(?:marketplace|install|update)(?:\s|$)/.test(cmd.args);
      if (needsRuntime) {
        const isCall = cmd.kind === "mcp" && /^(?:call|task-call|task-cancel|task-continue)(?:\s|$)/.test(cmd.args);
        if (isCall && (state.sessionMode === "plan" || state.sessionMode === "review")) throw new Error("External tool calls are disabled in read-only modes.");
        if (!onUpdate || (isCall && !options.requestToolPermission)) {
          return { state: withOutput(state, ["  Open an interactive session for cancellable extension operations and tool approval."]), shouldExit: false };
        }
        const requestPermission = options.requestToolPermission;
        const runtime = runTuiTask(cwd, cmd.raw, {
          onEvent: () => {},
          onError: (error) => onUpdate((current) => withOutput(setTaskStatus(current, "error"), [`  ${redactStreamingText(error)}`])),
        }, { runSession: async ({ signal }) => {
          if (isCall) {
            const approved = await requestPermission?.({ tool: "mcp_call", description: cmd.raw,
              input: { command: cmd.args }, external: true }, signal);
            if (!approved || signal.aborted) throw new Error("MCP call declined before connecting.");
          }
          const lines = await extensionCommand(cwd, cmd.kind === "mcp" ? "mcp" : cmd.kind === "lsp" ? "lsp" : "plugins", cmd.args, { ...options.extensionOptions, signal,
            onProgress: (line) => onUpdate((current) => withOutput(current, [line])) });
          onUpdate((current) => withOutput(setTaskStatus(current, "complete"), lines));
        } });
        return { state: setTaskStatus(state, "running"), shouldExit: false, runtime };
      }
      const lines = await extensionCommand(cwd, cmd.kind, cmd.args, options.extensionOptions);
      return { state: withOutput(state, lines), shouldExit: false };
    }

    case "skill": {
      const id = cmd.args.trim();
      const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)) };
      if (!id) return { state: withOutput(state, [`  Active skills: ${conversation.skillIds?.join(", ") || "none"}`, "  /skill <trusted-enabled-id> or /skill off"]), shouldExit: false };
      if (id === "off") conversation.skillIds = [];
      else {
        const skill = await loadSkill(cwd, id.startsWith("skill:") ? id : `skill:${id}`, options.extensionOptions);
        conversation.skillIds = [...new Set([...(conversation.skillIds ?? []), skill.id])];
      }
      const next = { ...state, conversation: { ...conversation } };
      if (options.persistSession !== false) await persistConversation(cwd, next);
      return { state: withOutput(next, [`  Active skills: ${conversation.skillIds.join(", ") || "none"}`]), shouldExit: false };
    }

    case "image": {
      const file = cmd.args.trim().replace(/^(["'])(.*)\1$/, "$2");
      const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)) };
      if (!file) return { state: withOutput(state, [`  Attached images: ${conversation.imagePaths?.join(", ") || "none"}`, "  /image <local-file> attaches actual image data to subsequent prompts; /image off clears it."]), shouldExit: false };
      if (file === "off") conversation.imagePaths = [];
      else {
        const paths = [...new Set([...(conversation.imagePaths ?? []), file])];
        validateProviderImages(await Promise.all(paths.map((image) => loadProviderImage(cwd, image))));
        conversation.imagePaths = paths;
      }
      const next = { ...state, conversation: { ...conversation } };
      if (options.persistSession !== false) await persistConversation(cwd, next);
      return { state: withOutput(next, [`  Attached images: ${conversation.imagePaths.join(", ") || "none"}. Image bytes stay request-only.`]), shouldExit: false };
    }

    case "shell": {
      if (!cmd.args) throw new Error("Usage: !<command> or /shell <command>");
      if (state.sessionMode === "plan" || state.sessionMode === "review") throw new Error("Shell commands are disabled in read-only modes.");
      if (!onUpdate || !options.requestToolPermission) {
        const decision = { kind: "command" as const, target: "shell", outcome: "ask" as const, canApply: true, reason: "A local command needs an interactive approval." };
        return { state: withOutput(withPendingPermission(state, decision), ["  Local commands need interactive approval; open hive to run this command."]), shouldExit: false };
      }
      const requestPermission = options.requestToolPermission;
      const runtime = runTuiTask(cwd, cmd.args, { onEvent: () => {}, onError: (error) => onUpdate((current) => withOutput(setTaskStatus(current, "error"), [`  ${redactStreamingText(error)}`])) }, {
        runSession: async ({ signal }) => {
          const result = await runLocalCommand({ cwd, command: cmd.args, codingSessionId: state.conversation?.codingSessionId,
            signal, requestPermission, onEvent: (event) => onUpdate((current) => projectRuntimeEvent(current, event)) });
          onUpdate((current) => {
            const summary = `Local command: ${cmd.args}\nExit code: ${result.exitCode ?? "signal"}\n${result.output.slice(-12_000)}`;
            const next = { ...current, conversation: current.conversation ? { ...current.conversation,
              codingStatus: result.changedWorkspace ? "cancelled" : current.conversation.codingStatus,
              messages: [...current.conversation.messages, { role: "assistant" as const, content: redactStreamingText(summary) }] } : current.conversation };
            return withOutput(setTaskStatus(next, result.exitCode === 0 ? "complete" : "error"), [
              `  Command exit: ${result.exitCode ?? "signal"}`,
              ...(result.changedWorkspace ? ["  Workspace changed; previous checks are stale and will rerun on the next coding turn."] : []),
            ]);
          });
          return result;
        },
      });
      return { state: setTaskStatus(state, "running"), shouldExit: false, runtime };
    }

    case "help": {
      const lines = [
        ...sessionHelpLines(),
        "  /providers     Inspect or configure BYOK and local providers",
        "  /connect       Choose BYOK or a local model server",
        "  /status        Show provider and runtime status",
        "  /model         Show the active model",
        "  /agents [id]   Toggle the subagent view or inspect one agent",
        "  /run <task>    Start a turn",
      ];
      return {
        state: withOutput(state, lines),
        shouldExit: false,
      };
    }

    case "mode": {
      if (!cmd.args) {
        return {
          state: withOutput(state, [
            `  Mode: ${state.sessionMode}`,
            `  ${describeMode(state.sessionMode)}`,
            "  Usage: /mode guarded|standard|autonomous|plan|review",
          ]),
          shouldExit: false,
        };
      }
      const requested = cmd.args.split(/\s+/)[0] ?? "";
      if (!isHiveMode(requested)) {
        return {
          state: withOutput(state, [
            "  Unknown mode. Choose guarded, standard, autonomous, plan, or review.",
          ]),
          shouldExit: false,
        };
      }
      const { ConfigStore } = await import("../config.js");
      await new ConfigStore(cwd).setMode(requested);
      return {
        state: withSessionMode(withOutput(state, [
          `  Mode set to ${requested}.`,
          `  ${describeMode(requested)}`,
        ]), requested),
        shouldExit: false,
      };
    }

    case "plan": {
      const { ConfigStore } = await import("../config.js");
      await new ConfigStore(cwd).setMode("plan");
      const planned = withSessionMode(withOutput(state, [
        "  Plan mode on. HIVE will read and propose, and will not apply edits.",
      ]), "plan");
      if (!cmd.args) return { state: planned, shouldExit: false };
      return beginTask(planned, cmd.args, cwd, onUpdate, options);
    }

    case "rewind": {
      if (state.running || state.taskStatus === "running" || state.taskStatus === "verifying") {
        return {
          state: withOutput(state, ["  A turn is running. Press Esc before /rewind."]),
          shouldExit: false,
        };
      }
      if (cmd.args.trim()) {
        if (!/^files(?:\s|$)/.test(cmd.args)) throw new Error("Usage: /rewind (transcript only) or /rewind files [checkpoint-id]");
        if (state.sessionMode === "plan" || state.sessionMode === "review") throw new Error("File restore is disabled in read-only modes.");
        const codingSessionId = state.conversation?.codingSessionId;
        if (!codingSessionId) throw new Error("No coding workspace is attached; use /checkpoints after a coding turn.");
        const workspace = await getCodingWorkspace(cwd, codingSessionId);
        const checkpoints = new CheckpointStore(workspace, codingSessionId);
        const id = cmd.args.slice("files".length).trim() || (await checkpoints.list()).find((item) => item.status === "complete" || item.status === "failed")?.id;
        if (!id) throw new Error("No file checkpoints are available.");
        const preview = await checkpoints.preview(id);
        const lines = [`  Checkpoint ${id}: ${preview.operation}`, ...preview.paths.map((file) => `  ${file.action}: ${file.path}`), ...preview.conflicts.map((conflict) => `  Conflict: ${conflict}`)];
        if (!preview.restorable) return { state: withOutput(state, lines), shouldExit: false };
        if (!onUpdate || !options.requestToolPermission) return { state: withOutput(state, [...lines, "  Restoring files requires interactive confirmation; no files changed."]), shouldExit: false };
        const requestPermission = options.requestToolPermission;
        const runtime = runTuiTask(cwd, `Restore ${id}`, { onEvent: () => {}, onError: (error) => onUpdate((current) => withOutput(setTaskStatus(current, "error"), [`  ${redactStreamingText(error)}`])) }, {
          runSession: async ({ signal }) => {
            const paths = await rewindLocalFiles({ cwd, codingSessionId, checkpointId: id, requestPermission, signal });
            onUpdate((current) => withOutput(setTaskStatus({ ...current, conversation: current.conversation ? { ...current.conversation, codingStatus: "cancelled" } : undefined }, "complete"), [`  Restored ${paths.length} file(s). Previous checks are stale; the next coding turn must revalidate.`]));
          },
        });
        return { state: setTaskStatus(withOutput(state, lines), "running"), shouldExit: false, runtime };
      }
      const rewound = rewindTranscript(state.transcript);
      if (!rewound.changed) {
        return { state: withOutput(state, [rewound.notice]), shouldExit: false };
      }
      return {
        state: withOutput(withTranscript(state, rewound.lines), [rewound.notice]),
        shouldExit: false,
      };
    }

    case "checkpoints": {
      const id = state.conversation?.codingSessionId;
      if (!id) return { state: withOutput(state, ["  No coding workspace is attached."]), shouldExit: false };
      const workspace = await getCodingWorkspace(cwd, id);
      const checkpoints = await new CheckpointStore(workspace, id).list();
      return { state: withOutput(state, checkpoints.length ? checkpoints.map((item) => `  ${item.id}  ${item.status}  ${item.operation}  ${item.paths.join(", ")}`) : ["  No file checkpoints recorded."]), shouldExit: false };
    }

    case "sessions": {
      let lines: string[];
      try {
        const { CodingSessionStore } = await import("../coding/session-store.js");
        const { findRepositoryRoot } = await import("../coding/repository.js");
        const root = await findRepositoryRoot(cwd).catch(() => cwd);
        const sessions = await new CodingSessionStore(root).list();
        lines = [
          "  Saved sessions",
          "  --------------",
          ...formatSessionList(sessions),
        ];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lines = [`  Could not list sessions: ${redactKnownSecrets(msg)}`];
      }
      return { state: withOutput(state, lines), shouldExit: false };
    }

    case "providers": {
      const args = providerCommandArguments(cmd.args);
      if (args[0] === "setup") {
        const mode = args[1];
        if (args.length > 2 || mode && mode !== "byok" && mode !== "local" && mode !== "subscription") throw new Error("Usage: /connect, /connect byok, /connect local, or /connect subscription.");
        const items = mode ? PROVIDER_SETUP_PRESETS.filter((preset) => preset.mode === mode).map((preset) => ({
          label: preset.label,
          detail: mode === "subscription" ? "Explicit ChatGPT sign-in through installed Codex; credentials stay with Codex" : `${preset.apiKeyEnv ? `Key environment: ${preset.apiKeyEnv}` : "No API key required"}${!preset.baseUrl ? "; enter API base URL" : ""}`,
          insert: mode === "subscription" ? "/providers add --id chatgpt --preset chatgpt" : `/providers add --id ${mode === "local" ? "local" : "my"}-${preset.id} --preset ${preset.id}${!preset.baseUrl ? " --base-url <endpoint>" : ""} --model `,
          submit: false,
        })) : [
          { label: "BYOK - your API key", detail: "OpenAI, Anthropic, Google, OpenRouter, or custom API", insert: "/providers setup byok", submit: true },
          { label: "Local models", detail: "Ollama or an OpenAI-compatible local server; no key required", insert: "/providers setup local", submit: true },
          { label: "ChatGPT subscription", detail: "Sign in through your installed Codex account service", insert: "/providers setup subscription", submit: true },
        ];
        return { state: { ...withOutput(state, [mode === "subscription" ? "  Register the account route, then use /providers login chatgpt --device."
          : mode ? "  Choose a provider, then enter its actual model ID in the prefilled command."
          : "  Choose BYOK, local models or ChatGPT subscription. Never paste a key into a command.",
          "  Replace <endpoint> with your API base URL when shown. Local models must already be running/loaded.",
          "  Setup never downloads models or changes existing defaults."]),
          picker: { kind: "command", query: "", selected: 0, items } }, shouldExit: false };
      }
      const apply = (current: TuiState, result: ProviderCommandResult) => {
        let next = withOutput(setTaskStatus(current, result.exitCode ? "error" : "complete"), result.lines.map((line) => `  ${line}`));
        if (result.models && result.provider?.approved && providerPublicText(result.provider.id, result.provider) === result.provider.id) {
          next = { ...next, picker: result.models.length ? { kind: "model", query: "", selected: 0,
            items: result.models.slice(0, 8).map((model) => ({ label: `${result.provider?.id}/${model}`, detail: "Available model from this endpoint",
              insert: `/model ${result.provider?.id}/${model}`, submit: true })) } : undefined };
        }
        return next;
      };
      if (onUpdate && ["test", "models", "login", "auth-status", "logout"].includes(args[0])) {
        const runtime = runTuiTask(cwd, cmd.raw, { onEvent: () => {},
          onError: (error) => onUpdate((current) => withOutput(setTaskStatus(current, "error"), [`  ${redactStreamingText(error)}`])),
        }, { runSession: async ({ signal }) => {
          const result = await providerCommand(cwd, args, { ...options.providerOptions, signal, onProgress: (text) => onUpdate((current) => withOutput(current, [text])) });
          onUpdate((current) => apply(setTaskStatus(current, result.exitCode ? "error" : "complete"), result));
        } });
        return { state: setTaskStatus(state, "running"), shouldExit: false, runtime };
      }
      const result = await providerCommand(cwd, args, options.providerOptions);
      return { state: apply(state, result), shouldExit: false };
    }

    case "status": {
      let lines: string[];
      try {
        const { ProviderRegistry } = await import(
          "../providers/registry.js"
        );
        const { ConfigStore } = await import("../config.js");
        const registry = new ProviderRegistry(await providerConfigRoot(cwd));
        const configStore = new ConfigStore(cwd);
        const providers = await registry.list();
        const mode = await configStore.getMode();
        const approved = providers.filter(
          (p: { approved: boolean }) => p.approved
        ).length;

        lines = [
          "  HIVE Runtime Status",
          "  -------------------",
          `  Mode:               ${mode}`,
          `  Providers:          ${providers.length} configured, ${approved} approved`,
          `  Provider:           ${state.provider}`,
          `  Model:              ${state.model}`,
          `  Active agents:      ${state.agents}`,
          state.contextChars === undefined ? "  Context size:       unavailable" : `  Last context:       ~${Math.ceil(state.contextChars / 4)} tokens (estimate)`,
          "  ",
          "  Safety Guardrails:",
          state.conversation?.codingSessionId ? `  Coding session: ${state.conversation.codingSessionId}` : "  Worktree: no coding session started",
          "  [OK] Approve-before-commit enforced",
          "  [OK] No auto-push",
          "  [OK] Secret redaction enabled",
        ];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lines = [`  Error loading status: ${msg}`];
      }
      return {
        state: withOutput(state, lines),
        shouldExit: false,
      };
    }

    case "model": {
      const catalog = await providerCatalog(cwd, options.providerOptions);
      const rows = catalog.rows.map((row) => row.provider).filter((row) => row.approved);
      if (!cmd.args) {
        const choices = rows.flatMap((provider) => {
          const models = [...new Set([provider.defaultModel, provider.model, ...Object.values(catalog.roles).filter((binding) => binding?.provider === provider.id).map((binding) => binding?.model)].filter((model): model is string => Boolean(model)))];
          if (providerPublicText(provider.id, provider) !== provider.id) return [];
          return models.filter((model) => providerPublicText(model, provider) === model).map((model) => ({ label: `${provider.id}/${model}`,
            detail: providerPublicText(provider.name, provider), insert: `/model ${provider.id}/${model}`, submit: true }));
        });
        return { state: { ...withOutput(state, [`  Current model: ${state.provider}/${state.model}`, "  Choose a configured model, or /model <provider>/<model>. Selection applies to this conversation." ]),
          picker: { kind: "model", query: "", selected: 0, items: [...choices.slice(0, 6),
            { label: "Add BYOK provider", detail: "Use your own API key", insert: "/providers setup byok", submit: true },
            { label: "Add local provider", detail: "Ollama or local OpenAI-compatible server", insert: "/providers setup local", submit: true },
            { label: "ChatGPT subscription", detail: "Sign in through installed Codex", insert: "/providers setup subscription", submit: true },
          ] } }, shouldExit: false };
      }
      const separator = cmd.args.indexOf("/");
      const providerId = cmd.args.slice(0, separator);
      const model = cmd.args.slice(separator + 1).trim();
      if (separator < 1 || !model || model.length > 256 || /[\x00-\x1f]/.test(model)) throw new Error("Usage: /model <approved-provider>/<model>");
      if (!rows.some((row) => row.id === providerId)) throw new Error(`Provider ${providerId} is not configured and approved.`);
      const conversation = { ...(state.conversation ?? newConversation(cwd, state.sessionMode)), model: { providerId, model } };
      const selected = { ...state, conversation, provider: providerId, model, picker: undefined };
      await persistConversation(cwd, selected);
      return { state: withOutput(selected, [`  Model selected: ${providerId}/${model} (this conversation).`]), shouldExit: false };
    }

    case "agents": {
      const target = cmd.args.trim();
      if (target === "collapse") {
        return {
          state: withSubagentsExpanded(withSelectedSubagent(state), false),
          shouldExit: false,
        };
      }
      if (target) {
        const selected = state.subagents.find((task) => task.id === target);
        if (!selected) {
          return {
            state: withOutput(state, [`  Subagent not found: ${target}`]),
            shouldExit: false,
          };
        }
        return {
          state: withSubagentsExpanded(withSelectedSubagent(state, selected.id), true),
          shouldExit: false,
        };
      }
      const selected = state.selectedSubagentId ?? state.subagents[0]?.id;
      return {
        state: withSubagentsExpanded(withSelectedSubagent(state, selected), !state.subagentsExpanded),
        shouldExit: false,
      };
    }

    case "run":
    case "task": {
      const task = cmd.args.trim();
      if (!task) {
        return {
          state: withOutput(state, [
            "  Usage: /run <task description>",
          ]),
          shouldExit: false,
        };
      }
      return beginTask(state, task, cwd, onUpdate, options);
    }

    case "unknown": {
      const catalog = await discoverExtensions(cwd, options.extensionOptions);
      const matches = catalog.skills.filter((skill) => {
        if (skill.name === cmd.args || skill.id === `skill:${cmd.args}`) return true;
        const plugin = catalog.plugins.find((entry) => entry.id === skill.pluginId);
        return plugin && (cmd.args === `${plugin.name}:${skill.name}` || cmd.args === `${plugin.sourceName ?? plugin.name}:${skill.name}`);
      });
      if (matches.length > 1) throw new Error("Ambiguous plugin command; use its full HIVE skill id");
      if (matches.length === 1) {
        const skill = await loadSkill(cwd, matches[0].id, options.extensionOptions);
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill.text)?.[1] ?? "";
        if (/^user-invocable:\s*(?:false|"false"|'false')\s*$/im.test(frontmatter)) throw new Error("This skill is not available as a user-invoked slash command.");
        const argumentsText = cmd.raw.slice(cmd.args.length + 1).trim();
        renderSkillArguments(skill.text, argumentsText);
        const prompt = argumentsText || `Apply the selected ${matches[0].name} skill to this workspace.`;
        return beginTask(state, prompt, cwd, onUpdate, { ...options, invokedSkills: [{ id: skill.id, arguments: argumentsText }] });
      }
      return {
        state: withOutput(state, [
          `  Unknown command: /${cmd.args}`,
          "  Type /help to see available commands.",
        ]),
        shouldExit: false,
      };
    }

    default:
      return { state, shouldExit: false };
  }
}
