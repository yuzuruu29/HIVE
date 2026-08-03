import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateSubagentCounts,
  assertSubagentTransition,
  canTransitionSubagentStatus,
  makeBeeId,
} from "../dist/coding/types.js";
import {
  RuntimeEventBus,
  deserializeRuntimeEvent,
  serializeRuntimeEvent,
  serializeRuntimeEvents,
} from "../dist/coding/events.js";
import {
  normalizeTaskObjective,
  serializeBuilderConflicts,
  validateTaskGraph,
} from "../dist/coding/task-graph.js";
import { SubagentScheduler } from "../dist/coding/scheduler.js";

const task = (overrides = {}) => ({
  id: "bee-001",
  sessionId: "session-1",
  role: "builder",
  title: "Build the scheduler",
  objective: "Implement a bounded scheduler",
  status: "created",
  providerId: "provider-a",
  dependencies: [],
  fileScope: ["src/coding/scheduler.ts"],
  expectedOutput: "A dependency-aware scheduler",
  completionCriteria: ["Focused tests pass"],
  validationCommands: ["npm test"],
  depth: 0,
  attempt: 0,
  maxAttempts: 3,
  createdAt: "2026-07-11T00:00:00.000Z",
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("scheduler cooperative pause before launch leaves queued work untouched", async () => {
  const executions = [];
  const scheduler = new SubagentScheduler(
    [task({ id: "bee-001" }), task({ id: "bee-002", objective: "Implement the second scheduler unit", fileScope: ["src/other.ts"] })],
    async (scheduled) => { executions.push(scheduled.id); },
    { maxConcurrency: 1 },
  );

  assert.equal(scheduler.requestPause("Desktop pause requested."), true);
  assert.equal(scheduler.requestPause("Duplicate pause."), true);
  const result = await scheduler.run();

  assert.equal(result.paused, true);
  assert.equal(result.cancelled, false);
  assert.deepEqual(executions, []);
  assert.deepEqual(result.tasks.map((entry) => entry.status), ["queued", "queued"]);
});

test("scheduler cooperative pause drains in-flight work and never launches the next task", async () => {
  const gate = deferred();
  const started = deferred();
  const executions = [];
  const scheduler = new SubagentScheduler(
    [task({ id: "bee-001" }), task({ id: "bee-002", objective: "Implement the dependent scheduler unit", dependencies: ["bee-001"], fileScope: ["src/other.ts"] })],
    async (scheduled) => {
      executions.push(scheduled.id);
      started.resolve();
      await gate.promise;
      return { summary: `finished ${scheduled.id}` };
    },
    { maxConcurrency: 1 },
  );

  const completion = scheduler.run();
  await started.promise;
  assert.equal(scheduler.requestPause("Desktop pause requested."), true);
  gate.resolve();
  const result = await completion;

  assert.equal(result.paused, true);
  assert.deepEqual(executions, ["bee-001"]);
  assert.equal(result.tasks[0].status, "completed");
  assert.equal(result.tasks[0].summary, "finished bee-001");
  assert.equal(result.tasks[1].status, "waiting_for_dependencies");
});

test("scheduler cancellation wins over a pending cooperative pause", async () => {
  const gate = deferred();
  const started = deferred();
  const scheduler = new SubagentScheduler([task()], async () => {
    started.resolve();
    await gate.promise;
  });

  const completion = scheduler.run();
  await started.promise;
  scheduler.requestPause("Desktop pause requested.");
  scheduler.cancel("User cancelled explicitly.");
  gate.resolve();
  const result = await completion;

  assert.equal(result.cancelled, true);
  assert.equal(result.paused, false);
  assert.equal(result.tasks[0].status, "cancelled");
});

test("bee IDs are stable, ASCII-only, and sortable", () => {
  assert.equal(makeBeeId(14), "bee-014");
  assert.equal(makeBeeId(1001), "bee-1001");
  assert.match(makeBeeId(2), /^[\x20-\x7e]+$/);
  assert.throws(() => makeBeeId(-1), /non-negative integer/);
  assert.throws(
    () => makeBeeId(Number.MAX_SAFE_INTEGER + 1),
    /non-negative integer/,
  );
});

test("subagent lifecycle permits legal transitions and rejects illegal jumps", () => {
  assert.equal(canTransitionSubagentStatus("created", "queued"), true);
  assert.equal(canTransitionSubagentStatus("queued", "waiting_for_dependencies"), true);
  assert.equal(canTransitionSubagentStatus("working", "validating"), true);
  assert.equal(canTransitionSubagentStatus("retrying", "validating"), true);
  assert.equal(canTransitionSubagentStatus("completed", "working"), false);
  assert.throws(
    () => assertSubagentTransition("created", "completed"),
    /Illegal subagent transition: created -> completed/,
  );
});

test("subagent counts aggregate active, waiting, done, and exceptional states", () => {
  const counts = aggregateSubagentCounts([
    task({ id: "bee-001", status: "working" }),
    task({ id: "bee-002", status: "validating" }),
    task({ id: "bee-003", status: "blocked" }),
    task({ id: "bee-004", status: "completed" }),
    task({ id: "bee-005", status: "failed" }),
    task({ id: "bee-006", status: "cancelled" }),
    task({ id: "bee-007", status: "skipped" }),
    task({ id: "bee-008", status: "waiting_for_dependencies" }),
  ]);

  assert.deepEqual(counts, {
    total: 8,
    active: 3,
    working: 2,
    waiting: 1,
    blocked: 1,
    done: 4,
    completed: 1,
    failed: 1,
    cancelled: 1,
    skipped: 1,
  });
});

test("runtime event bus assigns monotonic sequence numbers and replays history", () => {
  let tick = 0;
  const bus = new RuntimeEventBus({
    clock: () => `2026-07-11T00:00:0${tick++}.000Z`,
  });

  const first = bus.emit({
    sessionId: "session-1",
    type: "session.created",
    payload: {
      objective: "Build the foundation",
      mode: "auto",
      approvalPolicy: "changes",
    },
  });
  const second = bus.emit({
    sessionId: "session-1",
    type: "plan.created",
    payload: { summary: "Use a task graph", taskIds: ["bee-001"] },
  });

  assert.equal(first.sequence, 1);
  assert.equal(first.id, "evt-000001");
  assert.equal(second.sequence, 2);

  const seen = [];
  const unsubscribe = bus.subscribe((event) => seen.push(event.sequence), {
    replay: true,
  });
  bus.emit({
    sessionId: "session-1",
    type: "task.ready",
    payload: { taskId: "bee-001" },
  });
  unsubscribe();
  bus.emit({
    sessionId: "session-1",
    type: "task.started",
    payload: { taskId: "bee-001", attempt: 1 },
  });

  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(
    bus.replay({ fromSequence: 2 }).map((event) => event.sequence),
    [2, 3, 4],
  );
});

test("runtime events have a stable serializable shape and NDJSON round trip", () => {
  const bus = new RuntimeEventBus({
    clock: () => "2026-07-11T00:00:00.000Z",
  });
  const event = bus.emit({
    sessionId: "session-1",
    type: "command.completed",
    payload: { commandId: "cmd-1", exitCode: 0, durationMs: 25 },
  });

  const serialized = serializeRuntimeEvent(event);
  assert.deepEqual(Object.keys(JSON.parse(serialized)), [
    "schemaVersion",
    "id",
    "sequence",
    "sessionId",
    "timestamp",
    "type",
    "payload",
  ]);
  assert.deepEqual(deserializeRuntimeEvent(serialized), event);
  assert.equal(serializeRuntimeEvents([event]), `${serialized}\n`);
  assert.throws(
    () => deserializeRuntimeEvent('{"schemaVersion":99}'),
    /Invalid runtime event/,
  );

  const repositoryEvent = bus.emit({
    sessionId: "session-1",
    type: "session.started",
    payload: {
      repository: {
        root: "C:/repo",
        worktreePath: "C:/repo/.hive/worktrees/session-1",
        capturedAt: "2026-07-11T00:00:00.000Z",
        dirty: false,
        changedFiles: [],
      },
    },
  });
  assert.equal(
    deserializeRuntimeEvent(serializeRuntimeEvent(repositoryEvent)).payload.repository
      .worktreePath,
    "C:/repo/.hive/worktrees/session-1",
  );
});

test("task graph rejects missing dependencies and reports cycles", () => {
  const missing = validateTaskGraph([
    task({ dependencies: ["bee-missing"] }),
  ]);
  assert.equal(missing.valid, false);
  assert.equal(missing.issues.some((issue) => issue.code === "missing_dependency"), true);

  const cyclic = validateTaskGraph([
    task({ id: "bee-001", dependencies: ["bee-002"] }),
    task({ id: "bee-002", dependencies: ["bee-001"] }),
  ]);
  assert.equal(cyclic.valid, false);
  const cycleIssue = cyclic.issues.find((issue) => issue.code === "cycle");
  assert.ok(cycleIssue);
  assert.deepEqual(new Set(cycleIssue.taskIds), new Set(["bee-001", "bee-002"]));
});

test("task graph normalizes objectives and rejects duplicate work", () => {
  assert.equal(
    normalizeTaskObjective("  Implement—Scheduler!  "),
    "implement scheduler",
  );
  const result = validateTaskGraph([
    task({ id: "bee-001", objective: "Implement scheduler!" }),
    task({ id: "bee-002", objective: " implement   scheduler " }),
  ]);
  assert.equal(result.valid, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "duplicate_objective"),
    true,
  );
});

test("task graph enforces outputs, completion criteria, task limits, and depth", () => {
  const result = validateTaskGraph(
    [
      task({
        id: "bee-001",
        expectedOutput: " ",
        completionCriteria: [],
        depth: 3,
      }),
      task({ id: "bee-002", objective: "A distinct task" }),
    ],
    { maxTasks: 1, maxDepth: 2 },
  );
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.equal(codes.has("missing_expected_output"), true);
  assert.equal(codes.has("missing_completion_criteria"), true);
  assert.equal(codes.has("task_limit_exceeded"), true);
  assert.equal(codes.has("depth_limit_exceeded"), true);
});

test("read-only tasks may use an empty editable file scope", () => {
  const result = validateTaskGraph([
    task({
      role: "planner",
      objective: "Produce the bounded plan",
      fileScope: [],
    }),
  ]);
  assert.equal(result.valid, true);
});

test("overlapping builder scopes are detected and deterministically serialized", () => {
  const tasks = [
    task({
      id: "bee-001",
      objective: "Build event runtime",
      fileScope: ["src/coding"],
    }),
    task({
      id: "bee-002",
      objective: "Build event serializer",
      fileScope: [".\\src\\coding\\events.ts"],
    }),
    task({
      id: "bee-003",
      objective: "Build provider health",
      fileScope: ["src/providers/health.ts"],
    }),
  ];

  const rejected = validateTaskGraph(tasks);
  assert.equal(rejected.valid, false);
  assert.deepEqual(rejected.conflicts[0].taskIds, ["bee-001", "bee-002"]);
  assert.deepEqual(rejected.conflicts[0].scopes, [
    "src/coding",
    "src/coding/events.ts",
  ]);

  const serialized = serializeBuilderConflicts(tasks);
  assert.deepEqual(serialized.addedDependencies, [
    {
      taskId: "bee-002",
      dependsOn: "bee-001",
      scopes: ["src/coding", "src/coding/events.ts"],
    },
  ]);
  assert.deepEqual(
    serialized.tasks.find((item) => item.id === "bee-002").dependencies,
    ["bee-001"],
  );
  assert.deepEqual(
    serialized.tasks.find((item) => item.id === "bee-003").dependencies,
    [],
  );
  assert.equal(
    validateTaskGraph(serialized.tasks, { conflictPolicy: "serialize" }).valid,
    true,
  );
});

test("scheduler honors global concurrency and dependency completion", async () => {
  const gates = new Map([
    ["bee-001", deferred()],
    ["bee-002", deferred()],
    ["bee-003", deferred()],
  ]);
  const firstPairStarted = deferred();
  const dependentStarted = deferred();
  const started = [];
  let active = 0;
  let maximumActive = 0;

  const scheduler = new SubagentScheduler(
    [
      task({
        id: "bee-001",
        objective: "Build module A",
        fileScope: ["src/a.ts"],
      }),
      task({
        id: "bee-002",
        objective: "Build module B",
        fileScope: ["src/b.ts"],
      }),
      task({
        id: "bee-003",
        objective: "Validate module A",
        role: "validator",
        dependencies: ["bee-001"],
        fileScope: [],
      }),
    ],
    async (current) => {
      started.push(current.id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started.length === 2) firstPairStarted.resolve();
      if (current.id === "bee-003") dependentStarted.resolve();
      try {
        await gates.get(current.id).promise;
        return { summary: `${current.id} done` };
      } finally {
        active -= 1;
      }
    },
    { maxConcurrency: 2 },
  );

  const run = scheduler.run();
  await firstPairStarted.promise;
  assert.deepEqual(started, ["bee-001", "bee-002"]);
  gates.get("bee-001").resolve();
  await dependentStarted.promise;
  assert.deepEqual(started, ["bee-001", "bee-002", "bee-003"]);
  gates.get("bee-002").resolve();
  gates.get("bee-003").resolve();

  const result = await run;
  assert.equal(maximumActive, 2);
  assert.equal(result.counts.completed, 3);
  assert.deepEqual(
    scheduler.eventBus
      .replay()
      .filter((event) => event.type === "subagent.status_changed")
      .filter((event) => event.payload.subagentId === "bee-003")
      .map((event) => event.payload.status),
    [
      "queued",
      "waiting_for_dependencies",
      "starting",
      "working",
      "validating",
      "completed",
    ],
  );
});

test("scheduler enforces per-provider concurrency limits", async () => {
  const gates = new Map([
    ["bee-001", deferred()],
    ["bee-002", deferred()],
    ["bee-003", deferred()],
  ]);
  const initialStarted = deferred();
  const secondProviderTaskStarted = deferred();
  const started = [];

  const scheduler = new SubagentScheduler(
    [
      task({ id: "bee-001", objective: "Provider A first", fileScope: ["a"] }),
      task({ id: "bee-002", objective: "Provider A second", fileScope: ["b"] }),
      task({
        id: "bee-003",
        objective: "Provider B task",
        providerId: "provider-b",
        fileScope: ["c"],
      }),
    ],
    async (current) => {
      started.push(current.id);
      if (started.length === 2) initialStarted.resolve();
      if (current.id === "bee-002") secondProviderTaskStarted.resolve();
      await gates.get(current.id).promise;
    },
    {
      maxConcurrency: 3,
      providerConcurrency: { "provider-a": 1, "provider-b": 1 },
    },
  );

  const run = scheduler.run();
  await initialStarted.promise;
  assert.deepEqual(started, ["bee-001", "bee-003"]);
  gates.get("bee-001").resolve();
  await secondProviderTaskStarted.promise;
  gates.get("bee-002").resolve();
  gates.get("bee-003").resolve();
  const result = await run;
  assert.equal(result.counts.completed, 3);
});

test("scheduler serializes active builders with overlapping file leases", async () => {
  const firstGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const started = [];
  const scheduler = new SubagentScheduler(
    [
      task({
        id: "bee-001",
        objective: "Build coding directory",
        fileScope: ["src/coding"],
      }),
      task({
        id: "bee-002",
        objective: "Build coding events",
        fileScope: ["src/coding/events.ts"],
      }),
    ],
    async (current) => {
      started.push(current.id);
      if (current.id === "bee-001") {
        firstStarted.resolve();
        await firstGate.promise;
      } else {
        secondStarted.resolve();
      }
    },
    { maxConcurrency: 2 },
  );

  const run = scheduler.run();
  await firstStarted.promise;
  assert.deepEqual(started, ["bee-001"]);
  firstGate.resolve();
  await secondStarted.promise;
  const result = await run;
  assert.deepEqual(started, ["bee-001", "bee-002"]);
  assert.equal(result.counts.completed, 2);
});

test("scheduler retries with bounded exponential delays and stops at the cap", async () => {
  const delays = [];
  let attempts = 0;
  const scheduler = new SubagentScheduler(
    [task({ maxAttempts: 5 })],
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`failure ${attempts}`);
      return { summary: "recovered" };
    },
    {
      maxRetries: 2,
      baseRetryDelayMs: 10,
      retryDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );

  const result = await scheduler.run();
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(result.tasks[0].status, "completed");
  assert.equal(result.tasks[0].attempt, 3);

  let cappedAttempts = 0;
  const capped = new SubagentScheduler(
    [task({ maxAttempts: 9 })],
    async () => {
      cappedAttempts += 1;
      throw new Error("still failing");
    },
    { maxRetries: 1, retryDelay: async () => {} },
  );
  const cappedResult = await capped.run();
  assert.equal(cappedAttempts, 2);
  assert.equal(cappedResult.tasks[0].status, "failed");
});

test("scheduler skips or fails tasks whose dependencies fail", async () => {
  const buildTasks = () => [
    task({ id: "bee-001", objective: "Fail root", fileScope: ["a"] }),
    task({
      id: "bee-002",
      objective: "Dependent task",
      role: "validator",
      dependencies: ["bee-001"],
      fileScope: [],
    }),
  ];
  const executor = async (current) => {
    if (current.id === "bee-001") throw new Error("root failed");
    assert.fail("dependent executor must not run");
  };

  const skipped = await new SubagentScheduler(buildTasks(), executor, {
    maxRetries: 0,
  }).run();
  assert.deepEqual(
    skipped.tasks.map((current) => current.status),
    ["failed", "skipped"],
  );

  const failed = await new SubagentScheduler(buildTasks(), executor, {
    maxRetries: 0,
    dependencyFailure: "fail",
  }).run();
  assert.deepEqual(
    failed.tasks.map((current) => current.status),
    ["failed", "failed"],
  );
});

test("dynamic tasks respect Queen approval, depth, and task budget", async () => {
  const approvals = [];
  const scheduler = new SubagentScheduler([task()], async () => {}, {
    maxTasks: 2,
    maxDepth: 1,
    queenApprovesTask: async (candidate) => {
      approvals.push(candidate.id);
      return candidate.id !== "bee-denied";
    },
  });

  assert.equal(
    await scheduler.addTask(
      task({
        id: "bee-denied",
        objective: "Denied child",
        parentTaskId: "bee-001",
        dependencies: ["bee-001"],
        fileScope: ["denied.ts"],
        depth: 1,
      }),
    ),
    false,
  );
  assert.equal(
    await scheduler.addTask(
      task({
        id: "bee-002",
        objective: "Approved child",
        parentTaskId: "bee-001",
        dependencies: ["bee-001"],
        fileScope: ["child.ts"],
        depth: 1,
      }),
    ),
    true,
  );
  await assert.rejects(
    scheduler.addTask(
      task({ id: "bee-003", objective: "Over budget", fileScope: ["third.ts"] }),
    ),
    /task budget/i,
  );
  assert.deepEqual(approvals, ["bee-denied", "bee-002"]);
});

test("cancellation aborts active work and prevents queued tasks from spawning", async () => {
  const activeStarted = deferred();
  const started = [];
  const scheduler = new SubagentScheduler(
    [
      task({ id: "bee-001", objective: "Long task", fileScope: ["a"] }),
      task({ id: "bee-002", objective: "Queued task", fileScope: ["b"] }),
    ],
    async (current, context) => {
      started.push(current.id);
      activeStarted.resolve();
      await new Promise((resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
      });
    },
    { maxConcurrency: 1 },
  );

  const run = scheduler.run();
  await activeStarted.promise;
  scheduler.cancel("user requested stop");
  const result = await run;
  assert.deepEqual(started, ["bee-001"]);
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.tasks.map((current) => current.status),
    ["cancelled", "cancelled"],
  );
  await assert.rejects(
    scheduler.addTask(
      task({ id: "bee-003", objective: "Too late", fileScope: ["c"] }),
    ),
    /cancelled/i,
  );
});
