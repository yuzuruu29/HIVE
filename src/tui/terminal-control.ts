/**
 * terminal-control.ts
 * Centralized ANSI escape sequences for the HIVE TUI cockpit.
 * Uses Node.js built-ins only - no external dependencies.
 */

// -- Alternate Screen ----------------------------------------------------------
export function enterAlternateScreen(): void {
  process.stdout.write("\x1b[?1049h");
}

/** Wheel events arrive as SGR mouse reports on the same stdin path as keys. */
export function enableMouseTracking(): void {
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
}

export function disableMouseTracking(): void {
  process.stdout.write("\x1b[?1006l\x1b[?1000l");
}

export function exitAlternateScreen(): void {
  process.stdout.write("\x1b[?1049l");
}

// -- Cursor -------------------------------------------------------------------
export function hideCursor(): void {
  process.stdout.write("\x1b[?25l");
}

export function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

export function moveCursor(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

export function cursorHome(): void {
  process.stdout.write("\x1b[H");
}

export function clearScreen(): void {
  process.stdout.write("\x1b[2J");
}

export function clearScreenAndHome(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

// -- Raw Mode -----------------------------------------------------------------
export function enableRawMode(): boolean {
  process.stdout.write("\x1b[?2004h");
  if (
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === "function"
  ) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return true;
  }
  return false;
}

export function disableRawMode(): void {
  process.stdout.write("\x1b[?2004l");
  if (
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === "function"
  ) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Ignore - may already be cleaned up
    }
  }
}

// -- Terminal Size -------------------------------------------------------------
export function getTerminalSize(): { cols: number; rows: number } {
  const cols =
    process.stdout.columns && process.stdout.columns > 0
      ? process.stdout.columns
      : 80;
  const rows =
    process.stdout.rows && process.stdout.rows > 0
      ? process.stdout.rows
      : 24;
  return { cols, rows };
}

// -- Write ---------------------------------------------------------------------
export function writeFrame(content: string): void {
  // The caller homes the cursor; erase before drawing so full-width last cells survive.
  process.stdout.write("\x1b[J" + content);
}

/**
 * Bytes that turn the previous frame into the next one. Without a previous
 * frame of the same height it redraws everything; otherwise it rewrites only
 * the rows that changed, each erased first so a full-width last cell is never
 * clipped by a trailing erase. Wrapped in synchronized output (DEC 2026) so
 * terminals that support it paint the update at once; others ignore it.
 */
export function frameUpdate(previous: readonly string[] | undefined, next: readonly string[]): string {
  let body = "";
  if (!previous || previous.length !== next.length) body = "\x1b[H\x1b[J" + next.join("\n");
  else {
    for (let row = 0; row < next.length; row += 1) {
      if (next[row] !== previous[row]) body += `\x1b[${row + 1};1H\x1b[2K${next[row]}`;
    }
  }
  return body ? `\x1b[?2026h${body}\x1b[?2026l` : "";
}
