/**
 * terminal-control.ts
 * Centralized ANSI escape sequences for the HIVE TUI cockpit.
 * Uses Node.js built-ins only - no external dependencies.
 */

// -- Alternate Screen ----------------------------------------------------------
export function enterAlternateScreen(): void {
  process.stdout.write("\x1b[?1049h");
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
  process.stdout.write(content);
}
