import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_THREAD_CONTEXT_CHARS,
  MAX_THREAD_MESSAGE_CHARS,
  JsonThreadStore,
  ThreadCorruptionError,
  buildCurrentTurnContext,
  buildThreadObjective,
} from "../dist/desktop/index.js";

const timestamp = "2026-07-14T00:00:00.000Z";

function message(id, role, content, createdAt = timestamp) {
  return { id, role, content, createdAt };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-desktop-core-"));
  const store = new JsonThreadStore(root, {
    clock: () => timestamp,
    idFactory: () => "thread-generated",
  });
  return { root, store };
}

test("JsonThreadStore creates, lists, loads, saves, and archives full threads", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({ id: "thread-one", title: "Desktop work" });
    assert.deepEqual(created, {
      schemaVersion: 1,
      id: "thread-one",
      title: "Desktop work",
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      messages: [],
      runs: [],
    });

    created.messages.push(message("message-one", "user", "Implement the desktop core"));
    created.messages.push(message("message-two", "assistant", "I will inspect the repository first."));
    created.runs.push({
      userMessageId: "message-one",
      codingSessionId: "session-existing",
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.save(created);

    assert.deepEqual(await store.load("thread-one"), created);
    assert.deepEqual((await store.list()).map((thread) => thread.id), ["thread-one"]);

    const archived = await store.archive("thread-one");
    assert.equal(archived.archived, true);
    assert.equal((await store.load("thread-one")).messages.length, 2);
    assert.equal((await store.load("thread-one")).runs.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("JsonThreadStore rejects unsafe IDs, invalid shapes, and oversized messages", async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(
      store.create({ id: "../escape", title: "Unsafe" }),
      /Invalid thread id/,
    );

    await assert.rejects(
      store.save({
        schemaVersion: 1,
        id: "bad-shape",
        title: "Bad shape",
        createdAt: timestamp,
        updatedAt: timestamp,
        archived: "no",
        messages: [],
        runs: [],
      }),
      /archived/,
    );

    await assert.rejects(
      store.save({
        schemaVersion: 1,
        id: "too-long",
        title: "Too long",
        createdAt: timestamp,
        updatedAt: timestamp,
        archived: false,
        messages: [message("message-long", "user", "x".repeat(MAX_THREAD_MESSAGE_CHARS + 1))],
        runs: [],
      }),
      /20,000 characters/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("JsonThreadStore rejects unknown raw fields before sanitization can drop them", async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(
      store.create({ id: "extra-create", title: "Extra create", unexpected: true }),
      /invalid shape/,
    );

    const created = await store.create({ id: "strict-thread", title: "Strict" });
    await assert.rejects(
      store.save({ ...created, unexpected: true }),
      /thread snapshot has an invalid shape/,
    );

    created.messages.push({
      ...message("message-one", "user", "Keep exact message shape"),
      toolOutput: "must not be silently discarded",
    });
    await assert.rejects(
      store.save(created),
      /message has an invalid shape/,
    );

    created.messages[0] = message("message-one", "user", "Keep exact run shape");
    created.runs.push({
      userMessageId: "message-one",
      codingSessionId: "session-one",
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerOutput: "must not be silently persisted",
    });
    await assert.rejects(
      store.save(created),
      /run reference has an invalid shape/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("JsonThreadStore rejects thread paths redirected outside the repository", async (t) => {
  const { root, store } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hive-desktop-outside-"));
  try {
    const threads = path.join(root, ".hivemind", "threads");
    await fs.mkdir(threads, { recursive: true });
    const redirected = path.join(threads, "redirected-thread");
    try {
      await fs.symlink(outside, redirected, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
        t.skip(`link creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      store.load("redirected-thread"),
      /escapes the repository root/,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("JsonThreadStore create is atomically exclusive for concurrent callers", async () => {
  const { root, store } = await fixture();
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        store.create({ id: "one-winner", title: "Only one creator wins" }),
      ),
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 11);
    assert.ok(
      attempts
        .filter((attempt) => attempt.status === "rejected")
        .every((attempt) => /already exists/.test(attempt.reason.message)),
    );

    const directory = path.join(root, ".hivemind", "threads", "one-winner");
    assert.deepEqual((await fs.readdir(directory)).sort(), ["thread.json"]);
    assert.equal((await store.load("one-winner")).title, "Only one creator wins");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("JsonThreadStore save rejects a missing thread", async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(
      store.save({
        schemaVersion: 1,
        id: "missing-thread",
        title: "Missing",
        createdAt: timestamp,
        updatedAt: timestamp,
        archived: false,
        messages: [],
        runs: [],
      }),
      /does not exist/,
    );
    await assert.rejects(
      fs.access(path.join(root, ".hivemind", "threads", "missing-thread", "thread.json")),
      /ENOENT/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("append-only thread mutation preserves concurrent message and run linkage", async () => {
  const { root, store } = await fixture();
  try {
    await store.create({ id: "concurrent-thread", title: "Concurrent" });
    const user = message("message-one", "user", "Build it");
    await Promise.all([
      store.appendMessage("concurrent-thread", user),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await store.mutate("concurrent-thread", (thread) => {
          if (!thread.messages.some((entry) => entry.id === user.id)) thread.messages.push(user);
          thread.runs.push({ userMessageId: user.id, codingSessionId: "session-one", status: "created", createdAt: timestamp, updatedAt: timestamp });
        });
      })(),
    ]);
    const persisted = await store.load("concurrent-thread");
    assert.deepEqual(persisted.messages.map((entry) => entry.id), ["message-one"]);
    assert.deepEqual(persisted.runs.map((run) => run.codingSessionId), ["session-one"]);
    await assert.rejects(store.appendMessage("concurrent-thread", user), /already exists/);
    await store.archive("concurrent-thread");
    await assert.rejects(store.appendMessage("concurrent-thread", message("message-two", "user", "No")), /archived/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("current-turn context retains the current user message and newest prior messages", () => {
  const messages = [
    message("oldest", "system", "o".repeat(8_000), "2026-07-14T00:00:00.000Z"),
    message("middle", "user", "m".repeat(8_000), "2026-07-14T00:00:01.000Z"),
    message("newest", "assistant", "n".repeat(8_000), "2026-07-14T00:00:02.000Z"),
    message("current", "user", "current request", "2026-07-14T00:00:03.000Z"),
  ];

  const context = buildCurrentTurnContext(messages, "current");
  assert.deepEqual(context.map((entry) => entry.id), ["current", "newest", "middle"]);
  assert.ok(context.reduce((sum, entry) => sum + entry.content.length, 0) <= MAX_THREAD_CONTEXT_CHARS);

  const objective = buildThreadObjective(messages, "current");
  assert.match(objective, /^\[user\]\ncurrent request/);
  assert.ok(objective.indexOf("n".repeat(20)) < objective.indexOf("m".repeat(20)));
  assert.equal(objective.includes("o".repeat(20)), false);
  assert.ok(objective.length <= MAX_THREAD_CONTEXT_CHARS);
});

test("current-turn context requires a valid <=20,000 character user message", () => {
  assert.throws(
    () => buildCurrentTurnContext([message("assistant", "assistant", "not a request")], "assistant"),
    /current message must have role user/,
  );
  assert.throws(
    () => buildCurrentTurnContext([], "missing"),
    /current user message is required/,
  );
  assert.throws(
    () => buildCurrentTurnContext(
      [message("current", "user", "x".repeat(MAX_THREAD_MESSAGE_CHARS + 1))],
      "current",
    ),
    /20,000 characters/,
  );
});

test("atomic saves leave no temp files and corrupt snapshots are never overwritten", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({ id: "atomic-thread", title: "Atomic" });
    created.messages.push(message("message-one", "user", "First"));
    await store.save(created);

    const directory = path.join(root, ".hivemind", "threads", "atomic-thread");
    assert.deepEqual((await fs.readdir(directory)).sort(), ["thread.json"]);

    const destination = path.join(directory, "thread.json");
    await fs.writeFile(destination, "{not-json", "utf8");
    const corruptBytes = await fs.readFile(destination, "utf8");

    await assert.rejects(store.load("atomic-thread"), ThreadCorruptionError);
    created.title = "Must not replace corrupt bytes";
    await assert.rejects(store.save(created), ThreadCorruptionError);
    assert.equal(await fs.readFile(destination, "utf8"), corruptBytes);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["thread.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("thread persistence redacts runner-compatible assignments, bearer values, and provider tokens", async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.create({ id: "redacted-thread", title: "Secrets" });
    created.messages.push(message(
      "message-one",
      "user",
      "OPENAI_API_KEY=very-secret Bearer abc.def sk-1234567890abcdef",
    ));
    const saved = await store.save(created);
    const content = saved.messages[0].content;
    assert.equal(content.includes("very-secret"), false);
    assert.equal(content.includes("abc.def"), false);
    assert.equal(content.includes("sk-1234567890abcdef"), false);
    assert.match(content, /OPENAI_API_KEY=\[REDACTED\]/);

    const serialized = await fs.readFile(
      path.join(root, ".hivemind", "threads", "redacted-thread", "thread.json"),
      "utf8",
    );
    assert.equal(serialized.includes("very-secret"), false);
    assert.equal(serialized.includes("abc.def"), false);
    assert.equal(serialized.includes("sk-1234567890abcdef"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
