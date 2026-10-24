import assert from "node:assert/strict";
import test from "node:test";

const colors = /\x1b\[(?:0|(?:38|48);2;\d{1,3};\d{1,3};\d{1,3})m/g;
const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

test("terminal text removes CSI, OSC, DCS and C0/C1 controls while retaining prose", async () => {
  const { sanitizeTerminalText } = await import("../dist/tui/display-text.js");
  const source = [
    "before\x1b[2Jafter",
    "\x1b]52;c;CLIPBOARD\x07kept",
    "\x1b]8;;https://host.invalid\x1b\\link\x1b]8;;\x1b\\",
    "\x1bPDEVICE\x1b\\\x1b_APC\x1b\\\x1b^PRIVATE\x1b\\\x1bXSTRING\x1b\\",
    "\u009b2J\u009d52;c;CLIPBOARD\u009c\u0090DEVICE\u009c",
    "\x00\x01\x07\x08\x0b\x0c\x0e\x1f\x7f\u0085\u009c",
    "\x1b[31m中文 👩🏽‍💻 e\u0301\x1b[0m",
  ].join("");
  assert.equal(sanitizeTerminalText(source), "beforeafterkeptlink中文 👩🏽‍💻 e\u0301");
  assert.equal(sanitizeTerminalText("safe\x1b]52;c;unfinished secret"), "safe");
  assert.equal(sanitizeTerminalText("safe\u0090unfinished secret"), "safe");
  assert.equal(sanitizeTerminalText("a\r\nb\rc\td"), "a\nb\nc\td");
});

test("model, command, file, status and draft text cannot inject terminal instructions", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { serializeToolCard } = await import("../dist/tui/tool-card.js");
  const attack = "safe\x1b[2J\x1b]52;c;DO_NOT_COPY\x07\u009bH\u009d8;;https://host.invalid\u009cvisible\x1b]8;;\x1b\\";
  for (const colorEnabled of [false, true]) {
    const state = {
      ...initialState(),
      width: 100,
      height: 30,
      colorEnabled,
      provider: attack,
      model: attack,
      workspaceName: attack,
      transcript: [attack, serializeToolCard({
        id: "call-safe", kind: "command", tool: attack, summary: attack, status: attack,
        expanded: true, mutating: false, prompt: false, body: [attack],
      })],
      input: attack,
      permissionPrompt: attack,
      messageQueue: [attack],
      picker: { kind: "file", selected: 0, items: [{ label: attack, detail: attack, value: attack }] },
    };
    for (const output of [renderTuiScreen(state)]) {
      const plain = output.replace(colors, "");
      assert.equal(controls.test(plain), false, JSON.stringify(plain));
      assert.equal(plain.includes("DO_NOT_COPY"), false);
      assert.equal(plain.includes("host.invalid"), false);
      if (colorEnabled) assert.match(output, /\x1b\[38;2;/);
      else assert.equal(output.includes("\x1b"), false);
    }
    assert.match(renderTuiScreen(state).replace(colors, ""), /safe/);
    assert.equal(state.transcript[0], attack, "display sanitization does not rewrite persisted data");
  }
});

test("terminal cell widths and truncation preserve Unicode grapheme clusters", async () => {
  const { terminalCellWidth, truncateTerminalText } = await import("../dist/tui/display-text.js");
  const { fitVisible } = await import("../dist/tui/transcript-view.js");
  assert.equal(terminalCellWidth("A你🙂e\u0301"), 6);
  assert.equal(terminalCellWidth("👨‍👩‍👧‍👦🇵🇭1️⃣🏳️‍🌈👩🏽‍💻"), 10);
  assert.equal(terminalCellWidth("\u0301"), 0);
  assert.equal(terminalCellWidth("a\tb"), 5);
  assert.equal(terminalCellWidth("\x1b[38;2;1;2;3m你\x1b[0m"), 2);
  assert.equal(truncateTerminalText("a你b", 2), "a");
  assert.equal(truncateTerminalText("👨‍👩‍👧‍👦x", 2), "👨‍👩‍👧‍👦");
  assert.equal(truncateTerminalText("e\u0301x", 1), "e\u0301");
  assert.equal(fitVisible("\x1b[2J\x1b[31m你🙂\x1b[0m", 3), "你");
});

test("composer wrapping preserves indentation and repeated spaces across multiline drafts", async () => {
  const { COMPOSER_CURSOR, layoutComposer } = await import("../dist/tui/transcript-view.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const input = "    const  你 = '👩🏽‍💻';\n      return  e\u0301;";
  const layout = layoutComposer(input, input.length, 18, "  > ");
  assert.equal(layout.rows.map((row) => row.slice(4)).join(""), input.replace(/\n/g, "") + COMPOSER_CURSOR);
  assert.ok(layout.rows.every((row) => terminalCellWidth(row.replace(COMPOSER_CURSOR, "_")) <= 18));
  assert.equal(layout.cursorRow, layout.rows.length - 1);
  const accented = layoutComposer("e\u0301x", 1, 20, "  > ");
  assert.equal(accented.rows.join(""), `  > ${COMPOSER_CURSOR}e\u0301x`, "cursor snaps to the grapheme boundary");
  for (const width of [1, 2, 3, 4, 5]) {
    const narrow = layoutComposer("你👩🏽‍💻", undefined, width, "  > ");
    assert.ok(narrow.rows.every((row) => terminalCellWidth(row.replace(COMPOSER_CURSOR, "_")) <= width));
  }
});

test("fenced code wraps by cells without trimming indentation, tabs or repeated spaces", async () => {
  const { renderEntry, transcriptEntries } = await import("../dist/tui/transcript-view.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const source = "```ts\n    const  你 = '👩🏽‍💻';\n\treturn  e\u0301;\n```";
  const rows = renderEntry(source, 14);
  assert.equal(rows[0], "```ts");
  assert.equal(rows.at(-1), "```");
  assert.equal(rows.slice(1, -1).map((row) => row.slice(2)).join(""), "    const  你 = '👩🏽‍💻';    return  e\u0301;");
  assert.ok(rows.every((row) => terminalCellWidth(row) <= 14));
  assert.ok(rows.slice(1, -1).every((row) => row.startsWith("│ ")));
  const prose = "  keep  repeated   spaces with 中文 and 👨‍👩‍👧‍👦";
  assert.equal(renderEntry(prose, 12).join(""), prose);
  assert.deepEqual(transcriptEntries({ transcript: [], outputLines: [], liveText: "    keep  spaces  " }), ["    keep  spaces  "]);
});

test("Unicode frames stay within terminal cells and retain a transcript majority", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { planSessionFrame } = await import("../dist/tui/transcript-view.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const { initialState } = await import("../dist/tui/state.js");
  for (const colorEnabled of [false, true]) {
    for (const width of [20, 40, 80]) {
      const state = {
        ...initialState(), width, height: 30, colorEnabled,
        workspaceName: "工程项目👩🏽‍💻", model: "模型🇵🇭", provider: "本地",
        transcript: ["中文 prose 👩🏽‍💻 e\u0301 ".repeat(8)],
        input: "    确认  👨‍👩‍👧‍👦 e\u0301\n".repeat(20),
      };
      const rows = renderTuiScreen(state).split("\n");
      assert.equal(rows.length, 30);
      assert.ok(rows.every((row) => terminalCellWidth(row) <= width));
      assert.ok(planSessionFrame(state).transcriptRows > 15);
      assert.match(rows.join("\n"), /中文/);
    }
  }
});

test("a short picker keeps the highlighted command visible as selection moves", async () => {
  const { renderTuiScreen, renderPickerRows } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { planSessionFrame } = await import("../dist/tui/transcript-view.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const items = Array.from({ length: 8 }, (_, index) => ({ label: `/item-${index}`, detail: "Command", insert: `/item-${index}`, submit: true }));
  for (const height of [4, 5, 8, 12]) {
    for (let selected = 0; selected < items.length; selected += 1) {
      const state = { ...initialState(), width: 40, height, colorEnabled: false, asciiGlyphs: true, picker: { kind: "command", query: "", items, selected } };
      const plan = planSessionFrame(state);
      assert.ok(plan.pickerRows > 0);
      const rows = renderTuiScreen(state).split("\n");
      assert.equal(rows.length, height);
      assert.match(rows.join("\n"), new RegExp(`> /item-${selected}`));
      assert.ok(rows.every((line) => terminalCellWidth(line) <= 40));
      assert.equal(renderPickerRows(state, plan.pickerRows).length, plan.pickerRows);
    }
  }
});

test("compact permission controls retain the request, selected option and keyboard hints", async () => {
  const { renderComposerBand, renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState, withPendingPermission } = await import("../dist/tui/state.js");
  const { decidePermission } = await import("../dist/tui/interaction.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const decision = decidePermission("guarded", { kind: "command", target: "npm", inWorkspace: true, confirmed: false });
  for (const asciiGlyphs of [false, true]) {
    for (const choice of [0, 1]) {
      const state = { ...withPendingPermission(initialState(), decision), width: 40, height: 6, colorEnabled: false, asciiGlyphs, permissionChoice: choice };
      const frame = renderTuiScreen(state);
      assert.match(frame, /Allow command npm\?/);
      assert.match(frame, choice === 0 ? /\[1.Yes\] \/ 2.No/ : /1.Yes \/ \[2.No\]/);
      assert.match(frame.split("\n").at(-1), /enter.*esc/);
      for (const available of [1, 2]) {
        const rows = renderComposerBand(state, 40, available);
        assert.equal(rows.length, available);
        assert.match(rows.join("\n"), /Allow command/);
        assert.match(rows.join("\n"), choice === 0 ? /\[1.Yes\]/ : /\[2.No\]/);
        assert.ok(rows.every((line) => terminalCellWidth(line) <= 40));
      }
    }
  }
});

test("long approval targets wrap in the selector body rather than disappearing in its border", async () => {
  const { renderComposerBand } = await import("../dist/tui/renderer.js");
  const { initialState, withPendingPermission } = await import("../dist/tui/state.js");
  const { decidePermission } = await import("../dist/tui/interaction.js");
  const { composerBandRows } = await import("../dist/tui/transcript-view.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const target = "packages/工程👩🏽‍💻/long-module-name-that-wraps/long-target-with-tail.ts";
  const state = { ...withPendingPermission(initialState(), decidePermission("guarded", { kind: "edit", target, inWorkspace: true, confirmed: false })), colorEnabled: false, asciiGlyphs: false, height: 30 };
  for (const width of [24, 40, 60]) {
    const rows = renderComposerBand(state, width, composerBandRows(state, width));
    assert.match(rows[0], /Approval/);
    assert.ok(rows.every((line) => terminalCellWidth(line) <= width));
    const body = rows.slice(1, -1).map((line) => line.slice(2, -2)).join("").replace(/\s/g, "");
    assert.ok(body.includes(target.replace(/\s/g, "")));
    assert.match(rows.join("\n"), /1\. Yes/);
    assert.match(rows.join("\n"), /2\. No/);
  }
});

test("approval instructions stay ahead of runtime metadata in an 80-column footer", async () => {
  const { renderStatusBar } = await import("../dist/tui/renderer.js");
  const { initialState, withPendingPermission } = await import("../dist/tui/state.js");
  const { decidePermission } = await import("../dist/tui/interaction.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const base = { ...withPendingPermission(initialState(), decidePermission("guarded", { kind: "command", target: "npm", inWorkspace: true, confirmed: false })), provider: "configured-provider", model: "long-model-name", workspaceName: "current-workspace", colorEnabled: false };
  for (const asciiGlyphs of [false, true]) {
    const footer = renderStatusBar({ ...base, asciiGlyphs }, 80);
    assert.match(footer, /guarded mode/);
    assert.match(footer, /enter confirms/);
    assert.match(footer, /esc declines/);
    assert.ok(terminalCellWidth(footer) <= 80);
    const narrow = renderStatusBar({ ...base, asciiGlyphs }, 24);
    assert.match(narrow, /enter.*esc/);
    assert.ok(terminalCellWidth(narrow) <= 24);
  }
});

test("narrow welcome cards wrap their full tagline, runtime, workspace and command hints", async () => {
  const { renderTranscriptRows, renderHiveMascot, plainRow } = await import("../dist/tui/transcript-view.js");
  const { ASCII_GLYPHS } = await import("../dist/tui/glyphs.js");
  const mascot = new Set(renderHiveMascot(ASCII_GLYPHS).map(plainRow));
  const { initialState } = await import("../dist/tui/state.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  for (const width of [24, 32, 40, 60]) {
    const rows = renderTranscriptRows({ ...initialState(), width, asciiGlyphs: true, provider: "provider-name", model: "model-with-tail", workspaceName: "workspace-with-tail", gitBranch: "feature/clarity", transcript: [], outputLines: [] }, width).map(plainRow);
    assert.ok(rows.every((line) => terminalCellWidth(line) <= width));
    const content = rows.map((line) => {
      const body = line.startsWith("| ") ? line.slice(2, -2) : line;
      return mascot.has(body.slice(0, 13)) && body.slice(13, 15) === "  " ? body.slice(15) : body;
    }).join("").replace(/\s/g, "");
    for (const expected of ["HyperIntelligenceforVerifiedEngineering", "provider-name", "model-with-tail", "workspace-with-tail", "feature/clarity", "/helpforcommands", "@forfiles", "shift+tabformodes"]) {
      assert.ok(content.includes(expected), `${width}-cell welcome lost ${expected}`);
    }
  }
});

test("no-provider runtime reads as a next step in the welcome card and footer", async () => {
  const { renderTranscriptRows, plainRow } = await import("../dist/tui/transcript-view.js");
  const { renderStatusBar } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  for (const asciiGlyphs of [false, true]) {
    const state = { ...initialState(), width: 80, asciiGlyphs, colorEnabled: false, transcript: [], outputLines: [] };
    const card = renderTranscriptRows(state, 80).map(plainRow).join("\n");
    assert.match(card, /No provider yet . \/providers to connect one/);
    assert.doesNotMatch(card, /none/);
    const footer = renderStatusBar(state, 120);
    assert.match(footer, /no provider/);
    assert.doesNotMatch(footer, /none\/none/);
  }
});

test("ASCII glyphs keep the result connector printable and long paths keep both ends", async () => {
  const { ASCII_GLYPHS } = await import("../dist/tui/glyphs.js");
  const { truncateMiddle, terminalCellWidth } = await import("../dist/tui/display-text.js");
  assert.equal(ASCII_GLYPHS.result, "|");
  const long = "C:\Users\someone\Documents\projects\clients\acme\HIVE";
  for (const width of [12, 20, 30]) {
    const fitted = truncateMiddle(long, width);
    assert.ok(terminalCellWidth(fitted) <= width, `${fitted} exceeds ${width}`);
    assert.ok(fitted.startsWith("C:"), fitted);
    assert.ok(fitted.endsWith("HIVE"), fitted);
    assert.match(fitted, /…/);
  }
  assert.equal(truncateMiddle("short", 20), "short");
  assert.equal(truncateMiddle(long, 20, "...").includes("..."), true);
});
