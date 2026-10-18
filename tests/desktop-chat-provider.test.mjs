import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay, setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { JsonDesktopAppStateStore } from "../dist/desktop/electron/app-state.js";
import { DesktopCommandRouter } from "../dist/desktop/electron/router.js";
import { DesktopModelLister } from "../dist/desktop/model-lister.js";

const now = "2026-10-18T00:00:00.000Z";
const initialSecret = "opaque.desktop-only+fixture/42";

function memoryVault() {
  const entries = new Map();
  const reads = [];
  const metadata = (entry) => entry ? { providerId: entry.providerId, kind: entry.kind, configured: true } : null;
  return {
    entries, reads,
    credentialResolver: { async resolve(id) { reads.push(id); const entry = entries.get(id); return entry ? { ...entry } : null; } },
    async list() { return [...entries.values()].map(metadata); },
    async metadata(id) { return metadata(entries.get(id)); },
    async set(input) { if (entries.has(input.providerId)) throw new Error("Credential already exists."); entries.set(input.providerId, { ...input }); return metadata(input); },
    async replace(input) { if (!entries.has(input.providerId)) throw new Error("Credential does not exist."); entries.set(input.providerId, { ...input }); return metadata(input); },
    async remove(input) { entries.delete(input.providerId); },
    async test(input) { return { providerId: input.providerId, ok: entries.has(input.providerId), message: "Fixture storage check." }; },
  };
}

async function until(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-desktop-chat-provider-"));
  const repository = path.join(root, "workspace");
  await fs.mkdir(repository);
  const calls = [];
  const controls = { output: "First reply.", key: initialSecret };
  const server = http.createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ path: request.url, authorization: request.headers.authorization, body });
      if (request.headers.authorization !== (controls.key ? `Bearer ${controls.key}` : undefined)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Fixture authentication failed." } }));
      } else if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: controls.models ?? [{ id: "catalog-model" }] }));
      } else if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const content of controls.output.match(/.{1,5}/gs) ?? []) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
          await nextTick();
        }
        response.end("data: [DONE]\n\n");
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: controls.output } }] }));
      }
    } catch {
      if (!response.destroyed) { response.writeHead(500); response.end("Fixture failed."); }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const stateStore = new JsonDesktopAppStateStore(path.join(root, "app-data"), { clock: () => now });
  const credentialVault = memoryVault();
  const events = [];
  const router = new DesktopCommandRouter({
    stateStore, credentialVault,
    workerSupervisor: { async reconcileRepositoryRuns() {} },
    guardedGitFactory() { throw new Error("Git is not used in chat provider tests."); },
    clock: () => now,
    onEvent: (event) => events.push(event),
    ...options,
  });
  let requestNumber = 0;
  const request = (type, extra = {}) => router.handle({ requestId: `request-${++requestNumber}`, type, ...extra });
  assert.equal((await request("repository.open", { repositoryRoot: repository })).type, "desktop.ready");
  const provider = {
    id: "desktop-only", name: "Desktop fixture", kind: "openai-compatible", authType: "api-key", approved: true,
    defaultModel: "default-model", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const configure = async (overrides = {}) => {
    const event = await request("provider.configure", { input: { ...provider, ...overrides } });
    assert.equal(event.type, "provider.changed", JSON.stringify(event));
    return event;
  };
  let conversationId;
  const turn = async (content = "Say hello", choice = {}) => {
    if (!conversationId) {
      const created = await request("chat.create", { input: {} });
      assert.equal(created.type, "chat.changed", JSON.stringify(created));
      conversationId = created.conversation.id;
    }
    const start = events.length;
    assert.equal((await request("chat.send", { input: { conversationId, content, providerId: provider.id, model: "selected-model", ...choice } })).type, "request.completed");
    const terminal = await until(() => events.slice(start).find((event) => event.type === "chat.completed" || event.type === "chat.failed"), "chat terminal event");
    await nextTick();
    return terminal;
  };
  return { root, repository, provider, configure, turn, request, stateStore, credentialVault, events, calls, controls };
}

async function authenticatedFixture(t, options) {
  const result = await fixture(t, options);
  await result.configure();
  assert.equal((await result.request("credential.set", { input: { providerId: result.provider.id, kind: "api-key", secret: initialSecret } })).type, "credential.changed");
  return result;
}

async function engineFor(f, adapterFactory) {
  const { createDesktopChatEngine } = await import("../dist/desktop/chat-provider-registry.js");
  return createDesktopChatEngine(f.repository, "desktop-provider-session", { stateStore: f.stateStore, credentialVault: f.credentialVault, adapterFactory });
}

function variants(secret) {
  const uri = encodeURIComponent(secret);
  return [...new Set([
    secret, JSON.stringify(secret).slice(1, -1), encodeURI(secret), uri,
    uri.replace(/%[A-F0-9]{2}/g, (escape) => escape.toLowerCase()),
    Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64").replace(/=+$/, ""),
    Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("hex"), Buffer.from(secret).toString("hex").toUpperCase(),
  ])];
}

function assertMasked(text, secrets) {
  for (const secret of secrets) assert.equal(text.includes(secret), false, "A fixture credential or its encoding escaped redaction.");
}

test("default desktop chat uses a fresh desktop-only provider and the exact selected model", async (t) => {
  const f = await authenticatedFixture(t);
  f.controls.output = `First reply. Echo ${initialSecret} done.`;
  const terminal = await f.turn();
  assert.equal(terminal.type, "chat.completed", JSON.stringify(terminal));
  assert.equal(terminal.message.content, "First reply. Echo [REDACTED] done.");
  assert.equal(terminal.message.receipt.providerId, f.provider.id);
  assert.equal(terminal.message.receipt.model, "selected-model");
  assert.equal(terminal.message.receipt.degraded, false);
  const generations = f.calls.filter((call) => call.body);
  assert.equal(generations.length, 1);
  assert.equal(generations[0].body.model, "selected-model");
  assert.equal(generations[0].body.stream, true);
  assert.equal(generations[0].authorization, `Bearer ${initialSecret}`);
  await assert.rejects(fs.access(path.join(f.repository, ".hive", "providers.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.repository, ".hive", "provider-roles.json")), { code: "ENOENT" });
  const saved = await fs.readFile(path.join(f.repository, ".hivemind", "chat-sessions", `${terminal.conversationId}.json`), "utf8");
  assertMasked(saved + JSON.stringify(f.events) + JSON.stringify(await f.stateStore.load()), variants(initialSecret));
});

test("a cached desktop chat engine sees credential rotation, removal, and revoked approval", async (t) => {
  const f = await authenticatedFixture(t);
  assert.equal((await f.turn()).type, "chat.completed");
  const rotated = "opaque.rotated.desktop~fixture";
  f.controls.key = rotated;
  assert.equal((await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "api-key", secret: rotated } })).type, "credential.changed");
  assert.equal((await f.turn("Use the replacement key")).type, "chat.completed");
  assert.equal(f.calls.filter((call) => call.body).at(-1).authorization, `Bearer ${rotated}`);
  const callCount = f.calls.length;
  await f.request("credential.remove", { input: { providerId: f.provider.id, kind: "api-key" } });
  const removed = await f.turn("The old key must not survive");
  assert.equal(removed.type, "chat.failed");
  assert.match(removed.message, /credential/i);
  assert.equal(f.calls.length, callCount);
  await f.request("credential.set", { input: { providerId: f.provider.id, kind: "api-key", secret: rotated } });
  await f.configure({ approved: false });
  const revoked = await f.turn("Approval was revoked");
  assert.equal(revoked.type, "chat.failed");
  assert.match(revoked.message, /approved|approval/i);
  assert.equal(f.calls.length, callCount);
  await f.configure();
  assert.equal((await f.turn("Approved again")).type, "chat.completed");
});

test("desktop IDs are isolated from colliding and CLI-only provider configuration", async (t) => {
  const f = await authenticatedFixture(t);
  await fs.mkdir(path.join(f.repository, ".hive"), { recursive: true });
  const cli = { ...f.provider, kind: "local", authType: "none", baseUrl: `${f.provider.baseUrl}/cli-poison`, createdAt: now, updatedAt: now };
  await fs.writeFile(path.join(f.repository, ".hive", "providers.json"), JSON.stringify([cli, { ...cli, id: "cli-only" }]));
  await fs.writeFile(path.join(f.repository, ".hive", "provider-roles.json"), JSON.stringify({ coding: { provider: "cli-only", model: "wrong-model" }, fallback: { provider: "cli-only", model: "wrong-model" } }));
  assert.equal((await f.turn()).type, "chat.completed");
  assert.ok(f.calls.every((call) => !call.path.includes("cli-poison")));
  const callCount = f.calls.length;
  assert.equal((await f.turn("Do not consult the CLI", { providerId: "cli-only" })).type, "chat.failed");
  await f.configure({ approved: false });
  assert.equal((await f.turn("Do not fall back to the colliding CLI ID")).type, "chat.failed");
  assert.equal(f.calls.length, callCount);
});

test("keyless local chat needs approval but never resolves or sends a credential", async (t) => {
  const f = await fixture(t);
  f.controls.key = null;
  await f.configure({ kind: "local", authType: "none" });
  assert.equal((await f.turn()).type, "chat.completed");
  assert.deepEqual(f.credentialVault.reads, []);
  assert.ok(f.calls.every((call) => call.authorization === undefined));
  const callCount = f.calls.length;
  await f.configure({ kind: "local", authType: "none", approved: false });
  assert.equal((await f.turn()).type, "chat.failed");
  assert.equal(f.calls.length, callCount);
});

test("injected chatService and chatServiceOptions.createEngine remain authoritative", async (t) => {
  const injected = await fixture(t, { chatService: { async list() { return []; } }, chatServiceOptions: { createEngine() { throw new Error("Must not construct an engine."); } } });
  assert.equal((await injected.request("chat.list")).type, "chat.listed");
  let engineCreations = 0;
  const customized = await fixture(t, { chatServiceOptions: { createEngine() {
    engineCreations += 1;
    return { async complete(input) { input.onChunk?.("Injected reply."); return { output: "Injected reply.", receipt: { role: input.role, providerId: "injected", model: "injected-model" } }; } };
  } } });
  assert.equal((await customized.turn()).message.content, "Injected reply.");
  assert.equal(engineCreations, 1);
  assert.equal(customized.calls.length, 0);
});

test("request adapters re-read current metadata and credentials without retaining auth objects", async (t) => {
  const f = await authenticatedFixture(t);
  const credentials = [];
  const configs = [];
  const { createDesktopChatProviderRegistry } = await import("../dist/desktop/chat-provider-registry.js");
  const registry = createDesktopChatProviderRegistry({ stateStore: f.stateStore, credentialVault: f.credentialVault, adapterFactory: (kind) => ({
    kind,
    async healthCheck(config, credential, signal) { configs.push(config); credentials.push(credential); return { ok: true, providerId: config.id, message: "Healthy." }; },
    async complete(config, input, credential) { configs.push(config); credentials.push(credential); return { output: credential.secret === initialSecret ? "Initial." : "Rotated." }; },
  }) });
  const { adapter, config } = await registry.getAdapter(f.provider.id);
  assert.equal((await adapter.complete(config, { prompt: "one", model: "exact" })).output, "Initial.");
  assert.ok(credentials.every((credential) => credential.secret === ""));
  const rotated = "opaque.request-replacement";
  await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "api-key", secret: rotated } });
  await f.configure({ baseUrl: `${f.provider.baseUrl}/updated`, defaultModel: "new-default" });
  assert.equal((await adapter.complete(config, { prompt: "two", model: "exact" })).output, "Rotated.");
  assert.equal(configs.at(-1).baseUrl, `${f.provider.baseUrl}/updated`);
  assert.ok(credentials.every((credential) => credential.secret === ""));
  assert.equal(f.credentialVault.entries.get(f.provider.id).secret, rotated, "Request cleanup must not mutate the vault's stored value.");
  assertMasked(JSON.stringify(configs) + JSON.stringify(config), [...variants(initialSecret), ...variants(rotated)]);
  assert.ok(configs.every((value) => value.apiKeyEnv === undefined && value.tokenEnv === undefined));
  await f.request("credential.remove", { input: { providerId: f.provider.id, kind: "api-key" } });
  await assert.rejects(adapter.complete(config, { prompt: "three", model: "exact" }), /credential/i);
  await assert.rejects(registry.getAdapter(f.provider.id), /credential/i);
});

test("health checks receive AbortSignal and cancellation never starts generation", async (t) => {
  const f = await authenticatedFixture(t);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let generated = false;
  let observedCredential;
  const controller = new AbortController();
  const engine = await engineFor(f, (kind) => ({
    kind,
    async healthCheck(config, credential, signal) {
      assert.equal(signal, controller.signal);
      observedCredential = credential;
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(`Cancelled ${credential.secret}`)), { once: true }));
    },
    async complete() { generated = true; return { output: "Must not run." }; },
  }));
  const completion = engine.complete({ role: "coding", providerId: f.provider.id, model: "selected-model", prompt: "hello", signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(completion, { name: "AbortError" });
  await nextTick();
  assert.equal(generated, false);
  assert.equal(observedCredential.secret, "");
});

test("opaque credentials and common encodings are masked in buffered results and health/errors", async (t) => {
  const f = await authenticatedFixture(t);
  const secret = 'opaque"\\ fixture/+é';
  await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "api-key", secret } });
  const echoes = variants(secret);
  let failCompletion = false;
  const engine = await engineFor(f, (kind) => ({
    kind,
    async healthCheck(config) { return { ok: true, providerId: config.id, message: echoes.join(" | ") }; },
    async complete() {
      if (failCompletion) { const error = new Error(echoes.join(" | "), { cause: secret }); error.name = secret; throw error; }
      return { output: `Public: ${echoes.join(" | ")} end.`, usage: { promptTokens: secret, completionTokens: 2, totalTokens: 3 } };
    },
  }));
  const input = { role: "coding", providerId: f.provider.id, model: "selected-model", prompt: "hello" };
  const result = await engine.complete(input);
  assertMasked(JSON.stringify(result), echoes);
  assert.match(result.output, /\[REDACTED\]/);
  assert.equal(result.receipt.promptTokens, undefined);
  failCompletion = true;
  await assert.rejects(engine.complete(input), (error) => { assertMasked(error.stack, echoes); return true; });
  const { createDesktopChatProviderRegistry } = await import("../dist/desktop/chat-provider-registry.js");
  const registry = createDesktopChatProviderRegistry({ stateStore: f.stateStore, credentialVault: f.credentialVault, adapterFactory: (kind) => ({
    kind,
    async healthCheck(config) { return { ok: false, providerId: config.id, message: echoes.join(" | "), redactedError: echoes.join(" | ") }; },
    async complete() { throw new Error("No generation expected."); },
  }) });
  assertMasked(JSON.stringify(await registry.test(f.provider.id)), echoes);
});

test("streamed opaque echoes stay hidden at every split and match the final redacted result", async (t) => {
  const f = await authenticatedFixture(t);
  const secret = 'opaque"\\ stream/+é';
  await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "api-key", secret } });
  const echoes = variants(secret);
  const output = `Visible. ${echoes.join(" | ")} Done.`;
  const chunks = [];
  let streamed = false;
  let lateChunk;
  const engine = await engineFor(f, (kind) => ({
    kind,
    async healthCheck(config) { return { ok: true, providerId: config.id, message: "ok" }; },
    async complete() { throw new Error("The streaming adapter must not buffer this turn."); },
    async streamComplete(config, input, onChunk, credential) {
      streamed = true;
      lateChunk = onChunk;
      assert.equal(input.model, "selected-model");
      assert.equal(credential.secret, secret);
      for (const char of output) onChunk(char);
      return { output, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } };
    },
  }));
  const result = await engine.complete({ role: "coding", providerId: f.provider.id, model: "selected-model", prompt: "hello", onChunk(chunk) {
    chunks.push(chunk);
    assertMasked(chunks.join(""), echoes.map((value) => value.slice(0, Math.min(8, value.length))));
  } });
  assert.equal(streamed, true);
  assert.ok(chunks.length > 2, "Safe text must stream incrementally rather than wait for the final result.");
  lateChunk(output);
  assert.equal(chunks.join(""), result.output);
  assert.equal(result.output, `Visible. ${echoes.map(() => "[REDACTED]").join(" | ")} Done.`);
  assert.equal(result.receipt.totalTokens, 5);
});

test("stream cancellation drops held credential prefixes and ignores late adapter chunks", async (t) => {
  const f = await authenticatedFixture(t);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let lateChunk;
  let observedCredential;
  const controller = new AbortController();
  const chunks = [];
  const engine = await engineFor(f, (kind) => ({
    kind,
    async healthCheck(config) { return { ok: true, providerId: config.id, message: "ok" }; },
    async complete() { throw new Error("Cancellation must not retry buffered."); },
    async streamComplete(config, input, onChunk, credential) {
      observedCredential = credential;
      lateChunk = onChunk;
      onChunk(`Visible. ${initialSecret.slice(0, 8)}`);
      entered();
      return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error(`Cancelled ${credential.secret}`)), { once: true }));
    },
  }));
  const completion = engine.complete({ role: "coding", providerId: f.provider.id, model: "selected-model", prompt: "hello", signal: controller.signal, onChunk: (chunk) => chunks.push(chunk) });
  await started;
  assert.equal(chunks.join(""), "Visible. ");
  controller.abort();
  await assert.rejects(completion, { name: "AbortError" });
  await nextTick();
  lateChunk(initialSecret.slice(8) + " late data");
  assert.equal(chunks.join(""), "Visible. ");
  assert.equal(observedCredential.secret, "");
});

test("stream errors redact encoded echoes and never flush a held secret prefix", async (t) => {
  const f = await authenticatedFixture(t);
  const chunks = [];
  let buffered = false;
  const engine = await engineFor(f, (kind) => ({
    kind,
    async healthCheck(config) { return { ok: true, providerId: config.id, message: "ok" }; },
    async complete() { buffered = true; throw new Error(initialSecret); },
    async streamComplete(config, input, onChunk) { onChunk(`Visible. ${initialSecret.slice(0, 8)}`); throw new Error(variants(initialSecret).join(" | ")); },
  }));
  await assert.rejects(engine.complete({ role: "coding", providerId: f.provider.id, model: "selected-model", prompt: "hello", onChunk: (chunk) => chunks.push(chunk) }), (error) => { assertMasked(error.stack, variants(initialSecret)); return true; });
  assert.equal(chunks.join(""), "Visible. ");
  assert.equal(buffered, false);
});

test("mismatched credential kinds and keyless native adapters fail before any request", async (t) => {
  const f = await authenticatedFixture(t);
  const { createDesktopChatProviderRegistry } = await import("../dist/desktop/chat-provider-registry.js");
  const registry = createDesktopChatProviderRegistry({ stateStore: f.stateStore, credentialVault: f.credentialVault, adapterFactory() { throw new Error("No adapter call is expected."); } });
  f.credentialVault.entries.get(f.provider.id).kind = "bearer";
  await assert.rejects(registry.getAdapter(f.provider.id), /credential|kind/i);
  await f.configure({ kind: "openai", authType: "none" });
  await assert.rejects(registry.test(f.provider.id), /authentication|credential|auth/i);
  assert.equal(f.calls.length, 0);
});

test("provider readiness requires a credential matching the selected authentication kind", async (t) => {
  const f = await authenticatedFixture(t);
  const configured = await f.configure({ authType: "bearer" });
  assert.equal(configured.provider.configured, false);
  const metadata = await f.request("provider.metadata", { providerId: f.provider.id });
  assert.equal(metadata.provider.configured, false);
  assert.equal((await f.stateStore.load()).providers.find((provider) => provider.id === f.provider.id).configured, false);
  await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "bearer", secret: initialSecret } });
  const matching = await f.request("provider.list");
  assert.equal(matching.providers.find((provider) => provider.id === f.provider.id).configured, true);
  await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "api-key", secret: initialSecret } });
  const mismatched = await f.request("provider.list");
  assert.equal(mismatched.providers.find((provider) => provider.id === f.provider.id).configured, false);
});

test("keyless model discovery never resolves or transmits an older stored credential", async (t) => {
  const f = await authenticatedFixture(t);
  await f.configure({ authType: "none" });
  f.controls.key = null;
  const event = await f.request("models.list", { providerId: f.provider.id });
  assert.equal(event.type, "models.listed", JSON.stringify(event));
  assert.deepEqual(event.models.map((model) => model.id), ["catalog-model"]);
  assert.deepEqual(f.credentialVault.reads, []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].authorization, undefined);
  assert.equal(f.credentialVault.entries.get(f.provider.id).secret, initialSecret);
});

test("model discovery rejects revoked approval and mismatched credential kinds before requests", async (t) => {
  const f = await authenticatedFixture(t);
  await f.configure({ approved: false });
  const revoked = await f.request("models.list", { providerId: f.provider.id });
  assert.equal(revoked.type, "request.failed");
  assert.match(revoked.message, /approved|approval/i);
  assert.deepEqual(f.credentialVault.reads, []);
  assert.equal(f.calls.length, 0);
  await f.configure();
  f.credentialVault.entries.get(f.provider.id).kind = "bearer";
  const mismatched = await f.request("models.list", { providerId: f.provider.id });
  assert.equal(mismatched.type, "request.failed");
  assert.match(mismatched.message, /credential|kind/i);
  assert.equal(f.calls.length, 0);
});

test("model discovery drops credential-bearing IDs and redacts encoded credential echoes in display fields", async (t) => {
  const f = await authenticatedFixture(t);
  const secret = 'opaque"\\ models/+é';
  const echoes = variants(secret);
  await f.request("credential.replace", { input: { providerId: f.provider.id, kind: "api-key", secret } });
  f.controls.key = secret;
  f.controls.models = [
    { id: "catalog-model", name: "Catalog model", owned_by: "Fixture" },
    ...echoes.flatMap((echo, index) => [
      { id: `private-${echo}-${index}`, name: "Must not become a selectable route" },
      { id: `safe-model-${index}`, name: `Name ${echo}`, owned_by: `Owner ${echo}` },
    ]),
  ];
  const event = await f.request("models.list", { providerId: f.provider.id });
  assert.equal(event.type, "models.listed", JSON.stringify(event));
  assertMasked(JSON.stringify(event) + JSON.stringify(f.events), echoes);
  assert.equal(event.models.length, echoes.length + 1);
  assert.deepEqual(event.models.find((model) => model.id === "catalog-model"), { id: "catalog-model", name: "Catalog model", ownedBy: "Fixture", contextWindow: 128_000 });
  for (let index = 0; index < echoes.length; index += 1) {
    const model = event.models.find((entry) => entry.id === `safe-model-${index}`);
    assert.equal(model.name, "Name [REDACTED]");
    assert.equal(model.ownedBy, "Owner [REDACTED]");
  }
  assert.equal(f.credentialVault.entries.get(f.provider.id).secret, secret);
});

test("model discovery redacts credential echoes from failures before publishing request.failed", async (t) => {
  const f = await authenticatedFixture(t);
  const echoes = variants(initialSecret);
  t.mock.method(DesktopModelLister, "list", async () => { throw new Error(`Fixture failure: ${echoes.join(" | ")}`); });
  const event = await f.request("models.list", { providerId: f.provider.id });
  assert.equal(event.type, "request.failed");
  assert.match(event.message, /\[REDACTED\]/);
  assertMasked(JSON.stringify(event) + JSON.stringify(f.events), echoes);
  assert.equal(f.calls.length, 0);
  assert.equal(f.credentialVault.entries.get(f.provider.id).secret, initialSecret);
});
