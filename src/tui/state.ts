/**
 * state.ts
 * TuiState type, initial state factory, and pure update helpers.
 */

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
    !(
      process.env.NO_COLOR !== undefined &&
      process.env.NO_COLOR !== ""
    );

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
