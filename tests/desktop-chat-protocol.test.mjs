import assert from "node:assert/strict";
import test from "node:test";

import { validateDesktopCommand, validateDesktopEvent } from "../dist/desktop/electron/contracts.js";
import { DESKTOP_COMMAND_TYPES } from "../dist/desktop/electron/command-manifest.js";

const now = "2026-08-17T00:00:00.000Z";
const conversationId = "chat-1789200000000-ab12";

function command(type, extra = {}) {
  return { requestId: "request-1", type, ...extra };
}

function event(type, extra) {
  return { type, timestamp: now, ...extra };
}

const assistantMessage = {
  id: "message-1",
  role: "assistant",
  content: "Here is the plan.",
  at: now,
  receipt: { role: "coding", providerId: "openai", model: "gpt-4o", source: "role-assignment", degraded: false, promptTokens: 10, completionTokens: 20, totalTokens: 30, latencyMs: 1_250 },
};

// ---------------------------------------------------------------------------
// Commands — acceptance
// ---------------------------------------------------------------------------

test("chat commands validate with well-formed payloads", () => {
  assert.equal(validateDesktopCommand(command("chat.list")).type, "chat.list");
  assert.equal(validateDesktopCommand(command("chat.create", { input: {} })).type, "chat.create");
  assert.equal(validateDesktopCommand(command("chat.create", { input: { role: "heavy-reasoning", ground: true } })).type, "chat.create");
  assert.equal(validateDesktopCommand(command("chat.create", { input: { role: "heavyReasoning" } })).type, "chat.create");
  assert.equal(validateDesktopCommand(command("chat.load", { conversationId })).type, "chat.load");
  assert.equal(validateDesktopCommand(command("chat.archive", { conversationId })).type, "chat.archive");
  assert.equal(validateDesktopCommand(command("chat.cancel", { conversationId })).type, "chat.cancel");
  assert.equal(validateDesktopCommand(command("chat.route")).type, "chat.route");
  assert.equal(validateDesktopCommand(command("chat.route", { input: { role: "coding", providerId: "ollama", model: "qwen3" } })).type, "chat.route");
  assert.equal(validateDesktopCommand(command("chat.send", { input: { conversationId, content: "Hello HIVE" } })).type, "chat.send");
  assert.equal(validateDesktopCommand(command("chat.send", { input: { conversationId, content: "Hello", role: "auto", providerId: "openai", model: "gpt-4o", ground: true } })).type, "chat.send");
});

test("chat command ids enforce the chat session id pattern", () => {
  for (const bad of ["../escape", "thread-1", "chat-not-a-session", "chat-1789200000000-XYZ9", ""]) {
    assert.throws(() => validateDesktopCommand(command("chat.load", { conversationId: bad })), /invalid|must be an object/);
    assert.throws(() => validateDesktopCommand(command("chat.send", { input: { conversationId: bad, content: "x" } })), /invalid/);
  }
});

test("chat.create and chat.send reject unknown roles", () => {
  assert.throws(() => validateDesktopCommand(command("chat.create", { input: { role: "vibes" } })), /invalid/);
  assert.throws(() => validateDesktopCommand(command("chat.send", { input: { conversationId, content: "x", role: "wizard" } })), /invalid/);
});

test("chat.send enforces the content ceiling and rejects unknown fields", () => {
  assert.throws(() => validateDesktopCommand(command("chat.send", { input: { conversationId, content: "x".repeat(24_001) } })), /invalid/);
  assert.throws(() => validateDesktopCommand(command("chat.send", { input: { conversationId, content: "x", systemPrompt: "extra" } })), /unexpected or missing fields/);
  assert.throws(() => validateDesktopCommand(command("chat.send", { input: { content: "x" } })), /unexpected or missing fields/);
  assert.throws(() => validateDesktopCommand(command("chat.create", { input: { ground: "yes" } })), /invalid/);
  assert.throws(() => validateDesktopCommand(command("chat.route", { input: { providerId: "bad id!" } })), /invalid/);
});

// ---------------------------------------------------------------------------
// Events — acceptance and rejection
// ---------------------------------------------------------------------------

test("chat lifecycle events validate in both directions", () => {
  assert.equal(validateDesktopEvent(event("chat.started", { conversationId, turnId: "turn-abc-1" })).type, "chat.started");
  assert.equal(validateDesktopEvent(event("chat.chunk", { conversationId, turnId: "turn-abc-1", chunk: "partial text\n", seq: 0 })).type, "chat.chunk");
  assert.equal(validateDesktopEvent(event("chat.completed", { conversationId, turnId: "turn-abc-1", message: assistantMessage })).type, "chat.completed");
  assert.equal(validateDesktopEvent(event("chat.failed", { conversationId, turnId: "turn-abc-1", message: "Cancelled.", recoverable: true })).type, "chat.failed");
  assert.equal(validateDesktopEvent(event("chat.route.resolved", { role: "coding", providerId: "openai", model: "gpt-4o", source: "role-assignment", degraded: false })).type, "chat.route.resolved");
  assert.equal(validateDesktopEvent(event("chat.listed", { conversations: [{ id: conversationId, title: "First prompt", role: "auto", updatedAt: now, messageCount: 2 }] })).type, "chat.listed");
  assert.equal(validateDesktopEvent(event("chat.changed", { conversation: { id: conversationId, cwd: "C:\\repo", role: "coding", ground: false, createdAt: now, updatedAt: now, messages: [{ id: "message-0", role: "user", content: "hi", at: now }, assistantMessage] } })).type, "chat.changed");
});

test("chat.chunk rejects over-length chunks, negative seq, and unknown fields", () => {
  assert.throws(() => validateDesktopEvent(event("chat.chunk", { conversationId, turnId: "t-1", chunk: "x".repeat(2_049), seq: 0 })), /invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.chunk", { conversationId, turnId: "t-1", chunk: "x", seq: -1 })), /sequence is invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.chunk", { conversationId, turnId: "t-1", chunk: "x", seq: 1.5 })), /sequence is invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.chunk", { conversationId, turnId: "t-1", chunk: "x", seq: 0, extra: true })), /unexpected or missing fields/);
});

test("chat conversation and message events reject malformed shapes", () => {
  assert.throws(() => validateDesktopEvent(event("chat.started", { conversationId: "nope", turnId: "t-1" })), /invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.completed", { conversationId, turnId: "t-1", message: { id: "m", role: "system", content: "x", at: now } })), /role is invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.completed", { conversationId, turnId: "t-1", message: { id: "m", role: "user", content: "x".repeat(24_001), at: now } })), /invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.completed", { conversationId, turnId: "t-1", message: { id: "m", role: "user", content: "x", at: now, receipt: { role: "coding", providerId: "openai", model: "m", promptTokens: -5 } } })), /promptTokens is invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.failed", { conversationId, turnId: "t-1", message: "x".repeat(2_001), recoverable: true })), /invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.listed", { conversations: [{ id: conversationId, title: "t", role: "auto", updatedAt: now, messageCount: -1 }] })), /message count is invalid/);
  assert.throws(() => validateDesktopEvent(event("chat.route.resolved", { role: "wizard", providerId: "openai", model: "m", source: "s", degraded: false })), /invalid/);
});

// ---------------------------------------------------------------------------
// Additive parity — existing surface unchanged
// ---------------------------------------------------------------------------

test("chat commands are registered in the canonical manifest and existing commands still validate", () => {
  for (const type of ["chat.list", "chat.create", "chat.load", "chat.archive", "chat.route", "chat.send", "chat.cancel"]) {
    assert.ok(DESKTOP_COMMAND_TYPES.includes(type), `${type} must be in the manifest`);
  }
  assert.equal(validateDesktopCommand(command("thread.create", { input: { title: "Parity check" } })).type, "thread.create");
  assert.equal(validateDesktopCommand(command("thread.list")).type, "thread.list");
  assert.equal(validateDesktopEvent(event("thread.listed", { threads: [] })).type, "thread.listed");
  assert.throws(() => validateDesktopCommand(command("chat.scaffold")), /Unsupported desktop command type/);
});

// ---------------------------------------------------------------------------
// Council commands + events
// ---------------------------------------------------------------------------

const councilSummary = {
  status: "COMPLETE",
  reason: "All criteria satisfied; Sentinel PASS.",
  preset: "quick",
  runId: "hivebot-1789200000000-ab12",
  stages: [{ agent: "Queen", role: "queen", output: "analysis", receipt: { role: "queen", providerId: "p1", model: "m1", promptTokens: 3, completionTokens: 4, totalTokens: 7, latencyMs: 5 }, phase: "Orchestrate & classify", attempt: 1 }],
  totalTokens: 7,
  artifactDir: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12",
  runPath: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12\\run.json",
  reportPath: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12\\report.md",
};

test("council commands and events validate with strict shapes", () => {
  assert.equal(validateDesktopCommand(command("council.start", { input: { task: "refactor the parser" } })).type, "council.start");
  assert.equal(validateDesktopCommand(command("council.start", { input: { task: "t", preset: "deep", providerId: "ollama", model: "qwen3" } })).type, "council.start");
  assert.equal(validateDesktopCommand(command("council.cancel", { runId: "hivebot-1-ab" })).type, "council.cancel");

  assert.throws(() => validateDesktopCommand(command("council.start", { input: { task: "t", preset: "turbo" } })), /preset is invalid/);
  assert.throws(() => validateDesktopCommand(command("council.start", { input: {} })), /unexpected or missing fields/);
  assert.throws(() => validateDesktopCommand(command("council.cancel", { runId: "bad id!" })), /invalid/);

  assert.equal(validateDesktopEvent(event("council.started", { runId: "hivebot-1-ab", preset: "quick" })).type, "council.started");
  assert.equal(validateDesktopEvent(event("council.stage", { runId: "hivebot-1-ab", stage: { type: "stage-started", agent: "Scout", attempt: 1 } })).type, "council.stage");
  assert.equal(validateDesktopEvent(event("council.stage", { runId: "hivebot-1-ab", stage: { type: "stage-completed", agent: "Scout", attempt: 1, receipt: { role: "coding", providerId: "p", model: "m" }, output: "context map" } })).type, "council.stage");
  assert.equal(validateDesktopEvent(event("council.completed", { runId: "hivebot-1-ab", summary: councilSummary })).type, "council.completed");
  assert.equal(validateDesktopEvent(event("council.failed", { runId: "hivebot-1-ab", message: "artifacts unwritable" })).type, "council.failed");

  assert.throws(() => validateDesktopEvent(event("council.stage", { runId: "hivebot-1-ab", stage: { type: "stage-skipped", agent: "Scout", attempt: 1 } })), /stage type is invalid/);
  assert.throws(() => validateDesktopEvent(event("council.stage", { runId: "hivebot-1-ab", stage: { type: "stage-started", agent: "Scout", attempt: 0 } })), /attempt is invalid/);
  assert.throws(() => validateDesktopEvent(event("council.completed", { runId: "hivebot-1-ab", summary: { ...councilSummary, status: "MAYBE" } })), /status is invalid/);
  assert.throws(() => validateDesktopEvent(event("council.completed", { runId: "hivebot-1-ab", summary: { ...councilSummary, extra: true } })), /unexpected or missing fields/);
  assert.ok(DESKTOP_COMMAND_TYPES.includes("council.start") && DESKTOP_COMMAND_TYPES.includes("council.cancel"));
});
