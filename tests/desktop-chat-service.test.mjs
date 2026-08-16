import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopChatService } from "../dist/desktop/chat-service.js";

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
