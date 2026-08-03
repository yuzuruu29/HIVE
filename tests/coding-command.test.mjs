import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function record(root, overrides = {}) {
  const now = "2026-07-11T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "hive-test-session",
    objective: "Implement the command",
    mode: "auto",
    approvalPolicy: "changes",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    repository: { root, capturedAt: now, dirty: false, changedFiles: [] },
    tasks: [],
    events: [],
    providerBindings: [],
    validationResults: [],
    reviewResults: [],
    files: [],
    finalReport: {
      result: "Implemented the command.",
      subagents: { total: 1, active: 0, working: 0, waiting: 0, blocked: 0, done: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
      filesChanged: ["src/coding/command.ts"],
      validation: [{ label: "Tests", status: "passed" }],
      review: ["No critical findings"],
      outstanding: [],
      completedAt: now,
    },
    ...overrides,
  };
}

function event(type, payload = {}) {
  return {
    schemaVersion: 1,
    id: `event-${type}`,
    sequence: 1,
    sessionId: "hive-test-session",
    timestamp: "2026-07-11T00:00:00.000Z",
    type,
    payload,
  };
}

test("code command passes parsed flags to an injectable runtime and streams readable lines", async () => {
  const { runCodeCommand } = await import("../dist/coding/command.js");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hive-code-command-"));
  const lines = [];
  let received;
  const result = await runCodeCommand([
    "repair", "scheduler", "--mode", "review", "--max-agents", "2",
    "--max-retries", "1", "--provider", "mock", "--model", "coder",
    "--approval", "safe", "--no-tui",
  ], cwd, {
    onLine: (line) => lines.push(line),
    createRuntime(options) {
      received = options.command;
      return {
        async run() {
          options.onEvent(event("session.started"));
          options.onEvent(event("subagent.progress", { subagentId: "bee-001", activity: "Inspecting scheduler" }));
          return record(cwd);
        },
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(received.objective, "repair scheduler");
  assert.equal(received.mode, "review");
  assert.equal(received.maxAgents, 2);
  assert.deepEqual({ provider: received.provider, model: received.model }, { provider: "mock", model: "coder" });
  assert.deepEqual(lines, ["[Queen] Session started", "[Agent bee-001] Inspecting scheduler"]);
  assert.match(result.output, /HIVE coding session complete/);
});

test("json mode streams NDJSON events without a final decorated report", async () => {
  const { runCodeCommand } = await import("../dist/coding/command.js");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hive-code-json-"));
  const lines = [];
  const result = await runCodeCommand(["inspect", "repository", "--json"], cwd, {
    onLine: (line) => lines.push(line),
    createRuntime(options) {
      return { async run() { options.onEvent(event("session.started")); return record(cwd); } };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, "session.started");
  assert.doesNotMatch(lines[0], /HIVE coding session/);
});

test("top-level CLI exposes code help and delegates code execution", async () => {
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hive-code-cli-"));
  const help = await runCoderCli(["code", "--help"], { cwd });
  assert.equal(help.exitCode, 0);
  assert.match(help.output, /hive code "<objective>"/);

  let called = false;
  const result = await runCoderCli(["code", "bounded", "change", "--no-tui"], {
    cwd,
    codingRuntimeFactory(options) {
      called = true;
      return { async run() { return record(cwd, { objective: options.command.objective }); } };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(called, true);
  assert.match(result.output, /bounded change/);
});

test("sessions and agents commands read persisted coding sessions", async () => {
  const { CodingSessionStore } = await import("../dist/coding/session-store.js");
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hive-code-sessions-"));
  const saved = record(cwd, {
    tasks: [{
      id: "bee-001", sessionId: "hive-test-session", role: "builder", title: "Wire CLI",
      objective: "Wire CLI", expectedOutput: "working command", completionCriteria: ["tests pass"],
      validationCommands: ["npm test"],
      status: "completed", providerId: "mock", dependencies: [], fileScope: ["src/cli.ts"],
      depth: 0, attempt: 1, maxAttempts: 2, createdAt: "2026-07-11T00:00:00.000Z",
    }],
  });
  const store = new CodingSessionStore(cwd);
  await store.save(saved);

  const sessions = await runCoderCli(["sessions"], { cwd });
  assert.match(sessions.output, /hive-test-session \[completed\]/);
  const agents = await runCoderCli(["agents"], { cwd });
  assert.match(agents.output, /bee-001 \[builder\] completed/);
  const shown = await runCoderCli(["agents", "show", "bee-001"], { cwd });
  assert.equal(JSON.parse(shown.output).sessionId, "hive-test-session");
  let resumeOptions;
  const resumed = await runCoderCli(["resume", "hive-test-session"], {
    cwd,
    codingRuntimeFactory(options) {
      resumeOptions = options.command;
      return { async run() { return saved; } };
    },
  });
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumeOptions.resume, "hive-test-session");
  assert.match(resumed.output, /HIVE coding session complete/);
});
