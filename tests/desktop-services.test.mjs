import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  DefaultDesktopRunManager,
  DesktopCredentialVault,
  DefaultGuardedGitService,
  JsonThreadStore,
  JsonCredentialEnvelopeStore,
} from "../dist/desktop/index.js";
import { WorktreeManager, branchNameForTask } from "../dist/worktree.js";

const exec = promisify(execFile);
const now = "2026-07-14T00:00:00.000Z";

async function tempDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(cwd, args) {
  return exec("git", args, { cwd, encoding: "utf8" });
}

async function makeRepository(prefix = "hive-desktop-") {
  const root = await tempDirectory(prefix);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "hive@example.test"]);
  await git(root, ["config", "user.name", "HIVE Test"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "baseline"]);
  return root;
}

async function makeThread(repositoryRoot, threadId = "thread-1", messageId = "message-1", content = "Build it") {
  const store = new JsonThreadStore(repositoryRoot, { clock: () => now });
  const thread = await store.create({ id: threadId, title: "Desktop work" });
  thread.messages.push({ id: messageId, role: "user", content, createdAt: now });
  return { store, thread: await store.save(thread) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function session(repositoryRoot, id, status = "completed", overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    objective: "persisted objective",
    mode: "auto",
    approvalPolicy: "safe",
    status,
    createdAt: now,
    updatedAt: now,
    repository: { root: repositoryRoot, capturedAt: now, dirty: false, changedFiles: [] },
    tasks: [],
    events: [],
    providerBindings: [],
    validationResults: [],
    reviewResults: [],
    files: [],
    ...overrides,
  };
}

async function eventually(assertion, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    try { return await assertion(); } catch (error) {
      if (Date.now() - started >= timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

const runOptions = { mode: "auto", approvalPolicy: "safe", maxAgents: 2, maxRetries: 1 };

test("run manager builds only the persisted deterministic objective and gates same-repository work", async (t) => {
  const repoA = await makeRepository();
  const repoB = await makeRepository();
  t.after(async () => Promise.all([rm(repoA, { recursive: true, force: true }), rm(repoB, { recursive: true, force: true })]));
  const { store: storeA, thread: threadA } = await makeThread(repoA, "thread-a", "message-a", "first");
  threadA.messages.unshift({ id: "prior-a", role: "assistant", content: "prior", createdAt: now });
  await storeA.save(threadA);
  await makeThread(repoA, "thread-b", "message-b", "same repo");
  await makeThread(repoB, "thread-c", "message-c", "other repo");

  const launches = [];
  const completions = new Map();
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: (() => { let id = 0; return () => `session-${++id}`; })(),
    threadStoreFactory: (root) => new JsonThreadStore(root),
    launcher(input) {
      launches.push(input);
      const pending = deferred();
      completions.set(input.sessionId, pending);
      return pending.promise;
    },
  });

  const first = await manager.start({ repositoryRoot: path.join(repoA, "."), threadId: "thread-a", currentUserMessageId: "message-a", options: runOptions });
  assert.equal(first.status, "created");
  await eventually(() => assert.equal(launches.length, 1));
  assert.equal(launches[0].objective, "[user]\nfirst\n\n[prior assistant]\nprior");
  assert.equal("rendererObjective" in launches[0], false);
  await assert.rejects(
    manager.start({ repositoryRoot: repoA, threadId: "thread-b", currentUserMessageId: "message-b", options: runOptions }),
    /active|nonterminal/i,
  );
  const other = await manager.start({ repositoryRoot: repoB, threadId: "thread-c", currentUserMessageId: "message-c", options: runOptions });
  assert.equal(other.codingSessionId, "session-2");

  completions.get(first.codingSessionId).resolve(session(await realpath(repoA), first.codingSessionId));
  await eventually(async () => assert.equal((await storeA.load("thread-a")).runs[0].status, "completed"));
  const updated = await storeA.load("thread-a");
  updated.messages.push({ id: "message-follow-up", role: "user", content: "follow up", createdAt: now });
  await storeA.save(updated);
  const followUp = await manager.start({ repositoryRoot: repoA, threadId: "thread-a", currentUserMessageId: "message-follow-up", options: runOptions });
  assert.equal(followUp.codingSessionId, "session-3");
  await assert.rejects(
    manager.start({ repositoryRoot: repoA, threadId: "thread-a", currentUserMessageId: "message-follow-up", options: runOptions }),
    /already has a run|duplicate/i,
  );
  completions.get(other.codingSessionId).resolve(session(await realpath(repoB), other.codingSessionId));
  completions.get(followUp.codingSessionId).resolve(session(await realpath(repoA), followUp.codingSessionId));
  await eventually(async () => assert.equal((await storeA.load("thread-a")).runs.at(-1).status, "completed"));
  await eventually(async () => {
    const storeB = new JsonThreadStore(repoB);
    assert.equal((await storeB.load("thread-c")).runs[0].status, "completed");
  });
  const archived = await makeThread(repoA, "thread-archived", "message-archived", "no run");
  await archived.store.archive("thread-archived");
  await assert.rejects(
    manager.start({ repositoryRoot: repoA, threadId: "thread-archived", currentUserMessageId: "message-archived", options: runOptions }),
    /archived/i,
  );
});

test("run manager forwards canonical events, persists pause/cancel, and resumes by repository/thread/session identity", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo);
  const events = [];
  const launches = [];
  const slotReleased = deferred();
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: () => "session-events",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    onEvent: (event) => {
      events.push(event);
      if (event.type === "worker.stopped" && event.codingSessionId === "session-events") slotReleased.resolve();
    },
    launcher(input) {
      launches.push(input);
      if (!input.resumeId) {
        input.onEvent({
          schemaVersion: 1, id: "event-1", sessionId: input.sessionId, sequence: 1, timestamp: now,
          type: "session.paused", payload: { reason: "approval" },
        });
        return Promise.resolve(session(input.repositoryRoot, input.sessionId, "paused"));
      }
      return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(session(input.repositoryRoot, input.sessionId, "cancelled")), { once: true }));
    },
  });
  const run = await manager.start({ repositoryRoot: repo, threadId: "thread-1", currentUserMessageId: "message-1", options: runOptions });
  await eventually(async () => assert.equal((await store.load("thread-1")).runs[0].status, "paused"));
  assert.ok(events.some((event) => event.type === "runtime.event" && event.event.type === "session.paused"));
  let releaseTimer;
  try {
    await Promise.race([
      slotReleased.promise,
      new Promise((_, reject) => { releaseTimer = setTimeout(() => reject(new Error("worker slot release event timed out")), 10_000); }),
    ]);
  } finally {
    clearTimeout(releaseTimer);
  }
  await eventually(async () => assert.equal((await store.load("thread-1")).runs[0].status, "paused"));
  const resumed = await manager.resume({ repositoryRoot: repo, threadId: "thread-1", codingSessionId: run.codingSessionId, options: runOptions });
  assert.equal(resumed.status, "paused");
  await eventually(() => assert.equal(launches.length, 2));
  assert.equal(launches[1].resumeId, run.codingSessionId);
  await manager.cancel({ repositoryRoot: repo, threadId: "thread-1", codingSessionId: run.codingSessionId });
  assert.equal((await store.load("thread-1")).runs[0].status, "cancelled");
});

test("run manager acknowledges cooperative pause only after authoritative persistence and releases the repository slot", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo);
  const completion = deferred();
  const events = [];
  let authoritative = session(await realpath(repo), "session-cooperative", "running");
  let pauseCalls = 0;
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: () => "session-cooperative",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    codingSessionStoreFactory: () => ({ async load() { return authoritative; } }),
    onEvent: (event) => events.push(event),
    launcher(input) {
      return {
        completion: completion.promise,
        async requestPause() {
          pauseCalls += 1;
          authoritative = session(input.repositoryRoot, input.sessionId, "paused");
          input.onEvent({ schemaVersion: 1, id: "event-pause", sessionId: input.sessionId, sequence: 1, timestamp: now, type: "session.paused", payload: { reason: "Desktop pause requested." } });
          completion.resolve(authoritative);
          return true;
        },
      };
    },
  });

  const run = await manager.start({ repositoryRoot: repo, threadId: "thread-1", currentUserMessageId: "message-1", options: runOptions });
  await eventually(() => assert.equal(typeof manager.pause, "function"));
  await manager.pause({ repositoryRoot: repo, threadId: "thread-1", codingSessionId: run.codingSessionId });
  assert.equal(pauseCalls, 1);
  assert.equal((await store.load("thread-1")).runs[0].status, "paused");
  assert.ok(events.findIndex((event) => event.type === "runtime.event" && event.event.type === "session.paused") < events.findIndex((event) => event.type === "worker.stopped"));
  await manager.pause({ repositoryRoot: repo, threadId: "thread-1", codingSessionId: run.codingSessionId });
  assert.equal(pauseCalls, 1, "repeated pause after acknowledgement must be idempotent");
});

test("desktop cancellation racing a pause leaves the thread and authoritative session cancelled", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo);
  const events = [];
  let authoritative = session(await realpath(repo), "session-pause-cancel-race", "running");
  let launched;
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: () => "session-pause-cancel-race",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    codingSessionStoreFactory: () => ({ async load() { return authoritative; } }),
    onEvent: (event) => events.push(event),
    launcher(input) {
      launched = deferred();
      input.signal.addEventListener("abort", () => { authoritative = session(input.repositoryRoot, input.sessionId, "cancelled"); launched.resolve(authoritative); }, { once: true });
      return { completion: launched.promise, requestPause: () => true };
    },
  });
  const run = await manager.start({ repositoryRoot: repo, threadId: "thread-1", currentUserMessageId: "message-1", options: runOptions });
  await eventually(() => assert.ok(launched));
  const pause = manager.pause({ repositoryRoot: repo, threadId: "thread-1", codingSessionId: run.codingSessionId });
  const cancel = manager.cancel({ repositoryRoot: repo, threadId: "thread-1", codingSessionId: run.codingSessionId });
  await Promise.all([pause, cancel]);
  assert.equal((await store.load("thread-1")).runs[0].status, "cancelled");
  assert.equal(authoritative.status, "cancelled");
  assert.equal(events.some((event) => event.type === "run.changed" && event.run.status === "paused"), false);
});

test("concurrent starts reserve one canonical repository slot", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await makeThread(repo, "thread-one", "message-one", "one");
  await makeThread(repo, "thread-two", "message-two", "two");
  const pending = deferred();
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: () => "concurrent-session",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    launcher: () => pending.promise,
  });
  const results = await Promise.allSettled([
    manager.start({ repositoryRoot: repo, threadId: "thread-one", currentUserMessageId: "message-one", options: runOptions }),
    manager.start({ repositoryRoot: path.join(repo, "."), threadId: "thread-two", currentUserMessageId: "message-two", options: runOptions }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const successful = results.find((result) => result.status === "fulfilled").value;
  pending.resolve(session(await realpath(repo), successful.codingSessionId));
  const winningThread = results[0].status === "fulfilled" ? "thread-one" : "thread-two";
  await eventually(async () => assert.equal((await new JsonThreadStore(repo).load(winningThread)).runs[0].status, "completed"));
});

test("a new run manager rebuilds the repository-wide nonterminal gate from every persisted thread", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const first = await makeThread(repo, "persisted-active", "active-message", "active");
  first.thread.runs.push({ userMessageId: "active-message", codingSessionId: "persisted-session", status: "paused", createdAt: now, updatedAt: now });
  await first.store.save(first.thread);
  await makeThread(repo, "new-thread", "new-message", "new work");
  let launched = false;
  const restarted = new DefaultDesktopRunManager({
    threadStoreFactory: (root) => new JsonThreadStore(root),
    launcher: async () => { launched = true; return session(repo, "unexpected"); },
  });
  await assert.rejects(
    restarted.start({ repositoryRoot: repo, threadId: "new-thread", currentUserMessageId: "new-message", options: runOptions }),
    /repository|nonterminal|active/i,
  );
  assert.equal(launched, false);
});

test("cancel reconstructs persisted runs, force-terminates hung launchers, and ignores late completion", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo, "hung-thread", "hung-message", "hang");
  const hung = deferred();
  let forced = 0;
  const manager = new DefaultDesktopRunManager({
    cancelTimeoutMs: 100,
    sessionIdFactory: () => "hung-session",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    launcher: () => ({ completion: hung.promise, forceTerminate: async () => {
      forced += 1;
      hung.resolve(session(await realpath(repo), "hung-session", "cancelled"));
    } }),
  });
  const run = await manager.start({ repositoryRoot: repo, threadId: "hung-thread", currentUserMessageId: "hung-message", options: runOptions });
  await manager.cancel({ repositoryRoot: repo, threadId: "hung-thread", codingSessionId: run.codingSessionId });
  assert.equal(forced, 1);
  assert.equal((await store.load("hung-thread")).runs[0].status, "cancelled");
  const persisted = await makeThread(repo, "restart-thread", "restart-message", "restart");
  persisted.thread.runs.push({ userMessageId: "restart-message", codingSessionId: "restart-session", status: "running", createdAt: now, updatedAt: now });
  await persisted.store.save(persisted.thread);
  const restarted = new DefaultDesktopRunManager({ threadStoreFactory: (root) => new JsonThreadStore(root) });
  await assert.rejects(
    restarted.cancel({ repositoryRoot: repo, threadId: "restart-thread", codingSessionId: "restart-session" }),
    /completion|worker|active|cancel/i,
  );
  assert.equal((await persisted.store.load("restart-thread")).runs[0].status, "running");
});

test("cancel fails closed when force termination does not settle the worker", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo, "stuck-thread", "stuck-message", "stuck");
  await makeThread(repo, "blocked-thread", "blocked-message", "blocked");
  const events = [];
  let forced = 0;
  const manager = new DefaultDesktopRunManager({
    cancelTimeoutMs: 5,
    sessionIdFactory: () => "stuck-session",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    onEvent: (event) => events.push(event),
    launcher: () => ({ completion: new Promise(() => undefined), forceTerminate: async () => { forced += 1; } }),
  });
  const run = await manager.start({ repositoryRoot: repo, threadId: "stuck-thread", currentUserMessageId: "stuck-message", options: runOptions });
  await assert.rejects(
    manager.cancel({ repositoryRoot: repo, threadId: "stuck-thread", codingSessionId: run.codingSessionId }),
    /did not stop|timed out|completion/i,
  );
  assert.equal(forced, 1);
  assert.equal((await store.load("stuck-thread")).runs[0].status, "created");
  await assert.rejects(
    manager.start({ repositoryRoot: repo, threadId: "blocked-thread", currentUserMessageId: "blocked-message", options: runOptions }),
    /active|nonterminal|repository/i,
  );
  assert.ok(events.some((event) => event.type === "worker.failed" && event.recoverable));
});

test("worker failures redact provider keys before desktop event forwarding", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo, "error-thread", "error-message", "fail");
  const events = [];
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: () => "error-session",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    onEvent: (event) => events.push(event),
    launcher: async () => { throw new Error("provider failed api_key=sk-abcdefghijklmnop bearer ghp_abcdefghijklmnop"); },
  });
  await manager.start({ repositoryRoot: repo, threadId: "error-thread", currentUserMessageId: "error-message", options: runOptions });
  await eventually(async () => assert.equal((await store.load("error-thread")).runs[0].status, "failed"));
  const serialized = JSON.stringify(events.filter((event) => event.type === "worker.failed"));
  assert.doesNotMatch(serialized, /sk-abcdefghijklmnop|ghp_abcdefghijklmnop/);
  assert.match(serialized, /REDACTED/);
});

test("runtime failure reloads authoritative paused session status", async (t) => {
  const repo = await makeRepository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { store } = await makeThread(repo, "paused-thread", "paused-message", "pause authoritatively");
  const manager = new DefaultDesktopRunManager({
    sessionIdFactory: () => "paused-session",
    threadStoreFactory: (root) => new JsonThreadStore(root),
    codingSessionStoreFactory: () => ({ load: async () => session(repo, "paused-session", "paused") }),
    launcher: async () => { throw new Error("utility exited unexpectedly"); },
  });
  await manager.start({ repositoryRoot: repo, threadId: "paused-thread", currentUserMessageId: "paused-message", options: runOptions });
  await eventually(async () => assert.equal((await store.load("paused-thread")).runs[0].status, "paused"));
});

class MemoryCredentialStore {
  entries = new Map();
  async list() { return [...this.entries.values()]; }
  async load(providerId) { return this.entries.get(providerId) ?? null; }
  async save(envelope) { this.entries.set(envelope.providerId, structuredClone(envelope)); }
  async create(envelope) { if (this.entries.has(envelope.providerId)) return false; await this.save(envelope); return true; }
  async replace(envelope) { if (!this.entries.has(envelope.providerId)) return false; await this.save(envelope); return true; }
  async remove(providerId) { this.entries.delete(providerId); }
  async removeIfMatches(providerId, kind) {
    const existing = this.entries.get(providerId);
    if (!existing) return "missing";
    if (existing.kind !== kind) return "kind-mismatch";
    this.entries.delete(providerId);
    return "removed";
  }
}

test("credential vault exposes only metadata while the internal resolver alone can decrypt", async () => {
  const store = new MemoryCredentialStore();
  const cipher = {
    isEncryptionAvailable: () => true,
    encrypt: (value) => Buffer.from([...value].reverse().join(""), "utf8"),
    decrypt: (value) => Buffer.from(value).toString("utf8").split("").reverse().join(""),
  };
  const vault = new DesktopCredentialVault({ store, cipher, clock: () => now, tester: async (resolved) => resolved.secret === "sk-secret-never-public" });
  const metadata = await vault.set({ providerId: "openai", kind: "api-key", secret: "sk-secret-never-public" });
  assert.deepEqual(metadata, { providerId: "openai", kind: "api-key", configured: true, updatedAt: now, displayHint: "••••blic" });
  assert.doesNotMatch(JSON.stringify([metadata, await vault.list(), await vault.metadata("openai"), await vault.test({ providerId: "openai", kind: "api-key" })]), /sk-secret-never-public|secret/i);
  assert.doesNotMatch(JSON.stringify([...store.entries.values()]), /sk-secret-never-public/);
  assert.equal((await vault.credentialResolver.resolve("openai")).secret, "sk-secret-never-public");
  await vault.replace({ providerId: "openai", kind: "api-key", secret: "replacement-private" });
  await vault.remove({ providerId: "openai", kind: "api-key" });
  assert.equal(await vault.metadata("openai"), null);
});

test("credential envelope validation rejects excess plaintext fields without rewriting", async () => {
  const malicious = { providerId: "openai", kind: "api-key", ciphertext: "ZW5jcnlwdGVk", updatedAt: now, secret: "plaintext-leak" };
  const store = new MemoryCredentialStore();
  store.entries.set("openai", structuredClone(malicious));
  const vault = new DesktopCredentialVault({
    store,
    cipher: { isEncryptionAvailable: () => true, encrypt: (value) => Buffer.from(value), decrypt: (value) => Buffer.from(value).toString("utf8") },
  });
  await assert.rejects(vault.list(), /envelope|shape|corrupt|field/i);
  assert.deepEqual(store.entries.get("openai"), malicious);
});

test("credential display hints never reveal a complete short secret", async () => {
  const store = new MemoryCredentialStore();
  const vault = new DesktopCredentialVault({
    store,
    clock: () => now,
    cipher: { isEncryptionAvailable: () => true, encrypt: (value) => Buffer.from(value), decrypt: (value) => Buffer.from(value).toString("utf8") },
  });
  const four = await vault.set({ providerId: "four", kind: "api-key", secret: "abcd" });
  const short = await vault.set({ providerId: "short", kind: "bearer", secret: "short" });
  assert.equal(four.displayHint, "••••");
  assert.equal(short.displayHint, "••••");
  assert.doesNotMatch(JSON.stringify([four, short]), /abcd/);
  assert.notEqual(short.displayHint, "short");
});

test("JSON credential transactions preserve concurrent providers and admit one same-provider create", async (t) => {
  const directory = await tempDirectory("hive-credentials-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cipher = { isEncryptionAvailable: () => true, encrypt: (value) => Buffer.from(value), decrypt: (value) => Buffer.from(value).toString("utf8") };
  const first = new DesktopCredentialVault({ store: new JsonCredentialEnvelopeStore(directory), cipher, clock: () => now });
  const second = new DesktopCredentialVault({ store: new JsonCredentialEnvelopeStore(directory), cipher, clock: () => now });
  await Promise.all([
    first.set({ providerId: "alpha", kind: "api-key", secret: "alpha-secret" }),
    second.set({ providerId: "beta", kind: "bearer", secret: "beta-secret" }),
  ]);
  assert.deepEqual((await first.list()).map((entry) => entry.providerId), ["alpha", "beta"]);
  const competing = await Promise.allSettled([
    first.set({ providerId: "shared", kind: "api-key", secret: "first-shared" }),
    second.set({ providerId: "shared", kind: "api-key", secret: "second-shared" }),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
});

test("credential remove atomically compares kind against concurrent replacement", async (t) => {
  const directory = await tempDirectory("hive-credential-race-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cipher = { isEncryptionAvailable: () => true, encrypt: (value) => Buffer.from(value), decrypt: (value) => Buffer.from(value).toString("utf8") };
  const first = new DesktopCredentialVault({ store: new JsonCredentialEnvelopeStore(directory), cipher, clock: () => now });
  const second = new DesktopCredentialVault({ store: new JsonCredentialEnvelopeStore(directory), cipher, clock: () => now });
  for (let index = 0; index < 10; index += 1) {
    const providerId = `race-${index}`;
    await first.set({ providerId, kind: "api-key", secret: "original-secret" });
    const [replacement, removal] = await Promise.allSettled([
      first.replace({ providerId, kind: "bearer", secret: "replacement-secret" }),
      second.remove({ providerId, kind: "api-key" }),
    ]);
    const current = await first.metadata(providerId);
    if (replacement.status === "fulfilled") {
      assert.equal(removal.status, "rejected");
      assert.equal(current?.kind, "bearer");
    } else {
      assert.equal(removal.status, "fulfilled");
      assert.equal(current, null);
    }
  }
});

function reviewedSession(repositoryRoot, id, files = ["README.md"], overrides = {}) {
  return session(repositoryRoot, id, "completed", {
    validationResults: [{ id: "v1", command: "npm test", status: "passed", startedAt: now, completedAt: now, exitCode: 0 }],
    reviewResults: [{ id: "r1", status: "passed", summary: "approved", findings: [], completedAt: now }],
    files: files.map((file, index) => ({ path: file, operation: "modified", recordedAt: `${now.slice(0, -5)}${String(index).padStart(3, "0")}Z` })),
    ...overrides,
  });
}

async function makeGitFixture(t, sessionId = "git-session") {
  const repo = await makeRepository("hive-git-");
  await git(repo, ["remote", "add", "origin", "https://example.test/hive.git"]);
  t.after(() => rm(repo, { recursive: true, force: true }));
  const manager = new WorktreeManager(repo);
  const worktree = await manager.createWorktree(sessionId);
  const sessions = new Map([[sessionId, reviewedSession(repo, sessionId)]]);
  const remoteHeads = new Map();
  const forge = {
    pushes: [], prs: [],
    async push(...args) { this.pushes.push(args); remoteHeads.set(args[1], (await git(args[0], ["rev-parse", "HEAD"])).stdout.trim()); },
    async createPR(...args) { this.prs.push(args); return "https://example.test/pr/1"; },
  };
  const service = new DefaultGuardedGitService({
    sessionStoreFactory: () => ({ load: async (id) => sessions.get(id) ?? null }),
    worktreeManagerFactory: () => manager,
    forge,
    remoteHeadResolver: async (_worktree, _remote, branch) => remoteHeads.get(branch) ?? null,
    tokenFactory: (() => { let id = 0; return () => `token-${++id}`; })(),
  });
  return { repo, worktree, manager, sessions, forge, service, remoteHeads, sessionId };
}

test("guarded push rejects credential-bearing remotes and remote drift without exposing the URL", async (t) => {
  const fixture = await makeGitFixture(t, "remote-safety-session");
  const proposal = { action: "push", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, remote: "origin" };
  await git(fixture.repo, ["remote", "set-url", "origin", "https://token@host.test/repo.git"]);
  await assert.rejects(fixture.service.prepareConfirmation(proposal), (error) => /unsafe|unavailable/i.test(error.message) && !error.message.includes("token@"));
  await git(fixture.repo, ["remote", "set-url", "origin", "https://host.test/org/repo.git"]);
  await git(fixture.repo, ["config", "--add", "remote.origin.pushurl", "https://push-token@host.test/org/repo.git"]);
  await assert.rejects(fixture.service.prepareConfirmation(proposal), (error) => /unsafe|unavailable/i.test(error.message) && !error.message.includes("push-token@"));
  await git(fixture.repo, ["config", "--unset-all", "remote.origin.pushurl"]);
  await git(fixture.repo, ["remote", "set-url", "origin", "ssh://git@host.test/org/repo.git"]);
  await fixture.service.prepareConfirmation(proposal);
  await git(fixture.repo, ["remote", "set-url", "origin", "git@host.test:org/repo.git"]);
  const preview = await fixture.service.prepareConfirmation(proposal);
  await git(fixture.repo, ["config", "--add", "remote.origin.pushurl", "https://host.test/other.git"]);
  await assert.rejects(fixture.service.confirmPush({ confirmationToken: preview.confirmationToken, proposal }), /remote changed/i);
});

test("guarded commit binds one-use confirmation to exact proposal and HEAD and commits only reviewed files", async (t) => {
  const fixture = await makeGitFixture(t);
  await writeFile(path.join(fixture.worktree, "README.md"), "approved\n", "utf8");
  await writeFile(path.join(fixture.worktree, "unrecorded.txt"), "leave me\n", "utf8");
  const proposal = { action: "commit", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, message: "approved change", paths: ["README.md"] };
  const preview = await fixture.service.prepareConfirmation(proposal);
  await assert.rejects(fixture.service.confirmCommit({ confirmationToken: preview.confirmationToken, proposal: { ...proposal, message: "changed" } }), /confirmation|details/i);
  await assert.rejects(fixture.service.confirmCommit({ confirmationToken: preview.confirmationToken, proposal }), /used|unknown|confirmation/i);
  const retryPreview = await fixture.service.prepareConfirmation(proposal);
  const result = await fixture.service.confirmCommit({ confirmationToken: retryPreview.confirmationToken, proposal });
  assert.match(result.head, /^[0-9a-f]{40}$/);
  await assert.rejects(fixture.service.confirmCommit({ confirmationToken: retryPreview.confirmationToken, proposal }), /used|unknown|confirmation/i);
  assert.equal(fixture.forge.pushes.length, 0);
  assert.equal((await git(fixture.worktree, ["show", "--name-only", "--format=", "HEAD"])).stdout.trim(), "README.md");
  assert.match((await git(fixture.worktree, ["status", "--short"])).stdout, /unrecorded\.txt/);
});

test("failed commit hook cleans only operation staging and leaves a fresh token retryable", async (t) => {
  const fixture = await makeGitFixture(t, "hook-session");
  await writeFile(path.join(fixture.worktree, "README.md"), "hook failure\n", "utf8");
  const hook = path.join(fixture.repo, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(hook, 0o755);
  const proposal = { action: "commit", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, message: "retryable", paths: ["README.md"] };
  const failedPreview = await fixture.service.prepareConfirmation(proposal);
  await assert.rejects(fixture.service.confirmCommit({ confirmationToken: failedPreview.confirmationToken, proposal }));
  assert.equal((await git(fixture.worktree, ["diff", "--cached", "--name-only"])).stdout.trim(), "");
  assert.equal((await git(fixture.worktree, ["diff", "--name-only"])).stdout.trim(), "README.md");
  await rm(hook, { force: true });
  const retryPreview = await fixture.service.prepareConfirmation(proposal);
  await fixture.service.confirmCommit({ confirmationToken: retryPreview.confirmationToken, proposal });
});

test("guarded commit rejects an unrelated pre-staged index without altering it", async (t) => {
  const fixture = await makeGitFixture(t, "staged-session");
  await writeFile(path.join(fixture.worktree, "README.md"), "approved\n", "utf8");
  await writeFile(path.join(fixture.worktree, "unrelated.txt"), "user staged\n", "utf8");
  await git(fixture.worktree, ["add", "unrelated.txt"]);
  const headBefore = (await git(fixture.worktree, ["rev-parse", "HEAD"])).stdout.trim();
  const proposal = { action: "commit", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, message: "approved only", paths: ["README.md"] };
  const preview = await fixture.service.prepareConfirmation(proposal);
  await assert.rejects(
    fixture.service.confirmCommit({ confirmationToken: preview.confirmationToken, proposal }),
    /pre-staged|index|staged entries/i,
  );
  assert.equal((await git(fixture.worktree, ["rev-parse", "HEAD"])).stdout.trim(), headBefore);
  assert.equal((await git(fixture.worktree, ["diff", "--cached", "--name-only"])).stdout.trim(), "unrelated.txt");
  assert.equal((await git(fixture.worktree, ["diff", "--name-only"])).stdout.trim(), "README.md");
});

test("guarded Git rejects stale/expired/wrong-action tokens and bad session validation or review", async (t) => {
  let time = Date.parse(now);
  const fixture = await makeGitFixture(t, "token-session");
  const service = new DefaultGuardedGitService({
    sessionStoreFactory: () => ({ load: async (id) => fixture.sessions.get(id) ?? null }),
    worktreeManagerFactory: () => fixture.manager,
    forge: fixture.forge,
    clock: () => new Date(time),
    tokenFactory: (() => { let id = 0; return () => `time-token-${++id}`; })(),
  });
  const push = { action: "push", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, remote: "origin" };
  const expired = await service.prepareConfirmation(push);
  time += 5 * 60_000 + 1;
  await assert.rejects(service.confirmPush({ confirmationToken: expired.confirmationToken, proposal: push }), /expired/i);
  time = Date.parse(now);
  const stale = await service.prepareConfirmation(push);
  const wrongActionProposal = { action: "pull-request", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, remote: "origin", base: "main", title: "Wrong", body: "", draft: false };
  await assert.rejects(service.confirmPullRequest({ confirmationToken: stale.confirmationToken, proposal: wrongActionProposal }), /different action/i);
  const staleHead = await service.prepareConfirmation(push);
  await writeFile(path.join(fixture.worktree, "stale.txt"), "stale\n", "utf8");
  await git(fixture.worktree, ["add", "stale.txt"]);
  await git(fixture.worktree, ["commit", "-m", "stale"]);
  await assert.rejects(service.confirmPush({ confirmationToken: staleHead.confirmationToken, proposal: push }), /head|stale/i);

  fixture.sessions.set(fixture.sessionId, reviewedSession(fixture.repo, fixture.sessionId, ["README.md"], { validationResults: [{ id: "v", command: "test", status: "failed", startedAt: now }] }));
  await assert.rejects(service.prepareConfirmation({ action: "commit", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, message: "x", paths: ["README.md"] }), /validation/i);
  fixture.sessions.set(fixture.sessionId, reviewedSession(fixture.repo, fixture.sessionId, ["README.md"], { reviewResults: [{ id: "r", status: "changes_requested", summary: "no", findings: [], completedAt: now }] }));
  await assert.rejects(service.prepareConfirmation({ action: "commit", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, message: "x", paths: ["README.md"] }), /review/i);
  fixture.sessions.set(fixture.sessionId, reviewedSession(fixture.repo, fixture.sessionId, ["README.md"], { validationResults: [] }));
  await assert.rejects(service.prepareConfirmation({ action: "commit", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, message: "x", paths: ["README.md"] }), /validation/i);
});

test("guarded confirmations atomically admit one caller and prune expired tokens", async (t) => {
  let time = Date.parse(now);
  const fixture = await makeGitFixture(t, "atomic-token-session");
  const proposal = { action: "push", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, remote: "origin" };
  const preview = await fixture.service.prepareConfirmation(proposal);
  const results = await Promise.allSettled([
    fixture.service.confirmPush({ confirmationToken: preview.confirmationToken, proposal }),
    fixture.service.confirmPush({ confirmationToken: preview.confirmationToken, proposal }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(fixture.forge.pushes.length, 1);

  const pruning = new DefaultGuardedGitService({
    sessionStoreFactory: () => ({ load: async (id) => fixture.sessions.get(id) ?? null }),
    worktreeManagerFactory: () => fixture.manager,
    forge: fixture.forge,
    remoteHeadResolver: async () => null,
    clock: () => new Date(time),
    tokenFactory: () => "reusable-expired-token",
  });
  await pruning.prepareConfirmation(proposal);
  time += 5 * 60_000 + 1;
  const replacement = await pruning.prepareConfirmation(proposal);
  assert.equal(replacement.confirmationToken, "reusable-expired-token");
});

test("guarded discard derives the HIVE worktree, push/PR use the derived branch, and diff is bounded/path-safe", async (t) => {
  const fixture = await makeGitFixture(t, "safe-session");
  await writeFile(path.join(fixture.worktree, "README.md"), `${"x".repeat(500)}\n`, "utf8");
  const bounded = new DefaultGuardedGitService({
    sessionStoreFactory: () => ({ load: async (id) => fixture.sessions.get(id) ?? null }),
    worktreeManagerFactory: () => fixture.manager,
    forge: fixture.forge,
    maxDiffBytes: 64,
  });
  const diff = await bounded.inspectDiff({ repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, paths: ["README.md"] });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.patch, "utf8") <= 64);
  await assert.rejects(bounded.inspectDiff({ repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, paths: ["../outside"] }), /path|escape/i);

  const pushProposal = { action: "push", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, remote: "origin" };
  const prProposal = { action: "pull-request", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, remote: "origin", base: "main", title: "Safe", body: "Body", draft: false };
  await assert.rejects(fixture.service.prepareConfirmation(prProposal), /push|remote/i);
  const pushPreview = await fixture.service.prepareConfirmation(pushProposal);
  await fixture.service.confirmPush({ confirmationToken: pushPreview.confirmationToken, proposal: pushProposal });
  assert.deepEqual(fixture.forge.pushes[0].slice(1), [branchNameForTask(fixture.sessionId)]);
  const prPreview = await fixture.service.prepareConfirmation(prProposal);
  await fixture.service.confirmPullRequest({ confirmationToken: prPreview.confirmationToken, proposal: prProposal });
  assert.equal(fixture.forge.prs[0][2], branchNameForTask(fixture.sessionId));

  const discardProposal = { action: "discard", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId };
  const discardPreview = await fixture.service.prepareConfirmation(discardProposal);
  await fixture.service.confirmDiscard({ confirmationToken: discardPreview.confirmationToken, proposal: discardProposal });
  await assert.rejects(realpath(fixture.worktree));
});

test("session changes stay committable on a clean base and exclude unrelated dirty base files", async (t) => {
  const fixture = await makeGitFixture(t, "session-scoped-changes");
  await writeFile(path.join(fixture.repo, ".git", "info", "exclude"), ".hivemind/\n", { encoding: "utf8", flag: "a" });
  await writeFile(path.join(fixture.worktree, "README.md"), "session change\n", "utf8");
  const cleanBase = await fixture.service.inspect(fixture.repo);
  assert.equal(cleanBase.dirty, false);
  const cleanChanges = await fixture.service.inspectDiff({ repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId });
  assert.deepEqual(cleanChanges.recordedFiles, ["README.md"]);
  assert.deepEqual(cleanChanges.reviewedFiles, ["README.md"]);
  assert.equal(cleanChanges.commitEligibility, "eligible");
  assert.match(cleanChanges.patch, /session change/);

  await writeFile(path.join(fixture.repo, "unrelated-base.txt"), "user work\n", "utf8");
  const dirtyBase = await fixture.service.inspect(fixture.repo);
  assert.deepEqual(dirtyBase.changedFiles, ["unrelated-base.txt"]);
  const scopedChanges = await fixture.service.inspectDiff({ repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId });
  assert.deepEqual(scopedChanges.reviewedFiles, ["README.md"]);
  assert.doesNotMatch(scopedChanges.patch, /unrelated-base/);
  await assert.rejects(fixture.service.inspectDiff({ repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId, paths: ["unrelated-base.txt"] }), /recorded coding session/i);
});

test("discard confirmation fails closed when worktree or derived branch survives cleanup", async (t) => {
  const fixture = await makeGitFixture(t, "retained-session");
  const unsafe = new DefaultGuardedGitService({
    sessionStoreFactory: () => ({ load: async (id) => fixture.sessions.get(id) ?? null }),
    worktreeManagerFactory: () => ({
      getWorktreePath: (id) => fixture.manager.getWorktreePath(id),
      commitWorktree: (...args) => fixture.manager.commitWorktree(...args),
      discardWorktree: async () => undefined,
    }),
    forge: fixture.forge,
    remoteHeadResolver: async () => null,
  });
  const proposal = { action: "discard", repositoryRoot: fixture.repo, codingSessionId: fixture.sessionId };
  const preview = await unsafe.prepareConfirmation(proposal);
  await assert.rejects(unsafe.confirmDiscard({ confirmationToken: preview.confirmationToken, proposal }), /retained|still exists|branch|worktree/i);
});
