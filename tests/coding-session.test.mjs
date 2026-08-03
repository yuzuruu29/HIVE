import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { QueenOrchestrator } from "../dist/coding/queen.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";

const execFileAsync = promisify(execFile);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function createRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-session-test-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "hive@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "HIVE Test"], { cwd: root });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    type: "module",
    scripts: {},
  }, null, 2));
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "package.json", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

function planOutput() {
  return JSON.stringify({
    summary: "Build two isolated modules",
    architecture: "Extend the fixture with two modules",
    risks: [],
    acceptanceCriteria: ["Both files exist", "Validation passes"],
    validationCommands: ["node --version"],
    tasks: [
      {
        key: "module-a",
        role: "builder",
        title: "Build module A",
        objective: "Create module A",
        dependencies: [],
        fileScope: ["src/a.ts"],
        expectedOutput: "src/a.ts",
        completionCriteria: ["Module A exists"],
        validationCommands: [],
      },
      {
        key: "module-b",
        role: "builder",
        title: "Build module B",
        objective: "Create module B",
        dependencies: [],
        fileScope: ["src/b.ts"],
        expectedOutput: "src/b.ts",
        completionCriteria: ["Module B exists"],
        validationCommands: [],
      },
    ],
  });
}

function runtimeDependencies(root, options = {}) {
  const store = new CodingSessionStore(root, {
    clock: (() => {
      let tick = 0;
      return () => `2026-07-11T00:00:${String(tick++).padStart(2, "0")}.000Z`;
    })(),
  });
  let validationRuns = 0;
  const provider = {
    async bindingForRole(role) {
      return { role, providerId: `mock-${role}`, model: "mock-model" };
    },
    async complete(request) {
      if (request.role === "planner") return { output: planOutput(), usage: { total: 10 } };
      if (request.role === "reviewer") {
        return {
          output: JSON.stringify({
            done: true,
            summary: "No critical findings",
            data: { status: "passed", findings: [] },
          }),
        };
      }
      if (request.role === "validator") {
        return { output: JSON.stringify({ done: true, summary: "Acceptance criteria checked" }) };
      }
      if (request.prompt.includes("[Tool results")) {
        return { output: JSON.stringify({ done: true, summary: `${request.role} completed bounded work` }) };
      }
      const scope = request.prompt.match(/File scope: ([^\n]+)/)?.[1]?.split(",")[0].trim() ?? "src/a.ts";
      return {
        output: JSON.stringify({
          done: false,
          activity: `${request.role} edits ${scope}`,
          toolCalls: [{
            name: request.role === "fixer" ? "write_file" : "create_file",
            arguments: { path: scope, content: `export const role = ${JSON.stringify(request.role)};\n` },
          }],
        }),
      };
    },
  };
  const tools = {
    create({ repositoryRoot, emit }) {
      return {
        async execute(name, args, task) {
          if (name === "create_file" || name === "write_file" || name === "edit_file") {
            const relative = String(args.path);
            const destination = path.join(repositoryRoot, relative);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            const existed = await fs.stat(destination).then(() => true).catch(() => false);
            await fs.writeFile(destination, String(args.content ?? args.replacement ?? ""));
            const operation = existed ? "modified" : "created";
            emit("file.changed", {
              change: { path: relative, operation, taskId: task.id, recordedAt: new Date().toISOString() },
            });
            return { ok: true, output: `${operation} ${relative}`, metadata: { path: relative, operation } };
          }
          if (name === "run_test") {
            validationRuns += 1;
            const passed = !(options.failFirstValidation && validationRuns === 1);
            return {
              ok: passed,
              output: passed ? "check passed" : "check failed",
              metadata: { exitCode: passed ? 0 : 1 },
            };
          }
          if (name === "inspect_diff") {
            return { ok: true, output: "diff --git a/src/a.ts b/src/a.ts" };
          }
          return { ok: true, output: "ok" };
        },
      };
    },
  };
  const worktrees = {
    async create(_repositoryRoot, sessionId) {
      const target = path.join(root, ".worktrees", sessionId);
      await fs.mkdir(target, { recursive: true });
      return target;
    },
  };
  return { store, provider, tools, worktrees };
}

test("Queen executes Planner to parallel Builders to Validator and Reviewer", async () => {
  const root = await createRepository();
  try {
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
    const events = [];
    const queen = new QueenOrchestrator({
      repositoryPath: root,
      objective: "Build two fixture modules",
      sessionId: "session-success",
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 2,
      maxRetries: 1,
      onEvent: (event) => events.push(event),
    }, runtimeDependencies(root));

    const record = await queen.run();
    assert.equal(record.status, "completed", JSON.stringify(record.finalReport?.outstanding));
    assert.equal(record.tasks.filter((task) => task.role === "builder" && task.status === "completed").length, 2);
    assert.equal(record.validationResults.at(-1).status, "passed");
    assert.equal(record.reviewResults.at(-1).status, "passed");
    assert.deepEqual(new Set(record.finalReport.filesChanged), new Set(["src/a.ts", "src/b.ts"]));
    assert.ok(events.some((event) => event.type === "plan.created"));
    assert.ok(events.some((event) => event.type === "session.completed"));
    const restored = await new CodingSessionStore(root).load("session-success");
    assert.equal(restored.status, "completed");
    assert.equal(JSON.stringify(restored).includes("mock-secret"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Queen cooperatively pauses after in-flight work persists and resumes without duplicating completed tasks", async () => {
  const root = await createRepository();
  try {
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
    const events = [];
    let queen;
    let pauseRequests = 0;
    queen = new QueenOrchestrator({
      repositoryPath: root,
      objective: "Build two fixture modules cooperatively",
      sessionId: "session-cooperative-pause",
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 1,
      maxRetries: 1,
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "subagent.started" || pauseRequests > 0) return;
        const task = queen.record?.tasks.find((entry) => entry.id === event.payload.subagentId);
        if (task?.role !== "builder") return;
        pauseRequests += 1;
        assert.equal(queen.requestPause("Desktop pause requested."), true);
        assert.equal(queen.requestPause("Duplicate desktop pause."), true);
      },
    }, runtimeDependencies(root));

    const paused = await queen.run();
    assert.equal(paused.status, "paused");
    assert.equal(paused.tasks.filter((entry) => entry.role === "builder" && entry.status === "completed").length, 1);
    assert.equal(paused.tasks.filter((entry) => entry.role === "builder" && !["completed", "failed", "cancelled", "skipped"].includes(entry.status)).length, 1);
    const pausedEventIndex = events.findIndex((event) => event.type === "session.paused");
    const completedEventIndex = events.findIndex((event) => event.type === "task.completed" && paused.tasks.find((entry) => entry.id === event.payload.taskId)?.role === "builder");
    assert.ok(completedEventIndex >= 0 && pausedEventIndex > completedEventIndex);
    const completedBuilder = paused.tasks.find((entry) => entry.role === "builder" && entry.status === "completed");
    const completedSnapshot = { attempt: completedBuilder.attempt, completedAt: completedBuilder.completedAt, summary: completedBuilder.summary };
    const persisted = await new CodingSessionStore(root).load("session-cooperative-pause");
    assert.equal(persisted.status, "paused");

    const resumed = await new QueenOrchestrator({
      repositoryPath: root,
      resumeId: "session-cooperative-pause",
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 1,
      maxRetries: 1,
    }, runtimeDependencies(root)).run();
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.events.slice(-8)));
    const sameBuilder = resumed.tasks.find((entry) => entry.id === completedBuilder.id);
    assert.deepEqual(
      { attempt: sameBuilder.attempt, completedAt: sameBuilder.completedAt, summary: sameBuilder.summary },
      completedSnapshot,
    );
    assert.equal(resumed.tasks.filter((entry) => entry.role === "builder" && entry.status === "completed").length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Queen resume schedules dependency closure while skipping completed prerequisites", async () => {
  const root = await createRepository();
  try {
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
    const dependencies = runtimeDependencies(root);
    const complete = dependencies.provider.complete.bind(dependencies.provider);
    dependencies.provider.complete = async (request) => {
      if (request.role !== "planner") return complete(request);
      const plan = JSON.parse(planOutput());
      plan.tasks[1].dependencies = [plan.tasks[0].key];
      return { output: JSON.stringify(plan), usage: { total: 10 } };
    };
    let queen;
    let requested = false;
    queen = new QueenOrchestrator({ repositoryPath: root, objective: "Build dependent modules", sessionId: "session-dependent-resume", mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 1, onEvent: (event) => {
      if (requested || event.type !== "subagent.started") return;
      const task = queen.record?.tasks.find((entry) => entry.id === event.payload.subagentId);
      if (task?.role === "builder" && task.dependencies.length === 0) { requested = true; queen.requestPause(); }
    } }, dependencies);
    const paused = await queen.run();
    const prerequisite = paused.tasks.find((entry) => entry.role === "builder" && entry.dependencies.length === 0);
    const dependent = paused.tasks.find((entry) => entry.role === "builder" && entry.dependencies.length === 1);
    assert.equal(prerequisite.status, "completed");
    assert.ok(!["completed", "failed", "cancelled", "skipped"].includes(dependent.status));
    const snapshot = { attempt: prerequisite.attempt, completedAt: prerequisite.completedAt, summary: prerequisite.summary };
    const resumed = await new QueenOrchestrator({ repositoryPath: root, resumeId: paused.id, mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 1 }, dependencies).run();
    assert.equal(resumed.status, "completed");
    const savedPrerequisite = resumed.tasks.find((entry) => entry.id === prerequisite.id);
    assert.deepEqual({ attempt: savedPrerequisite.attempt, completedAt: savedPrerequisite.completedAt, summary: savedPrerequisite.summary }, snapshot);
    assert.equal(resumed.tasks.find((entry) => entry.id === dependent.id).attempt, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("cancellation wins durably while cooperative pause persistence is blocked", async () => {
  const root = await createRepository();
  try {
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
    const dependencies = runtimeDependencies(root);
    const baseStore = dependencies.store;
    const entered = deferred();
    const release = deferred();
    let blocked = false;
    dependencies.store = {
      load: (...args) => baseStore.load(...args),
      setActive: (...args) => baseStore.setActive(...args),
      async save(record) {
        if (record.status === "paused" && !blocked) { blocked = true; entered.resolve(); await release.promise; }
        return baseStore.save(record);
      },
    };
    const events = [];
    let queen;
    let requested = false;
    queen = new QueenOrchestrator({ repositoryPath: root, objective: "Cancel during pause persistence", sessionId: "session-cancel-pause-save", mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 1, onEvent: (event) => {
      events.push(event);
      if (!requested && event.type === "task.completed" && queen.record?.tasks.find((entry) => entry.id === event.payload.taskId)?.role === "builder") { requested = true; queen.requestPause(); }
    } }, dependencies);
    const completion = queen.run();
    await entered.promise;
    queen.cancel("Explicit cancellation wins.");
    release.resolve();
    const cancelled = await completion;
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await baseStore.load(cancelled.id)).status, "cancelled");
    assert.equal(events.some((event) => event.type === "session.paused"), false);
    assert.equal(events.at(-1).type, "session.cancelled");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const pausePoint of ["post-scout", "post-builder", "mid-validation", "post-validation", "mid-review"]) {
  test(`Queen resumes phase-aware after ${pausePoint} without rerunning completed roles`, async () => {
    const root = await createRepository();
    try {
      await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
      let queen;
      let requested = false;
      queen = new QueenOrchestrator({
        repositoryPath: root,
        objective: `Exercise ${pausePoint} resume`,
        sessionId: `session-${pausePoint}`,
        mode: "auto",
        approvalPolicy: "changes",
        maxAgents: 2,
        maxRetries: 1,
        onEvent: (event) => {
          if (requested) return;
          const taskId = event.type === "subagent.started" ? event.payload.subagentId : event.type === "task.completed" ? event.payload.taskId : undefined;
          const role = queen.record?.tasks.find((entry) => entry.id === taskId)?.role;
          const matches = pausePoint === "post-scout"
            ? event.type === "task.completed" && role === "scout"
            : pausePoint === "post-builder"
              ? event.type === "task.completed" && role === "builder"
              : pausePoint === "mid-validation"
                ? event.type === "subagent.started" && role === "validator"
                : pausePoint === "mid-review"
                  ? event.type === "subagent.started" && role === "reviewer"
                  : event.type === "task.completed" && role === "validator";
          if (matches) { requested = true; queen.requestPause(`Pause at ${pausePoint}.`); }
        },
      }, runtimeDependencies(root));
      const paused = await queen.run();
      assert.equal(paused.status, "paused");
      const completedBeforeResume = new Map(paused.tasks.filter((entry) => entry.status === "completed").map((entry) => [entry.id, { attempt: entry.attempt, summary: entry.summary, completedAt: entry.completedAt }]));

      const resumed = await new QueenOrchestrator({
        repositoryPath: root,
        resumeId: `session-${pausePoint}`,
        mode: "auto",
        approvalPolicy: "changes",
        maxAgents: 2,
        maxRetries: 1,
      }, runtimeDependencies(root)).run();
      assert.equal(resumed.status, "completed", JSON.stringify(resumed.events.slice(-5)));
      for (const [id, snapshot] of completedBeforeResume) {
        const task = resumed.tasks.find((entry) => entry.id === id);
        assert.deepEqual({ attempt: task.attempt, summary: task.summary, completedAt: task.completedAt }, snapshot, `completed task ${id} reran`);
      }
      assert.equal(resumed.tasks.filter((entry) => entry.role === "scout").length, 1);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "planner").length, 1);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "builder").length, 2);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "validator").length, 1);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "reviewer").length, 1);
      assert.ok(resumed.tasks.every((entry) => entry.attempt <= 1), "no task execution may be duplicated across resume");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const pausePoint of ["mid-fixer", "post-fixer", "mid-repair-validation", "post-repair-validation"]) {
  test(`Queen resumes the persisted repair frontier after ${pausePoint} without duplicating Fixers`, async () => {
    const root = await createRepository();
    try {
      await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
      const dependencies = runtimeDependencies(root, { failFirstValidation: true });
      let queen;
      let requested = false;
      queen = new QueenOrchestrator({
        repositoryPath: root,
        objective: `Exercise repair frontier ${pausePoint}`,
        sessionId: `session-repair-${pausePoint}`,
        mode: "auto",
        approvalPolicy: "changes",
        maxAgents: 1,
        maxRetries: 1,
        onEvent: (event) => {
          if (requested) return;
          const taskId = event.type === "subagent.started" ? event.payload.subagentId : event.type === "task.completed" ? event.payload.taskId : undefined;
          const currentTask = queen.record?.tasks.find((entry) => entry.id === taskId);
          const isRepairValidator = currentTask?.role === "validator" && currentTask.dependencies.some((dependencyId) => queen.record?.tasks.find((entry) => entry.id === dependencyId)?.role === "fixer");
          const matches = pausePoint === "mid-fixer"
            ? event.type === "subagent.started" && currentTask?.role === "fixer"
            : pausePoint === "post-fixer"
              ? event.type === "task.completed" && currentTask?.role === "fixer"
              : pausePoint === "mid-repair-validation"
                ? event.type === "subagent.started" && isRepairValidator
                : event.type === "task.completed" && isRepairValidator;
          if (matches) { requested = true; queen.requestPause(`Pause at ${pausePoint}.`); }
        },
      }, dependencies);
      const paused = await queen.run();
      assert.equal(paused.status, "paused");
      const completedBeforeResume = new Map(paused.tasks.filter((entry) => entry.status === "completed").map((entry) => [entry.id, { attempt: entry.attempt, summary: entry.summary, completedAt: entry.completedAt }]));

      const resumed = await new QueenOrchestrator({
        repositoryPath: root,
        resumeId: `session-repair-${pausePoint}`,
        mode: "auto",
        approvalPolicy: "changes",
        maxAgents: 1,
        maxRetries: 1,
      }, dependencies).run();
      assert.equal(resumed.status, "completed", JSON.stringify(resumed.events.slice(-8)));
      for (const [id, snapshot] of completedBeforeResume) {
        const task = resumed.tasks.find((entry) => entry.id === id);
        assert.deepEqual({ attempt: task.attempt, summary: task.summary, completedAt: task.completedAt }, snapshot, `completed repair task ${id} reran`);
      }
      assert.equal(resumed.tasks.filter((entry) => entry.role === "scout").length, 1);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "planner").length, 1);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "builder").length, 2);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "fixer").length, 1);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "validator").length, 2);
      assert.equal(resumed.tasks.filter((entry) => entry.role === "reviewer").length, 1);
      assert.ok(resumed.tasks.filter((entry) => entry.role !== "validator").every((entry) => entry.attempt <= 1));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("Queen resumes a persisted queued Fixer frontier without creating a second Fixer", async () => {
  const root = await createRepository();
  try {
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.worktrees/\n");
    const dependencies = runtimeDependencies(root, { failFirstValidation: true });
    let queen;
    queen = new QueenOrchestrator({
      repositoryPath: root,
      objective: "Resume a queued repair frontier",
      sessionId: "session-queued-fixer",
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 1,
      maxRetries: 1,
      onEvent: (event) => {
        if (event.type !== "task.completed") return;
        const completed = queen.record?.tasks.find((entry) => entry.id === event.payload.taskId);
        if (completed?.role === "validator" && !completed.dependencies.some((id) => queen.record?.tasks.find((entry) => entry.id === id)?.role === "fixer")) {
          queen.requestPause("Persist a queued Fixer fixture.");
        }
      },
    }, dependencies);
    const paused = await queen.run();
    assert.equal(paused.status, "paused");
    const validator = paused.tasks.find((entry) => entry.role === "validator");
    const builders = paused.tasks.filter((entry) => entry.role === "builder");
    const fixer = {
      id: "bee-900",
      sessionId: paused.id,
      role: "fixer",
      title: "Persisted queued repair",
      objective: "Repair the failed validation",
      status: "queued",
      providerId: "mock-fixer",
      model: "mock-model",
      dependencies: [validator.id],
      fileScope: builders.flatMap((entry) => entry.fileScope),
      expectedOutput: "A targeted repair",
      completionCriteria: ["Validation failure repaired"],
      validationCommands: [],
      depth: 2,
      attempt: 0,
      maxAttempts: 2,
      createdAt: "2026-07-11T00:10:00.000Z",
      queuedAt: "2026-07-11T00:10:01.000Z",
    };
    paused.tasks.push(fixer);
    await dependencies.store.save(paused);

    const resumed = await new QueenOrchestrator({
      repositoryPath: root,
      resumeId: paused.id,
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 1,
      maxRetries: 1,
    }, dependencies).run();
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.events.slice(-8)));
    assert.equal(resumed.tasks.filter((entry) => entry.role === "fixer").length, 1);
    assert.equal(resumed.tasks.find((entry) => entry.id === fixer.id).attempt, 1);
    assert.equal(resumed.tasks.filter((entry) => entry.role === "validator").length, 2);
    assert.equal(resumed.tasks.filter((entry) => entry.role === "builder").length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed validation creates a bounded Fixer and reruns validation", async () => {
  const root = await createRepository();
  try {
    const queen = new QueenOrchestrator({
      repositoryPath: root,
      objective: "Build and repair fixture modules",
      sessionId: "session-repair",
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 2,
      maxRetries: 2,
    }, runtimeDependencies(root, { failFirstValidation: true }));

    const record = await queen.run();
    assert.equal(record.status, "completed", JSON.stringify(record.finalReport?.outstanding));
    assert.ok(record.tasks.some((task) => task.role === "fixer" && task.status === "completed"));
    assert.ok(record.validationResults.some((result) => result.status === "failed"));
    assert.equal(record.validationResults.at(-1).status, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan mode persists the graph without creating a worktree", async () => {
  const root = await createRepository();
  try {
    const dependencies = runtimeDependencies(root);
    let worktreeCreated = false;
    dependencies.worktrees.create = async () => {
      worktreeCreated = true;
      throw new Error("plan mode must not create a worktree");
    };
    const queen = new QueenOrchestrator({
      repositoryPath: root,
      objective: "Plan fixture modules",
      sessionId: "session-plan",
      mode: "plan",
      approvalPolicy: "safe",
      maxAgents: 2,
      maxRetries: 1,
    }, dependencies);

    const record = await queen.run();
    assert.equal(record.status, "completed");
    assert.equal(worktreeCreated, false);
    assert.ok(record.tasks.filter((task) => task.role === "builder").every((task) => task.status === "skipped"));
    assert.equal(record.finalReport.filesChanged.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a safe-policy pause resumes after approval without treating HIVE metadata as a repository change", async () => {
  const root = await createRepository();
  try {
    const dependencies = runtimeDependencies(root);
    const paused = await new QueenOrchestrator({
      repositoryPath: root,
      objective: "Build resumable fixture modules",
      sessionId: "session-resume",
      mode: "auto",
      approvalPolicy: "safe",
      maxAgents: 2,
      maxRetries: 1,
    }, dependencies).run();

    assert.equal(paused.status, "paused");
    assert.ok(paused.tasks.some((task) => task.role === "builder" && task.status === "blocked"));

    const resumedEvents = [];
    const resumed = await new QueenOrchestrator({
      repositoryPath: root,
      resumeId: "session-resume",
      mode: "auto",
      approvalPolicy: "changes",
      maxAgents: 2,
      maxRetries: 1,
      onEvent: (event) => resumedEvents.push(event),
    }, dependencies).run();

    assert.equal(resumed.status, "completed", JSON.stringify(resumed.finalReport?.outstanding));
    assert.ok(resumedEvents.some((event) => event.type === "session.resumed"));
    assert.ok(resumed.tasks.filter((task) => task.role === "builder").every((task) => task.status === "completed"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
