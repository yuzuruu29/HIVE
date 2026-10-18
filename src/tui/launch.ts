import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ConfigStore, type HiveMode } from "../config.js";
import { formatRuntimeEventText } from "../coding/output.js";
import { isCredentialFieldName, redactKnownSecrets, redactStreamingText } from "../security/secrets.js";
import { isCI, shouldSuppressBranding } from "../ui/terminal.js";
import { executeTuiCommand, parseTuiCommand, type TuiCommand } from "./commands.js";
import { initialState, withHistory, type TuiState } from "./state.js";
import type { TuiRuntimeHandle, TuiSessionRunner } from "./runtime-adapter.js";

export interface TuiLaunchOptions {
  cwd?: string;
  stream?: (line: string) => void;
  signal?: AbortSignal;
  tuiSessionRunner?: TuiSessionRunner;
  readStdin?: (signal?: AbortSignal) => Promise<string>;
  startTui?: (cwd: string, options: { initialCommands?: string[]; initialMode?: "plan" | "review" }) => Promise<void>;
  isTTY?: boolean;
}

type OutputFormat = "plain" | "json" | "streaming-json";
type Launch = {
  print: boolean;
  format: OutputFormat;
  explicitFormat: boolean;
  cwd?: string;
  resume?: string;
  continue: boolean;
  fork: boolean;
  model?: string;
  images: string[];
  mode?: "plan" | "review";
  prompt: string;
};

const STDIN_LIMIT = 20_000;
const RESERVED = new Set([
  "help", "tui", "code", "run", "status", "diff", "approve", "reject", "discard", "push", "pr",
  "providers", "sessions", "resume", "agents", "report", "mode", "chat", "hivebot", "scout",
  "mcp", "skills", "plugins", "hooks", "lsp",
]);
const LAUNCH_FLAGS = new Set([
  "-p", "--print", "-r", "--resume", "-c", "--continue", "-m", "--model", "--image", "--cwd",
  "--plan", "--review", "--json", "--output-format", "--",
  "--fork-session",
]);

function parseLaunch(args: readonly string[]): Launch {
  const launch: Launch = { print: false, format: "plain", explicitFormat: false, continue: false, fork: false, images: [], prompt: "" };
  const prompt: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") { prompt.push(...args.slice(index + 1)); break; }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    const value = () => {
      const next = inline ?? args[++index];
      if (!next || next.startsWith("-") || /[\x00-\x1f\x7f]/.test(next)) throw new Error(`${flag} requires a value.`);
      return next;
    };
    const booleanFlag = () => {
      if (inline !== undefined) throw new Error(`${flag} does not accept a value.`);
    };
    switch (flag) {
      case "-p": case "--print":
        launch.print = true;
        if (inline !== undefined) prompt.push(inline);
        break;
      case "-r": case "--resume": launch.resume = value(); break;
      case "-c": case "--continue": booleanFlag(); launch.continue = true; break;
      case "--fork-session": booleanFlag(); launch.fork = true; break;
      case "-m": case "--model": launch.model = value(); break;
      case "--image": launch.images.push(value()); break;
      case "--cwd": launch.cwd = value(); break;
      case "--plan": case "--review": {
        booleanFlag();
        const mode = flag === "--plan" ? "plan" : "review";
        if (launch.mode && launch.mode !== mode) throw new Error("Choose either --plan or --review.");
        launch.mode = mode;
        break;
      }
      case "--json": case "--output-format": {
        if (flag === "--json") booleanFlag();
        const format = flag === "--json" ? "json" : value();
        if (format !== "plain" && format !== "json" && format !== "streaming-json") throw new Error("Output format must be plain, json, or streaming-json.");
        if (launch.explicitFormat && launch.format !== format) throw new Error("Choose one output format.");
        launch.format = format;
        launch.explicitFormat = true;
        break;
      }
      default:
        if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown session option: ${flag}`);
        prompt.push(arg);
    }
  }
  if (launch.resume && launch.continue) throw new Error("Choose either --resume or --continue.");
  if (launch.fork && !launch.resume && !launch.continue) throw new Error("--fork-session requires --resume <id> or --continue.");
  launch.prompt = prompt.join(" ").trim();
  return launch;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Session cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

/** stdin is consumed only for an explicit '-' prompt, never from TTY detection. */
async function readPromptStdin(signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  if (process.stdin.readableEnded) return "";
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let text = "";
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      process.stdin.pause();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => { const error = new Error("Session cancelled."); error.name = "AbortError"; onError(error); };
    const onData = (chunk: Buffer | string) => {
      text += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text.length > STDIN_LIMIT) onError(new Error(`stdin prompt exceeds ${STDIN_LIMIT.toLocaleString("en-US")} characters.`));
    };
    const onEnd = () => {
      text += decoder.end();
      cleanup();
      if (text.length > STDIN_LIMIT) reject(new Error(`stdin prompt exceeds ${STDIN_LIMIT.toLocaleString("en-US")} characters.`));
      else resolve(text);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    process.stdin.resume();
  });
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => isCredentialFieldName(key)
    ? "[REDACTED]"
    : typeof item === "string" ? redactStreamingText(item) : item) ?? "null";
}

function setupCommands(launch: Launch): string[] {
  return [
    ...(launch.resume ? [`/resume ${launch.resume}`] : launch.continue ? ["/continue"] : []),
    ...(launch.fork ? ["/fork"] : []),
    ...(launch.model ? [`/model ${launch.model}`] : []),
    ...launch.images.map((file) => `/image ${file}`),
  ];
}

async function headless(launch: Launch, cwd: string, options: TuiLaunchOptions): Promise<{ exitCode: number; output: string }> {
  const configuredMode: HiveMode = await new ConfigStore(cwd).getMode();
  let state: TuiState = { ...initialState(), colorEnabled: false, motionEnabled: false, sessionMode: launch.mode ?? configuredMode };
  const streamed: string[] = [];
  const seenEvents = new Set<string>();
  let latestText = "";
  let runtime: TuiRuntimeHandle | undefined;
  let wasCancelled = false;
  let assistantStart = 0;
  let transcriptStart = 0;
  const emit = (line: string) => {
    if (options.stream) options.stream(line);
    else streamed.push(line);
  };
  const update = (updater: (current: TuiState) => TuiState) => {
    state = updater(state);
    for (const event of state.recentRuntimeEvents) {
      const identity = `${event.sessionId}:${event.id}`;
      if (seenEvents.has(identity)) continue;
      seenEvents.add(identity);
      if (launch.format === "streaming-json") emit(safeJson(event));
      else if (launch.format === "plain" && options.stream) emit(redactStreamingText(formatRuntimeEventText(event)));
      if (event.type === "session.cancelled") wasCancelled = true;
    }
    if (state.liveText && state.liveText !== latestText) {
      latestText = state.liveText;
      if (launch.format === "streaming-json") emit(safeJson({ type: "assistant.text", text: latestText, cumulative: true }));
    }
  };
  const onAbort = () => { wasCancelled = true; runtime?.cancel("Session cancelled."); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const commands: TuiCommand[] = setupCommands(launch).map(parseTuiCommand);
    if (launch.mode === "review") commands.push({ kind: "review", args: launch.prompt, raw: launch.prompt || "/review" });
    else commands.push({ kind: "task", args: launch.prompt, raw: launch.prompt });
    for (const command of commands) {
      cancelled(options.signal);
      if (launch.mode) state = { ...state, sessionMode: launch.mode };
      if (command.kind === "task" || command.kind === "review") {
        if (state.pendingPermission) break;
        assistantStart = state.conversation?.messages.length ?? 0;
        transcriptStart = state.transcript.length;
        state = withHistory(state, command.raw);
      }
      const result = await executeTuiCommand(command, state, cwd, update, {
        runSession: options.tuiSessionRunner,
        persistSession: true,
      });
      state = result.state;
      if ((command.kind === "resume" || command.kind === "continue") && !state.conversation) throw new Error("No saved CLI conversation to continue.");
      runtime = result.runtime;
      if (options.signal?.aborted) onAbort();
      await runtime?.completion;
      runtime = undefined;
      if (wasCancelled || state.taskStatus === "error" || state.pendingPermission || state.conversation?.codingStatus === "paused") break;
    }
    const status = wasCancelled || options.signal?.aborted || state.conversation?.codingStatus === "cancelled" ? "cancelled"
      : state.taskStatus === "error" || state.conversation?.codingStatus === "failed" ? "failed"
      : state.pendingPermission || state.conversation?.codingStatus === "paused" ? "paused" : "completed";
    const exitCode = status === "cancelled" ? 130 : status === "paused" ? 2 : status === "failed" ? 1 : 0;
    const assistant = state.conversation?.messages.slice(assistantStart).filter((message) => message.role === "assistant").at(-1)?.content;
    const error = state.transcript.slice(transcriptStart).filter((line) => line.startsWith("[Error]")).at(-1);
    const detail = [assistant || latestText, error,
      status === "paused" ? "Session paused for approval. Resume in an interactive terminal." : status === "cancelled" ? "Session cancelled." : undefined,
    ].filter(Boolean).join("\n");
    const text = redactStreamingText(detail || state.permissionPrompt || state.outputLines.join("\n"));
    if (launch.format === "plain") return { exitCode, output: text };
    const final = safeJson({ type: "result", status, success: exitCode === 0, conversationId: state.conversation?.id, sessionId: state.conversation?.codingSessionId ?? state.sessionId, text });
    return { exitCode, output: launch.format === "streaming-json" ? [...streamed, final].join("\n") : final };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Returns null for established subcommands, leaving their dispatch unchanged. */
export async function maybeLaunchSession(args: string[], options: TuiLaunchOptions = {}): Promise<{ exitCode: number; output: string } | null> {
  const first = args[0];
  if (first && RESERVED.has(first)) return null;
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  if (flags.includes("--help") || flags.includes("-h")) return null;
  const flag = first?.split("=", 1)[0] ?? "";
  if (first && !LAUNCH_FLAGS.has(flag) && first !== "-" && !/\s/.test(first) && args.length === 1) return null;
  const tty = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !isCI() && !shouldSuppressBranding());
  if (!args.length && !tty) return null;
  const formatIndex = flags.indexOf("--output-format");
  const requestedFormat = flags.find((arg) => arg.startsWith("--output-format="))?.slice("--output-format=".length)
    ?? (formatIndex >= 0 ? flags[formatIndex + 1] : undefined);
  let format: OutputFormat = requestedFormat === "streaming-json" ? "streaming-json" : flags.includes("--json") || requestedFormat === "json" ? "json" : "plain";
  try {
    const launch = parseLaunch(args);
    format = launch.format;
    cancelled(options.signal);
    const cwd = path.resolve(options.cwd ?? process.cwd(), launch.cwd ?? ".");
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("--cwd must identify a directory.");
    if (launch.prompt === "-") {
      launch.prompt = await (options.readStdin ?? readPromptStdin)(options.signal);
      cancelled(options.signal);
      if (launch.prompt.length > STDIN_LIMIT) throw new Error("stdin prompt exceeds 20,000 characters.");
      launch.prompt = launch.prompt.trim();
      launch.print = true;
    }
    const print = launch.print || launch.explicitFormat || !tty;
    if (print && !launch.prompt && launch.mode !== "review") throw new Error("Headless sessions require a prompt. Use hive -p \"your task\" or hive -p - for explicit stdin.");
    if (print) return await headless(launch, cwd, options);
    const initialCommands = setupCommands(launch);
    if (launch.mode === "review") initialCommands.push(`/review run${launch.prompt ? ` ${launch.prompt}` : ""}`);
    else if (launch.prompt) initialCommands.push(launch.prompt.startsWith("/") ? `/run ${launch.prompt}` : launch.prompt);
    const startTui = options.startTui ?? (await import("./index.js")).startHiveTui;
    await startTui(cwd, { initialCommands, initialMode: launch.mode });
    return { exitCode: 0, output: "__TUI_STARTED__" };
  } catch (error: unknown) {
    const message = redactKnownSecrets(error instanceof Error ? error.message : String(error));
    const exitCode = options.signal?.aborted || error instanceof Error && error.name === "AbortError" ? 130 : 1;
    return { exitCode, output: format === "plain" ? message : safeJson({ type: "result", status: exitCode === 130 ? "cancelled" : "failed", success: false, text: message }) };
  }
}
