/**
 * state.ts
 * TuiState type, initial state factory, and pure update helpers.
 */

import type { HiveMode } from "../config.js";
import type { CliConversation } from "./conversations.js";
import {
  aggregateSubagentCounts,
  type RuntimeEvent,
  type SubagentTask,
} from "../coding/types.js";
import {
  permissionPromptText,
  type PermissionDecision,
} from "./interaction.js";
import type { ComposerPicker } from "./picker.js";
import type { McpUserInputRequest } from "../extensions/mcp-client-host.js";
import { redactStreamingText } from "../security/secrets.js";
import { prefersAsciiGlyphs } from "./glyphs.js";
import {
  renderTranscriptBody,
  scrollOffsetAfterGrowth,
  sessionFrameWidth,
  transcriptViewportRows,
} from "./transcript-view.js";

export type TuiMode =
  | "default"
  | "swarm"
  | "providers"
  | "running"
  | "error";

export interface TuiState {
  sharedLoading?: boolean;
  /** Shared session workflow and client-local context; safety remains sessionMode. */
  workflowMode?: import("../projects/types.js").SessionMode;
  sharedContext?: { project: string; session: string; path: string; status: string; effectivePolicy: string; engine?: string; archived: boolean };
  mode: TuiMode;
  provider: string;
  model: string;
  agents: number;
  contextPercent: number;
  input: string;
  /** Cursor index into `input`. The composer draws it. */
  cursor: number;
  history: string[];
  historyIndex: number;
  outputLines: string[];
  selectedPanel: "main" | "help" | "providers";
  width: number;
  height: number;
  colorEnabled: boolean;
  running: boolean;
  taskStatus: "idle" | "running" | "verifying" | "complete" | "error";
  activeTask?: string;
  transcript: string[];
  scrollOffset: number;
  selectedProvider?: string;
  selectedModel?: string;
  lastError?: string;
  updatedAt?: number;
  scoutSignals?: number;
  scoutDocs?: number;
  scoutRiskNotes?: number;
  subagents: SubagentTask[];
  subagentsExpanded: boolean;
  selectedSubagentId?: string;
  recentRuntimeEvents: RuntimeEvent[];
  motionEnabled: boolean;
  /** HIVE safety mode. Distinct from the panel `mode` above. */
  sessionMode: HiveMode;
  sessionId?: string;
  editsApproved: boolean;
  pendingPermission?: PermissionDecision;
  permissionPrompt?: string;
  /** Highlighted selector option while a permission is pending: 0 allows, 1 declines. */
  permissionChoice?: number;
  /** ASCII drawing characters instead of Unicode box and bullet glyphs. */
  asciiGlyphs?: boolean;
  /** When the current turn started running. Drives the working line's elapsed time. */
  turnStartedAt?: number;
  /** Light terminal background: the renderer switches to its light palette. */
  lightTheme?: boolean;
  /** When the pending permission opened. The selector border pulses briefly after it. */
  permissionAskedAt?: number;
  /** Open slash or file picker. Absent when the composer is plain text. */
  picker?: ComposerPicker;
  /** Assistant prose that has arrived but is not yet committed to the transcript. */
  liveText?: string;
  /** Drafts submitted while a turn is running. They start, in order, when it finishes. */
  messageQueue: string[];
  /** Tool-card index. Absent follows the latest card. */
  toolCardFocus?: number;
  /** Workspace directory basename. Absent until the session knows its directory. */
  workspaceName?: string;
  /** Current branch from `git rev-parse --abbrev-ref HEAD`. Absent when that command fails. */
  gitBranch?: string;
  /** Runtime command IDs point to the tool card that owns their output. */
  commandCardIds?: Record<string, string>;
  conversation?: CliConversation;
  contextChars?: number;
  /** Transient server input. Never project this request or its answer into conversation records. */
  mcpInput?: { request: McpUserInputRequest; scrollOffset: number; error?: string };
}

const RECENT_RUNTIME_EVENT_LIMIT = 100;

const SUBAGENT_EVENT_STATUS: Record<string, SubagentTask["status"]> = {
  "subagent.created": "created",
  "subagent.queued": "queued",
  "subagent.started": "working",
  "subagent.status_changed": "working",
  "subagent.progress": "working",
  "subagent.tool_call": "working",
  "subagent.tool_result": "working",
  "subagent.file_changed": "working",
  "subagent.blocked": "blocked",
  "subagent.retrying": "retrying",
  "subagent.validating": "validating",
  "subagent.completed": "completed",
  "subagent.failed": "failed",
  "subagent.cancelled": "cancelled",
  "subagent.skipped": "skipped",
  "task.created": "created",
  "task.ready": "queued",
  "task.started": "working",
  "task.progress": "working",
  "task.blocked": "blocked",
  "task.retrying": "retrying",
  "task.completed": "completed",
  "task.failed": "failed",
  "task.cancelled": "cancelled",
  "task.skipped": "skipped",
  "validation.started": "validating",
};

function environmentFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

function isSubagentStatus(value: unknown): value is SubagentTask["status"] {
  return (
    value === "created" ||
    value === "queued" ||
    value === "waiting_for_dependencies" ||
    value === "starting" ||
    value === "working" ||
    value === "blocked" ||
    value === "retrying" ||
    value === "validating" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "skipped"
  );
}

function isTaskLike(value: unknown): value is SubagentTask {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SubagentTask>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.title === "string" &&
    isSubagentStatus(candidate.status) &&
    typeof candidate.providerId === "string" &&
    Array.isArray(candidate.fileScope) &&
    typeof candidate.createdAt === "string"
  );
}

function eventTimestamp(event: RuntimeEvent): string | undefined {
  const value = (event as unknown as { timestamp?: unknown }).timestamp;
  return typeof value === "string" ? value : undefined;
}

function eventTask(event: RuntimeEvent): SubagentTask | undefined {
  const payload = event.payload as unknown as Record<string, unknown>;
  if (isTaskLike(payload.task)) return payload.task;
  if (isTaskLike(payload.subagent)) return payload.subagent;
  if (isTaskLike(payload)) return payload;
  return undefined;
}

function structuredTaskPatch(event: RuntimeEvent): Partial<SubagentTask> {
  const payload = event.payload as unknown as Record<string, unknown>;
  const patch: Partial<SubagentTask> = {};
  const status = isSubagentStatus(payload.status)
    ? payload.status
    : SUBAGENT_EVENT_STATUS[event.type];
  if (status) patch.status = status;
  if (typeof payload.title === "string") patch.title = payload.title;
  if (typeof payload.summary === "string") patch.summary = payload.summary;
  if (typeof payload.error === "string") patch.error = payload.error;
  if (typeof payload.providerId === "string") patch.providerId = payload.providerId;
  if (typeof payload.model === "string") patch.model = payload.model;
  if (Array.isArray(payload.fileScope) && payload.fileScope.every((entry) => typeof entry === "string")) {
    patch.fileScope = payload.fileScope as string[];
  }
  if (payload.tokenUsage && typeof payload.tokenUsage === "object") {
    patch.tokenUsage = payload.tokenUsage as SubagentTask["tokenUsage"];
  }

  const timestamp = eventTimestamp(event);
  if (typeof payload.startedAt === "string") patch.startedAt = payload.startedAt;
  else if (timestamp && (status === "starting" || status === "working") && !payload.completedAt) {
    patch.startedAt = timestamp;
  }
  if (typeof payload.completedAt === "string") patch.completedAt = payload.completedAt;
  else if (timestamp && (status === "completed" || status === "failed" || status === "cancelled" || status === "skipped")) {
    patch.completedAt = timestamp;
  }
  return patch;
}

function runtimeEventSubagentId(event: RuntimeEvent): string | undefined {
  const topLevel = (event as unknown as { subagentId?: unknown }).subagentId;
  if (typeof topLevel === "string") return topLevel;
  const payload = event.payload as unknown as Record<string, unknown>;
  if (typeof payload.subagentId === "string") return payload.subagentId;
  return typeof payload.taskId === "string" ? payload.taskId : undefined;
}

export function initialState(): TuiState {
  const cols =
    process.stdout.columns && process.stdout.columns > 0
      ? process.stdout.columns
      : 80;
  const rows =
    process.stdout.rows && process.stdout.rows > 0
      ? process.stdout.rows
      : 24;

  const colorEnabled =
    !process.argv.includes("--no-color") &&
    process.env.NO_COLOR === undefined;

  const motionEnabled =
    colorEnabled &&
    process.stdout.isTTY === true &&
    !environmentFlagEnabled(process.env.CI) &&
    (process.env.TERM ?? "").toLowerCase() !== "dumb" &&
    !process.argv.includes("--no-animation") &&
    !process.argv.includes("--no-motion");

  return {
    mode: "default",
    provider: "none",
    model: "none",
    agents: 0,
    contextPercent: 0,
    input: "",
    cursor: 0,
    history: [],
    historyIndex: -1,
    outputLines: ["  Session ready. Type a task, or /help."],
    selectedPanel: "main",
    width: cols,
    height: rows,
    colorEnabled,
    asciiGlyphs: prefersAsciiGlyphs(),
    lightTheme: themeFromEnvironment() === "light",
    running: false,
    taskStatus: "idle",
    transcript: [],
    scrollOffset: 0,
    scoutSignals: 0,
    scoutDocs: 0,
    scoutRiskNotes: 0,
    subagents: [],
    subagentsExpanded: false,
    recentRuntimeEvents: [],
    motionEnabled,
    sessionMode: "guarded",
    editsApproved: false,
    messageQueue: [],
  };
}

function reflowScroll(before: TuiState, after: TuiState): TuiState {
  const beforeCount = renderTranscriptBody(before, sessionFrameWidth(before.width)).length;
  const afterCount = renderTranscriptBody(after, sessionFrameWidth(after.width)).length;
  return {
    ...after,
    scrollOffset: scrollOffsetAfterGrowth(
      before.scrollOffset,
      beforeCount,
      afterCount,
      transcriptViewportRows(after),
    ),
  };
}

export function withOutput(
  state: TuiState,
  lines: string[]
): TuiState {
  const outputLines = [...state.outputLines, ...lines].slice(-200);
  const transcript = [...state.transcript, ...lines].slice(-1000);
  return reflowScroll(state, { ...state, outputLines, transcript });
}

export function withInput(state: TuiState, input: string, cursor = input.length): TuiState {
  const next = Number.isFinite(cursor) ? Math.floor(cursor) : input.length;
  return { ...state, input, cursor: Math.max(0, Math.min(input.length, next)) };
}

/** Replace transcript entries without clearing permission, live text, or the pin. */
export function replaceTranscript(state: TuiState, transcript: readonly string[]): TuiState {
  const lines = [...transcript].slice(-1000);
  return reflowScroll(state, { ...state, transcript: lines });
}

export function withHistory(
  state: TuiState,
  entry: string
): TuiState {
  const history = [entry, ...state.history].slice(0, 100);
  return { ...state, history, historyIndex: -1 };
}

export function withSize(
  state: TuiState,
  width: number,
  height: number
): TuiState {
  return reflowScroll(state, { ...state, width, height });
}

export function withRunning(
  state: TuiState,
  running: boolean
): TuiState {
  return { ...state, running };
}

export function withMode(state: TuiState, mode: TuiMode): TuiState {
  return { ...state, mode };
}

export function withProvider(
  state: TuiState,
  provider: string,
  model: string
): TuiState {
  return { ...state, provider, model };
}

export function withClear(state: TuiState): TuiState {
  return {
    ...state,
    outputLines: ["  Output cleared."],
    transcript: [],
    scrollOffset: 0,
    selectedPanel: "main",
    pendingPermission: undefined,
    permissionPrompt: undefined,
    picker: undefined,
    liveText: undefined,
    messageQueue: [],
    toolCardFocus: undefined,
    commandCardIds: {},
  };
}

export function withSessionMode(state: TuiState, sessionMode: HiveMode): TuiState {
  return {
    ...state,
    sessionMode,
    editsApproved: false,
    pendingPermission: undefined,
    permissionPrompt: undefined,
  };
}

export function withSessionId(state: TuiState, sessionId: string): TuiState {
  return { ...state, sessionId };
}

export function withEditsApproved(state: TuiState, editsApproved: boolean): TuiState {
  return { ...state, editsApproved };
}

export function withPicker(state: TuiState, picker: ComposerPicker | undefined): TuiState {
  return { ...state, picker };
}

export function withLiveText(state: TuiState, text: string | undefined): TuiState {
  let next: TuiState;
  if (!text?.trim()) {
    next = state.liveText ? { ...state, liveText: undefined } : state;
  } else {
    const clean = redactStreamingText(text);
    if (!clean.trim() || clean.trim() === "[REDACTED]") next = { ...state, liveText: undefined };
    else if (clean === state.liveText) return state;
    else next = { ...state, liveText: clean };
  }
  if (next === state) return state;
  return reflowScroll(state, next);
}

export function commitLiveText(state: TuiState): TuiState {
  const text = state.liveText;
  if (!text?.trim()) {
    return state.liveText ? reflowScroll(state, { ...state, liveText: undefined }) : state;
  }
  const cleared: TuiState = { ...state, liveText: undefined };
  if (cleared.transcript[cleared.transcript.length - 1] === text) return reflowScroll(state, cleared);
  const transcript = [...cleared.transcript, text].slice(-1000);
  return reflowScroll(state, { ...cleared, transcript });
}

export function withTranscript(state: TuiState, transcript: readonly string[]): TuiState {
  const lines = [...transcript];
  return {
    ...state,
    transcript: lines,
    outputLines: lines.slice(-200),
    liveText: undefined,
    picker: undefined,
    pendingPermission: undefined,
    permissionPrompt: undefined,
    scrollOffset: 0,
    commandCardIds: {},
  };
}

export function withPendingPermission(
  state: TuiState,
  decision: PermissionDecision | undefined,
): TuiState {
  return {
    ...state,
    pendingPermission: decision,
    permissionPrompt: decision ? permissionPromptText(decision) : undefined,
    permissionChoice: 0,
    permissionAskedAt: decision ? Date.now() : undefined,
  };
}

/**
 * HIVE_THEME=light|dark wins. Otherwise COLORFGBG ("fg;bg", set by rxvt,
 * Konsole and others) names a light background as 7 or 15. Undefined means
 * unknown; the app then asks the terminal for its background color.
 */
export function themeFromEnvironment(env: NodeJS.ProcessEnv = process.env): "light" | "dark" | undefined {
  const forced = (env.HIVE_THEME ?? "").toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  const background = (env.COLORFGBG ?? "").split(";").pop();
  if (!background || !/^\d+$/.test(background)) return undefined;
  return background === "7" || background === "15" ? "light" : "dark";
}

/** Parses an OSC 11 reply ("rgb:RRRR/GGGG/BBBB") into light or dark by perceived luminance. */
export function themeFromBackgroundReply(reply: string): "light" | "dark" | undefined {
  const match = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return undefined;
  const [r, g, b] = match.slice(1, 4).map((hex) => parseInt(hex, 16) / (16 ** hex.length - 1));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}

export function withLightTheme(state: TuiState, lightTheme: boolean): TuiState {
  return { ...state, lightTheme };
}

export function appendTranscriptLine(state: TuiState, line: string): TuiState {
  const MAX_LINES = 1000;
  const transcript = [...state.transcript, line].slice(-MAX_LINES);
  return reflowScroll(state, { ...state, transcript });
}

const ACTIVE_STATUSES: ReadonlySet<TuiState["taskStatus"]> = new Set(["running", "verifying"]);

export function setTaskStatus(state: TuiState, status: TuiState["taskStatus"]): TuiState {
  const active = ACTIVE_STATUSES.has(status);
  const turnStartedAt = active ? (ACTIVE_STATUSES.has(state.taskStatus) ? state.turnStartedAt : undefined) ?? Date.now() : undefined;
  return { ...state, taskStatus: status, turnStartedAt };
}

export function setRuntimeInfo(state: TuiState, activeTask?: string, provider?: string, model?: string): TuiState {
  return { 
    ...state, 
    activeTask: activeTask !== undefined ? activeTask : state.activeTask,
    selectedProvider: provider !== undefined ? provider : state.selectedProvider,
    selectedModel: model !== undefined ? model : state.selectedModel
  };
}

export function clearTranscript(state: TuiState): TuiState {
  return {
    ...state,
    transcript: [],
    scrollOffset: 0,
    liveText: undefined,
    picker: undefined,
    toolCardFocus: undefined,
    commandCardIds: {},
  };
}

export function withMessageQueue(state: TuiState, messageQueue: readonly string[]): TuiState {
  return { ...state, messageQueue: [...messageQueue] };
}

export function trimTranscript(state: TuiState, maxLines: number): TuiState {
  if (state.transcript.length <= maxLines) return state;
  return reflowScroll(state, { ...state, transcript: state.transcript.slice(-maxLines) });
}

export function withScoutInfo(state: TuiState, signals: number, docs: number, riskNotes: number): TuiState {
  return { ...state, scoutSignals: signals, scoutDocs: docs, scoutRiskNotes: riskNotes };
}

export function withSubagentsExpanded(state: TuiState, expanded: boolean): TuiState {
  return { ...state, subagentsExpanded: expanded };
}

export function withSelectedSubagent(state: TuiState, selectedSubagentId?: string): TuiState {
  return {
    ...state,
    selectedSubagentId:
      selectedSubagentId && state.subagents.some((task) => task.id === selectedSubagentId)
        ? selectedSubagentId
        : undefined,
  };
}

export function withMotionEnabled(state: TuiState, motionEnabled: boolean): TuiState {
  return { ...state, motionEnabled };
}

/**
 * Project one structured runtime event into TUI state. The reducer only reads
 * typed event fields and payload values; it never infers state from log text.
 */
export function reduceTuiRuntimeEvent(state: TuiState, event: RuntimeEvent): TuiState {
  const suppliedTask = eventTask(event);
  const patch = structuredTaskPatch(event);
  const currentSubagents = state.subagents ?? [];
  const subagentId = runtimeEventSubagentId(event) ?? suppliedTask?.id;
  const taskIndex = subagentId
    ? currentSubagents.findIndex((task) => task.id === subagentId)
    : -1;
  let subagents = currentSubagents;

  if (taskIndex >= 0) {
    const current = currentSubagents[taskIndex];
    const nextTask: SubagentTask = {
      ...current,
      ...(suppliedTask ?? {}),
      ...patch,
      startedAt: current.startedAt ?? suppliedTask?.startedAt ?? patch.startedAt,
    };
    subagents = currentSubagents.map((task, index) => index === taskIndex ? nextTask : task);
  } else if (suppliedTask) {
    subagents = [...currentSubagents, { ...suppliedTask, ...patch }];
  }

  const recentRuntimeEvents = [...(state.recentRuntimeEvents ?? []), event].slice(-RECENT_RUNTIME_EVENT_LIMIT);
  const activeCount = aggregateSubagentCounts(subagents).active;
  const timestamp = eventTimestamp(event);
  const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  const selectedSubagentId = state.selectedSubagentId ?? suppliedTask?.id;

  return {
    ...state,
    subagents,
    recentRuntimeEvents,
    agents: activeCount,
    selectedSubagentId,
    updatedAt: Number.isFinite(timestampMs) ? timestampMs : state.updatedAt,
  };
}

export const reduceRuntimeEvent = reduceTuiRuntimeEvent;
export const applyRuntimeEvent = reduceTuiRuntimeEvent;
