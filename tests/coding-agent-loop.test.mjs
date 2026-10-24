import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StructuredAgentLoop, parseAgentTurn } from "../dist/coding/agent-loop.js";
import { createRuntimeReporter, formatCodingFinalReport, formatRuntimeEventJson } from "../dist/coding/output.js";
import { materializeBuilderTasks, parseCodingPlan } from "../dist/coding/planner.js";
import { findDirtyScopeConflicts, pathMatchesScope } from "../dist/coding/repository.js";
import { RepositoryToolService } from "../dist/coding/tools.js";

const contractTask = {
  id: "contract-builder", sessionId: "contract-session", role: "builder", title: "Tool contract",
  objective: "Write and inspect the assigned file", status: "working", providerId: "fixture", dependencies: [],
  fileScope: ["notes/contract.txt"], expectedOutput: "The assigned file", completionCriteria: ["File created and read"],
  validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: "2026-10-16T00:00:00.000Z",
};

function advertisedRepositoryTools(prompt) {
  const prefix = "Available repository tools with their actual argument schemas:\n";
  assert.ok(prompt.includes(prefix), "the provider must receive the repository tool contract");
  return JSON.parse(prompt.slice(prompt.indexOf(prefix) + prefix.length).split("\n")[0]);
}

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

test("each subagent role carries its hive-mind-council role contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-role-contract-"));
  const expected = { scout: /council Scout:.*unverified/, planner: /council Architect:/, builder: /council Forger:.*disclose failed commands/, fixer: /council Forger in a repair cycle:.*environment failure/, validator: /council Sentinel:.*never imply a pass.*environment limitations/, reviewer: /council Sentinel's adversarial review:/ };
  try {
    for (const [role, pattern] of Object.entries(expected)) {
      let system = "";
      await new StructuredAgentLoop().run({
        task: { ...contractTask, id: `contract-${role}`, role, fileScope: ["builder", "fixer"].includes(role) ? contractTask.fileScope : [] },
        cwd: root, sharedContext: "Role contract check.",
        tools: new RepositoryToolService({ repositoryRoot: root, sessionId: contractTask.sessionId, approvalPolicy: "safe" }),
        signal: new AbortController().signal,
        completionClient: { async complete(request) { system = request.systemPrompt; return { output: JSON.stringify({ done: true, summary: "checked" }) }; } },
      });
      assert.match(system, pattern, `${role} prompt names its council role`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("structured agents receive executable built-in file tool schemas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-tool-contract-"));
  const content = `Tool contract ${Date.now()}\n`;
  let turn = 0;
  try {
    const result = await new StructuredAgentLoop().run({
      task: contractTask, cwd: root, sharedContext: "Only the assigned file may be edited.",
      tools: new RepositoryToolService({ repositoryRoot: root, sessionId: contractTask.sessionId, approvalPolicy: "changes" }),
      signal: new AbortController().signal,
      completionClient: { async complete(request) {
        const definitions = advertisedRepositoryTools(request.systemPrompt);
        const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
        assert.deepEqual([...definitionsByName.keys()], [
          "read_file", "list_directory", "search_text", "search_symbols", "create_file", "write_file",
          "edit_file", "apply_patch", "inspect_diff", "run_command", "run_test", "read_command_output",
        ]);
        assert.deepEqual(definitionsByName.get("create_file").inputSchema.required, ["path", "content"]);
        assert.deepEqual(definitionsByName.get("edit_file").inputSchema.required, ["path", "search"]);
        assert.ok(definitionsByName.get("edit_file").inputSchema.properties.replacement);
        assert.deepEqual(definitionsByName.get("apply_patch").inputSchema.required, ["patch"]);
        assert.match(definitionsByName.get("apply_patch").description, /unified Git text diff/);
        assert.deepEqual(definitionsByName.get("read_command_output").inputSchema.required, ["commandId"]);
        assert.equal(definitions.length, definitionsByName.size, "tools must be advertised exactly once");
        if (turn++ === 0) return { output: JSON.stringify({ done: false, toolCalls: [
          { name: definitionsByName.get("create_file").name, arguments: { path: "notes/contract.txt", content } },
        ] }) };
        if (turn === 2) {
          assert.match(request.prompt, /created notes\/contract\.txt/);
          return { output: JSON.stringify({ done: false, toolCalls: [
            { name: definitionsByName.get("read_file").name, arguments: { path: "notes/contract.txt" } },
          ] }) };
        }
        const readResults = JSON.parse(request.prompt.split("[Tool results 2]\n")[1]);
        assert.equal(readResults[0].name, "read_file");
        assert.equal(readResults[0].ok, true);
        assert.equal(readResults[0].output, content, "the provider must receive the real tool result");
        return { output: JSON.stringify({ done: true, summary: "Created and inspected the assigned file" }) };
      } },
    });
    assert.equal(result.toolCalls, 2);
    assert.equal(await fs.readFile(path.join(root, "notes/contract.txt"), "utf8"), content);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("executor capabilities restrict advertised built-ins while preserving additional tools", async () => {
  for (const builtinToolNames of [["read_file", "create_file", "read_file"], []]) await new StructuredAgentLoop().run({
    task: contractTask, cwd: process.cwd(), sharedContext: "Contract test", signal: new AbortController().signal,
    tools: {
      builtinToolNames,
      toolDefinitions: [{ name: "mcp__fixture__lookup", description: "Lookup", inputSchema: { type: "object", properties: {} } }],
      async execute() { throw new Error("No execution expected"); },
    },
    completionClient: { async complete(request) {
      assert.deepEqual(advertisedRepositoryTools(request.systemPrompt).map((definition) => definition.name), [...new Set(builtinToolNames)]);
      assert.equal(request.systemPrompt.split('"name":"mcp__fixture__lookup"').length - 1, 1);
      assert.ok(!request.systemPrompt.includes('"name":"run_command"'));
      return { output: JSON.stringify({ done: true, summary: "Inspected contract" }) };
    } },
  });
});

test("invalid capability metadata and duplicate tool names fail before contacting the provider", async () => {
  const definition = (name) => ({ name, description: "Fixture", inputSchema: { type: "object" } });
  for (const metadata of [
    { builtinToolNames: ["unsupported"] },
    { toolDefinitions: [definition("write_file")] },
    { toolDefinitions: [definition("mcp__fixture__lookup"), definition("mcp__fixture__lookup")] },
  ]) {
    let contacted = false;
    await assert.rejects(new StructuredAgentLoop().run({
      task: contractTask, cwd: process.cwd(), sharedContext: "Contract test", signal: new AbortController().signal,
      tools: { ...metadata, async execute() { throw new Error("No execution expected"); } },
      completionClient: { async complete() { contacted = true; throw new Error("No provider request expected"); } },
    }), /unsupported built-in tool|Duplicate or reserved agent tool definition/);
    assert.equal(contacted, false);
  }
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
    completionClient: { async complete(request) {
      assert.ok(advertisedRepositoryTools(request.systemPrompt).every((definition) =>
        !["create_file", "write_file", "edit_file", "apply_patch"].includes(definition.name)), "read-only roles must not be offered writes");
      return { output: responses.shift() };
    } },
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
