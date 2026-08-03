/**
 * state.ts
 * TuiState type, initial state factory, and pure update helpers.
 */

import {
  aggregateSubagentCounts,
  type RuntimeEvent,
  type SubagentTask,
} from "../coding/types.js";

export type TuiMode =
  | "default"
  | "swarm"
  | "providers"
  | "running"
  | "error";

export interface TuiState {
  mode: TuiMode;
  provider: string;
  model: string;
  agents: number;
  contextPercent: number;
  input: string;
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
}

const RECENT_RUNTIME_EVENT_LIMIT = 100;

const SUBAGENT_EVENT_STATUS: Record<string, SubagentTask["status"]> = {
  "subagent.created": "created",
  "subagent.queued": "queued",
  "subagent.started": "working",
  "subagent.status_changed": "working",
  "subagent.progress": "working",
  "subagent.tool_call": "working",
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
    history: [],
    historyIndex: -1,
    outputLines: ["  Ready when you are. Type /help for commands."],
    selectedPanel: "main",
    width: cols,
    height: rows,
    colorEnabled,
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
  };
}

export function withOutput(
  state: TuiState,
  lines: string[]
): TuiState {
  const MAX_LINES = 200;
  const next = [...state.outputLines, ...lines].slice(-MAX_LINES);
  return { ...state, outputLines: next };
}

export function withInput(state: TuiState, input: string): TuiState {
  return { ...state, input };
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
  return { ...state, width, height };
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
    selectedPanel: "main",
  };
}

export function appendTranscriptLine(state: TuiState, line: string): TuiState {
  const MAX_LINES = 1000;
  const transcript = [...state.transcript, line].slice(-MAX_LINES);
  return { ...state, transcript };
}

export function setTaskStatus(state: TuiState, status: TuiState["taskStatus"]): TuiState {
  return { ...state, taskStatus: status };
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
  return { ...state, transcript: [], scrollOffset: 0 };
}

export function trimTranscript(state: TuiState, maxLines: number): TuiState {
  if (state.transcript.length <= maxLines) return state;
  return { ...state, transcript: state.transcript.slice(-maxLines) };
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
