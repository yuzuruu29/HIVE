import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withDesktopCredentialRuntime } from "../dist/desktop/electron/worker-credential.js";
import { createProductionSessionEngine } from "../dist/projects/runtime-adapter.js";

const secret = 'opaque"\\ worker/+é';
const provider = { id: "desktop-stream", name: "Desktop stream", kind: "openai-compatible", authType: "bearer", approved: true, configured: true, defaultModel: "selected-model" };
const input = { prompt: "Hello", model: "selected-model" };
const credential = () => ({ provider: { ...provider }, kind: "bearer", secret });
const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5 };

async function withAdapter(overrides, operation, direct = credential()) {
  const raw = { kind: provider.kind, async healthCheck(config) { return { ok: true, providerId: config.id, message: "Ready" }; }, async complete() { return { output: "Buffered response" }; }, ...overrides };
  try {
    return await withDesktopCredentialRuntime(direct, async (registry) => {
      const { adapter, config } = await registry.getAdapter(provider.id);
      return operation(adapter, config, registry);
    }, { adapterFactory: () => raw });
  } finally { assert.equal(direct.secret, undefined); }
}

function variants(value) {
  const uri = encodeURIComponent(value);
  return [...new Set([value, JSON.stringify(value).slice(1, -1), encodeURI(value), uri, uri.replace(/%[A-F0-9]{2}/g, (escape) => escape.toLowerCase()), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64").replace(/=+$/, ""), Buffer.from(value).toString("base64url"), Buffer.from(value).toString("hex"), Buffer.from(value).toString("hex").toUpperCase()])];
}

function assertMasked(value) {
  for (const echo of variants(secret)) assert.equal(value.includes(echo), false, "A fixture credential escaped the worker boundary.");
}

test("desktop worker streams a shared Chat response before the provider completes", { timeout: 10_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "hive-worker-stream-"));
  const gate = Promise.withResolvers();
  const firstText = Promise.withResolvers();
  const events = [];
  let buffered = 0;
  let streamed = 0;
  try {
    await withAdapter({
      async complete() { buffered += 1; return { output: "Buffered response" }; },
      async streamComplete(config, request, onChunk, direct) {
        streamed += 1;
        assert.equal(config.id, provider.id);
        assert.equal(request.model, "selected-model");
        assert.equal(direct.secret, secret);
        onChunk("Incremental response");
        await gate.promise;
        onChunk(" finished");
        return { output: "Incremental response finished", usage };
      },
    }, async (_adapter, _config, registry) => {
      const settings = { mode: "chat", permissions: "guarded", providerId: provider.id, model: "selected-model" };
      const run = { id: "run-stream", sessionId: "session-stream", workspace, settings };
      const engine = createProductionSessionEngine({ providerRegistries: { project: registry, global: registry } });
      const handle = engine.start({ project: {}, session: { id: run.sessionId, messages: [], runs: [run] }, run, text: "Say hello" }, {
        async persist(event) { events.push(event); if (event.type === "text") firstText.resolve(event.text); },
        async requestApproval() { throw new Error("Chat must not request write approval."); },
      });
      let settled = false;
      const completion = handle.completion.finally(() => { settled = true; });
      try {
        const text = await Promise.race([firstText.promise, completion.then((outcome) => outcome.text)]);
        assert.equal(text, "Incremental response");
        assert.equal(settled, false, "Partial text must arrive before the provider completes.");
        assert.equal(buffered, 0);
        gate.resolve();
        const outcome = await completion;
        assert.equal(outcome.status, "completed");
        assert.equal(outcome.text, "Incremental response finished");
        assert.equal(streamed, 1);
        assert.equal(events.filter((event) => event.type === "text").at(-1).text, outcome.text);
      } finally { gate.resolve(); await completion.catch(() => undefined); }
    });
    assertMasked(JSON.stringify(events));
  } finally { gate.resolve(); await rm(workspace, { recursive: true, force: true }); }
});

test("desktop worker streaming forwards the exact request, direct credential and usage", async () => {
  const controller = new AbortController();
  const request = { ...input, signal: controller.signal, maxOutputTokens: 256, systemPrompt: "Be concise" };
  const chunks = [];
  await withAdapter({
    async streamComplete(config, actual, onChunk, direct) {
      assert.equal(config.id, provider.id);
      assert.equal(actual, request);
      assert.deepEqual(direct, { kind: "bearer", secret });
      assert.equal(Object.values(process.env).includes(secret), false);
      onChunk("Visible ");
      return { output: "Visible final tail", usage };
    },
  }, async (adapter, config) => {
    assert.equal(typeof adapter.streamComplete, "function");
    const result = await adapter.streamComplete(config, request, (chunk) => chunks.push(chunk));
    assert.deepEqual(result, { output: "Visible final tail", usage });
    assert.deepEqual(chunks, ["Visible ", "final tail"]);
  });
});

test("desktop worker streaming masks opaque and encoded credentials at every split", { timeout: 10_000 }, async () => {
  let echo;
  let split;
  const chunks = [];
  await withAdapter({
    async streamComplete(_config, _request, onChunk, direct) {
      assert.equal(direct.secret, secret);
      onChunk(`Visible. ${echo.slice(0, split)}`);
      assert.equal(chunks.join(""), "Visible. ", "A split credential prefix must remain private.");
      onChunk(`${echo.slice(split)} Done.`);
      return { output: `Visible. ${echo} Done.`, usage };
    },
  }, async (adapter, config) => {
    assert.equal(typeof adapter.streamComplete, "function");
    for (echo of variants(secret)) {
      for (split = 1; split < echo.length; split += 1) {
        chunks.length = 0;
        const result = await adapter.streamComplete(config, input, (chunk) => chunks.push(chunk));
        assert.equal(result.output, "Visible. [REDACTED] Done.");
        assert.equal(chunks.join(""), result.output);
        assertMasked(JSON.stringify(result));
      }
    }
  });
});

test("desktop worker streaming failures redact encoded echoes and discard held prefixes", async () => {
  const chunks = [];
  let lateChunk;
  await withAdapter({
    async streamComplete(_config, _request, onChunk) {
      lateChunk = onChunk;
      onChunk(`Visible. ${secret.slice(0, 8)}`);
      const error = new Error(variants(secret).join(" | "), { cause: secret });
      error.name = secret;
      throw error;
    },
  }, async (adapter, config) => {
    assert.equal(typeof adapter.streamComplete, "function");
    await assert.rejects(adapter.streamComplete(config, input, (chunk) => chunks.push(chunk)), (error) => {
      assertMasked(error.stack);
      assert.match(error.message, /REDACTED/);
      assert.equal(error.cause, undefined);
      return true;
    });
    lateChunk(secret.slice(8) + " Late output");
    assert.equal(chunks.join(""), "Visible. ");
  });
});

test("desktop worker streaming cancellation ignores late chunks and never flushes a private prefix", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const chunks = [];
  let lateChunk;
  await withAdapter({
    async streamComplete(_config, request, onChunk) {
      assert.equal(request.signal, controller.signal);
      lateChunk = onChunk;
      onChunk(`Visible. ${secret.slice(0, 8)}`);
      started.resolve();
      await gate.promise;
      return { output: `Visible. ${secret}` };
    },
  }, async (adapter, config) => {
    assert.equal(typeof adapter.streamComplete, "function");
    const completion = adapter.streamComplete(config, { ...input, signal: controller.signal }, (chunk) => chunks.push(chunk));
    try {
      await started.promise;
      controller.abort();
      lateChunk(secret.slice(8) + " After cancellation");
      gate.resolve();
      await assert.rejects(completion, { name: "AbortError" });
      lateChunk("After completion");
      assert.equal(chunks.join(""), "Visible. ");
    } finally { gate.resolve(); await completion.catch(() => undefined); }
  });
});

test("desktop worker streaming keeps redaction and direct credentials isolated across concurrent calls", { timeout: 10_000 }, async () => {
  const bothStarted = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let active = 0;
  await withAdapter({
    async streamComplete(_config, request, onChunk, direct) {
      assert.equal(direct.secret, secret);
      onChunk(`${request.prompt}: ${secret.slice(0, 8)}`);
      if (++active === 2) bothStarted.resolve();
      await gate.promise;
      onChunk(secret.slice(8));
      return { output: `${request.prompt}: ${secret}` };
    },
  }, async (adapter, config) => {
    assert.equal(typeof adapter.streamComplete, "function");
    const chunks = [[], []];
    const completions = ["First", "Second"].map((prompt, index) => adapter.streamComplete(config, { ...input, prompt }, (chunk) => chunks[index].push(chunk)));
    try {
      await bothStarted.promise;
      assert.equal(active, 2);
      assert.deepEqual(chunks.map((parts) => parts.join("")), ["First: ", "Second: "]);
      gate.resolve();
      const results = await Promise.all(completions);
      assert.deepEqual(results.map((result) => result.output), ["First: [REDACTED]", "Second: [REDACTED]"]);
      assert.deepEqual(chunks.map((parts) => parts.join("")), results.map((result) => result.output));
    } finally { gate.resolve(); await Promise.allSettled(completions); }
  });
});

test("desktop worker keeps buffered-only providers and keyless authentication compatible", async () => {
  await withAdapter({
    async complete(_config, _request, direct) { assert.equal(direct, undefined); return { output: "Buffered only", usage }; },
  }, async (adapter, config) => {
    assert.equal(adapter.streamComplete, undefined);
    assert.deepEqual(await adapter.complete(config, input), { output: "Buffered only", usage });
  }, { provider: { ...provider, authType: "none" } });
});

test("desktop worker streaming refuses an already-aborted request before generation", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await withAdapter({ async streamComplete() { calls += 1; return { output: "Must not run" }; } }, async (adapter, config) => {
    assert.equal(typeof adapter.streamComplete, "function");
    await assert.rejects(adapter.streamComplete(config, { ...input, signal: controller.signal }, () => {}), { name: "AbortError" });
    assert.equal(calls, 0);
  });
});

test("desktop worker forwards health-check cancellation and masks encoded health failures", async () => {
  const controller = new AbortController();
  await withAdapter({
    async healthCheck(config, direct, signal) {
      assert.equal(signal, controller.signal);
      assert.equal(direct.secret, secret);
      return { ok: false, providerId: config.id, message: variants(secret).join(" | "), redactedError: variants(secret).join(" | ") };
    },
  }, async (_adapter, _config, registry) => {
    const result = await registry.test(provider.id, controller.signal);
    assertMasked(JSON.stringify(result));
    assert.match(result.message, /REDACTED/);
  });
});
