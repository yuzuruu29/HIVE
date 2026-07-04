/**
 * index.ts
 * Public entry point for the HIVE TUI cockpit.
 * Exports startHiveTui() with all safety guards.
 */

import { TuiApp } from "./app.js";

const MIN_WIDTH = 70;

export async function startHiveTui(cwd: string): Promise<void> {
  // Guard: must be an interactive TTY
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      "HIVE TUI requires an interactive terminal (TTY not detected).\n"
    );
    return;
  }

  // Guard: CI environments must not enter interactive mode
  if (
    process.env.CI !== undefined &&
    process.env.CI !== "" &&
    process.env.CI !== "false"
  ) {
    process.stderr.write(
      "HIVE TUI is disabled in CI environments.\n"
    );
    return;
  }

  // Guard: --json suppresses TUI
  if (process.argv.includes("--json")) {
    return;
  }

  // Guard: minimum terminal width
  const cols = process.stdout.columns || 0;
  if (cols > 0 && cols < MIN_WIDTH) {
    process.stderr.write(
      `HIVE TUI requires an interactive terminal at least ${MIN_WIDTH} columns wide.\n` +
        `Current width: ${cols} columns.\n`
    );
    return;
  }

  const app = new TuiApp(cwd);
  await app.start();
}
