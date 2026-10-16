/**
 * tui-transcript.test.mjs
 * Transcript-first session frame, scrollback, and wrapped assistant prose.
 */

import assert from "node:assert/strict";
import test from "node:test";

function session(extra = {}) {
  return {
    width: 100,
    height: 30,
    colorEnabled: false,
    transcript: [],
    outputLines: [],
    scrollOffset: 0,
    input: "",
    sessionMode: "guarded",
    provider: "openai",
    model: "gpt-test",
    sessionId: "sess-1",
    taskStatus: "idle",
    subagents: [],
    subagentsExpanded: false,
    asciiGlyphs: false,
    ...extra,
  };
}

test("a 30-row session is status, transcript, and a short composer", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const frame = renderTuiScreen({
    ...initialState(),
    ...session({
      transcript: ["alpha keeps the top of the turn", "omega is the newest transcript line"],
    }),
  });
  const lines = frame.split("\n");
  assert.equal(lines.length, 30);
  const status = lines.at(-1);
  const composer = lines.slice(-4, -1);
  const transcript = lines.slice(0, -4);
  assert.match(status, /guarded mode/);
  assert.match(status, /openai\/gpt-test/);
  assert.match(status, /session:sess-1/);
  assert.equal(status.includes("\n"), false);
  assert.equal(composer.length, 3);
  assert.match(composer[0], /^╭─+╮$/);
  assert.match(composer[1], /^│ > _ +│$/);
  assert.match(composer[2], /^╰─+╯$/);
  assert.match(status, /shift\+tab to cycle/);
  assert.ok(transcript.length > lines.length / 2, `transcript rows ${transcript.length}`);
  assert.equal(transcript.length, 26);
  assert.match(transcript.join("\n"), /omega is the newest transcript line/);
  assert.equal(frame.includes("\\__/"), false);
  assert.equal(frame.includes("BRAND KIT"), false);
  assert.equal(frame.includes("TYPOGRAPHY"), false);
  assert.ok(lines.every((line) => line.length <= 100));
});

test("scrollOffset hides the newest line until the view is pinned to the bottom", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { appendTranscriptLine, initialState } = await import("../dist/tui/state.js");
  const lines = Array.from({ length: 80 }, (_, index) => `row-${String(index).padStart(3, "0")}-token`);
  lines[0] = "OLDEST-LINE";
  lines[79] = "NEWEST-LINE";
  const base = {
    ...initialState(),
    ...session({ transcript: lines, scrollOffset: 0 }),
  };

  const pinned = renderTuiScreen(base);
  assert.match(pinned, /NEWEST-LINE/);
  assert.equal(pinned.includes("OLDEST-LINE"), false);

  const scrolled = renderTuiScreen({ ...base, scrollOffset: 80 });
  assert.match(scrolled, /OLDEST-LINE/);
  assert.equal(scrolled.includes("NEWEST-LINE"), false);
  assert.match(scrolled.split("\n").at(-1), /scrolled/);

  let parked = { ...base, scrollOffset: 20 };
  parked = appendTranscriptLine(parked, "EXTRA-TOKEN");
  assert.ok(parked.scrollOffset > 20);
  const parkedFrame = renderTuiScreen(parked);
  assert.equal(parkedFrame.includes("EXTRA-TOKEN"), false);

  const followed = appendTranscriptLine({ ...base, scrollOffset: 0 }, "PINNED-TOKEN");
  assert.equal(followed.scrollOffset, 0);
  assert.match(renderTuiScreen(followed), /PINNED-TOKEN/);
});

test("PageUp, PageDown, Ctrl+U, Ctrl+D, and the wheel move the transcript", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { TuiApp } = await import("../dist/tui/app.js");
  const { initialState } = await import("../dist/tui/state.js");
  const lines = Array.from({ length: 80 }, (_, index) => `nav-${String(index).padStart(3, "0")}`);
  lines[0] = "OLDEST-LINE";
  lines[79] = "NEWEST-LINE";
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd());
    app.state = {
      ...initialState(),
      ...session({ transcript: lines }),
    };
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };

    feed("\x1b[5~");
    assert.ok(app.state.scrollOffset > 0);
    assert.equal(app.stopped, false);
    assert.equal(renderTuiScreen(app.state).includes("NEWEST-LINE"), false);

    const parked = app.state.scrollOffset;
    feed("\x1b[<64;8;8M");
    assert.ok(app.state.scrollOffset > parked);
    assert.equal(app.state.input, "");

    feed("\x04");
    assert.ok(app.state.scrollOffset < parked + 3);
    assert.equal(app.stopped, false);

    feed("\x15");
    assert.ok(app.state.scrollOffset > 0);

    feed("\x1b[<65;8;8M");
    feed("\x1b[6~");
    assert.equal(app.state.scrollOffset, 0);
    assert.match(renderTuiScreen(app.state), /NEWEST-LINE/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("assistant prose wraps, and a fenced block stays distinct", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { commitLiveText, initialState, withLiveText } = await import("../dist/tui/state.js");
  const { renderTranscriptBody } = await import("../dist/tui/transcript-view.js");
  const words = Array.from({ length: 36 }, (_, index) => `word${index}`);
  const prose = [
    words.join(" "),
    "",
    "```ts",
    "const keep = true;",
    "```",
    "Plan mode does not apply edits.",
  ].join("\n");
  let state = {
    ...initialState(),
    ...session({ width: 40, height: 30, provider: "mock", model: "buffered" }),
  };
  const snapshots = [];
  state = withLiveText(state, prose);
  snapshots.push(state.liveText);
  const liveFrame = renderTuiScreen(state);
  assert.deepEqual(snapshots, [prose]);
  assert.match(liveFrame, /word0/);
  assert.match(liveFrame, /word35/);
  assert.match(liveFrame, /│ const keep = true;/);
  assert.match(liveFrame, /Plan mode does not apply edits/);
  assert.ok(liveFrame.split("\n").every((line) => line.length <= 40));
  const codeLine = liveFrame.split("\n").find((line) => line.includes("const keep = true"));
  assert.equal(codeLine, "  │ const keep = true;");

  state = commitLiveText(state);
  assert.equal(state.liveText, undefined);
  const committed = renderTranscriptBody(state, 40).join("\n");
  assert.match(committed, /word0/);
  assert.match(committed, /word35/);
  assert.match(committed, /│ const keep = true;/);
  assert.match(renderTuiScreen(state), /word35/);
});

test("a one-shot planner completion stays visible when the turn finishes", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const prose = [
    "PLAN-START keep the auth gate read only for this buffered completion.",
    "The architecture extends the existing session gate.",
    "```ts",
    "const keep = true;",
    "```",
    "PLAN-END the full buffered text stays in the transcript.",
  ].join("\n");
  let projected = {
    ...initialState(),
    width: 48,
    height: 30,
    colorEnabled: false,
    sessionMode: "plan",
  };
  const result = await executeTuiCommand(
    parseTuiCommand("describe the auth gate"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    {
      runSession: async ({ onText, onEvent }) => {
        onText?.(prose);
        onEvent({
          schemaVersion: 1,
          id: "event-plan",
          sequence: 1,
          sessionId: "session-plan",
          timestamp: "2026-10-16T00:00:00.000Z",
          type: "plan.created",
          payload: { summary: prose, taskIds: ["bee-001"] },
        });
        onEvent({
          schemaVersion: 1,
          id: "event-done",
          sequence: 2,
          sessionId: "session-plan",
          timestamp: "2026-10-16T00:00:01.000Z",
          type: "session.completed",
          payload: { summary: "done" },
        });
      },
    },
  );
  projected = result.state;
  await result.runtime.completion;
  const transcript = projected.transcript.join("\n");
  assert.match(transcript, /PLAN-START keep the auth gate/);
  assert.match(transcript, /PLAN-END the full buffered text/);
  assert.match(transcript, /const keep = true/);
  assert.equal(transcript.includes("word1"), false);
  const frame = renderTuiScreen({
    ...projected,
    width: 48,
    height: 30,
    colorEnabled: false,
    asciiGlyphs: false,
    scrollOffset: 0,
  });
  assert.match(frame, /PLAN-END the full buffered text/);
  assert.match(frame, /│ const keep = true;/);
  assert.match(frame, /Plan mode did not apply edits/);
});

test("the composer cursor moves, and Ctrl+J inserts a newline inside the bottom band", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { TuiApp } = await import("../dist/tui/app.js");
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd());
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };
    const frameOf = () => renderTuiScreen({ ...app.state, width: 100, height: 30, colorEnabled: false, asciiGlyphs: false });
    const composerLine = () => frameOf().split("\n").find((line) => line.startsWith("│ > "))?.trimEnd();

    feed("ac");
    feed("\x1b[D");
    feed("b");
    assert.equal(app.state.input, "abc");
    assert.equal(app.state.cursor, 2);
    feed("\x1b[D");
    assert.match(composerLine(), /^│ > a_bc +│$/);

    feed("\x1b[H");
    assert.equal(app.state.cursor, 0);
    assert.match(composerLine(), /^│ > _abc +│$/);
    feed("\x1b[3~");
    assert.equal(app.state.input, "bc");
    assert.equal(app.state.cursor, 0);

    feed("\x1b[F");
    feed("\x7f");
    assert.equal(app.state.input, "b");
    feed("\n");
    feed("z");
    assert.equal(app.state.input, "b\nz");
    assert.equal(app.state.cursor, 3);

    const frame = frameOf();
    const lines = frame.split("\n");
    assert.equal(lines.length, 30);
    const rule = lines.findLastIndex((line) => line.startsWith("╭"));
    const transcript = lines.slice(0, rule);
    const band = lines.slice(rule);
    assert.ok(rule > lines.length / 2, `composer box at ${rule}`);
    assert.ok(transcript.length > lines.length / 2, `transcript rows ${transcript.length}`);
    assert.match(band.join("\n"), /> b/);
    assert.match(band.join("\n"), /z_/);
    assert.match(band.join("\n"), /shift\+tab to cycle/);
    assert.equal(transcript.join("\n").includes("z_"), false);
    assert.ok(lines.every((line) => line.length <= 100));

    const help = new TuiApp(process.cwd());
    help.inputBuffer += "/help\r";
    help.processInputBuffer();
    for (let attempt = 0; attempt < 5 && !help.state.transcript.join("\n").includes("Ctrl+J"); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.match(help.state.transcript.join("\n"), /Ctrl\+J inserts a newline/);
    assert.equal(help.state.input, "");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("a pasted newline stays in the composer, and a tall draft does not take the transcript majority", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { TuiApp } = await import("../dist/tui/app.js");
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd());
    app.inputBuffer += "one\r\ntwo";
    app.processInputBuffer();
    assert.equal(app.state.input, "one\ntwo");
    assert.equal(app.state.transcript.some((line) => line.includes("$ one")), false);
    assert.equal(app.stopped, false);
  } finally {
    process.stdout.write = originalWrite;
  }

  const input = Array.from({ length: 20 }, (_, index) => `block ${index} ${"x".repeat(30)}`).join("\n");
  const frame = renderTuiScreen({
    ...initialState(),
    ...session({ transcript: ["TRANSCRIPT-TOKEN"], input, cursor: input.length }),
  });
  const lines = frame.split("\n");
  assert.equal(lines.length, 30);
  const rule = lines.findLastIndex((line) => line.startsWith("╭"));
  const transcript = lines.slice(0, rule);
  const band = lines.slice(rule);
  assert.ok(transcript.length > lines.length / 2, `transcript rows ${transcript.length}`);
  assert.match(transcript.join("\n"), /TRANSCRIPT-TOKEN/);
  assert.equal(transcript.join("\n").includes("block 0"), false);
  assert.match(band.join("\n"), /block 19/);
  assert.match(band.join("\n"), /guarded mode/);
  assert.equal(band.join("\n").includes("TRANSCRIPT-TOKEN"), false);
  assert.ok(lines.every((line) => line.length <= 100));
});

test("assistant prose renders headings, lists, and inline code, and keeps the fence gutter", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { renderTranscriptBody } = await import("../dist/tui/transcript-view.js");
  const source = [
    "# Auth gate",
    "",
    "- keep the gate",
    "Call `decidePermission` now.",
    "```ts",
    "# keep",
    "const keep = true;",
    "```",
    "<b>not html</b>",
  ].join("\n");
  const rendered = renderTranscriptBody({
    ...initialState(),
    asciiGlyphs: false,
    transcript: [source],
    outputLines: [],
    liveText: undefined,
  }, 60).join("\n");
  assert.match(rendered, /^● Auth gate$/m);
  assert.equal(rendered.includes("# Auth gate"), false);
  assert.match(rendered, /^ {4}- keep the gate$/m);
  assert.match(rendered, /Call decidePermission now\./);
  assert.equal(rendered.includes("`decidePermission`"), false);
  assert.match(rendered, /│ # keep/);
  assert.match(rendered, /│ const keep = true;/);
  assert.match(rendered, /<b>not html<\/b>/);
  assert.equal(rendered.includes("\x1b["), false);

  const frame = renderTuiScreen({
    ...initialState(),
    ...session({ transcript: [source], width: 80, height: 30 }),
  });
  const lines = frame.split("\n");
  assert.equal(lines.length, 30);
  const rule = lines.findLastIndex((line) => line.startsWith("╭"));
  assert.ok(lines.slice(0, rule).length > lines.length / 2);
  assert.match(frame, /Auth gate/);
  assert.match(frame, /decidePermission/);
  assert.match(frame, /│ const keep = true;/);
  assert.equal(frame.includes("`decidePermission`"), false);
  assert.equal(frame.includes("\x1b["), false);
});

test("transcript rows separate turns and tone user text, cards, and diffs", async () => {
  const { renderTranscriptRows, plainRow } = await import("../dist/tui/transcript-view.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { serializeToolCard } = await import("../dist/tui/tool-card.js");
  const card = serializeToolCard({
    id: "c1", kind: "edit", tool: "edit_file", summary: "src/a.ts", status: "asking",
    expanded: true, mutating: true, prompt: true, body: ["@@ -1 +1 @@", "-old", "+new"],
  });
  const transcript = ["[User] fix it", "On it.", card, "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -7,2 +7,2 @@", "-removed", "+added", "[Error] boom"];
  const rows = renderTranscriptRows({ ...initialState(), width: 60, asciiGlyphs: false, transcript }, 60);
  const plain = rows.map(plainRow);
  const toneOf = (text) => rows.find((row) => plainRow(row).includes(text))?.at(-1)?.tone;
  const hive = plain.findIndex((line) => line.includes("▄▄███▄▄"));
  assert.ok(hive > 1 && plain[hive + 3].includes("▄████▀ ▀████▄"), "the welcome card carries the hive");
  assert.match(plain[hive - 1], /^│ {11}ʚ●ɞ  HIVE/, "the bee rests top right at idle");
  assert.equal(rows[hive - 1].find((part) => part.text === "●").tone, "gold");
  const user = plain.indexOf("› fix it");
  assert.ok(user > 0);
  assert.equal(plain[user - 1], "", "a blank row opens each user turn");
  assert.equal(toneOf("fix it"), "user");
  assert.equal(plain[user + 1], "", "a blank row separates the user turn from the reply");
  assert.equal(plain[user + 2], "● On it.");
  assert.match(plain.find((line) => line.includes("edit_file")), /^❯ edit_file\(src\/a\.ts\) +asking$/);
  assert.equal(toneOf("asking"), "warn");
  assert.ok(plain.includes("  ⎿  @@ -1 +1 @@"));
  assert.ok(plain.includes("        1 - old"), "card diffs are numbered from the hunk header");
  assert.ok(plain.includes("        1 + new"));
  assert.equal(toneOf("1 + new"), "add");
  assert.equal(toneOf("1 - old"), "del");
  assert.ok(plain.includes("     Awaiting approval"));
  assert.ok(plain.includes("        7 - removed"), "standalone diff lines are numbered, not read as markdown bullets");
  assert.equal(toneOf("7 - removed"), "del");
  assert.equal(toneOf("7 + added"), "add");
  assert.match(plain.find((line) => line.includes("/help for commands")), /shift\+tab for modes$/);
  assert.equal(plain.at(-1), "● Error: boom");
  assert.equal(toneOf("boom"), "error");
  for (const line of plain) assert.ok(line.length <= 60);

  const ascii = renderTranscriptRows({ ...initialState(), width: 60, asciiGlyphs: true, transcript }, 60).map(plainRow).join("\n");
  assert.equal(/[^\x00-\x7f]/.test(ascii), false, "the ASCII fallback draws only ASCII");
  assert.match(ascii, /\(=====n=====\)/);
  assert.match(ascii, /^\* On it\.$/m);
});

test("the permission selector moves with arrows and an empty Enter confirms the highlighted option", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { TuiApp } = await import("../dist/tui/app.js");
  const { initialState, withPendingPermission } = await import("../dist/tui/state.js");
  const { decidePermission } = await import("../dist/tui/interaction.js");
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd());
    const decision = decidePermission("guarded", { kind: "edit", target: "workspace", inWorkspace: true, confirmed: false });
    app.state = withPendingPermission({ ...initialState(), ...session() }, decision);
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };
    const frame = () => renderTuiScreen(app.state);
    assert.match(frame(), /╭─ Allow in-workspace edits\? ─+╮/);
    assert.match(frame(), /│ ❯ 1\. Yes +│/);
    feed("\x1b[B");
    assert.equal(app.state.permissionChoice, 1);
    assert.match(frame(), /│ ❯ 2\. No \(esc\) +│/);
    assert.match(frame().split("\n").at(-1), /enter confirms/);
    feed("\r");
    assert.equal(app.state.pendingPermission, undefined);
    assert.equal(app.state.editsApproved, false);
    assert.match(app.state.transcript.join("\n"), /denied/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("the working bee rests without motion and flies across a fixed lane with it", async () => {
  const { renderComposerBand, FRAME_MS } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { terminalCellWidth } = await import("../dist/tui/display-text.js");
  const base = { ...initialState(), ...session(), taskStatus: "running", turnStartedAt: 0 };
  assert.match(renderComposerBand({ ...base, motionEnabled: false }, 80, 6, 12_000)[0], /^ʚ●ɞ Working… \(12s · esc to interrupt\)/);
  const lanes = [];
  for (let frame = 0; frame < 8; frame += 1) {
    const row = renderComposerBand({ ...base, motionEnabled: true }, 80, 6, frame * FRAME_MS)[0];
    const lane = [...row].slice(0, 7).join("");
    assert.equal(terminalCellWidth(lane), 7, lane);
    assert.match(lane, frame % 2 === 0 ? /ʚ●ɞ/ : /ε●з/);
    assert.equal(row.slice(lane.length, lane.length + 9), " Working…");
    lanes.push(lane.indexOf("●"));
  }
  assert.deepEqual(lanes, [1, 2, 3, 4, 5, 4, 3, 2], "the bee flies right, then back");
  const ascii = renderComposerBand({ ...base, motionEnabled: false, asciiGlyphs: true }, 80, 6, 0)[0];
  assert.match(ascii, /^\{o\} Working\.\.\./);
});

test("motion pulses a running card, circles the hive bee and blinks a streaming caret", async () => {
  const { renderTranscriptRows, plainRow } = await import("../dist/tui/transcript-view.js");
  const { serializeToolCard } = await import("../dist/tui/tool-card.js");
  const card = serializeToolCard({ id: "r", kind: "command", tool: "run_command", summary: "npm test", status: "running", expanded: false, mutating: false, prompt: false, body: [] });
  // The last card takes focus by default, so the running card goes first.
  const done = serializeToolCard({ id: "d", kind: "read", tool: "read_file", summary: "a.ts", status: "done", expanded: false, mutating: false, prompt: false, body: [] });
  const state = { ...session({ asciiGlyphs: false }), taskStatus: "running", transcript: [card, done], liveText: "Streaming now" };
  const at = (frame) => renderTranscriptRows(state, 100, frame);
  const cardRow = (rows) => rows.find((row) => plainRow(row).includes("run_command("));
  assert.equal(cardRow(at(0))[0].tone, "accent");
  assert.equal(cardRow(at(3))[0].tone, "dim");
  // The sky row follows the card's top border; "│ " leads, then the bee's left wing.
  const beeAt = (frame) => plainRow(at(frame)[1]).indexOf("●") - 3;
  assert.deepEqual(Array.from({ length: 10 }, (_, frame) => beeAt(frame)), [10, 8, 6, 4, 2, 0, 2, 4, 6, 8], "the bee flies over the hive and back");
  assert.match(plainRow(at(1)[1]), /ε●з/, "the wings fold on odd frames");
  assert.equal(at(0).length, at(4).length, "moving the bee never changes the row count");
  assert.match(plainRow(at(0).at(-1)), /Streaming now▍$/);
  assert.doesNotMatch(plainRow(at(4).at(-1)), /▍/);
  assert.equal(at(0).length, at(4).length, "the caret never adds a row");
  assert.doesNotMatch(plainRow(renderTranscriptRows({ ...state, taskStatus: "idle" }, 100, 0).at(-1)), /▍/);
});

test("the permission border pulses gold right after it opens, then holds amber", async () => {
  const { renderComposerBand } = await import("../dist/tui/renderer.js");
  const { initialState, withPendingPermission } = await import("../dist/tui/state.js");
  const { decidePermission } = await import("../dist/tui/interaction.js");
  const decision = decidePermission("guarded", { kind: "edit", target: "workspace", inWorkspace: true, confirmed: false });
  const asked = { ...withPendingPermission({ ...initialState(), ...session(), colorEnabled: true, motionEnabled: true }, decision), permissionAskedAt: 1_000 };
  const border = (now) => renderComposerBand(asked, 80, 6, now).find((row) => row.includes("╭"));
  const gold = "\x1b[38;2;245;197;66m";
  assert.ok(border(1_000).startsWith(gold));
  assert.ok(!border(1_300).startsWith(gold));
  assert.ok(!border(2_500).startsWith(gold), "the pulse stops after the opening window");
});

test("frame updates rewrite only changed rows and redraw fully when the height changes", async () => {
  const { frameUpdate } = await import("../dist/tui/terminal-control.js");
  const full = frameUpdate(undefined, ["a", "b"]);
  assert.equal(full, "\x1b[?2026h\x1b[H\x1b[Ja\nb\x1b[?2026l");
  assert.equal(frameUpdate(["a", "b"], ["a", "b"]), "");
  assert.equal(frameUpdate(["a", "b", "c"], ["a", "B", "c"]), "\x1b[?2026h\x1b[2;1H\x1b[2KB\x1b[?2026l");
  assert.equal(frameUpdate(["a"], ["a", "b"]), "\x1b[?2026h\x1b[H\x1b[Ja\nb\x1b[?2026l");
});

test("theme detection honors HIVE_THEME, COLORFGBG and the terminal's background reply", async () => {
  const { themeFromEnvironment, themeFromBackgroundReply } = await import("../dist/tui/state.js");
  assert.equal(themeFromEnvironment({ HIVE_THEME: "light", COLORFGBG: "15;0" }), "light");
  assert.equal(themeFromEnvironment({ COLORFGBG: "0;15" }), "light");
  assert.equal(themeFromEnvironment({ COLORFGBG: "15;default;0" }), "dark");
  assert.equal(themeFromEnvironment({}), undefined);
  assert.equal(themeFromBackgroundReply("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"), "light");
  assert.equal(themeFromBackgroundReply("\x1b]11;rgb:0c0c/0c0c/0c0c\x07"), "dark");
  assert.equal(themeFromBackgroundReply("garbage"), undefined);
});

test("a background reply switches to the light palette and never reaches the composer", async () => {
  const { TuiApp } = await import("../dist/tui/app.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const app = new TuiApp(process.cwd(), { persistSession: false });
  app.render = () => {};
  app.state = { ...initialState(), ...session(), colorEnabled: true, lightTheme: false };
  app.onData(Buffer.from("ab\x1b]11;rgb:fafa/fafa/fafa\x1b\\c"));
  clearTimeout(app.escapeTimer);
  assert.equal(app.state.input, "abc");
  assert.equal(app.state.lightTheme, true);
  assert.match(renderTuiScreen(app.state), /\x1b\[38;2;31;41;55m/, "light text ink");
  app.onData(Buffer.from("\x1b]11;rgb:1010/1010/1010\x07"));
  assert.equal(app.state.lightTheme, false);
});
