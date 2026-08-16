import type { CodingFinalReport, RuntimeEvent } from "../../../src/coding/types";
import type {
  DesktopChangesDiff, DesktopChatConversation, DesktopChatSummary, DesktopEvent, DesktopProviderMetadata, DesktopRecentRepository,
  GuardedGitActionPreview, GuardedGitStatus, ThreadRecordV1, ThreadRunRef,
} from "../../../src/desktop/types";
import type { ChatReceipt } from "../../../src/chat/types";

export type CenterTab = "conversation" | "changes" | "report";
export type DesktopMode = "chat" | "coder";
export type DesktopUiAction =
  | { type: "ui.tab"; tab: CenterTab }
  | { type: "ui.dismiss-error" }
  | { type: "ui.close-preview" }
  | { type: "ui.repository-opening" }
  | { type: "ui.rails"; side: "left" | "right" }
  | { type: "ui.rails.set"; rails: { left: boolean; right: boolean } }
  | { type: "ui.mode"; mode: DesktopMode };
export type WorkerState = "idle" | "starting" | "running" | "stopped" | "failed";

/** Resolved provider route for a chat role, for trust chips and pickers. */
export interface ChatRouteInfo {
  providerId: string;
  model: string;
  source: string;
  degraded: boolean;
}

/** One council (hivebot) stage event rendered inside a conversation. */
export interface CouncilStage {
  type: "stage-started" | "stage-completed";
  agent: string;
  attempt: number;
  receipt?: ChatReceipt;
  output?: string;
}

export interface DesktopChatState {
  conversations: DesktopChatSummary[];
  activeId: string | null;
  active: DesktopChatConversation | null;
  /** In-flight assistant text per conversation; chunks append only when turnId matches. */
  streaming: Record<string, { turnId: string; text: string } | undefined>;
  routes: Record<string, ChatRouteInfo>;
  councilByConv: Record<string, CouncilStage[]>;
}

export function initialChatState(): DesktopChatState {
  return { conversations: [], activeId: null, active: null, streaming: {}, routes: {}, councilByConv: {} };
}

export interface DesktopViewState {
  repositoryRoot: string | null;
  repositories: DesktopRecentRepository[];
  threads: ThreadRecordV1[];
  activeThreadId: string | null;
  selectedSessionId: string | null;
  tab: CenterTab;
  mode: DesktopMode;
  chat: DesktopChatState;
  providers: DesktopProviderMetadata[];
  selectedProviderId: string;
  runtimeEvents: RuntimeEvent[];
  run: ThreadRunRef | null;
  pausingSessionId: string | null;
  pausingRequestId: string | null;
  worker: WorkerState;
  gitStatus: GuardedGitStatus | null;
  diff: DesktopChangesDiff | null;
  reports: Record<string, CodingFinalReport | null>;
  preview: GuardedGitActionPreview | null;
  rails: { left: boolean; right: boolean };
  error: string | null;
  notice: string | null;
}

export function initialDesktopState(): DesktopViewState {
  return {
    repositoryRoot: null,
    repositories: [],
    threads: [],
    activeThreadId: null,
    selectedSessionId: null,
    tab: "conversation",
    mode: "coder",
    chat: initialChatState(),
    providers: [],
    selectedProviderId: "",
    runtimeEvents: [],
    run: null,
    pausingSessionId: null,
    pausingRequestId: null,
    worker: "idle",
    gitStatus: null,
    diff: null,
    reports: {},
    preview: null,
    rails: { left: true, right: true },
    error: null,
    notice: null,
  };
}

export function reduceDesktopEvent(state: DesktopViewState, event: DesktopEvent | DesktopUiAction): DesktopViewState {
  switch (event.type) {
    case "ui.tab": return { ...state, tab: event.tab, notice: null };
    case "ui.dismiss-error": return { ...state, error: null };
    case "ui.close-preview": return { ...state, preview: null };
    case "ui.rails": return { ...state, rails: { ...state.rails, [event.side]: !state.rails[event.side] } };
    case "ui.rails.set": return { ...state, rails: event.rails };
    case "ui.mode": return { ...state, mode: event.mode };
    case "ui.repository-opening": return { ...state, repositoryRoot: null, threads: [], activeThreadId: null, selectedSessionId: null, runtimeEvents: [], run: null, pausingSessionId: null, pausingRequestId: null, worker: "idle", gitStatus: null, diff: null, reports: {}, preview: null, chat: initialChatState(), error: null, notice: null };
    case "request.failed": {
      const failedPause = Boolean(state.pausingRequestId && event.requestId === state.pausingRequestId);
      return { ...state, pausingSessionId: failedPause ? null : state.pausingSessionId, pausingRequestId: failedPause ? null : state.pausingRequestId, error: event.message, notice: null };
    }
    case "request.completed": return { ...state, notice: "Command completed.", error: null };
    case "repository.listed": return { ...state, repositories: event.repositories, error: null };
    case "desktop.ready": return { ...state, repositoryRoot: event.repositoryRoot, activeThreadId: null, selectedSessionId: null, threads: [], runtimeEvents: [], run: null, pausingSessionId: null, pausingRequestId: null, worker: "idle", gitStatus: null, diff: null, reports: {}, preview: null, chat: initialChatState(), error: null, notice: null };
    case "thread.listed": return { ...state, threads: [...event.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), error: null };
    case "thread.changed": {
      const threads = [event.thread, ...state.threads.filter((thread) => thread.id !== event.thread.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const run = latestRun(event.thread);
      const sessionId = run?.codingSessionId ?? null;
      const changed = state.activeThreadId !== event.thread.id || state.selectedSessionId !== sessionId;
      return { ...state, threads, activeThreadId: event.thread.id, selectedSessionId: sessionId, run, pausingSessionId: changed ? null : state.pausingSessionId, pausingRequestId: changed ? null : state.pausingRequestId, runtimeEvents: changed ? [] : state.runtimeEvents, diff: changed ? null : state.diff, reports: changed ? {} : state.reports, worker: changed ? "idle" : state.worker, error: null, notice: null };
    }
    case "run.changed": {
      const owner = state.threads.find((thread) => thread.messages.some((message) => message.id === event.run.userMessageId) || thread.runs.some((run) => run.codingSessionId === event.run.codingSessionId));
      if (!owner) return state;
      const threads = state.threads.map((thread) => {
        if (thread.id !== owner.id) return thread;
        const exists = thread.runs.some((run) => run.codingSessionId === event.run.codingSessionId);
        return { ...thread, runs: exists ? thread.runs.map((run) => run.codingSessionId === event.run.codingSessionId ? event.run : run) : [...thread.runs, event.run], updatedAt: event.run.updatedAt };
      });
      if (owner.id !== state.activeThreadId) return { ...state, threads };
      const changed = state.selectedSessionId !== event.run.codingSessionId;
      const pauseSettled = event.run.codingSessionId === state.pausingSessionId && (event.run.status === "paused" || ["completed", "failed", "cancelled"].includes(event.run.status));
      return { ...state, threads, run: event.run, selectedSessionId: event.run.codingSessionId, pausingSessionId: changed || pauseSettled ? null : state.pausingSessionId, pausingRequestId: changed || pauseSettled ? null : state.pausingRequestId, runtimeEvents: changed ? [] : state.runtimeEvents, diff: changed ? null : state.diff, reports: changed ? {} : state.reports, error: null, notice: null };
    }
    case "run.pause-requested": if (state.selectedSessionId !== event.codingSessionId) return state; return { ...state, pausingSessionId: event.codingSessionId, pausingRequestId: event.requestId ?? null, notice: "Pause requested. Waiting for a safe boundary.", error: null };
    case "run.reported": if (state.selectedSessionId !== event.codingSessionId) return state; return { ...state, reports: { [event.codingSessionId]: event.report }, error: null };
    case "runtime.event": {
      if (!state.selectedSessionId || event.event.sessionId !== state.selectedSessionId) return state;
      const runtimeEvents = [...state.runtimeEvents.filter((item) => item.id !== event.event.id), event.event].sort((a, b) => a.sequence - b.sequence);
      return { ...state, runtimeEvents, error: null };
    }
    case "worker.starting": if (!state.selectedSessionId || event.codingSessionId !== state.selectedSessionId) return state; return { ...state, worker: "starting", error: null };
    case "worker.started": if (!state.selectedSessionId || event.codingSessionId !== state.selectedSessionId) return state; return { ...state, worker: "running", error: null };
    case "worker.stopped": if (!state.selectedSessionId || event.codingSessionId !== state.selectedSessionId) return state; return { ...state, worker: "stopped" };
    case "worker.failed": {
      if (event.codingSessionId) {
        if (!state.selectedSessionId || event.codingSessionId !== state.selectedSessionId) return state;
        const failedPause = event.codingSessionId === state.pausingSessionId;
        return { ...state, worker: "failed", pausingSessionId: failedPause ? null : state.pausingSessionId, pausingRequestId: failedPause ? null : state.pausingRequestId, error: event.message };
      }
      return { ...state, error: event.message };
    }
    case "provider.listed": return { ...state, providers: event.providers, selectedProviderId: state.selectedProviderId || event.providers.find((provider) => provider.configured)?.id || "", error: null };
    case "provider.changed": return { ...state, providers: [event.provider, ...state.providers.filter((provider) => provider.id !== event.provider.id)], selectedProviderId: event.provider.id, error: null };
    case "git.changed": return { ...state, gitStatus: event.status, error: null };
    case "changes.diffed": if (state.selectedSessionId !== event.diff.codingSessionId) return state; return { ...state, diff: event.diff, error: null };
    case "git.previewed": return { ...state, preview: event.preview, error: null };
    case "git.action-completed": return { ...state, preview: null, notice: event.summary ?? `${event.action} completed.`, error: null };
    case "credential.tested": return { ...state, notice: event.result.message, error: event.result.ok ? null : event.result.message };
    case "credential.changed": return { ...state, notice: event.credential.configured ? "Credential encrypted and stored." : "Credential removed.", error: null };
    case "credential.listed": return state;
    case "chat.listed": return { ...state, chat: { ...state.chat, conversations: event.conversations }, error: null };
    case "chat.changed": return { ...state, chat: { ...state.chat, active: event.conversation, activeId: event.conversation.id }, error: null };
    case "chat.started": return { ...state, chat: { ...state.chat, streaming: { ...state.chat.streaming, [event.conversationId]: { turnId: event.turnId, text: "" } } }, error: null };
    case "chat.chunk": {
      const stream = state.chat.streaming[event.conversationId];
      if (!stream || stream.turnId !== event.turnId) return state;
      return { ...state, chat: { ...state.chat, streaming: { ...state.chat.streaming, [event.conversationId]: { ...stream, text: stream.text + event.chunk } } } };
    }
    case "chat.completed": {
      const { [event.conversationId]: _cleared, ...streaming } = state.chat.streaming;
      return { ...state, chat: { ...state.chat, streaming }, error: null };
    }
    case "chat.failed": {
      const { [event.conversationId]: _cleared, ...streaming } = state.chat.streaming;
      return { ...state, chat: { ...state.chat, streaming }, error: event.message };
    }
    case "chat.route.resolved": return { ...state, chat: { ...state.chat, routes: { ...state.chat.routes, [event.role]: { providerId: event.providerId, model: event.model, source: event.source, degraded: event.degraded } } } };
  }
}

export function latestRun(thread: ThreadRecordV1 | undefined): ThreadRunRef | null {
  return thread?.runs.length ? thread.runs[thread.runs.length - 1] : null;
}
