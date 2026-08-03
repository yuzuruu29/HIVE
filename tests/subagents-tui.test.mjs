/**
 * Focused tests for the terminal-native Subagents projection and panel.
 */

import test from "node:test";
import assert from "node:assert/strict";

const START = "2026-07-11T00:00:00.000Z";
const NOW = Date.parse("2026-07-11T00:01:07.000Z");

function task(id, role, status, overrides = {}) {
  return {
    id,
    sessionId: "session-001",
    role,
    title: `${role} task ${id}`,
    objective: `Complete ${role} work`,
    status,
    providerId: "openrouter",
    model: "coding-model",
    dependencies: [],
    fileScope: [`src/${id}.ts`],
    expectedOutput: "A bounded implementation",
    completionCriteria: ["Focused checks pass"],
    validationCommands: ["npm test"],
    depth: 1,
    attempt: 1,
    maxAttempts: 2,
    createdAt: START,
    startedAt: status === "created" || status === "queued" ? undefined : START,
    ...overrides,
  };
}

const sampleTasks = [
  task("bee-014", "builder", "working", { title: "Implement task scheduler" }),
  task("bee-015", "scout", "working", { title: "Inspect provider registry" }),
  task("bee-016", "validator", "blocked", { title: "Run integration tests" }),
  task("bee-012", "planner", "completed", {
    title: "Produce execution graph",
    completedAt: "2026-07-11T00:00:31.000Z",
  }),
  task("bee-017", "reviewer", "failed", { error: "Review provider unavailable" }),
  task("bee-018", "fixer", "queued"),
];

function visibleLength(line, stripAnsi) {
  return stripAnsi(line).length;
}

test("Subagents helpers - counts, badges, state markers, and elapsed time", async () => {
  const {
    aggregateSubagentCounts,
    avatarVariant,
    formatElapsed,
    renderSubagentAvatar,
    roleBadge,
    statusGlyph,
  } = await import("../dist/tui/subagents.js");

  assert.deepEqual(aggregateSubagentCounts(sampleTasks), {
    total: 6,
    active: 3,
    working: 2,
    waiting: 1,
    done: 2,
    blocked: 1,
    completed: 1,
    failed: 1,
    cancelled: 0,
    skipped: 0,
  });
  assert.deepEqual(
    ["planner", "scout", "builder", "validator", "reviewer", "fixer"].map(roleBadge),
    ["[PL]", "[SC]", "[BU]", "[VA]", "[RV]", "[FX]"]
  );
  assert.equal(statusGlyph("working"), "*");
  assert.equal(statusGlyph("blocked"), "!");
  assert.equal(statusGlyph("failed"), "X");
  assert.equal(avatarVariant("bee-014"), avatarVariant("bee-014"));
  assert.equal(renderSubagentAvatar(sampleTasks[0], false), renderSubagentAvatar(sampleTasks[0], false));
  assert.equal(formatElapsed(START, undefined, NOW), "01:07");
});

test("Subagents panel - collapsed and expanded responsive views", async (t) => {
  const { initialState } = await import("../dist/tui/state.js");
  const { renderSubagentsPanel } = await import("../dist/tui/subagents.js");
  const { stripAnsi } = await import("../dist/ui/colors.js");
  const base = {
    ...initialState(),
    colorEnabled: false,
    motionEnabled: false,
    subagents: sampleTasks,
    selectedSubagentId: "bee-014",
    updatedAt: NOW,
  };

  await t.test("collapsed view leads with active avatars and explicit counts", () => {
    const panel = renderSubagentsPanel({ ...base, subagentsExpanded: false }, 90, NOW).join("\n");
    assert.match(panel, /[oO@*]\[BU\]/);
    assert.ok(panel.indexOf("[BU]") < panel.indexOf("2 working"));
    assert.ok(panel.includes("2 done"));
    assert.ok(panel.includes("1 blocked"));
    assert.ok(panel.includes("1 failed"));
  });

  await t.test("wide expanded view includes provider, model, elapsed, and selected detail", () => {
    const panel = renderSubagentsPanel({ ...base, subagentsExpanded: true }, 140, NOW).join("\n");
    assert.ok(panel.includes("PROVIDER/MODEL"));
    assert.ok(panel.includes("openrouter/coding-model"));
    assert.ok(panel.includes("01:07"));
    assert.ok(panel.includes("Builder [BU] - bee-014"));
    assert.ok(panel.includes("Files:"));
    assert.ok(panel.includes("Latest activity:"));
  });

  await t.test("medium view uses ID, role, status, and task columns", () => {
    const panel = renderSubagentsPanel({ ...base, subagentsExpanded: true }, 90, NOW).join("\n");
    assert.ok(panel.includes("ID"));
    assert.ok(panel.includes("ROLE"));
    assert.ok(panel.includes("STATUS"));
    assert.ok(panel.includes("TASK"));
    assert.ok(!panel.includes("PROVIDER/MODEL"));
  });

  await t.test("narrow expanded view remains a compact summary", () => {
    const lines = renderSubagentsPanel({ ...base, subagentsExpanded: true }, 60, NOW);
    assert.ok(lines.some((line) => stripAnsi(line).includes("[BU] bee-014 working")));
    assert.ok(lines.every((line) => visibleLength(line, stripAnsi) <= 60));
  });

  await t.test("overflow agents collapse into a +N marker", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      task(`bee-${String(index + 1).padStart(3, "0")}`, "builder", "working")
    );
    const panel = renderSubagentsPanel(
      { ...base, subagents: many, subagentsExpanded: false },
      40,
      NOW
    ).join("\n");
    assert.match(panel, /\+\d+/);
    assert.ok(panel.includes("12 working"));
  });
});

test("Subagents panel - no color is ANSI-free, ASCII-only, and width bounded", async () => {
  const { initialState } = await import("../dist/tui/state.js");
  const { renderSubagentsPanel } = await import("../dist/tui/subagents.js");
  const { stripAnsi } = await import("../dist/ui/colors.js");
  const state = {
    ...initialState(),
    colorEnabled: false,
    motionEnabled: false,
    subagents: sampleTasks,
    subagentsExpanded: true,
    selectedSubagentId: "bee-014",
    updatedAt: NOW,
  };

  for (const width of [40, 60, 90, 140]) {
    const lines = renderSubagentsPanel(state, width, NOW);
    assert.ok(lines.every((line) => visibleLength(line, stripAnsi) <= width), `overflow at ${width}`);
    const output = lines.join("\n");
    assert.ok(!output.includes("\x1b["), `ANSI emitted at ${width}`);
    for (const char of output) {
      assert.ok(char.charCodeAt(0) <= 127, `non-ASCII output at ${width}`);
    }
  }
});

test("TUI screen - widths 40/60/90/140 and rapid resize remain bounded", async () => {
  const { initialState } = await import("../dist/tui/state.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { stripAnsi } = await import("../dist/ui/colors.js");
  const base = {
    ...initialState(),
    colorEnabled: false,
    motionEnabled: false,
    subagents: sampleTasks,
    subagentsExpanded: false,
    updatedAt: NOW,
  };

  for (let index = 0; index < 80; index += 1) {
    const width = [40, 60, 90, 140][index % 4];
    const height = 8 + (index % 33);
    let frame = "";
    assert.doesNotThrow(() => {
      frame = renderTuiScreen({ ...base, width, height });
    });
    assert.ok(frame.includes("Subagents"));
    assert.ok(!frame.includes("Window too small"));
    assert.ok(
      frame.split("\n").every((line) => stripAnsi(line).length <= width),
      `screen overflow at ${width}x${height}`
    );
  }
});

test("TUI state reducer consumes structured events without parsing human strings", async () => {
  const { initialState, reduceTuiRuntimeEvent } = await import("../dist/tui/state.js");
  const created = task("bee-021", "builder", "created");
  const createdEvent = {
    schemaVersion: 1,
    id: "event-001",
    sequence: 1,
    sessionId: "session-001",
    timestamp: START,
    type: "subagent.created",
    payload: { subagentId: created.id, task: created },
  };
  let state = reduceTuiRuntimeEvent(initialState(), createdEvent);
  assert.equal(state.subagents.length, 1);
  assert.equal(state.subagents[0].status, "created");
  assert.equal(state.selectedSubagentId, "bee-021");

  const working = { ...created, status: "working", startedAt: "2026-07-11T00:00:05.000Z" };
  state = reduceTuiRuntimeEvent(state, {
    schemaVersion: 1,
    id: "event-002",
    sequence: 2,
    sessionId: "session-001",
    timestamp: "2026-07-11T00:00:05.000Z",
    type: "subagent.status_changed",
    payload: {
      subagentId: created.id,
      previousStatus: "created",
      status: "working",
      task: working,
      message: "human text says failed but structured status says working",
    },
  });
  assert.equal(state.subagents[0].status, "working");
  assert.equal(state.agents, 1);
  assert.equal(state.recentRuntimeEvents.length, 2);

  const completed = {
    ...working,
    status: "completed",
    completedAt: "2026-07-11T00:00:42.000Z",
    summary: "Implementation complete",
  };
  state = reduceTuiRuntimeEvent(state, {
    schemaVersion: 1,
    id: "event-003",
    sequence: 3,
    sessionId: "session-001",
    timestamp: completed.completedAt,
    type: "subagent.completed",
    payload: { subagentId: created.id, task: completed, status: "completed" },
  });
  assert.equal(state.subagents[0].status, "completed");
  assert.equal(state.subagents[0].summary, "Implementation complete");
  assert.equal(state.agents, 0);
});
