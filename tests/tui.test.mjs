/**
 * tui.test.mjs
 * Tests for pure TUI functions: command parser, renderer, and guards.
 * Does NOT test raw terminal runtime or Ink/React components.
 */

import test from "node:test";
import assert from "node:assert";

// -- parseTuiCommand tests -----------------------------------------------------

test("TUI Commands - parseTuiCommand", async (t) => {
  const { parseTuiCommand } = await import("../dist/tui/commands.js");

  await t.test("parses /help", () => {
    const cmd = parseTuiCommand("/help");
    assert.strictEqual(cmd.kind, "help");
    assert.strictEqual(cmd.args, "");
  });

  await t.test("parses /exit", () => {
    const cmd = parseTuiCommand("/exit");
    assert.strictEqual(cmd.kind, "exit");
  });

  await t.test("parses /quit as exit", () => {
    const cmd = parseTuiCommand("/quit");
    assert.strictEqual(cmd.kind, "exit");
  });

  await t.test("parses /run with task", () => {
    const cmd = parseTuiCommand("/run build the feature");
    assert.strictEqual(cmd.kind, "run");
    assert.strictEqual(cmd.args, "build the feature");
  });

  await t.test("parses /run with no args", () => {
    const cmd = parseTuiCommand("/run");
    assert.strictEqual(cmd.kind, "run");
    assert.strictEqual(cmd.args, "");
  });

  await t.test("parses plain text as task", () => {
    const cmd = parseTuiCommand("fix the login bug");
    assert.strictEqual(cmd.kind, "task");
    assert.strictEqual(cmd.args, "fix the login bug");
  });

  await t.test("parses /providers", () => {
    const cmd = parseTuiCommand("/providers");
    assert.strictEqual(cmd.kind, "providers");
  });

  await t.test("parses /status", () => {
    const cmd = parseTuiCommand("/status");
    assert.strictEqual(cmd.kind, "status");
  });

  await t.test("parses /model", () => {
    const cmd = parseTuiCommand("/model");
    assert.strictEqual(cmd.kind, "model");
  });

  await t.test("parses /clear", () => {
    const cmd = parseTuiCommand("/clear");
    assert.strictEqual(cmd.kind, "clear");
  });

  await t.test("parses unknown slash command", () => {
    const cmd = parseTuiCommand("/unknowncmd");
    assert.strictEqual(cmd.kind, "unknown");
  });

  await t.test("trims whitespace from input", () => {
    const cmd = parseTuiCommand("   /help   ");
    assert.strictEqual(cmd.kind, "help");
  });

  await t.test("empty string returns task with empty args", () => {
    const cmd = parseTuiCommand("  ");
    assert.strictEqual(cmd.kind, "task");
  });
});

// -- renderTuiScreen tests -----------------------------------------------------

test("TUI Renderer - renderTuiScreen", async (t) => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { stripAnsi } = await import("../dist/ui/colors.js");

  // Use a fixed state for reproducible tests
  const baseState = {
    ...initialState(),
    width: 100,
    height: 30,
    colorEnabled: false,
  };

  await t.test("contains HIVE in output", () => {
    const frame = renderTuiScreen(baseState);
    assert.ok(
      frame.includes("HIVE"),
      "Expected HIVE in rendered frame"
    );
  });

  await t.test("contains queen bee ASCII motif", () => {
    const frame = renderTuiScreen(baseState);
    // Queen bee has /\_/\ shape
    assert.ok(
      frame.includes("/\\_/\\"),
      "Expected queen bee /\\_/\\ in frame"
    );
  });

  await t.test("contains input row prompt", () => {
    const frame = renderTuiScreen(baseState);
    assert.ok(
      frame.includes("> "),
      "Expected '> ' prompt in input row"
    );
  });

  await t.test("contains status rail footer", () => {
    const frame = renderTuiScreen(baseState);
    // Footer must contain provider: and mode: fields
    assert.ok(
      frame.includes("provider:"),
      "Expected 'provider:' in footer"
    );
    assert.ok(
      frame.includes("mode:"),
      "Expected 'mode:' in footer"
    );
  });

  await t.test("contains command cockpit header", () => {
    const frame = renderTuiScreen(baseState);
    assert.ok(
      frame.includes("HIVE COMMAND COCKPIT"),
      "Expected 'HIVE COMMAND COCKPIT' in right panel"
    );
  });

  await t.test("is ASCII-only after stripping ANSI", () => {
    const frame = renderTuiScreen({ ...baseState, colorEnabled: true });
    const bare = stripAnsi(frame);
    for (let i = 0; i < bare.length; i++) {
      const code = bare.charCodeAt(i);
      assert.ok(
        code <= 127,
        `Non-ASCII character '${bare[i]}' (code ${code}) at index ${i}`
      );
    }
  });

  await t.test("handles narrow width gracefully (40 cols)", () => {
    const narrowState = { ...baseState, width: 40 };
    // Should not throw
    let frame = "";
    assert.doesNotThrow(() => {
      frame = renderTuiScreen(narrowState);
    });
    // Should still contain HIVE
    assert.ok(frame.includes("HIVE"));
  });

  await t.test("no-color mode has no ANSI escape sequences", () => {
    const noColorState = { ...baseState, colorEnabled: false };
    const frame = renderTuiScreen(noColorState);
    assert.ok(
      !frame.includes("\x1b["),
      "Expected no ANSI sequences in no-color mode"
    );
  });

  await t.test("output lines appear in frame", () => {
    const stateWithOutput = {
      ...baseState,
      outputLines: ["  custom output line xyz"],
    };
    const frame = renderTuiScreen(stateWithOutput);
    assert.ok(
      frame.includes("custom output line xyz"),
      "Expected output lines to appear in frame"
    );
  });

  await t.test("input text appears in input row", () => {
    const stateWithInput = { ...baseState, input: "hello world" };
    const frame = renderTuiScreen(stateWithInput);
    assert.ok(
      frame.includes("hello world"),
      "Expected input text in input row"
    );
  });
});

// -- Guard tests ---------------------------------------------------------------

test("TUI Guards - startHiveTui", async (t) => {
  await t.test("does not start TUI when stdout is not a TTY", async () => {
    // In test environment stdout.isTTY is false - startHiveTui should return without side effects
    const { startHiveTui } = await import("../dist/tui/index.js");

    // Save originals
    const origIsTTY = process.stdout.isTTY;
    const origStdinIsTTY = process.stdin.isTTY;

    // Force non-TTY
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    // Should resolve without errors
    await assert.doesNotReject(startHiveTui(process.cwd()));

    // Restore
    Object.defineProperty(process.stdout, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: origStdinIsTTY,
      configurable: true,
    });
  });

  await t.test("does not start TUI when CI=true", async () => {
    const { startHiveTui } = await import("../dist/tui/index.js");

    const origCI = process.env.CI;
    process.env.CI = "true";

    // Should resolve without errors, even if TTY
    await assert.doesNotReject(startHiveTui(process.cwd()));

    if (origCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = origCI;
    }
  });
});

// -- Ctrl+C cleanup test (unit) ------------------------------------------------

test("TUI Cleanup - stop() calls exitAlternateScreen and showCursor", async (t) => {
  const termCtrl = await import("../dist/tui/terminal-control.js");
  
  await t.test("writes exit alternate screen and show cursor sequences", async () => {
    const written = [];
    const origWrite = process.stdout.write.bind(process.stdout);

    // Capture stdout.write calls
    process.stdout.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return true;
    };

    try {
      termCtrl.exitAlternateScreen();
      termCtrl.showCursor();

      assert.ok(
        written.some((w) => w.includes("\x1b[?1049l")),
        "exitAlternateScreen should write \\x1b[?1049l"
      );
      assert.ok(
        written.some((w) => w.includes("\x1b[?25h")),
        "showCursor should write \\x1b[?25h"
      );
    } finally {
      // Always restore
      process.stdout.write = origWrite;
    }
  });
});
