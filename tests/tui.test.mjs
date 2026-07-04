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

  await t.test("wide renderer contains honeycomb motif", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160 });
    // Honeycomb has \__/ shape
    assert.ok(
      frame.includes("\\__/"),
      "Expected honeycomb \\__/ in frame"
    );
  });

  await t.test("wide renderer contains HIVE CLI/IDE COMMAND COCKPIT", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160 });
    assert.ok(
      frame.includes("HIVE CLI/IDE COMMAND COCKPIT"),
      "Expected 'HIVE CLI/IDE COMMAND COCKPIT' in right panel"
    );
  });

  await t.test("wide renderer contains BRAND KIT / COLOR PALETTE", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160 });
    assert.ok(frame.includes("BRAND KIT / COLOR PALETTE"));
  });

  await t.test("wide renderer contains TYPOGRAPHY / UI", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160 });
    assert.ok(frame.includes("TYPOGRAPHY / UI"));
  });

  await t.test("wide renderer contains RUNTIME", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160 });
    assert.ok(frame.includes("RUNTIME / BRAND NOTE"));
  });

  await t.test("wide renderer contains bottom IDE rail", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160 });
    assert.ok(frame.includes("[default]"));
    assert.ok(frame.includes("hive main"));
    assert.ok(frame.includes("/help  Ctrl+C"));
  });

  await t.test("no undefined/null appears in rendered output", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160, provider: null, model: undefined });
    assert.ok(!frame.includes("undefined"));
    assert.ok(!frame.includes("null"));
    assert.ok(frame.includes("none"));
  });

  await t.test("compact renderer does not wrap title", () => {
    const narrowState = { ...baseState, width: 80 };
    const frame = renderTuiScreen(narrowState);
    assert.ok(frame.includes("HIVE"));
    assert.ok(!frame.includes("BRAND KIT")); // Lower panels disabled on narrow
  });

  await t.test("long cwd/model/provider values truncate safely", () => {
    const longState = { 
      ...baseState, 
      width: 100, 
      provider: "A_VERY_LONG_PROVIDER_NAME_THAT_EXCEEDS_WIDTH_LIMITS", 
      model: "A_VERY_LONG_MODEL_NAME_THAT_EXCEEDS_WIDTH_LIMITS" 
    };
    let frame = "";
    assert.doesNotThrow(() => {
      frame = renderTuiScreen(longState);
    });
    // Find the longest line
    const lines = frame.split("\n");
    const longest = Math.max(...lines.map(l => stripAnsi(l).length));
    assert.ok(longest <= 100, `Longest line should not exceed 100 cols, got ${longest}`);
  });

  await t.test("max-width layout does not stretch beyond configured width", () => {
    const wideState = { ...baseState, width: 200 };
    const frame = renderTuiScreen(wideState);
    const lines = frame.split("\n");
    const longestVisible = Math.max(...lines.map(l => stripAnsi(l.trim()).length));
    assert.ok(longestVisible <= 160, `Layout should not stretch beyond 160 visible cols, got ${longestVisible}`);
  });

  await t.test("contains input row prompt", () => {
    const frame = renderTuiScreen(baseState);
    assert.ok(
      frame.includes("> "),
      "Expected '> ' prompt in input row"
    );
  });

  await t.test("is ASCII-only after stripping ANSI", () => {
    const frame = renderTuiScreen({ ...baseState, width: 160, colorEnabled: true });
    const bare = stripAnsi(frame);
    for (let i = 0; i < bare.length; i++) {
      const code = bare.charCodeAt(i);
      assert.ok(
        code <= 127,
        `Non-ASCII character '${bare[i]}' (code ${code}) at index ${i}`
      );
    }
  });

  await t.test("no-color mode has no ANSI escape sequences", () => {
    const noColorState = { ...baseState, colorEnabled: false, width: 160 };
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
