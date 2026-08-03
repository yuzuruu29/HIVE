import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderRouter } from "../dist/coding/provider-router.js";
import {
  CodingSessionStore,
  SessionCorruptionError,
} from "../dist/coding/session-store.js";
import { RepositoryToolService } from "../dist/coding/tools.js";

const timestamp = "2026-07-11T00:00:00.000Z";

const task = (overrides = {}) => ({
  id: "bee-001",
  sessionId: "session-1",
  role: "builder",
  title: "Build service",
  objective: "Implement the bounded service",
  status: "created",
  providerId: "provider-a",
  dependencies: [],
  fileScope: ["src/new.ts"],
  expectedOutput: "A tested service",
  completionCriteria: ["Focused tests pass"],
  validationCommands: [],
  depth: 0,
  attempt: 0,
  maxAttempts: 2,
  createdAt: timestamp,
  ...overrides,
});

const session = (root, overrides = {}) => ({
  schemaVersion: 1,
  id: "session-1",
  objective: "Build coding services",
  mode: "auto",
  approvalPolicy: "changes",
  status: "running",
  createdAt: timestamp,
  updatedAt: timestamp,
  repository: {
    root,
    capturedAt: timestamp,
    dirty: false,
    changedFiles: [],
  },
  tasks: [],
  events: [],
  providerBindings: [],
  validationResults: [],
  reviewResults: [],
  files: [],
  ...overrides,
});

const provider = (id, model = `${id}-model`) => ({
  id,
  name: id,
  kind: "local",
  authType: "none",
  defaultModel: model,
  approved: true,
  createdAt: timestamp,
  updatedAt: timestamp,
});

function registry({ configs = [], roles = {}, health = {}, outputs = {} } = {}) {
  const byId = new Map(configs.map((config) => [config.id, config]));
  const calls = { get: [], test: [], complete: [] };
  return {
    calls,
    async get(id) {
      calls.get.push(id);
      return byId.get(id);
    },
    async getRoles() {
      return roles;
    },
    async test(id) {
      calls.test.push(id);
      const ok = health[id] !== false;
      return {
        ok,
        providerId: id,
        message: ok ? "healthy" : "unavailable",
      };
    },
    async getAdapter(id) {
      const config = byId.get(id);
      if (!config) throw new Error(`missing ${id}`);
      return {
        config,
        adapter: {
          kind: config.kind,
          async healthCheck() {
            throw new Error("registry.test must own health checks");
          },
          async complete(_config, input) {
            calls.complete.push({ id, model: input.model });
            const output = outputs[id];
            if (output instanceof Error) throw output;
            return { output: output ?? `${id} response` };
          },
        },
      };
    },
  };
}

test("session persistence redacts secrets without mutating caller state and restores active state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-session-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const record = session(root, {
    tasks: [task({ summary: `provider returned ${secret}` })],
    events: [
      {
        schemaVersion: 1,
        id: "evt-1",
        sequence: 1,
        sessionId: "session-1",
        timestamp,
        type: "task.progress",
        payload: { taskId: "bee-001", message: `API_KEY=${secret}` },
      },
    ],
  });
  const store = new CodingSessionStore(root, { clock: () => timestamp });

  const saved = await store.save(record);
  assert.match(record.tasks[0].summary, /sk-/);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.match(saved.tasks[0].summary, /\[REDACTED\]/);

  await store.setActive(record.id);
  assert.deepEqual(await store.getActive(), await store.load(record.id));
  assert.equal((await store.getAgent(record.id, "bee-001")).id, "bee-001");
  await store.clearActive();
  assert.equal(await store.getActive(), null);
});

test("session persistence rejects corrupted snapshots and unsafe ids", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-corrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CodingSessionStore(root);
  await assert.rejects(store.load("../escape"), /Invalid session id/);
  const directory = store.getSessionDirectory("broken");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "session.json"), "{not-json", "utf8");
  await assert.rejects(
    store.load("broken"),
    (error) => error instanceof SessionCorruptionError,
  );

  const invalidEvent = session(root, {
    id: "invalid-event",
    events: [
      {
        schemaVersion: 1,
        id: "evt-1",
        sequence: 1,
        sessionId: "invalid-event",
        timestamp,
        type: "unknown.event",
        payload: {},
      },
    ],
  });
  await assert.rejects(store.save(invalidEvent), /event type unknown\.event is invalid/);
});

test("provider routing honors explicit, session, project, and global precedence", async () => {
  const configs = ["explicit", "session", "project", "global"].map((id) => provider(id));
  const projectRegistry = registry({
    configs: configs.slice(0, 3),
    roles: { builder: { provider: "project", model: "project-role-model" } },
  });
  const globalRegistry = registry({
    configs: [configs[3]],
    roles: { builder: { provider: "global", model: "global-role-model" } },
  });
  const router = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-1",
    sessionBindings: [{ role: "builder", providerId: "session", model: "session-model" }],
    projectRegistry,
    globalRegistry,
  });

  assert.equal((await router.resolve("builder")).providerId, "session");
  assert.equal(
    (await router.resolve("builder", { providerId: "explicit", model: "explicit-model" })).providerId,
    "explicit",
  );

  const projectOnly = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-2",
    projectRegistry,
    globalRegistry,
  });
  assert.equal((await projectOnly.resolve("builder")).providerId, "project");

  const globalOnly = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-3",
    projectRegistry: registry(),
    globalRegistry,
  });
  assert.equal((await globalOnly.resolve("builder")).providerId, "global");
});

test("provider routing checks health, caches healthy routes, and uses only configured fallback", async () => {
  const degraded = [];
  const projectRegistry = registry({
    configs: [provider("primary"), provider("fallback")],
    roles: {
      builder: { provider: "primary", model: "primary-model" },
      fallback: { provider: "fallback", model: "fallback-model" },
    },
    health: { primary: false },
  });
  const router = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-1",
    projectRegistry,
    globalRegistry: registry(),
    onDegradedRoute: (route, failures) => degraded.push({ route, failures }),
  });

  const first = await router.resolve("builder");
  const second = await router.resolve("builder");
  assert.equal(first.providerId, "fallback");
  assert.equal(first.degraded, true);
  assert.equal(second.providerId, "fallback");
  assert.equal(projectRegistry.calls.test.filter((id) => id === "fallback").length, 1);
  assert.match(degraded[0].failures[0], /primary.*unavailable/);

  const noFallback = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-2",
    projectRegistry: registry({
      configs: [provider("primary")],
      roles: { builder: { provider: "primary", model: "model" } },
      health: { primary: false },
    }),
    globalRegistry: registry({ configs: [provider("unused")] }),
  });
  await assert.rejects(noFallback.resolve("builder"), /No healthy provider route/);

  const fallbackOnly = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-3",
    projectRegistry: registry({
      configs: [provider("fallback-only")],
      roles: { fallback: { provider: "fallback-only", model: "fallback-model" } },
    }),
    globalRegistry: registry(),
  });
  const fixerRoute = await fallbackOnly.resolve("fixer");
  assert.equal(fixerRoute.providerId, "fallback-only");
  assert.equal(fixerRoute.degraded, true);
  assert.equal(fixerRoute.source, "fallback");
});

test("provider completion falls back after failure, rejects empty output, and supports cancellation", async () => {
  const projectRegistry = registry({
    configs: [provider("primary"), provider("fallback")],
    roles: {
      builder: { provider: "primary", model: "primary-model" },
      fallback: { provider: "fallback", model: "fallback-model" },
    },
    outputs: { primary: new Error("temporary failure"), fallback: "recovered" },
  });
  const router = new ProviderRouter({
    projectRoot: process.cwd(),
    sessionId: "session-1",
    projectRegistry,
    globalRegistry: registry(),
  });
  assert.equal((await router.complete({ role: "builder", prompt: "build" })).output, "recovered");

  const empty = registry({
    configs: [provider("empty")],
    roles: { builder: { provider: "empty", model: "model" } },
    outputs: { empty: "   " },
  });
  await assert.rejects(
    new ProviderRouter({ projectRoot: process.cwd(), sessionId: "session-2", projectRegistry: empty, globalRegistry: registry() })
      .complete({ role: "builder", prompt: "build" }),
    /empty response/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    router.resolve("builder", undefined, controller.signal),
    (error) => error.name === "AbortError",
  );
});

test("repository tools enforce exact scope, traversal, symlink, and prohibited Git safety", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-tools-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hive-outside-"));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const service = new RepositoryToolService({
    repositoryRoot: root,
    sessionId: "session-1",
    approvalPolicy: "always",
    fileScope: ["src/new.ts"],
  });

  await service.createFile("src/new.ts", "export const value = 1;\n");
  await assert.rejects(service.writeFile("src/other.ts", "no"), /outside the exact declared file scope/);
  await assert.rejects(service.readFile("../outside.txt"), /traversal/);
  await assert.rejects(service.runCommand(["git", "reset", "--hard"]), /Prohibited Git operation/);
  await assert.rejects(service.runCommand(["git", "clean", "-fd"]), /Prohibited Git operation/);
  await assert.rejects(service.runCommand(["npm", "--prefix=../../outside", "test"]), /escapes the repository/);

  const link = path.join(root, "escape-link");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(service.listDirectory("escape-link"), /Symbolic-link path escapes/);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
});

test("repository tool execution exposes create-file changes and diff metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-events-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "hive@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "HIVE Test"], { cwd: root });
  await fs.writeFile(path.join(root, "existing.ts"), "export const value = 1;\n", "utf8");
  execFileSync("git", ["add", "existing.ts"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
  const events = [];
  const service = new RepositoryToolService({
    repositoryRoot: root,
    sessionId: "session-1",
    approvalPolicy: "changes",
    onEvent: (event) => events.push(event),
  });
  const executionTask = task({ fileScope: ["src/new.ts", "existing.ts"] });
  const signal = new AbortController().signal;

  const created = await service.execute(
    "create_file",
    { path: "src/new.ts", content: "export const created = true;\n" },
    executionTask,
    signal,
  );
  assert.equal(created.ok, true);
  assert.equal(created.metadata.operation, "created");

  await service.editFile("existing.ts", "value = 1", "value = 2", false, {
    taskId: executionTask.id,
    subagentId: executionTask.id,
    fileScope: executionTask.fileScope,
  });
  const diff = await service.execute("inspect_diff", {}, executionTask, signal);
  assert.deepEqual(diff.metadata.filesChanged, ["existing.ts"]);
  assert.equal(events.some((event) => event.type === "file.changed" && event.payload.change.path === "src/new.ts"), true);
  assert.equal(events.some((event) => event.type === "subagent.file_changed"), true);
});

test("command output is truncated in memory, stored in full, and secrets are redacted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-output-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const service = new RepositoryToolService({
    repositoryRoot: root,
    sessionId: "session-1",
    approvalPolicy: "changes",
    outputCapChars: 1_024,
  });
  const result = await service.runCommand([
    "node",
    "-e",
    `process.stdout.write(${JSON.stringify(`${secret}\n${"x".repeat(4_000)}`)})`,
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.truncated, true);
  assert.equal(result.output.includes(secret), false);
  const stored = await service.readCommandOutput(result.commandId, 10_000);
  assert.equal(stored.content.includes(secret), false);
  assert.match(stored.content, /\[REDACTED\]/);
  assert.equal(stored.size > result.output.length, true);
});
