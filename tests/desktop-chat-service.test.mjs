import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopChatService } from "../dist/desktop/chat-service.js";
import { ChatSessionStore } from "../dist/chat/session-store.js";

const clockNow = "2026-08-17T00:00:00.000Z";
let tick = 0;
const clock = () => { tick += 1; return new Date(Date.parse(clockNow) + tick).toISOString(); };

async function fixture(engineOverrides = {}, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-chat-service-"));
  const events = [];
  const requests = [];
  const engine = {
    async resolveRoute(role, override) {
      if (engineOverrides.resolveRoute) return engineOverrides.resolveRoute(role, override);
      return { providerId: "stub-provider", model: "stub-model", source: "role-assignment", degraded: false };
    },
    async complete(request) {
      requests.push(request);
      if (engineOverrides.complete) return engineOverrides.complete(request);
      request.onChunk?.("Hello ");
      request.onChunk?.("world.");
      return { output: "Hello world.", receipt: { role: request.role, providerId: "stub-provider", model: "stub-model", source: "role-assignment", degraded: false, promptTokens: 5, completionTokens: 7, totalTokens: 12, latencyMs: 42 } };
    },
  };
  const service = new DesktopChatService(
    () => root,
    (event) => events.push(event),
    {
      createEngine: () => engine,
      buildGrounding: engineOverrides.buildGrounding ?? (async () => null),
      clock,
      // Large window so tests assert batching semantics without timer races.
      chunkBatchMs: 60_000,
      ...options,
    },
  );
  return { root, events, requests, service };
}

async function until(predicate, label, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("simultaneous sends reserve a conversation before loading or saving its transcript", async (t) => {
  const { root, events, requests, service } = await fixture();
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let loads = 0;
  const originalLoad = ChatSessionStore.prototype.load;
  let attempts;
  try {
    const conversation = await service.create({});
    t.mock.method(ChatSessionStore.prototype, "load", async function (id) {
      loads += 1;
      const record = await originalLoad.call(this, id);
      await loadGate;
      return record;
    });
    attempts = Promise.allSettled([
      service.send({ conversationId: conversation.id, content: "first" }),
      service.send({ conversationId: conversation.id, content: "duplicate" }),
    ]);
    assert.equal(loads, 1, "A duplicate send must be rejected before a second transcript read.");
    releaseLoad();
    const outcomes = await attempts;
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, "rejected");
    assert.match(outcomes[1].reason.message, /already streaming/);
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");
    assert.equal(requests.length, 1);
    assert.deepEqual((await service.load(conversation.id)).messages.map((message) => message.content), ["first", "Hello world."]);
  } finally {
    releaseLoad();
    await attempts;
    await until(() => events.filter((event) => event.type === "chat.completed").length === requests.length, "all initiated turns to finish");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("archive cannot move a conversation while a send is preparing its transcript", async (t) => {
  const { root, events, requests, service } = await fixture();
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let loaded;
  const recordLoaded = new Promise((resolve) => { loaded = resolve; });
  const originalLoad = ChatSessionStore.prototype.load;
  let sending;
  try {
    const conversation = await service.create({});
    t.mock.method(ChatSessionStore.prototype, "load", async function (id) {
      const record = await originalLoad.call(this, id);
      loaded();
      await loadGate;
      return record;
    });
    sending = service.send({ conversationId: conversation.id, content: "first" });
    await recordLoaded;
    await assert.rejects(service.archive(conversation.id), /streaming/);
    releaseLoad();
    await sending;
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");
    assert.equal((await service.list()).filter((entry) => entry.archived).length, 0);
  } finally {
    releaseLoad();
    await sending;
    await until(() => events.filter((event) => event.type === "chat.completed").length === requests.length, "all initiated turns to finish");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("send cannot recreate a conversation while its archive is preparing", async (t) => {
  const { root, service, requests } = await fixture();
  let releaseArchive;
  const archiveGate = new Promise((resolve) => { releaseArchive = resolve; });
  const originalMkdir = fs.mkdir;
  let archiving;
  try {
    const conversation = await service.create({});
    t.mock.method(fs, "mkdir", async function (directory, options) {
      if (path.basename(directory) === "archived") await archiveGate;
      return originalMkdir.call(this, directory, options);
    });
    archiving = service.archive(conversation.id);
    await assert.rejects(service.send({ conversationId: conversation.id, content: "too late" }), /archiv/);
    releaseArchive();
    assert.equal((await archiving).find((entry) => entry.id === conversation.id).archived, true);
    assert.equal(requests.length, 0);
    await assert.rejects(service.load(conversation.id), /not found/);
  } finally {
    releaseArchive();
    await archiving;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed transcript reads, writes, and grounding release the send reservation", async (t) => {
  let failGrounding = true;
  const { root, events, requests, service } = await fixture({ buildGrounding: async () => {
    if (failGrounding) throw new Error("Fixture grounding failed.");
    return null;
  } });
  try {
    const conversation = await service.create({});
    const originalLoad = ChatSessionStore.prototype.load;
    let failLoad = true;
    t.mock.method(ChatSessionStore.prototype, "load", async function (id) {
      if (failLoad) throw new Error("Fixture transcript read failed.");
      return originalLoad.call(this, id);
    });
    await assert.rejects(service.send({ conversationId: conversation.id, content: "read" }), /transcript read failed/);
    failLoad = false;
    assert.equal((await service.load(conversation.id)).messages.length, 0);
    const originalSave = ChatSessionStore.prototype.save;
    let failSave = true;
    t.mock.method(ChatSessionStore.prototype, "save", async function (record) {
      if (failSave) throw new Error("Fixture transcript write failed.");
      return originalSave.call(this, record);
    });
    await assert.rejects(service.send({ conversationId: conversation.id, content: "write" }), /transcript write failed/);
    failSave = false;
    assert.equal((await service.load(conversation.id)).messages.length, 0);
    await assert.rejects(service.send({ conversationId: conversation.id, content: "ground", ground: true }), /grounding failed/);
    assert.equal(events.some((event) => event.type === "chat.started"), false, "Failed preparation must not leave a visible streaming turn.");
    assert.equal((await service.load(conversation.id)).messages.length, 0, "Failed grounding must not persist an invisible user message.");
    failGrounding = false;
    await service.send({ conversationId: conversation.id, content: "ground", ground: false });
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");
    assert.equal(requests.length, 1);
    assert.deepEqual((await service.load(conversation.id)).messages.map((message) => message.content), ["ground", "Hello world."]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed engine setup preserves the transcript and permits a single-message retry", async () => {
  let failEngine = true;
  let generations = 0;
  const { root, events, service } = await fixture({}, { createEngine() {
    if (failEngine) throw new Error("Fixture engine setup failed.");
    return { async complete(request) {
      generations += 1;
      return { output: "Reply.", receipt: { role: request.role, providerId: "fixture", model: "fixture-model" } };
    } };
  } });
  try {
    const conversation = await service.create({});
    await assert.rejects(service.send({ conversationId: conversation.id, content: "first" }), /engine setup failed/);
    assert.equal((await service.load(conversation.id)).messages.length, 0);
    assert.equal(events.length, 0);
    failEngine = false;
    await service.send({ conversationId: conversation.id, content: "first" });
    await until(() => events.some((event) => event.type === "chat.completed"), "retry completion");
    assert.equal(generations, 1);
    assert.deepEqual((await service.load(conversation.id)).messages.map((message) => message.content), ["first", "Reply."]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancel during transcript preparation stops generation and releases the conversation", async (t) => {
  const { root, events, requests, service } = await fixture();
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const originalLoad = ChatSessionStore.prototype.load;
  let sending;
  try {
    const conversation = await service.create({});
    t.mock.method(ChatSessionStore.prototype, "load", async function (id) {
      const record = await originalLoad.call(this, id);
      await loadGate;
      return record;
    });
    sending = service.send({ conversationId: conversation.id, content: "cancel this" });
    service.cancel(conversation.id);
    releaseLoad();
    await assert.rejects(sending, { name: "AbortError" });
    assert.equal(requests.length, 0);
    assert.equal(events.some((event) => event.type === "chat.started"), false);
    await service.send({ conversationId: conversation.id, content: "retry" });
    await until(() => events.some((event) => event.type === "chat.completed"), "retry completion");
    assert.equal(requests.length, 1);
  } finally {
    releaseLoad();
    await sending?.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancel during transcript save publishes the committed user message and never starts generation", async (t) => {
  const { root, events, requests, service } = await fixture();
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let saved;
  const recordSaved = new Promise((resolve) => { saved = resolve; });
  const originalSave = ChatSessionStore.prototype.save;
  let sending;
  try {
    const conversation = await service.create({});
    t.mock.method(ChatSessionStore.prototype, "save", async function (record) {
      const result = await originalSave.call(this, record);
      saved();
      await saveGate;
      return result;
    });
    sending = service.send({ conversationId: conversation.id, content: "cancel during save" });
    await recordSaved;
    service.cancel(conversation.id);
    releaseSave();
    await sending;
    assert.equal(requests.length, 0);
    assert.equal(events.find((event) => event.type === "chat.changed").conversation.messages[0].content, "cancel during save");
    assert.equal(events.find((event) => event.type === "chat.failed").message, "Cancelled.");
    assert.equal((await service.load(conversation.id)).messages.length, 1);
  } finally {
    releaseSave();
    await sending?.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("send persists the user turn, emits started, batched chunk, completed with receipt", async () => {
  const { root, events, requests, service } = await fixture();
  try {
    const conversation = await service.create({ role: "coding" });
    await service.send({ conversationId: conversation.id, content: "Fix the bug" });
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");

    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("chat.changed") < types.indexOf("chat.started"), "chat.changed precedes chat.started");
    assert.ok(types.indexOf("chat.started") < types.indexOf("chat.chunk"), "chat.started precedes chunks");
    assert.ok(types.indexOf("chat.chunk") < types.indexOf("chat.completed"), "chunks precede chat.completed");

    const chunks = events.filter((event) => event.type === "chat.chunk");
    assert.equal(chunks.length, 1, "chunks within the batch window coalesce into one event");
    assert.equal(chunks[0].chunk, "Hello world.");
    assert.equal(chunks[0].seq, 0);

    const completed = events.find((event) => event.type === "chat.completed");
    assert.equal(completed.message.content, "Hello world.");
    assert.equal(completed.message.receipt.totalTokens, 12);
    assert.equal(completed.conversationId, conversation.id);

    const request = requests.at(-1);
    assert.equal(request.role, "coding");
    assert.match(request.systemPrompt, /You are HIVE Coding/);
    assert.equal(request.prompt, "Fix the bug", "first turn sends the bare message");

    const reloaded = await service.load(conversation.id);
    assert.equal(reloaded.messages.length, 2);
    assert.equal(reloaded.messages[0].role, "user");
    assert.equal(reloaded.messages[1].role, "assistant");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("second send carries the compacted transcript like the CLI", async () => {
  const { root, events, requests, service } = await fixture();
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "first question" });
    await until(() => events.some((event) => event.type === "chat.completed"), "first completed");
    await service.send({ conversationId: conversation.id, content: "second question" });
    await until(() => requests.length === 2, "second completion");
    assert.equal(requests[1].prompt, "User: first question\n\nAssistant: Hello world.\n\nUser: second question");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grounding prepends the Scout pack to the persona system prompt", async () => {
  const { root, requests, service } = await fixture(undefined, {});
  const grounded = await fixture({ buildGrounding: async () => "SCOUT CONTEXT PACK" });
  try {
    const conversation = await grounded.service.create({});
    await grounded.service.send({ conversationId: conversation.id, content: "debug the failing code", ground: true });
    await until(() => grounded.requests.length === 1, "grounded completion");
    assert.match(grounded.requests[0].systemPrompt, /^SCOUT CONTEXT PACK\n\n---\n\nYou are HIVE Coding/);
    assert.equal(grounded.requests[0].prompt, "debug the failing code");
    const persisted = await grounded.service.load(conversation.id);
    assert.equal(persisted.ground, true, "ground flag persists on the conversation");
    void root; void service; void requests;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(grounded.root, { recursive: true, force: true });
  }
});

test("cancel aborts the in-flight turn and reports a recoverable failure", async () => {
  const { root, events, service } = await fixture({
    complete: (request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("stream aborted")));
    }),
  });
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "slow prompt" });
    await until(() => events.some((event) => event.type === "chat.started"), "chat.started");
    service.cancel(conversation.id);
    await until(() => events.some((event) => event.type === "chat.failed"), "chat.failed");
    const failed = events.find((event) => event.type === "chat.failed");
    assert.equal(failed.message, "Cancelled.");
    assert.equal(failed.recoverable, true);
    assert.ok(!events.some((event) => event.type === "chat.completed"), "no partial-complete event after cancel");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("engine failures emit recoverable chat.failed and free the conversation", async () => {
  let shouldFail = true;
  const { root, events, service } = await fixture({
    complete: async (request) => {
      if (shouldFail) throw new Error("provider exploded");
      request.onChunk?.("ok");
      return { output: "ok", receipt: { role: request.role, providerId: "p", model: "m" } };
    },
  });
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "boom" });
    await until(() => events.some((event) => event.type === "chat.failed"), "chat.failed after error");
    const failed = events.find((event) => event.type === "chat.failed");
    assert.equal(failed.message, "provider exploded");
    assert.equal(failed.recoverable, true);

    shouldFail = false;
    await service.send({ conversationId: conversation.id, content: "retry" });
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed after retry");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("route resolves through the engine and emits chat.route.resolved", async () => {
  const { root, events, service } = await fixture({
    resolveRoute: async (role, override) => ({ providerId: override?.providerId ?? "stub-provider", model: override?.model ?? "auto-model", source: "role-assignment", degraded: false }),
  });
  try {
    await service.route({ role: "heavy-reasoning", providerId: "ollama", model: "qwen3" });
    const resolved = events.find((event) => event.type === "chat.route.resolved");
    assert.equal(resolved.role, "heavy-reasoning");
    assert.equal(resolved.providerId, "ollama");
    assert.equal(resolved.model, "qwen3");
    assert.equal(resolved.source, "role-assignment");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("list derives titles, sorts by recency, and archive moves conversations out", async () => {
  const { root, events, service } = await fixture();
  try {
    const first = await service.create({});
    const second = await service.create({ role: "study-buddy" });
    await service.send({ conversationId: first.id, content: "Plan the migration carefully" });
    await until(() => events.some((event) => event.type === "chat.completed"), "first completed");

    const listed = await service.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, first.id, "the sent conversation has the newest updatedAt and sorts first");
    assert.equal(listed.find((entry) => entry.id === first.id).title, "Plan the migration carefully");
    assert.equal(listed.find((entry) => entry.id === second.id).title, "New chat");

    const afterArchive = await service.archive(first.id);
    assert.equal(afterArchive.filter((entry) => !entry.archived).length, 1);
    const archived = afterArchive.find((entry) => entry.id === first.id);
    assert.equal(archived.archived, true);
    await assert.rejects(() => service.load(first.id), /not found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("create normalizes kebab-case roles and rejects unknown ones", async () => {
  const { root, service } = await fixture();
  try {
    const conversation = await service.create({ role: "game-builder" });
    assert.equal(conversation.role, "gameBuilder");
    await assert.rejects(() => service.create({ role: "wizard" }), /Unknown chat role/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a second send while streaming rejects instead of interleaving turns", async () => {
  const { root, events, service } = await fixture({
    complete: (request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "first" });
    await until(() => events.some((event) => event.type === "chat.started"), "chat.started");
    await assert.rejects(() => service.send({ conversationId: conversation.id, content: "second" }), /already streaming/);
    service.cancel(conversation.id);
    await until(() => events.some((event) => event.type === "chat.failed"), "cancelled");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("send with agent:true emits tool events then a completed message with receipt", async () => {
  const { root, events, service } = await fixture({}, {
    runAgentTurn: async (input, hooks) => {
      hooks.onEvent?.({ type: "subagent.tool_call", subagentId: "chat-1", payload: { callId: "c1", name: "read_file", arguments: { path: "src/foo.ts" } } });
      return { output: "I read the file.", receipt: { role: "coding", providerId: "stub-provider", model: "stub-model", degraded: false, totalTokens: 10 }, turns: 2, toolCalls: 1 };
    },
  });
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "read foo", agent: true });
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");

    const tool = events.find((event) => event.type === "chat.tool");
    assert.equal(tool.tool.name, "read_file");
    assert.equal(tool.tool.label, "read src/foo.ts");
    const completed = events.find((event) => event.type === "chat.completed");
    assert.equal(completed.message.content, "I read the file.");
    assert.equal(completed.message.receipt.totalTokens, 10);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("regenerate reruns the last user turn without appending another user message", async () => {
  const { root, events, requests, service } = await fixture();
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "Plan the migration" });
    await until(() => events.some((event) => event.type === "chat.completed"), "first completed");
    events.length = 0;
    await service.send({ conversationId: conversation.id, content: "ignored", regenerate: true });
    await until(() => events.some((event) => event.type === "chat.completed"), "regenerated");
    assert.equal(requests.at(-1).prompt, "Plan the migration");
    const loaded = await service.load(conversation.id);
    assert.equal(loaded.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(loaded.messages[0].content, "Plan the migration");
    assert.equal(loaded.messages.filter((message) => message.role === "assistant").length, 1);
    const changed = events.find((event) => event.type === "chat.changed");
    assert.equal(changed.conversation.messages.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("agent tool labels are clamped to the contract cap so long paths do not fail the turn", async () => {
  const longPath = `src/${"a".repeat(500)}.ts`;
  const { root, events, service } = await fixture({}, {
    runAgentTurn: async (input, hooks) => {
      hooks.onEvent?.({ type: "subagent.tool_call", subagentId: "chat-1", payload: { callId: "c1", name: "read_file", arguments: { path: longPath } } });
      return { output: "done", receipt: { role: "coding", providerId: "stub-provider", model: "stub-model", degraded: false, totalTokens: 5 }, turns: 1, toolCalls: 1 };
    },
  });
  try {
    const conversation = await service.create({});
    await service.send({ conversationId: conversation.id, content: "read a long path", agent: true });
    await until(() => events.some((event) => event.type === "chat.completed"), "chat.completed");
    const tool = events.find((event) => event.type === "chat.tool");
    assert.ok(tool, "chat.tool event emitted despite the long path");
    assert.ok(tool.tool.label.length <= 300, `label clamped to 300 chars, got ${tool.tool.label.length}`);
    assert.ok(tool.tool.name.length <= 64, "tool name within the 64-char cap");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
