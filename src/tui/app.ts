/**
 * app.ts
 * TuiApp - lifecycle, raw input loop, render scheduling.
 */

import { TuiState, initialState, withInput, withHistory, withOutput, withSize, withRunning } from "./state.js";
import { parseTuiCommand, executeTuiCommand } from "./commands.js";
import { renderTuiScreen } from "./renderer.js";
import {
  enterAlternateScreen,
  exitAlternateScreen,
  hideCursor,
  showCursor,
  cursorHome,
  enableRawMode,
  disableRawMode,
  getTerminalSize,
  writeFrame,
} from "./terminal-control.js";

// Key codes
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const ENTER = "\r";
const ENTER_LF = "\n";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ESCAPE = "\x1b";

export class TuiApp {
  private state: TuiState;
  private cwd: string;
  private stopped = false;
  private inputBuffer = "";
  private boundOnData: ((chunk: Buffer) => void) | null = null;
  private boundOnResize: (() => void) | null = null;
  private resolveStop: (() => void) | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.state = initialState();
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
      clearAndHome();

      // Enable raw mode
      enableRawMode();

      // Set up stdin
      this.boundOnData = this.onData.bind(this);
      process.stdin.on("data", this.boundOnData);

      // Set up resize
      this.boundOnResize = this.onResize.bind(this);
      process.stdout.on("resize", this.boundOnResize);

      // Initial render
      this.render();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    // Remove listeners
    if (this.boundOnData) {
      process.stdin.removeListener("data", this.boundOnData);
    }
    if (this.boundOnResize) {
      process.stdout.removeListener("resize", this.boundOnResize);
    }

    disableRawMode();

    // Pause stdin so process can exit
    try {
      process.stdin.pause();
    } catch {
      // Ignore
    }

    exitAlternateScreen();
    showCursor();

    if (this.resolveStop) {
      this.resolveStop();
      this.resolveStop = null;
    }
  }

  // -- Resize ------------------------------------------------------------------

  private onResize(): void {
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
    const frame = renderTuiScreen(this.state);
    cursorHome();
    writeFrame(frame);
  }

  // -- Input Handling ----------------------------------------------------------

  private onData(chunk: Buffer): void {
    const str = chunk.toString("utf8");

    // Handle multi-byte sequences that may arrive fragmented
    this.inputBuffer += str;
    this.processInputBuffer();
  }

  private processInputBuffer(): void {
    while (this.inputBuffer.length > 0) {
      if (this.inputBuffer.startsWith("\x1b[")) {
        // Possible escape sequence - wait for more if not complete
        if (this.inputBuffer.length < 3) break;

        if (this.inputBuffer.startsWith(ARROW_UP)) {
          this.navigateHistory(1);
          this.inputBuffer = this.inputBuffer.slice(ARROW_UP.length);
          continue;
        }
        if (this.inputBuffer.startsWith(ARROW_DOWN)) {
          this.navigateHistory(-1);
          this.inputBuffer = this.inputBuffer.slice(ARROW_DOWN.length);
          continue;
        }
        // Unknown escape sequence - consume escape char
        this.inputBuffer = this.inputBuffer.slice(1);
        continue;
      }

      if (this.inputBuffer.startsWith(ESCAPE)) {
        // Lone escape - consume
        this.inputBuffer = this.inputBuffer.slice(1);
        continue;
      }

      const ch = this.inputBuffer[0];
      this.inputBuffer = this.inputBuffer.slice(1);
      this.handleChar(ch);
    }
  }

  private handleChar(ch: string): void {
    if (ch === CTRL_C || ch === CTRL_D) {
      if (this.state.taskStatus === "running" || this.state.taskStatus === "verifying") {
        const next = { ...this.state, outputLines: [...this.state.outputLines, "  Cancel requested. Waiting for current operation to finish."].slice(-200) };
        this.setState(next);
      }
      this.stop();
      return;
    }

    if (this.state.running || this.state.taskStatus === "running" || this.state.taskStatus === "verifying") return; // Block input while running

    if (ch === ENTER || ch === ENTER_LF) {
      this.submitInput();
      return;
    }

    if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
      if (this.state.input.length > 0) {
        this.setState(withInput(this.state, this.state.input.slice(0, -1)));
      }
      return;
    }

    // Printable characters only (charCode 32-126)
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      this.setState(withInput(this.state, this.state.input + ch));
    }
  }

  private navigateHistory(direction: number): void {
    const { history, historyIndex, input } = this.state;
    if (history.length === 0) return;

    let nextIdx = historyIndex + direction;
    nextIdx = Math.max(-1, Math.min(history.length - 1, nextIdx));

    const nextInput = nextIdx === -1 ? "" : history[nextIdx];
    this.setState({
      ...this.state,
      historyIndex: nextIdx,
      input: nextInput,
    });
  }

  private submitInput(): void {
    const raw = this.state.input.trim();
    if (!raw) return;

    // Clear input, add to history
    let next = withInput(this.state, "");
    next = withHistory(next, raw);

    // Echo the command in output
    next = withOutput(next, [`  $ ${raw}`]);
    this.setState(next);

    // Parse and execute asynchronously
    const cmd = parseTuiCommand(raw);

    if (cmd.kind === "exit") {
      this.stop();
      return;
    }

    // Mark running
    this.setState(withRunning(this.state, true));

    const onUpdate = (updater: (s: TuiState) => TuiState) => {
      if (this.stopped) return;
      this.setState(updater(this.state));
    };

    executeTuiCommand(cmd, this.state, this.cwd, onUpdate).then(({ state: updated, shouldExit }) => {
      if (this.stopped) return;
      if (shouldExit) {
        this.stop();
        return;
      }
      const final = withRunning(updated, false);
      this.setState(final);
    }).catch((err: unknown) => {
      if (this.stopped) return;
      const msg = err instanceof Error ? err.message : String(err);
      const errState = withOutput(withRunning(this.state, false), [`  Error: ${msg}`]);
      this.setState(errState);
    });
  }
}

// Helper - avoid importing clearScreen from terminal-control to keep this local
function clearAndHome(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}
