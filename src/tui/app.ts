/**
 * app.ts
 * TuiApp - lifecycle, raw input loop, render scheduling.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { persistConversation, reconcileCodingConversation } from "./conversations.js";
import { StringDecoder } from "node:string_decoder";
import type { HiveMode } from "../config.js";
import { cycleSessionMode, nextInterrupt, settlePermissionAsk, decidePermission } from "./interaction.js";
import type { ToolPermissionRequest } from "../coding/types.js";
import type { ExtensionOptions } from "../extensions/types.js";
import { validateMcpUserInput, type McpUserInputRequest, type McpUserInputResult } from "../extensions/mcp-client-host.js";
import { redactStreamingText } from "../security/secrets.js";
import { providerCatalog } from "../providers/commands.js";
import {
  acceptPicker,
  commandPicker,
  filePicker,
  fileQuery,
  listWorkspaceFiles,
  slashQuery,
} from "./picker.js";
import {
  TuiState,
  initialState,
  withInput,
  withHistory,
  withOutput,
  withSize,
  withRunning,
  withSelectedSubagent,
  withSubagentsExpanded,
  withSessionMode,
  withEditsApproved,
  withPendingPermission,
  withPicker,
  withProvider,
  withMessageQueue,
  appendTranscriptLine,
  replaceTranscript,
  setTaskStatus,
  themeFromBackgroundReply,
  themeFromEnvironment,
  withLightTheme,
} from "./state.js";
import { parseTuiCommand, executeTuiCommand, type ExecuteTuiCommandOptions } from "./commands.js";
import type { TuiRuntimeHandle, TuiSessionRunner } from "./runtime-adapter.js";
import { FRAME_MS, parseGitBranch, permissionPulsing, renderMcpInputRows, renderTuiScreen } from "./renderer.js";
import {
  enterAlternateScreen,
  exitAlternateScreen,
  hideCursor,
  showCursor,
  enableRawMode,
  disableRawMode,
  enableMouseTracking,
  disableMouseTracking,
  frameUpdate,
  getTerminalSize,
} from "./terminal-control.js";
import { composerCursor, nextScrollOffset, planSessionFrame, sessionFrameWidth } from "./transcript-view.js";
import { graphemeColumnOffset, graphemeCursor, graphemes, moveGraphemeCursor, moveWordCursor } from "./text.js";
import {
  closePromptedToolCard,
  cancelActiveToolCards,
  focusedToolCardPosition,
  moveToolCardFocus,
  toggleFocusedToolCard,
  toolCardCount,
} from "./tool-card.js";

// Key codes
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_O = "\x0f";
const CTRL_U = "\x15";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const SHIFT_TAB = "\x1b[Z";
const ESCAPE = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

interface PendingMcpInput {
  request: McpUserInputRequest;
  signal: AbortSignal;
  resolve: (result: McpUserInputResult) => void;
}

export class TuiApp {
  private state: TuiState;
  private cwd: string;
  private stopped = false;
  private inputBuffer = "";
  private readonly inputDecoder = new StringDecoder("utf8");
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private workingTick?: ReturnType<typeof setInterval>;
  /** Rows on screen now. Undefined forces a full redraw (start, resize). */
  private shownRows?: string[];
  private pasteBuffer: string | undefined;
  private historyDraft?: { input: string; cursor: number };
  private boundOnData: ((chunk: Buffer) => void) | null = null;
  private boundOnResize: (() => void) | null = null;
  private resolveStop: (() => void) | null = null;
  private activeRuntime: TuiRuntimeHandle | null = null;
  private readonly runSession?: TuiSessionRunner;
  private readonly persistSession: boolean;
  private readonly extensionOptions?: ExtensionOptions;
  private exitArmed = false;
  private turnLive = false;
  private lastObjective = "";
  private continuationsLeft = 1;
  private sessionReady = false;
  private fileToken = 0;
  private cachedPaths: string[] | null = null;
  private filesPromise: Promise<string[]> | null = null;
  /** Identifies the command whose updates and completion still belong here. */
  private turnGeneration = 0;
  private commandPending = false;
  private turnCancelled = false;
  private pendingContinuation?: string;
  private branchRefresh = 0;
  private readonly readGitBranch: (cwd: string) => Promise<string | undefined>;
  private readonly initialCommands: string[];
  private startupRemaining = 0;
  private startupSetupActive = false;
  private queueSuspended = false;
  private launchMode?: HiveMode;
  private pendingMode?: HiveMode;
  private modePersistence: Promise<void> = Promise.resolve();
  private readonly reconcileConversation: (cwd: string, state: TuiState) => Promise<TuiState>;
  private toolDecision?: (allow: boolean) => void;
  private readonly toolPermissionQueue: Array<{ request: ToolPermissionRequest; signal: AbortSignal; resolve: (allow: boolean) => void }> = [];
  private readonly mcpInputQueue: PendingMcpInput[] = [];
  private mcpDecision?: (result: McpUserInputResult) => void;
  private activeMcpInput?: PendingMcpInput;

  constructor(cwd: string, options: {
    runSession?: TuiSessionRunner;
    readGitBranch?: (cwd: string) => Promise<string | undefined>;
    persistSession?: boolean;
    extensionOptions?: ExtensionOptions;
    initialCommands?: string[];
    initialMode?: HiveMode;
    reconcileConversation?: (cwd: string, state: TuiState) => Promise<TuiState>;
  } = {}) {
    this.cwd = cwd;
    const workspaceName = path.basename(path.resolve(cwd)) || path.resolve(cwd);
    this.state = { ...initialState(), workspaceName, ...(options.initialMode ? { sessionMode: options.initialMode } : {}) };
    this.launchMode = options.initialMode;
    if (options.initialMode) this.sessionReady = true;
    this.runSession = options.runSession;
    this.persistSession = options.persistSession ?? options.runSession === undefined;
    this.extensionOptions = options.extensionOptions;
    this.readGitBranch = options.readGitBranch ?? readWorkspaceBranch;
    this.initialCommands = [...(options.initialCommands ?? [])];
    this.reconcileConversation = options.reconcileConversation ?? (options.runSession ? async (_cwd, state) => state : reconcileCodingConversation);
  }

  // -- Lifecycle ---------------------------------------------------------------

  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveStop = resolve;
      this.stopped = false;

      // Install SIGTERM/SIGINT cleanup
      const cleanup = () => {
        if (!this.stopped) this.stop();
      };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      // Note: SIGINT via raw mode Ctrl+C is caught in onData, not here.
      // The process.on("SIGINT") is a belt-and-suspenders fallback.

      // Enter alternate screen, hide cursor
      enterAlternateScreen();
      hideCursor();
      enableMouseTracking();
      clearAndHome();

      // Enable raw mode
      enableRawMode();
      // Ask for the background color when the environment does not say; the
      // reply arrives on stdin and is consumed before key handling.
      if (this.state.colorEnabled && themeFromEnvironment() === undefined) process.stdout.write("\x1b]11;?\x1b\\");

      // Set up stdin
      this.boundOnData = this.onData.bind(this);
      process.stdin.on("data", this.boundOnData);

      // Set up resize
      this.boundOnResize = this.onResize.bind(this);
      process.stdout.on("resize", this.boundOnResize);

      // Initial render
      this.render();
      if (this.initialCommands.length) this.commandPending = true;
      void this.hydrateSession().finally(() => {
        this.enqueueInitialCommands();
      });

      // Load scout info asynchronously
      import("../scout/index.js").then(({ generateContextPack }) => {
        generateContextPack(this.cwd).then(pack => {
          if (this.stopped) return;
          const { withScoutInfo } = require("./state.js"); // lazy load to avoid circular deps if any
          this.setState(withScoutInfo(this.state, pack.importantFiles.length, pack.docs.length, pack.riskNotes.length));
        }).catch(() => {});
      }).catch(() => {});
    });
  }

  private enqueueInitialCommands(): void {
    if (!this.initialCommands.length || this.stopped) return;
    this.commandPending = false;
    this.startupRemaining = this.initialCommands.length;
    this.state = withMessageQueue(this.state, [...this.initialCommands, ...this.state.messageQueue]);
    this.drainMessageQueue();
  }

  private abortStartupSetup(): void {
    if (!this.startupSetupActive) return;
    const queue = this.state.messageQueue ?? [];
    const pending = queue.slice(0, this.startupRemaining).filter((raw) => ["task", "run", "review", "plan"].includes(parseTuiCommand(raw).kind));
    const retained = [...pending, ...queue.slice(this.startupRemaining)];
    let next = withMessageQueue(this.state, retained);
    if (!next.input && retained[0]) next = withInput(withMessageQueue(next, retained.slice(1)), retained[0]);
    this.startupRemaining = 0;
    this.startupSetupActive = false;
    this.queueSuspended = true;
    this.pendingContinuation = undefined;
    this.setState(appendTranscriptLine(next, "Startup setup failed; dependent commands were stopped. The request is kept as a draft. Submit a task to resume queued prompts, or Esc to clear them."));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.escapeTimer);
    clearInterval(this.workingTick);
    this.workingTick = undefined;
    this.mcpDecision?.({ action: "cancel" });
    for (const pending of this.mcpInputQueue.splice(0)) pending.resolve({ action: "cancel" });
    this.toolDecision?.(false);
    for (const pending of this.toolPermissionQueue.splice(0)) pending.resolve(false);

    // Cancellation happens before terminal cleanup so active provider/tool
    // work observes the abort even if cleanup itself throws.
    this.activeRuntime?.cancel("TUI stopped.");

    // Remove listeners
    if (this.boundOnData) {
      process.stdin.removeListener("data", this.boundOnData);
    }
    if (this.boundOnResize) {
      process.stdout.removeListener("resize", this.boundOnResize);
    }

    // Restore the screen while raw mode is still on. Leaving the alternate
    // screen after cooked input returns leaves Windows ConPTY shells unable
    // to draw their prompt, so the terminal looks hung after exit.
    disableMouseTracking();
    exitAlternateScreen();
    showCursor();
    disableRawMode();

    // Pause stdin so process can exit
    try {
      process.stdin.pause();
    } catch {
      // Ignore
    }

    const resolve = this.resolveStop;
    this.resolveStop = null;
    if (this.persistSession && this.state.conversation) {
      const snapshot = this.state;
      void (async () => {
        await persistConversation(this.cwd, snapshot);
        await this.activeRuntime?.completion;
        const settled = await this.reconcileConversation(this.cwd, snapshot);
        await persistConversation(this.cwd, settled);
      })().catch(() => {
        process.stderr.write("HIVE could not save the final conversation state; the last saved snapshot was preserved.\n");
      }).finally(() => resolve?.());
    } else resolve?.();
  }

  // -- Resize ------------------------------------------------------------------

  private onResize(): void {
    this.shownRows = undefined;
    const { cols, rows } = getTerminalSize();
    this.setState(withSize(this.state, cols, rows));
  }

  // -- State -------------------------------------------------------------------

  private setState(next: TuiState): void {
    this.state = next;
    this.render();
  }

  // -- Render ------------------------------------------------------------------

  private render(): void {
    if (this.stopped) return;
    const now = Date.now();
    this.syncWorkingTick(now);
    const rows = renderTuiScreen(this.state, now).split("\n");
    const update = frameUpdate(this.shownRows, rows);
    if (update) process.stdout.write(update);
    this.shownRows = rows;
  }

  /**
   * Redraw on a clock while something moves: a running turn (timer, bee,
   * tool pulse, caret) or a permission selector that just opened.
   */
  private syncWorkingTick(now: number): void {
    const active = this.state.taskStatus === "running" || this.state.taskStatus === "verifying" || permissionPulsing(this.state, now);
    if (active && !this.workingTick) {
      this.workingTick = setInterval(() => this.render(), this.state.motionEnabled ? FRAME_MS : 1000);
      this.workingTick.unref?.();
    } else if (!active && this.workingTick) {
      clearInterval(this.workingTick);
      this.workingTick = undefined;
    }
  }

  // -- Input Handling ----------------------------------------------------------

  private onData(chunk: Buffer): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    // ponytail: assumes the short OSC 11 reply arrives in one chunk; a split reply would reach the key parser.
    let theme: "light" | "dark" | undefined;
    const text = this.inputDecoder.write(chunk).replace(OSC_BACKGROUND_REPLY, (reply) => {
      theme = themeFromBackgroundReply(reply) ?? theme;
      return "";
    });
    if (theme && (theme === "light") !== Boolean(this.state.lightTheme)) this.setState(withLightTheme(this.state, theme === "light"));
    this.inputBuffer += text;
    this.processInputBuffer(true);
  }

  private processInputBuffer(deferEscape = false): void {
    while (this.inputBuffer.length > 0) {
      if (this.pasteBuffer !== undefined) {
        this.pasteBuffer += this.inputBuffer;
        this.inputBuffer = "";
        const end = this.pasteBuffer.indexOf(PASTE_END);
        if (end < 0) return;
        const pasted = this.pasteBuffer.slice(0, end)
          .replace(/\r\n?/g, "\n")
          .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
        this.inputBuffer = this.pasteBuffer.slice(end + PASTE_END.length);
        this.pasteBuffer = undefined;
        // Paste is text: embedded newlines and escape keys never execute actions.
        this.editComposer("insert", pasted);
        continue;
      }

      if (this.inputBuffer.startsWith("\x1b[") || this.inputBuffer.startsWith("\x1bO")) {
        const read = readControlSequence(this.inputBuffer);
        if (read.kind === "need-more") return;
        this.inputBuffer = read.rest;
        if (read.sequence === PASTE_START) this.pasteBuffer = "";
        else this.handleControlSequence(read.sequence);
        continue;
      }

      if (this.inputBuffer.startsWith(ESCAPE)) {
        if (this.inputBuffer.length === 1 && deferEscape) {
          // A data event can end before the rest of an arrow or Alt key arrives.
          this.escapeTimer = setTimeout(() => {
            this.escapeTimer = undefined;
            if (!this.stopped) this.processInputBuffer();
          }, 50);
          this.escapeTimer.unref();
          return;
        }
        const alt = this.inputBuffer[1];
        if (alt === "\r" || alt === "\n" || alt === "b" || alt === "f" || alt === BACKSPACE || alt === BACKSPACE_ALT) {
          this.inputBuffer = this.inputBuffer.slice(2);
          if (alt === "b" || alt === "f") this.moveWord(alt === "b" ? -1 : 1);
          else if (alt === BACKSPACE || alt === BACKSPACE_ALT) this.killWord();
          else this.editComposer("insert", "\n");
          continue;
        }
        if (this.closePicker()) {
          this.inputBuffer = this.inputBuffer.slice(1);
          continue;
        }
        this.applyInterrupt("escape");
        this.inputBuffer = this.inputBuffer.slice(1);
        continue;
      }

      const code = this.inputBuffer.codePointAt(0);
      if (code === undefined) return;
      const ch = String.fromCodePoint(code);
      this.inputBuffer = this.inputBuffer.slice(ch.length);
      this.handleChar(ch);
    }
  }

  private handleChar(ch: string): void {
    if (ch === "\x01" || ch === "\x05") {
      const cursor = composerCursor(this.state.input, this.state.cursor);
      const before = cursor === 0 ? -1 : this.state.input.lastIndexOf("\n", cursor - 1);
      const after = this.state.input.indexOf("\n", cursor);
      this.setComposerCursor(ch === "\x01" ? before + 1 : after < 0 ? this.state.input.length : after);
      return;
    }
    if (ch === "\x02" || ch === "\x06") {
      this.moveCursor(ch === "\x02" ? -1 : 1);
      return;
    }
    if (ch === "\x17") {
      this.killWord();
      return;
    }
    if (ch === "\x0b") {
      const cursor = graphemeCursor(this.state.input, composerCursor(this.state.input, this.state.cursor));
      const lineEnd = this.state.input.indexOf("\n", cursor);
      const end = lineEnd < 0 ? this.state.input.length : lineEnd === cursor ? cursor + 1 : lineEnd;
      this.replaceComposerRange(cursor, end);
      return;
    }
    if (ch === "\t") {
      const accepted = this.state.picker && !this.state.pendingPermission
        ? acceptPicker(this.state.input, this.state.picker)
        : undefined;
      if (accepted) {
        this.historyDraft = undefined;
        this.updateComposer(accepted.input, { historyIndex: -1 });
        this.setState(withPicker(this.state, undefined));
      }
      return;
    }
    if (ch === CTRL_U) {
      this.pageTranscript(1, "page");
      return;
    }

    if (ch === CTRL_D) {
      this.pageTranscript(-1, "page");
      return;
    }

    if (ch === CTRL_O) {
      if (this.state.mcpInput) return;
      this.toggleFocusedCard();
      return;
    }

    if (ch === CTRL_C) {
      this.applyInterrupt("ctrl-c");
      return;
    }

    // Enter submits. Ctrl+J is LF, which this parser can see, and inserts a newline.
    // A pasted CRLF is a newline too; a bare CR still submits.
    if (ch === ENTER) {
      if (this.inputBuffer.startsWith("\n")) {
        this.inputBuffer = this.inputBuffer.slice(1);
        this.editComposer("insert", "\n");
        return;
      }
      this.submitInput();
      return;
    }

    if (ch === "\n") {
      this.editComposer("insert", "\n");
      return;
    }

    if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
      this.editComposer("backspace");
      return;
    }

    if (!this.state.mcpInput && (ch === "[" || ch === "]") && this.state.input.length === 0 && toolCardCount(this.state.transcript) > 0) {
      this.moveToolCard(ch === "[" ? -1 : 1);
      return;
    }

    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && (code < 0x7f || code > 0x9f)) {
      this.editComposer("insert", ch);
    }
  }

  private editComposer(kind: "backspace" | "delete" | "insert", text = ""): void {
    const cursor = graphemeCursor(this.state.input, composerCursor(this.state.input, this.state.cursor));
    if (kind === "backspace") {
      if (cursor === 0) {
        this.exitArmed = false;
        return;
      }
      this.replaceComposerRange(moveGraphemeCursor(this.state.input, cursor, -1), cursor);
      return;
    }
    if (kind === "delete") {
      if (cursor >= this.state.input.length) return;
      this.replaceComposerRange(cursor, moveGraphemeCursor(this.state.input, cursor, 1));
      return;
    }
    this.replaceComposerRange(cursor, cursor, text);
  }

  private replaceComposerRange(start: number, end: number, text = ""): void {
    this.historyDraft = undefined;
    const input = this.state.input.slice(0, start) + text + this.state.input.slice(end);
    if (this.state.mcpInput && Buffer.byteLength(input) > 32_768) {
      this.setState({ ...this.state, mcpInput: { ...this.state.mcpInput, scrollOffset: 0, error: "Response exceeds the input limit. Shorten it or /decline." } });
      return;
    }
    const offset = start + text.length;
    const boundary = graphemeCursor(input, offset);
    const cursor = boundary === offset ? offset : moveGraphemeCursor(input, boundary, 1);
    this.updateComposer(input, { cursor, historyIndex: -1 });
  }

  private killWord(): void {
    const cursor = graphemeCursor(this.state.input, composerCursor(this.state.input, this.state.cursor));
    this.replaceComposerRange(moveWordCursor(this.state.input, cursor, -1), cursor);
  }

  private moveWord(delta: -1 | 1): void {
    const cursor = composerCursor(this.state.input, this.state.cursor);
    this.setComposerCursor(moveWordCursor(this.state.input, cursor, delta));
  }

  private moveCursor(delta: number): void {
    const cursor = composerCursor(this.state.input, this.state.cursor);
    this.setComposerCursor(moveGraphemeCursor(this.state.input, cursor, delta));
  }

  private setComposerCursor(offset: number): void {
    const cursor = composerCursor(this.state.input, this.state.cursor);
    const next = graphemeCursor(this.state.input, offset);
    if (next === cursor && this.state.cursor === next) return;
    this.exitArmed = false;
    this.setState({ ...this.state, cursor: next });
  }

  private jumpCursor(edge: "start" | "end"): void {
    const next = edge === "start" ? 0 : this.state.input.length;
    this.setComposerCursor(next);
  }

  /**
   * Up and Down move within a multiline draft. They do not drive tool cards.
   * A single-line draft still uses them for history.
   */
  private moveComposerLine(delta: -1 | 1): boolean {
    const input = this.state.input;
    if (!input.includes("\n")) return false;
    const cursor = composerCursor(input, this.state.cursor);
    const lineBreak = cursor === 0 ? -1 : input.lastIndexOf("\n", cursor - 1);
    const lineStart = lineBreak + 1;
    const column = Array.from(graphemes(input.slice(lineStart, cursor))).length;
    if (delta < 0) {
      if (lineStart === 0) return true;
      const prevEnd = lineStart - 1;
      const prevBreak = prevEnd === 0 ? -1 : input.lastIndexOf("\n", prevEnd - 1);
      const prevStart = prevBreak + 1;
      const next = prevStart + graphemeColumnOffset(input.slice(prevStart, prevEnd), column);
      this.setComposerCursor(next);
      return true;
    }
    const breakAt = input.indexOf("\n", cursor);
    if (breakAt === -1) return true;
    const nextStart = breakAt + 1;
    const nextBreak = input.indexOf("\n", nextStart);
    const nextEnd = nextBreak === -1 ? input.length : nextBreak;
    const next = nextStart + graphemeColumnOffset(input.slice(nextStart, nextEnd), column);
    this.setComposerCursor(next);
    return true;
  }

  private moveToolCard(delta: -1 | 1): void {
    const count = toolCardCount(this.state.transcript);
    if (count === 0) return;
    const current = focusedToolCardPosition(count, this.state.toolCardFocus);
    const toolCardFocus = moveToolCardFocus(count, this.state.toolCardFocus, delta);
    if (toolCardFocus === current && this.state.toolCardFocus === toolCardFocus) return;
    this.exitArmed = false;
    this.setState({ ...this.state, toolCardFocus });
  }

  private toggleFocusedCard(): void {
    this.exitArmed = false;
    const count = toolCardCount(this.state.transcript);
    const toolCardFocus = focusedToolCardPosition(count, this.state.toolCardFocus);
    const next = replaceTranscript(
      this.state,
      toggleFocusedToolCard(this.state.transcript, toolCardFocus),
    );
    this.setState(toolCardFocus >= 0 ? { ...next, toolCardFocus } : next);
  }

  private turnBusy(): boolean {
    return this.commandPending
      || this.turnLive
      || this.state.running
      || this.activeRuntime !== null
      || this.state.taskStatus === "running"
      || this.state.taskStatus === "verifying";
  }

  private updateComposer(input: string, patch: Partial<TuiState> = {}): void {
    const cursor = typeof patch.cursor === "number" ? patch.cursor : input.length;
    const base = { ...this.state, ...patch, cursor };
    this.exitArmed = false;
    if (base.pendingPermission || base.mcpInput) {
      this.setState(withPicker(withInput(base, input, cursor), undefined));
      return;
    }

    const slash = slashQuery(input);
    if (slash !== null) {
      const selected = base.picker?.kind === "command" && base.picker.query === slash
        ? base.picker.selected
        : 0;
      this.setState(withPicker(withInput(base, input, cursor), commandPicker(input, selected)));
      return;
    }

    const mention = fileQuery(input);
    if (!mention) {
      this.setState(withPicker(withInput(base, input, cursor), undefined));
      return;
    }

    const selected = base.picker?.kind === "file" && base.picker.query === mention.query
      ? base.picker.selected
      : 0;
    if (this.cachedPaths) {
      this.setState(withPicker(withInput(base, input, cursor), filePicker(input, this.cachedPaths, selected)));
      return;
    }

    const loading = filePicker(input, [], selected);
    this.setState(withPicker(withInput(base, input, cursor), loading ? { ...loading, loading: true } : undefined));
    const token = ++this.fileToken;
    void this.workspaceFiles().then((paths) => {
      if (this.stopped || token !== this.fileToken || this.state.input !== input) return;
      const current = this.state.picker?.kind === "file" ? this.state.picker.selected : 0;
      this.setState(withPicker(this.state, filePicker(input, paths, current)));
    });
  }

  private workspaceFiles(): Promise<string[]> {
    if (this.cachedPaths) return Promise.resolve(this.cachedPaths);
    if (!this.filesPromise) {
      this.filesPromise = listWorkspaceFiles(this.cwd)
        .then((paths) => {
          this.cachedPaths = paths;
          return paths;
        })
        .catch(() => {
          this.cachedPaths = [];
          return [];
        });
    }
    return this.filesPromise;
  }

  private movePicker(delta: number): void {
    const picker = this.state.picker;
    if (!picker || picker.items.length === 0) return;
    const selected = Math.max(0, Math.min(picker.items.length - 1, picker.selected + delta));
    if (selected === picker.selected) return;
    this.exitArmed = false;
    this.setState(withPicker(this.state, { ...picker, selected }));
  }

  private closePicker(): boolean {
    if (!this.state.picker || this.turnLive || this.state.pendingPermission) return false;
    this.exitArmed = false;
    this.setState(withPicker(this.state, undefined));
    return true;
  }

  private handleControlSequence(sequence: string): void {
    if (this.state.mcpInput) {
      if (sequence === ARROW_UP || sequence === "\x1bOA" || sequence === ARROW_DOWN || sequence === "\x1bOB") {
        this.moveComposerLine(sequence === ARROW_UP || sequence === "\x1bOA" ? -1 : 1);
        return;
      }
      if (sequence === SHIFT_TAB) return;
      if ((isCtrlLeft(sequence) || isCtrlRight(sequence)) && this.state.input.length === 0) return;
    }
    if (isCtrlLeft(sequence)) {
      if (this.state.input.length > 0) this.moveWord(-1);
      else this.moveToolCard(-1);
      return;
    }
    if (isCtrlRight(sequence)) {
      if (this.state.input.length > 0) this.moveWord(1);
      else this.moveToolCard(1);
      return;
    }
    if (isLeftKey(sequence)) {
      this.moveCursor(-1);
      return;
    }
    if (isRightKey(sequence)) {
      this.moveCursor(1);
      return;
    }
    if (isHomeKey(sequence)) {
      this.jumpCursor("start");
      return;
    }
    if (isEndKey(sequence)) {
      this.jumpCursor("end");
      return;
    }
    if (isDeleteKey(sequence)) {
      this.editComposer("delete");
      return;
    }
    if (isShiftEnter(sequence)) {
      this.editComposer("insert", "\n");
      return;
    }
    if (sequence === ARROW_UP || sequence === "\x1bOA") {
      if (this.state.pendingPermission && !this.state.mcpInput && !this.state.input) {
        this.setState({ ...this.state, permissionChoice: 0 });
      } else if (this.state.picker && this.state.picker.items.length > 0 && !this.state.pendingPermission) {
        this.movePicker(-1);
      } else if (this.state.subagentsExpanded && this.state.input.length === 0) {
        this.navigateSubagents(-1);
      } else if (!this.moveComposerLine(-1)) {
        this.navigateHistory(1);
      }
      return;
    }
    if (sequence === ARROW_DOWN || sequence === "\x1bOB") {
      if (this.state.pendingPermission && !this.state.mcpInput && !this.state.input) {
        this.setState({ ...this.state, permissionChoice: 1 });
      } else if (this.state.picker && this.state.picker.items.length > 0 && !this.state.pendingPermission) {
        this.movePicker(1);
      } else if (this.state.subagentsExpanded && this.state.input.length === 0) {
        this.navigateSubagents(1);
      } else if (!this.moveComposerLine(1)) {
        this.navigateHistory(-1);
      }
      return;
    }
    if (sequence === SHIFT_TAB) {
      this.cycleMode();
      return;
    }
    if (/^\x1b\[5(;\d+)*~$/.test(sequence)) {
      this.pageTranscript(1, "page");
      return;
    }
    if (/^\x1b\[6(;\d+)*~$/.test(sequence)) {
      this.pageTranscript(-1, "page");
      return;
    }
    const wheel = wheelDirection(sequence);
    if (wheel !== 0) this.pageTranscript(wheel > 0 ? 1 : -1, "wheel");
  }

  private pageTranscript(direction: 1 | -1, unit: "page" | "wheel"): void {
    if (this.state.mcpInput) {
      const count = renderMcpInputRows(this.state, sessionFrameWidth(this.state.width)).length;
      const viewport = planSessionFrame({ ...this.state, permissionPrompt: "MCP", subagentsExpanded: false, picker: undefined, messageQueue: [] }).transcriptRows;
      const delta = unit === "wheel" ? 3 : Math.max(1, viewport - 1);
      const scrollOffset = Math.max(0, Math.min(Math.max(0, count - viewport), this.state.mcpInput.scrollOffset - direction * delta));
      this.setState({ ...this.state, mcpInput: { ...this.state.mcpInput, scrollOffset } });
      return;
    }
    const scrollOffset = nextScrollOffset(this.state, direction, unit);
    if (scrollOffset === this.state.scrollOffset) return;
    this.exitArmed = false;
    this.setState({ ...this.state, scrollOffset });
  }

  private navigateHistory(direction: number): void {
    if (this.state.mcpInput) return;
    const { history, historyIndex } = this.state;
    if (history.length === 0) return;
    if (historyIndex < 0 && direction > 0) {
      this.historyDraft = {
        input: this.state.input,
        cursor: composerCursor(this.state.input, this.state.cursor),
      };
    }

    let nextIdx = historyIndex + direction;
    nextIdx = Math.max(-1, Math.min(history.length - 1, nextIdx));
    if (nextIdx === historyIndex) return;

    const nextInput = nextIdx === -1 ? this.historyDraft?.input ?? "" : history[nextIdx] ?? "";
    const cursor = nextIdx === -1 ? this.historyDraft?.cursor ?? nextInput.length : nextInput.length;
    this.updateComposer(nextInput, { historyIndex: nextIdx, cursor });
  }

  private navigateSubagents(direction: number): void {
    const tasks = this.state.subagents;
    if (tasks.length === 0) return;
    const current = tasks.findIndex((task) => task.id === this.state.selectedSubagentId);
    const start = current >= 0 ? current : 0;
    const next = (start + direction + tasks.length) % tasks.length;
    this.setState(withSelectedSubagent(this.state, tasks[next].id));
  }

  private submitInput(): void {
    if (this.state.mcpInput) { this.submitMcpInput(); return; }
    if (this.state.pendingPermission) {
      // An empty Enter confirms the highlighted selector option.
      const raw = this.state.input.trim() || (this.state.permissionChoice === 1 ? "n" : "y");
      this.exitArmed = false;
      this.answerPermission(raw);
      return;
    }

    const accepted = this.state.picker ? acceptPicker(this.state.input, this.state.picker) : undefined;
    if (accepted && !accepted.submit) {
      this.updateComposer(accepted.input);
      return;
    }

    const raw = (accepted?.submit ? accepted.input : this.state.input).trim();
    if (!raw) return;
    this.exitArmed = false;

    if (this.turnBusy()) {
      const messageQueue = [...(this.state.messageQueue ?? []), raw];
      let next = withHistory(withInput(this.state, ""), raw);
      next = withPicker(withMessageQueue(next, messageQueue), undefined);
      this.setState(next);
      return;
    }

    this.launchSubmitted(raw, false);
  }

  private launchSubmitted(raw: string, fromQueue: boolean): void {
    const submitted = parseTuiCommand(raw);
    if (!fromQueue && (submitted.kind === "task" || submitted.kind === "run" || submitted.kind === "review" || submitted.kind === "plan" && submitted.args)) this.queueSuspended = false;
    let next = fromQueue ? this.state : withPicker(withInput(this.state, ""), undefined);
    if (!fromQueue) next = withHistory(next, raw);
    next = withOutput(next, [`  $ ${raw}`]);
    this.setState(next);
    this.startCommand(raw);
  }

  private startCommand(
    raw: string,
    options: ExecuteTuiCommandOptions & { continuation?: boolean } = {},
  ): void {
    const cmd = parseTuiCommand(raw);
    if (["mode", "plan", "review"].includes(cmd.kind)) this.launchMode = undefined;
    if (["task", "run"].includes(cmd.kind) && this.launchMode) {
      this.state = withSessionMode(this.state, this.launchMode);
      this.launchMode = undefined;
    }
    if (cmd.kind === "exit") {
      this.stop();
      return;
    }
    const generation = ++this.turnGeneration;
    this.commandPending = true;
    this.turnCancelled = false;
    if (["mode", "plan", "resume", "continue", "new"].includes(cmd.kind)) this.sessionReady = true;
    if (!options.continuation && (cmd.kind === "task" || cmd.kind === "run" || cmd.kind === "plan") && cmd.args.trim()) {
      this.lastObjective = cmd.args.trim();
      this.continuationsLeft = 1;
    }

    this.setState(withRunning(this.state, true));
    const onUpdate = (updater: (current: TuiState) => TuiState) => {
      if (this.stopped || this.turnCancelled || this.pendingContinuation || generation !== this.turnGeneration) return;
      this.setState(updater(this.state));
    };

    const commandOptions = options;
    const approvedForSession = this.state.editsApproved
      && (this.state.sessionMode === "guarded" || this.state.sessionMode === "standard");
    executeTuiCommand(cmd, this.state, this.cwd, onUpdate, {
      runSession: this.runSession,
      persistSession: this.persistSession,
      extensionOptions: this.extensionOptions,
      requestToolPermission: (request, signal) => this.requestToolPermission(request, signal),
      requestMcpInput: (request, signal) => this.requestMcpInput(request, signal),
      ...commandOptions,
      posture: commandOptions.posture ?? (approvedForSession
        ? { mode: "auto", approvalPolicy: "changes" }
        : undefined),
    }).then(({ state: updated, shouldExit, runtime }) => {
      if (this.stopped) {
        runtime?.cancel("TUI stopped.");
        return;
      }
      if (generation !== this.turnGeneration) {
        runtime?.cancel("User interrupted the turn.");
        return;
      }
      if (this.startupSetupActive && ["resume", "continue"].includes(cmd.kind) && !updated.conversation) throw new Error("No saved conversation was restored; startup stopped before running the request.");
      this.commandPending = false;
      if (shouldExit) {
        this.stop();
        return;
      }
      const live = this.state;
      let next = withRunning(updated, false);
      next = {
        ...next,
        messageQueue: live.messageQueue ?? [],
        toolCardFocus: live.toolCardFocus,
        workspaceName: live.workspaceName ?? next.workspaceName,
        gitBranch: live.gitBranch ?? next.gitBranch,
        input: live.input,
        cursor: live.cursor,
        picker: live.input ? live.picker : updated.picker,
        history: ["resume", "continue", "new"].includes(cmd.kind) ? updated.history : live.history,
        historyIndex: ["resume", "continue", "new"].includes(cmd.kind) ? updated.historyIndex : live.historyIndex,
      };
      if (["resume", "continue"].includes(cmd.kind) && next.conversation) {
        const conversation = next.conversation;
        if (this.launchMode) next = withSessionMode(next, this.launchMode);
        this.lastObjective = [...conversation.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        this.continuationsLeft = 1;
      }
      if (!this.turnCancelled) this.setState(next);
      if (runtime) {
        this.activeRuntime = runtime;
        if (this.turnCancelled) {
          runtime.cancel("User interrupted the turn.");
        } else {
          this.turnLive = true;
          this.exitArmed = false;
        }
        const settled = () => this.onRuntimeSettled(runtime, generation);
        void runtime.completion.then(settled, settled);
        return;
      }
      this.turnLive = false;
      this.advanceAfterSettlement();
    }).catch((err: unknown) => {
      if (this.stopped || generation !== this.turnGeneration) return;
      this.commandPending = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.turnLive = false;
      this.activeRuntime = null;
      if (!this.turnCancelled) {
        this.setState(withOutput(setTaskStatus(withRunning(this.state, false), "error"), [`  Error: ${msg}`]));
      }
      this.advanceAfterSettlement();
    });
  }

  private onRuntimeSettled(runtime: TuiRuntimeHandle, generation: number): void {
    if (this.stopped) return;
    if (this.activeRuntime === runtime) {
      this.activeRuntime = null;
      this.turnLive = false;
    }
    if (generation !== this.turnGeneration) return;
    let next = withRunning(this.state, false);
    if (next.taskStatus === "running" || next.taskStatus === "verifying") {
      next = setTaskStatus(next, "idle");
    }
    this.state = next;
    this.advanceAfterSettlement();
  }

  private advanceAfterSettlement(): void {
    if (this.startupSetupActive && (this.state.taskStatus === "error" || this.turnCancelled)) this.abortStartupSetup();
    if (!this.persistSession) {
      this.advanceAfterPersistence();
      return;
    }
    this.commandPending = true;
    void (async () => {
      const snapshot = this.state;
      const reconciled = await this.reconcileConversation(this.cwd, snapshot);
      if (this.state.conversation && reconciled.conversation && this.state.conversation.id === reconciled.conversation.id
        && this.state.conversation.codingSessionId === reconciled.conversation.codingSessionId) {
        this.state = { ...this.state, conversation: { ...this.state.conversation, codingStatus: reconciled.conversation.codingStatus } };
      }
      await persistConversation(this.cwd, this.state);
    })().catch((error: unknown) => {
      if (!this.stopped) this.setState(withOutput(this.state, [`  Conversation save failed: ${error instanceof Error ? error.message : String(error)}`]));
    }).then(() => {
      this.commandPending = false;
      if (this.stopped) return;
      this.advanceAfterPersistence();
    });
  }

  private advanceAfterPersistence(): void {
    this.applyPendingMode();
    this.refreshGitBranch();
    const objective = this.pendingContinuation;
    if (objective) {
      this.pendingContinuation = undefined;
      this.startCommand(objective, {
        continuation: true,
        posture: { mode: "auto", approvalPolicy: "changes" },
      });
      return;
    }
    this.drainMessageQueue();
  }

  private drainMessageQueue(): void {
    this.showNextMcpInput();
    if (this.stopped || this.commandPending || this.turnLive || this.activeRuntime || this.state.pendingPermission || this.state.mcpInput || this.queueSuspended) return;
    const queue = this.state.messageQueue ?? [];
    const nextRaw = queue[0];
    if (!nextRaw) {
      this.startupSetupActive = false;
      this.setState(withRunning(this.state, false));
      return;
    }
    const startup = this.startupRemaining > 0;
    if (startup) this.startupRemaining -= 1;
    this.startupSetupActive = startup && ["resume", "continue", "fork", "model", "image"].includes(parseTuiCommand(nextRaw).kind);
    let ready = withMessageQueue(this.state, queue.slice(1));
    ready = withRunning(ready, false);
    if (ready.taskStatus === "running" || ready.taskStatus === "verifying") {
      ready = setTaskStatus(ready, "idle");
    }
    this.state = ready;
    this.launchSubmitted(nextRaw, true);
  }

  private answerPermission(raw: string): void {
    const allow = raw === "y" || raw === "yes" || raw === "1";
    const deny = raw === "n" || raw === "no" || raw === "2";
    let next = withInput(this.state, "");
    if (!allow && !deny) {
      this.setState(withOutput(next, ["  Answer 1 or 2 (y or n)."]));
      return;
    }
    if (this.toolDecision) {
      this.toolDecision(allow);
      return;
    }
    const pending = next.pendingPermission;
    next = withPendingPermission(next, undefined);
    if (!pending) {
      this.setState(next);
      return;
    }
    const settlement = settlePermissionAsk(next.sessionMode, pending, allow, {
      editsApproved: next.editsApproved,
    });
    next = replaceTranscript(
      next,
      closePromptedToolCard(next.transcript, settlement.applied ? "allowed" : "denied"),
    );
    if (!settlement.applied) {
      next = appendTranscriptLine(
        next,
        `permission ${settlement.decision.kind} ${settlement.decision.target} - denied - ${settlement.detail}`,
      );
      if (!settlement.decision.canApply) {
        next = appendTranscriptLine(next, "  Edits stay unapplied.");
      }
      if (next.conversation?.codingStatus === "paused") {
        const retainedId = next.conversation.codingSessionId;
        next = { ...next, conversation: { ...next.conversation, codingSessionId: undefined, codingStatus: undefined, detachedCodingSessionId: retainedId,
          messages: [...next.conversation.messages, { role: "assistant", content: `Declined coding session ${retainedId ?? ""}; it remains saved. Later prompts start a fresh coding run.` }] } };
        next = appendTranscriptLine(next, "  The declined run remains saved; your next prompt starts a fresh coding run.");
      }
      this.setState(next);
      this.drainMessageQueue();
      return;
    }

    next = withEditsApproved(next, true);
    next = appendTranscriptLine(
      next,
      `permission ${settlement.decision.kind} ${settlement.decision.target} - allowed`,
    );
    next = appendTranscriptLine(
      next,
      "  In-workspace edits are allowed for the rest of this session. Push and pull requests still need --confirmed.",
    );
    this.setState(next);

    const mode = next.sessionMode;
    if (
      this.lastObjective &&
      this.continuationsLeft > 0 &&
      (mode === "guarded" || mode === "standard")
    ) {
      this.continuationsLeft -= 1;
      this.pendingContinuation = this.lastObjective;
      if (this.activeRuntime || this.commandPending) {
        this.activeRuntime?.cancel("Continuing with approved in-workspace edits.");
      } else {
        this.advanceAfterSettlement();
      }
      return;
    }
    this.drainMessageQueue();
  }

  private applyInterrupt(key: "ctrl-c" | "escape"): void {
    if (this.mcpDecision) { this.mcpDecision({ action: "cancel" }); return; }
    if (this.turnCancelled && this.turnBusy()) {
      this.pendingContinuation = undefined;
      if ((this.state.messageQueue?.length ?? 0) > 0) {
        this.setState(withMessageQueue(this.state, []));
      } else if (key === "ctrl-c") {
        this.stop();
      }
      return;
    }
    const result = nextInterrupt({
      key,
      turnLive: this.commandPending
        || this.turnLive
        || this.activeRuntime !== null
        || this.state.running,
      exitArmed: this.exitArmed,
      permissionPending: this.state.pendingPermission !== undefined,
    });
    this.turnLive = result.turnLive;
    this.exitArmed = result.exitArmed;

    if (result.action === "exit") {
      this.stop();
      return;
    }
    if (result.action === "arm-exit") {
      this.setState(withPicker(withOutput(this.state, ["  Press Ctrl+C again to exit."]), undefined));
      return;
    }
    if (result.action === "ignore") {
      if ((this.state.messageQueue?.length ?? 0) > 0) {
        this.setState(withMessageQueue(this.state, []));
        return;
      }
      if (this.state.subagentsExpanded) {
        this.setState(withSubagentsExpanded(this.state, false));
      }
      return;
    }
    if (result.action === "decline-permission") {
      if (this.toolDecision) {
        this.toolDecision(false);
        return;
      }
      this.answerPermission("n");
      return;
    }

    this.turnCancelled = true;
    this.pendingContinuation = undefined;
    this.activeRuntime?.cancel(key === "escape" ? "User pressed Esc." : "User pressed Ctrl+C.");
    let next = withRunning(this.state, false);
    next = setTaskStatus(next, "idle");
    next = withPendingPermission(next, undefined);
    next = withPicker(next, undefined);
    next = replaceTranscript(next, cancelActiveToolCards(next.transcript));
    if (key === "ctrl-c") next = withMessageQueue(next, []);
    next = appendTranscriptLine(next, "Turn interrupted.");
    this.setState(next);
  }

  private cycleMode(): void {
    this.launchMode = undefined;
    const nextMode = cycleSessionMode(this.pendingMode ?? this.state.sessionMode);
    this.sessionReady = true;
    this.exitArmed = false;
    this.pendingMode = nextMode;
    if (this.turnBusy()) {
      this.setState(withOutput(this.state, [`  Next turn: ${nextMode}. The current turn remains ${this.state.sessionMode}; Esc cancels it.`]));
      if (this.toolDecision) this.toolDecision(false);
      return;
    }
    this.applyPendingMode();
    this.setState(withOutput(this.state, [`  Mode set to ${nextMode}.`]));
    this.drainMessageQueue();
  }

  private applyPendingMode(): void {
    const mode = this.pendingMode;
    if (!mode) return;
    this.pendingMode = undefined;
    this.commandPending = true;
    if (this.toolDecision) this.toolDecision(false);
    else if (this.state.pendingPermission) this.answerPermission("n");
    this.state = withSessionMode(this.state, mode);
    this.commandPending = false;
    this.persistMode(mode);
  }

  private requestToolPermission(request: ToolPermissionRequest, signal: AbortSignal): Promise<boolean> {
    if (this.stopped || signal.aborted || this.toolPermissionQueue.length + (this.toolDecision ? 1 : 0) >= 32) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const pending = { request, signal, resolve: (allow: boolean) => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", aborted); resolve(allow);
      } };
      const aborted = () => {
        const index = this.toolPermissionQueue.indexOf(pending);
        if (index < 0) return; // The active prompt installs its own abort listener.
        this.toolPermissionQueue.splice(index, 1); pending.resolve(false);
      };
      this.toolPermissionQueue.push(pending);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      this.showNextToolPermission();
    });
  }

  private showNextToolPermission(): void {
    if (this.toolDecision || this.state.pendingPermission || this.mcpDecision || this.state.mcpInput || this.stopped) return;
    const pending = this.toolPermissionQueue.shift();
    if (!pending) return;
    const { request, signal, resolve } = pending;
    const base = decidePermission(this.state.sessionMode, { kind: "command", target: request.tool, inWorkspace: true, confirmed: false });
    const detail = redactStreamingText(JSON.stringify(request.input, null, 2));
    if (signal.aborted || !base.canApply || detail.length > 16_000) {
      resolve(false);
      this.showNextToolPermission();
      return;
    }
    if (!request.external && !request.alwaysAsk && base.outcome === "allow") {
      resolve(true);
      this.showNextToolPermission();
      return;
    }
    const draft = { input: this.state.input, cursor: this.state.cursor };
    const finish = (allow: boolean) => {
      signal.removeEventListener("abort", aborted);
      this.toolDecision = undefined;
      const stillAllowed = decidePermission(this.state.sessionMode, { kind: "command", target: request.tool, inWorkspace: true, confirmed: false }).canApply;
      const accepted = allow && !signal.aborted && stillAllowed;
      if (!this.stopped) {
        this.setState(appendTranscriptLine(withPendingPermission(withInput(this.state, draft.input, draft.cursor), undefined), `  ${accepted ? "Allowed" : "Declined"} ${request.tool}.`));
      }
      resolve(accepted);
      this.showNextToolPermission();
      this.showNextMcpInput();
    };
    const aborted = () => finish(false);
    this.toolDecision = finish;
    signal.addEventListener("abort", aborted, { once: true });
    const decision = { ...base, outcome: "ask" as const, reason: request.external || request.alwaysAsk ? "This tool requires explicit approval." : "Command requires approval before execution." };
    let next = withPendingPermission(withInput(this.state, ""), decision);
    next = withOutput(next, [`  ${redactStreamingText(request.description)}`, detail, "  Allow this tool call? Choose below."]);
    this.setState(next);
  }

  /** Elicitation values live only in the modal composer and the response promise. */
  private requestMcpInput(request: McpUserInputRequest, signal: AbortSignal): Promise<McpUserInputResult> {
    if (this.stopped || signal.aborted || this.mcpInputQueue.length + (this.mcpDecision ? 1 : 0) >= 32) return Promise.resolve({ action: "cancel" });
    let snapshot: McpUserInputRequest;
    try {
      if (Buffer.byteLength(JSON.stringify(request)) > 65_536) return Promise.resolve({ action: "cancel" });
      snapshot = structuredClone(request);
    } catch { return Promise.resolve({ action: "cancel" }); }
    return new Promise((resolve) => {
      let settled = false;
      const pending: PendingMcpInput = { request: snapshot, signal, resolve: (response) => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", aborted); resolve(response);
      } };
      const aborted = () => {
        if (this.activeMcpInput === pending) this.mcpDecision?.({ action: "cancel" });
        else {
          const index = this.mcpInputQueue.indexOf(pending);
          if (index >= 0) this.mcpInputQueue.splice(index, 1);
          pending.resolve({ action: "cancel" });
        }
      };
      this.mcpInputQueue.push(pending);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      this.showNextMcpInput();
    });
  }

  private showNextMcpInput(): void {
    if (this.stopped || this.mcpDecision || this.state.mcpInput || this.toolDecision || this.state.pendingPermission) return;
    const pending = this.mcpInputQueue.shift();
    if (!pending) return;
    if (pending.signal.aborted) { pending.resolve({ action: "cancel" }); this.showNextMcpInput(); return; }
    const draft = { input: this.state.input, cursor: this.state.cursor, historyIndex: this.state.historyIndex, picker: this.state.picker, historyDraft: this.historyDraft };
    let input = "";
    if (pending.request.mode === "form") {
      const properties = pending.request.requestedSchema.properties;
      const entries: Array<[string, unknown]> = properties && typeof properties === "object" && !Array.isArray(properties) ? Object.entries(properties) : [];
      const defaults: Array<[string, unknown]> = [];
      for (const [key, field] of entries) if (field && typeof field === "object" && "default" in field) defaults.push([key, field.default]);
      input = JSON.stringify(Object.fromEntries(defaults));
    }
    let finished = false;
    this.activeMcpInput = pending;
    this.mcpDecision = (response) => {
      if (finished) return;
      finished = true;
      this.mcpDecision = undefined; this.activeMcpInput = undefined;
      this.inputBuffer = ""; this.pasteBuffer = undefined;
      this.fileToken += 1;
      this.historyDraft = draft.historyDraft;
      this.state = { ...withInput(this.state, draft.input, draft.cursor), historyIndex: draft.historyIndex, picker: draft.picker, mcpInput: undefined };
      if (!this.stopped) this.render();
      pending.resolve(pending.signal.aborted ? { action: "cancel" } : response);
      this.showNextToolPermission(); this.showNextMcpInput();
    };
    this.fileToken += 1;
    this.historyDraft = undefined;
    this.setState({ ...withInput(this.state, input), historyIndex: -1, picker: undefined, mcpInput: { request: pending.request, scrollOffset: 0 } });
  }

  private submitMcpInput(): void {
    const modal = this.state.mcpInput;
    if (!modal || !this.mcpDecision) return;
    const raw = this.state.input.trim();
    if (["/decline", "decline", "n", "no"].includes(raw.toLowerCase())) { this.mcpDecision({ action: "decline" }); return; }
    if (["/cancel", "/stop"].includes(raw.toLowerCase())) { this.mcpDecision({ action: "cancel" }); return; }
    try {
      if (modal.request.mode === "url" && raw.toLowerCase() !== "accept") throw new Error("Explicit action required");
      const result = validateMcpUserInput(modal.request, modal.request.mode === "url" ? { action: "accept" } : { action: "accept", content: JSON.parse(raw) });
      this.mcpDecision(result);
    } catch {
      this.setState({ ...this.state, mcpInput: { ...modal, scrollOffset: 0, error: modal.request.mode === "url" ? "Type accept after completing the URL, /decline, or Esc to cancel." : "Enter a JSON object matching the fields, /decline, or Esc to cancel." } });
    }
  }

  private persistMode(mode: HiveMode): void {
    this.modePersistence = this.modePersistence.then(() => import("../config.js"))
      .then(({ ConfigStore }) => new ConfigStore(this.cwd).setMode(mode))
      .catch(() => {
        if (!this.stopped) this.setState(withOutput(this.state, ["  Could not save the mode preference; the current session mode still applies."]));
      });
  }

  private async hydrateSession(): Promise<void> {
    this.refreshGitBranch();
    try {
      const { ConfigStore } = await import("../config.js");
      const mode = await new ConfigStore(this.cwd).getMode();
      if (!this.stopped && !this.sessionReady) this.setState(withSessionMode(this.state, mode));
      this.sessionReady = true;
    } catch {
      // Keep the guarded default when config cannot be read.
    }
    try {
      const catalog = await providerCatalog(this.cwd);
      const roles = catalog.roles;
      const binding = roles.queen ?? roles.planner ?? roles.builder ?? roles.coding;
      if (binding && catalog.rows.some((row) => row.provider.id === binding.provider && row.provider.approved)
        && !this.stopped && !this.state.conversation?.model) {
        this.setState(withProvider(this.state, binding.provider, binding.model));
      } else if (!this.stopped && !this.state.conversation?.model) {
        this.setState(withOutput(this.state, [catalog.rows.some((row) => row.provider.approved)
          ? "  Choose /model for this conversation, or /connect to add BYOK or local models."
          : "  Use /connect to choose BYOK (your API key) or a local model server."]));
      }
    } catch {
      // Provider status stays "none" until one is configured.
    }
  }

  private refreshGitBranch(): void {
    const refresh = ++this.branchRefresh;
    void this.readGitBranch(this.cwd).catch(() => undefined).then((stdout) => {
      if (this.stopped || refresh !== this.branchRefresh) return;
      const gitBranch = parseGitBranch(stdout ?? "");
      if (gitBranch === this.state.gitBranch) return;
      this.setState({ ...this.state, gitBranch });
    });
  }
}

function readWorkspaceBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/** A terminal's reply to the OSC 11 background-color query, BEL- or ST-terminated. */
const OSC_BACKGROUND_REPLY = /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Helper - avoid importing clearScreen from terminal-control to keep this local
function clearAndHome(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

type ControlRead = { kind: "need-more" } | { kind: "seq"; sequence: string; rest: string };

function readControlSequence(buffer: string): ControlRead {
  if (buffer.startsWith("\x1bO")) {
    if (buffer.length < 3) return { kind: "need-more" };
    if (/[\x00-\x1f\x7f]/.test(buffer[2])) return { kind: "seq", sequence: buffer.slice(0, 2), rest: buffer.slice(2) };
    return { kind: "seq", sequence: buffer.slice(0, 3), rest: buffer.slice(3) };
  }
  if (!buffer.startsWith("\x1b[")) return { kind: "seq", sequence: buffer.slice(0, 1), rest: buffer.slice(1) };
  if (buffer.startsWith("\x1b[<")) {
    const end = buffer.slice(3).search(/[Mm]/);
    const interrupted = buffer.slice(3, end < 0 ? undefined : end + 3).search(/[\x00-\x1f\x7f]/);
    if (interrupted >= 0) {
      const boundary = interrupted + 3;
      return { kind: "seq", sequence: buffer.slice(0, boundary), rest: buffer.slice(boundary) };
    }
    if (end < 0) {
      if (buffer.length > 48) return { kind: "seq", sequence: buffer.slice(0, 3), rest: buffer.slice(3) };
      return { kind: "need-more" };
    }
    const sequence = buffer.slice(0, 4 + end);
    return { kind: "seq", sequence, rest: buffer.slice(sequence.length) };
  }
  if (buffer.startsWith("\x1b[M")) {
    if (buffer.length < 6) return { kind: "need-more" };
    return { kind: "seq", sequence: buffer.slice(0, 6), rest: buffer.slice(6) };
  }
  let index = 2;
  while (index < buffer.length && index <= 32) {
    const code = buffer.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return { kind: "seq", sequence: buffer.slice(0, index + 1), rest: buffer.slice(index + 1) };
    }
    if (code < 0x20 || code > 0x3f) return { kind: "seq", sequence: buffer.slice(0, index), rest: buffer.slice(index) };
    index += 1;
  }
  if (buffer.length > 32) return { kind: "seq", sequence: buffer.slice(0, 2), rest: buffer.slice(2) };
  return { kind: "need-more" };
}

function isCtrlLeft(sequence: string): boolean {
  return sequence === "\x1b[1;5D" || sequence === "\x1b[5D";
}

function isCtrlRight(sequence: string): boolean {
  return sequence === "\x1b[1;5C" || sequence === "\x1b[5C";
}

function isLeftKey(sequence: string): boolean {
  return sequence === "\x1b[D" || sequence === "\x1bOD";
}

function isRightKey(sequence: string): boolean {
  return sequence === "\x1b[C" || sequence === "\x1bOC";
}

function isHomeKey(sequence: string): boolean {
  return sequence === "\x1b[H" || sequence === "\x1bOH" || /^\x1b\[1(;\d+)*H$/.test(sequence) || /^\x1b\[7(;\d+)*~$/.test(sequence);
}

function isEndKey(sequence: string): boolean {
  return sequence === "\x1b[F" || sequence === "\x1bOF" || /^\x1b\[1(;\d+)*F$/.test(sequence) || /^\x1b\[4(;\d+)*~$/.test(sequence) || /^\x1b\[8(;\d+)*~$/.test(sequence);
}

function isDeleteKey(sequence: string): boolean {
  return /^\x1b\[3(;\d+)*~$/.test(sequence);
}

function isShiftEnter(sequence: string): boolean {
  return sequence === "\x1b[13;2u" || sequence === "\x1b[27;2;13~";
}

function wheelDirection(sequence: string): number {
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(sequence);
  if (sgr) {
    const button = Number(sgr[1]) & ~28;
    if (button === 64) return 1;
    if (button === 65) return -1;
    return 0;
  }
  if (sequence.startsWith("\x1b[M") && sequence.length >= 6) {
    const button = sequence.charCodeAt(3) - 32;
    const base = button & ~28;
    if (base === 64) return 1;
    if (base === 65) return -1;
  }
  return 0;
}
