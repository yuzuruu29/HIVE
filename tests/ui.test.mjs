import test from "node:test";
import assert from "node:assert";
import {
  renderStartupFrame,
  renderCompactStartupFrame,
  renderPlainStartupText,
  renderHelpFrame,
  renderHiveWordmark,
  stripAnsi
} from "../dist/ui/index.js";

test("UI Branding", async (t) => {
  await t.test("full startup frame uses the session's skep and bee", () => {
    const frame = renderStartupFrame(100, false);
    assert.ok(frame.includes("HIVE"));
    assert.ok(frame.includes("Hyper Intelligence for Verified Engineering"));
    assert.ok(frame.includes("(=====n=====)"));
    assert.ok(frame.includes("{o}"));
    assert.equal(frame.includes("/\\_/\\"), false);
  });

  await t.test("compact startup frame uses the same skep and banner", () => {
    const frame = renderCompactStartupFrame(70, false);
    assert.ok(frame.includes("HIVE - Verified Agentic Coding"));
    assert.ok(frame.includes("(=====n=====)"));
  });
  
  await t.test("plain startup text contains banner", () => {
    const text = renderPlainStartupText(false);
    assert.ok(text.includes("HIVE - Verified Agentic Coding"));
    assert.ok(text.includes("hive run"));
  });

  await t.test("no-color mode strips ANSI and uses ASCII", () => {
    const colored = renderHiveWordmark("HIVE", { color: true });
    assert.ok(colored.includes("\x1b[38;2;"));
    
    const stripped = stripAnsi(colored);
    assert.strictEqual(stripped, "HIVE");
    assert.ok(!stripped.includes("\x1b["));
  });

  await t.test("output contains no non-ASCII characters", () => {
    const frame = renderStartupFrame(100, false);
    const compact = renderCompactStartupFrame(70, false);
    const plain = renderPlainStartupText(false);
    
    // Check that every character is in the standard ASCII range (0-127)
    for (let i = 0; i < frame.length; i++) {
      assert.ok(frame.charCodeAt(i) <= 127, `Full frame contains non-ASCII character: ${frame[i]} at index ${i}`);
    }
    for (let i = 0; i < compact.length; i++) {
      assert.ok(compact.charCodeAt(i) <= 127, `Compact frame contains non-ASCII character: ${compact[i]} at index ${i}`);
    }
    for (let i = 0; i < plain.length; i++) {
      assert.ok(plain.charCodeAt(i) <= 127, `Plain text contains non-ASCII character: ${plain[i]} at index ${i}`);
    }
  });

  await t.test("NO_COLOR disables gradient", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    
    const { supportsColorOutput } = await import("../dist/ui/terminal.js");
    assert.strictEqual(supportsColorOutput(), false);
    
    // Test the fallback
    const output = renderHiveWordmark("HIVE");
    assert.strictEqual(output, "HIVE");
    assert.ok(!output.includes("\x1b["));
    
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  await t.test("output remains readable without ANSI", () => {
    const frame = stripAnsi(renderStartupFrame(100, true));
    assert.ok(frame.includes("HIVE"));
    assert.ok(frame.includes("Hyper Intelligence for Verified Engineering"));
    
    const compact = stripAnsi(renderCompactStartupFrame(70, true));
    assert.ok(compact.includes("HIVE"));
    assert.ok(compact.includes("Verified"));
  });
});

test("startup and help frames fit terminal cells and retain long workspace paths", async () => {
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const { renderHiveMascot, plainRow } = await import("../dist/tui/transcript-view.js");
  const { ASCII_GLYPHS } = await import("../dist/tui/glyphs.js");
  const mascot = new Set(renderHiveMascot(ASCII_GLYPHS).map(plainRow));
  const content = (output) => stripAnsi(output).split("\n").map((line) => {
    const body = line.startsWith("| ") ? line.slice(2, -2) : line;
    return mascot.has(body.slice(0, 13)) && body.slice(13, 15) === "  " ? body.slice(15) : body;
  }).join("").replace(/\s/g, "");
  const originalCwd = process.cwd;
  const workspace = `C:\\工程👩🏽‍💻\\${"long-workspace-name-".repeat(14)}tail`;
  process.cwd = () => workspace;
  try {
    for (const width of [12, 24, 40, 60, 70, 100, 160]) {
      for (const color of [false, true]) {
        for (const output of [renderStartupFrame(width, color), renderCompactStartupFrame(width, color), renderPlainStartupText(color, width)]) {
          assert.ok(output.split("\n").every((line) => terminalCellWidth(line) <= width), `${width}-cell startup overflow`);
          const plain = content(output);
          assert.ok(plain.includes(workspace.replace(/\s/g, "")), "the full workspace survives wrapping");
          assert.ok(plain.includes("hiveproviderssetup"));
          assert.ok(plain.includes("HyperIntelligenceforVerifiedEngineering"));
        }
        const help = renderHelpFrame(width, color, `hive run <task>\n${"你👩🏽‍💻e\u0301".repeat(60)}\nUse --help for commands.`);
        assert.ok(help.split("\n").every((line) => terminalCellWidth(line) <= width), `${width}-cell help overflow`);
        const text = stripAnsi(help).split("\n").map((line) => line.startsWith("| ") ? line.slice(2, -2) : line).join("").replace(/\s/g, "");
        assert.ok(text.includes("你👩🏽‍💻e\u0301".repeat(60)), "help wraps whole graphemes without losing content");
      }
    }
  } finally {
    process.cwd = originalCwd;
  }
});

// --- TUI Actions Tests ---
// Test the logic of TUI actions directly by simulating a pure state reducer
test("TUI Actions State Reducer", async (t) => {
  // Pure state reducer for hypothetical UI panes
  function uiReducer(state, action) {
    switch (action.type) {
      case "KEY_A":
        return state.taskState === "AWAITING_APPROVAL" ? { ...state, modal: "approve_confirm" } : { ...state, warning: "No task to approve" };
      case "KEY_X":
        return state.activeTaskId ? { ...state, modal: "discard_confirm" } : { ...state, warning: "No task to discard" };
      case "KEY_D":
        return state.activeTaskId ? { ...state, activePane: "diff" } : state;
      case "KEY_T":
        return state.activeTaskId ? { ...state, activePane: "transcript" } : state;
      default:
        return state;
    }
  }

  const initialState = {
    activeTaskId: null,
    taskState: "IDLE",
    activePane: "main",
    modal: null,
    warning: null
  };

  const activeState = {
    activeTaskId: "task-123",
    taskState: "AWAITING_APPROVAL",
    activePane: "main",
    modal: null,
    warning: null
  };

  await t.test("approve action logic (KEY_A) safely refuses if no approvable task", () => {
    const nextState = uiReducer(initialState, { type: "KEY_A" });
    assert.strictEqual(nextState.modal, null);
    assert.strictEqual(nextState.warning, "No task to approve");
  });

  await t.test("approve action logic (KEY_A) shows confirmation when awaiting approval", () => {
    const nextState = uiReducer(activeState, { type: "KEY_A" });
    assert.strictEqual(nextState.modal, "approve_confirm");
  });

  await t.test("discard action logic (KEY_X) shows confirmation when task active", () => {
    const nextState = uiReducer(activeState, { type: "KEY_X" });
    assert.strictEqual(nextState.modal, "discard_confirm");
  });

  await t.test("discard action logic (KEY_X) safely refuses if no task active", () => {
    const nextState = uiReducer(initialState, { type: "KEY_X" });
    assert.strictEqual(nextState.modal, null);
    assert.strictEqual(nextState.warning, "No task to discard");
  });

  await t.test("diff viewing logic (KEY_D) opens diff pane", () => {
    const nextState = uiReducer(activeState, { type: "KEY_D" });
    assert.strictEqual(nextState.activePane, "diff");
  });

  await t.test("transcript navigation logic (KEY_T) opens transcript pane", () => {
    const nextState = uiReducer(activeState, { type: "KEY_T" });
    assert.strictEqual(nextState.activePane, "transcript");
  });
});
