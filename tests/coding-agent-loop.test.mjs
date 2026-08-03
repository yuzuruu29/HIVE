import assert from "node:assert/strict";
import test from "node:test";

import { StructuredAgentLoop, parseAgentTurn } from "../dist/coding/agent-loop.js";
import { createRuntimeReporter, formatCodingFinalReport, formatRuntimeEventJson } from "../dist/coding/output.js";
import { materializeBuilderTasks, parseCodingPlan } from "../dist/coding/planner.js";
import { findDirtyScopeConflicts, pathMatchesScope } from "../dist/coding/repository.js";

const planJson = JSON.stringify({
  summary: "Implement a bounded runtime",
  architecture: "Extend the existing orchestration layer",
  risks: ["Provider failure"],
  acceptanceCriteria: ["Tests pass"],
  validationCommands: ["npm test"],
  tasks: [
    {
      key: "runtime",
      role: "builder",
      title: "Build runtime",
      objective: "Implement the runtime",
      dependencies: [],
      fileScope: ["src/coding/runtime.ts"],
      expectedOutput: "Runtime modules",
      completionCriteria: ["Unit tests pass"],
      validationCommands: ["npm test"],
    },
    {
      key: "cli",
      role: "builder",
      title: "Wire CLI",
      objective: "Wire the command",
      dependencies: ["runtime"],
      fileScope: ["src/cli.ts"],
      expectedOutput: "CLI integration",
      completionCriteria: ["Help includes code"],
    },
  ],
});

test("planner parsing and task materialization preserve bounded dependencies", () => {
  const plan = parseCodingPlan(`\`\`\`json\n${planJson}\n\`\`\``);
  const tasks = materializeBuilderTasks({
    sessionId: "session-1",
    plan,
    providerForRole: () => ({ providerId: "mock", model: "coder" }),
    maxAttempts: 3,
    now: () => "2026-07-10T00:00:00.000Z",
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "bee-003");
  assert.deepEqual(tasks[1].dependencies, ["bee-003"]);
  assert.deepEqual(tasks[0].fileScope, ["src/coding/runtime.ts"]);
  assert.equal(tasks[0].providerId, "mock");
});

test("planner rejects missing outputs and unknown dependencies", () => {
  const missingOutput = JSON.parse(planJson);
  delete missingOutput.tasks[0].expectedOutput;
  assert.throws(() => parseCodingPlan(JSON.stringify(missingOutput)), /expectedOutput/);

  const badDependency = JSON.parse(planJson);
  badDependency.tasks[1].dependencies = ["missing"];
  assert.throws(() => parseCodingPlan(JSON.stringify(badDependency)), /unknown task/);
});

test("agent response parser accepts JSON fences and rejects ambiguous turns", () => {
  assert.deepEqual(
    parseAgentTurn('```json\n{"done":true,"summary":"Complete"}\n```'),
    { done: true, summary: "Complete", activity: undefined, toolCalls: undefined, data: undefined },
  );
  assert.throws(() => parseAgentTurn('{"done":false}'), /require tool calls/);
  assert.throws(() => parseAgentTurn("not json"), /Invalid structured response/);
});

test("structured agent loop executes bounded tools and accumulates usage", async () => {
  const responses = [
    JSON.stringify({
      done: false,
      activity: "Inspect file",
      toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "src/a.ts" } }],
    }),
    JSON.stringify({ done: true, summary: "Inspected the target" }),
  ];
  const calls = [];
  const events = [];
  const loop = new StructuredAgentLoop();
  const result = await loop.run({
    task: {
      id: "bee-003",
      sessionId: "session-1",
      role: "builder",
      title: "Build",
      objective: "Build one file",
      status: "working",
      providerId: "mock",
      dependencies: [],
      fileScope: ["src/a.ts"],
      expectedOutput: "A file",
      completionCriteria: ["Done"],
      validationCommands: [],
      depth: 1,
      attempt: 1,
      maxAttempts: 2,
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    cwd: process.cwd(),
    sharedContext: "Relevant context",
    completionClient: {
      async complete() {
        return { output: responses.shift(), usage: { input: 2, output: 3, total: 5 } };
      },
    },
    tools: {
      async execute(name, args) {
        calls.push({ name, args });
        return { ok: true, output: "file contents" };
      },
    },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.summary, "Inspected the target");
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.usage, { input: 4, output: 6, total: 10 });
  assert.equal(calls[0].name, "read_file");
  assert.ok(events.some((event) => event.type === "subagent.tool_call"));
});

test("read-only agent roles cannot invoke write tools", async () => {
  let toolExecuted = false;
  const responses = [
    JSON.stringify({
      done: false,
      toolCalls: [{ name: "write_file", arguments: { path: "src/a.ts", content: "x" } }],
    }),
    JSON.stringify({ done: true, summary: "Reported the denied write" }),
  ];
  const loop = new StructuredAgentLoop();
  await loop.run({
    task: {
      id: "bee-004",
      sessionId: "session-1",
      role: "reviewer",
      title: "Review",
      objective: "Review only",
      status: "working",
      providerId: "mock",
      dependencies: [],
      fileScope: [],
      expectedOutput: "Review findings",
      completionCriteria: ["Review complete"],
      validationCommands: [],
      depth: 1,
      attempt: 1,
      maxAttempts: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    cwd: process.cwd(),
    sharedContext: "Context",
    completionClient: { async complete() { return { output: responses.shift() }; } },
    tools: {
      async execute() {
        toolExecuted = true;
        return { ok: true, output: "unexpected" };
      },
    },
    signal: new AbortController().signal,
  });
  assert.equal(toolExecuted, false);
});

test("scope matching detects dirty-file ownership conflicts", () => {
  assert.equal(pathMatchesScope("src/coding/a.ts", "src/coding/**"), true);
  assert.equal(pathMatchesScope("tests/a.test.mjs", "src/**"), false);
  assert.deepEqual(
    findDirtyScopeConflicts(["src/a.ts", "README.md"], ["src/**"]),
    ["src/a.ts"],
  );
});

test("JSON output is undecorated and final report uses actual values", () => {
  const event = {
    schemaVersion: 1,
    id: "evt-1",
    sequence: 1,
    sessionId: "session-1",
    timestamp: "2026-07-10T00:00:00.000Z",
    type: "session.started",
    payload: { repository: { root: ".", capturedAt: "now", dirty: false, changedFiles: [] } },
  };
  assert.deepEqual(JSON.parse(formatRuntimeEventJson(event)), event);
  const report = formatCodingFinalReport({
    sessionId: "session-1",
    objective: "Build HIVE",
    result: "Implemented",
    subagents: { completed: 2, failed: 0, cancelled: 0 },
    filesChanged: ["src/a.ts"],
    validation: [{ name: "Tests", passed: true }],
    review: ["No critical findings"],
    outstanding: [],
  });
  assert.match(report, /2 completed/);
  assert.match(report, /Tests: passed/);
  assert.match(report, /Outstanding:\n- None/);
});

test("human runtime output suppresses duplicate task mirrors while JSON retains them", () => {
  const taskEvent = {
    schemaVersion: 1,
    sequence: 1,
    id: "event-1",
    sessionId: "session-1",
    timestamp: "2026-07-10T00:00:00.000Z",
    type: "task.started",
    payload: { taskId: "bee-001", attempt: 1 },
  };
  const subagentEvent = {
    ...taskEvent,
    sequence: 2,
    id: "event-2",
    type: "subagent.started",
    payload: { subagentId: "bee-001", attempt: 1 },
  };

  const human = createRuntimeReporter({ json: false });
  human.emit(taskEvent);
  human.emit(subagentEvent);
  assert.deepEqual(human.lines, ["[Agent bee-001] Started"]);

  const machine = createRuntimeReporter({ json: true });
  machine.emit(taskEvent);
  machine.emit(subagentEvent);
  assert.equal(machine.lines.length, 2);
  assert.equal(JSON.parse(machine.lines[0]).type, "task.started");
});
