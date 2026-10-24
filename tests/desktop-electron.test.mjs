import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  JsonDesktopAppStateStore,
  SafeStorageCredentialCipher,
  createHiveDesktopApi,
  isTrustedRendererUrl,
  redactDesktopFailure,
  resolveWorkspaceTarget,
  validateDesktopCommand,
  validateDesktopEvent,
  validateIpcSender,
  WorkerProcessSupervisor,
  DESKTOP_BROWSER_WEB_PREFERENCES,
  DESKTOP_CSP,
  DesktopCommandRouter,
  DesktopExternalToolService,
  DesktopCliForge,
  ShellWindowRegistry,
  withDesktopCredentialRuntime,
} from "../dist/desktop/electron/index.js";
import { DefaultDesktopRunManager } from "../dist/desktop/index.js";
import { filteredCodingToolEnvironment } from "../dist/coding/tools.js";

test("BrowserWindow contract is sandboxed and CSP denies ambient capabilities", () => {
  assert.equal(DESKTOP_BROWSER_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(DESKTOP_BROWSER_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(DESKTOP_BROWSER_WEB_PREFERENCES.sandbox, true);
  assert.match(DESKTOP_CSP, /default-src 'none'/);
  assert.match(DESKTOP_CSP, /object-src 'none'/);
  assert.match(DESKTOP_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(DESKTOP_CSP, /unsafe-eval|unsafe-inline|https:\*/);
});

const now = "2026-07-14T00:00:00.000Z";
// C:\repo on Windows, /repo on POSIX: absolute-path validation must hold on every CI runner.
const repoRoot = path.resolve("/repo");

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("desktop IPC accepts exact commands and rejects malformed or extra payloads", () => {
  assert.deepEqual(validateDesktopCommand({ requestId: "request-1", type: "thread.list" }), {
    requestId: "request-1",
    type: "thread.list",
  });
  assert.throws(
    () => validateDesktopCommand({ requestId: "request-1", type: "thread.list", shell: "calc.exe" }),
    /unexpected or missing/i,
  );
  assert.throws(
    () => validateDesktopCommand({ requestId: "request-1", type: "external.open-terminal", repositoryRoot: repoRoot, argv: ["/c", "calc"] }),
    /unexpected or missing/i,
  );
  assert.throws(
    () => validateDesktopCommand({ requestId: "request-1", type: "thread.save", thread: { id: "loose" } }),
    /thread/i,
  );
  assert.throws(() => validateDesktopCommand({ requestId: "", type: "thread.list" }), /request id/i);
  assert.throws(() => validateDesktopCommand({ requestId: "request-1", type: "unknown" }), /command type/i);
  assert.equal(validateDesktopCommand({ requestId: "pause-1", type: "run.pause", input: { repositoryRoot: repoRoot, threadId: "thread-1", codingSessionId: "session-1" } }).type, "run.pause");
  assert.throws(() => validateDesktopCommand({ requestId: "pause-1", type: "run.pause", input: { repositoryRoot: repoRoot, threadId: "thread-1", codingSessionId: "session-1", force: true } }), /unexpected/i);
  assert.equal(validateDesktopEvent({ type: "run.pause-requested", timestamp: now, requestId: "pause-1", repositoryRoot: repoRoot, codingSessionId: "session-1" }).type, "run.pause-requested");
  assert.equal(validateDesktopCommand({ requestId: "models-1", type: "models.list", providerId: "openai" }).type, "models.list");
  assert.throws(() => validateDesktopCommand({ requestId: "models-1", type: "models.list" }), /unexpected or missing/i);
  assert.equal(validateDesktopEvent({ type: "models.listed", timestamp: now, providerId: "openai", models: [{ id: "gpt-4o", contextWindow: 128000 }] }).type, "models.listed");
});

test("sender and navigation validation only trust the owned renderer", () => {
  const rendererFile = path.resolve("/HIVE/dist-desktop/renderer/index.html");
  const production = pathToFileURL(rendererFile).href;
  const sibling = pathToFileURL(path.resolve("/HIVE/dist-desktop/renderer/other.html")).href;
  assert.equal(isTrustedRendererUrl(production, { rendererFile }), true);
  assert.equal(isTrustedRendererUrl("https://evil.test/", { rendererFile }), false);
  assert.equal(isTrustedRendererUrl(sibling, { rendererFile }), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173/", { developmentUrl: "http://127.0.0.1:5173/" }), true);
  assert.equal(isTrustedRendererUrl("http://localhost:5173/", { developmentUrl: "http://127.0.0.1:5173/" }), false);
  assert.doesNotThrow(() => validateIpcSender({ url: production }, { rendererFile }));
  assert.throws(() => validateIpcSender({ url: "https://evil.test" }, { rendererFile }), /untrusted/i);
});

test("preload API exposes only request and subscribe and validates both directions", async () => {
  const listeners = new Set();
  const invocations = [];
  const api = createHiveDesktopApi({
    invoke: async (channel, command) => {
      invocations.push([channel, command]);
      return { type: "request.completed", timestamp: now, requestId: command.requestId };
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  assert.deepEqual(Object.keys(api).sort(), ["request", "subscribe"]);
  const response = await api.request({ requestId: "request-1", type: "thread.list" });
  assert.equal(response.type, "request.completed");
  assert.equal(invocations[0][0], "hive-desktop:request");
  await assert.rejects(() => api.request({ requestId: "request-2", type: "shell.exec", command: "calc" }), /command type/i);
  assert.throws(() => api.subscribe("not a function"), /listener/i);
  const seen = [];
  const unsubscribe = api.subscribe((event) => seen.push(event));
  for (const listener of listeners) listener({ type: "request.completed", timestamp: now, requestId: "request-1" });
  assert.equal(seen.length, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("errors are redacted before crossing Electron boundaries", () => {
  const error = redactDesktopFailure(new Error("failed with sk-1234567890ABCDEFGHI and Bearer topsecretvalue"));
  assert.doesNotMatch(error, /sk-123|topsecretvalue/);
  assert.match(error, /REDACTED/);
});

test("desktop AppData state is atomic, exact-schema validated, and corrupt records are preserved", async () => {
  const root = await temporaryDirectory("hive-desktop-state-");
  const store = new JsonDesktopAppStateStore(root, { clock: () => now });
  const initial = await store.load();
  assert.equal(initial.schemaVersion, 1);
  assert.deepEqual(initial.recentRepositories, []);
  const saved = await store.save({
    ...initial,
    recentRepositories: [{ path: path.resolve("/work"), lastOpenedAt: now }],
    preferences: { theme: "dark", reducedMotion: true, editor: "vscode" },
  });
  assert.equal(saved.recentRepositories.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "desktop-state.json"), "utf8")).schemaVersion, 1);
  await writeFile(path.join(root, "desktop-state.json"), "{broken", "utf8");
  await assert.rejects(() => store.load(), /corrupt/i);
  assert.equal(await readFile(path.join(root, "desktop-state.json"), "utf8"), "{broken");
  await assert.rejects(() => store.save({ ...saved, unexpected: true }), /unknown|unexpected/i);
  assert.equal(await readFile(path.join(root, "desktop-state.json"), "utf8"), "{broken");
  await rm(root, { recursive: true, force: true });
});

test("first-run AppData offers approved-empty provider metadata without changing persisted state", async () => {
  const root = await temporaryDirectory("hive-desktop-provider-defaults-");
  const store = new JsonDesktopAppStateStore(root, { clock: () => now });
  const initial = await store.load();
  assert.deepEqual(initial.providers.map(({ id, authType, approved, configured }) => ({ id, authType, approved, configured })), [
    { id: "anthropic", authType: "api-key", approved: false, configured: false },
    { id: "deepseek", authType: "api-key", approved: false, configured: false },
    { id: "google", authType: "api-key", approved: false, configured: false },
    { id: "hive-cloud", authType: "bearer", approved: false, configured: false },
    { id: "ollama", authType: "none", approved: false, configured: false },
    { id: "openai", authType: "api-key", approved: false, configured: false },
  ]);
  const custom = { id: "custom-local", name: "Custom local", kind: "local", authType: "none", approved: true, configured: true };
  await store.save({ ...initial, providers: [custom] });
  const loaded = await new JsonDesktopAppStateStore(root).load();
  assert.equal(loaded.providers[0].id, "custom-local");
  assert.ok(loaded.providers.some((p) => p.id === "google"));
  assert.ok(loaded.providers.some((p) => p.id === "deepseek"));
  await rm(root, { recursive: true, force: true });
});

test("AppData state merge preserves user-configured provider row without overwriting", async () => {
  const root = await temporaryDirectory("hive-desktop-provider-merge-");
  const store = new JsonDesktopAppStateStore(root, { clock: () => now });
  const customDeepSeek = {
    id: "deepseek",
    name: "My Custom DeepSeek",
    kind: "openai-compatible",
    authType: "api-key",
    approved: true,
    configured: true,
    baseUrl: "https://my-proxy.com/v1",
    defaultModel: "deepseek-custom",
  };
  await store.save({ ...store.defaultState(), providers: [customDeepSeek] });
  const loaded = await new JsonDesktopAppStateStore(root).load();
  const ds = loaded.providers.find((p) => p.id === "deepseek");
  assert.equal(ds.name, "My Custom DeepSeek");
  assert.equal(ds.baseUrl, "https://my-proxy.com/v1");
  assert.equal(ds.defaultModel, "deepseek-custom");
  assert.equal(ds.approved, true);
  assert.equal(ds.configured, true);
  assert.ok(loaded.providers.some((p) => p.id === "google"));
  await rm(root, { recursive: true, force: true });
});

test("AppData atomic mutate preserves concurrent repository and provider updates", async () => {
  const root = await temporaryDirectory("hive-appstate-race-");
  const first = new JsonDesktopAppStateStore(root, { clock: () => now });
  const second = new JsonDesktopAppStateStore(root, { clock: () => now });
  await first.save(first.defaultState());
  await Promise.all([
    first.mutate(async (state) => { await new Promise((resolve) => setTimeout(resolve, 15)); return { ...state, recentRepositories: [{ path: repoRoot, lastOpenedAt: now }] }; }),
    second.mutate((state) => ({ ...state, providers: [{ id: "provider-1", name: "Provider", kind: "openai", authType: "api-key", approved: true, configured: false }] })),
  ]);
  const saved = await first.load();
  assert.equal(saved.recentRepositories.length, 1);
  assert.ok(saved.providers.some((p) => p.id === "provider-1"));
  await rm(root, { recursive: true, force: true });
});

test("safeStorage adapter refuses plaintext fallback when encryption is unavailable", () => {
  const cipher = new SafeStorageCredentialCipher({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from("should-not-run"),
    decryptString: () => "should-not-run",
  });
  assert.equal(cipher.isEncryptionAvailable(), false);
  assert.throws(() => cipher.encrypt("secret"), /unavailable/i);
  assert.throws(() => cipher.decrypt(Buffer.from("cipher")), /unavailable/i);
});

test("external targets stay inside the selected repository and reject URLs and metadata", async () => {
  const root = await temporaryDirectory("hive-desktop-path-");
  await writeFile(path.join(root, "file.ts"), "export {};\n", "utf8");
  assert.equal(await resolveWorkspaceTarget(root, "file.ts", { mustExist: true }), path.join(root, "file.ts"));
  await assert.rejects(() => resolveWorkspaceTarget(root, "..\\outside.txt"), /outside/i);
  await assert.rejects(() => resolveWorkspaceTarget(root, "https://evil.test"), /URL|protocol/i);
  await assert.rejects(() => resolveWorkspaceTarget(root, ".git\\config"), /metadata/i);
  await rm(root, { recursive: true, force: true });
});

test("desktop launches ignore malicious repository executables and use resolved absolute tools", async () => {
  const root = await temporaryDirectory("hive-malicious-tools-");
  for (const name of ["git.cmd", "code.cmd", "wt.exe", "explorer.exe", "gh.cmd"]) await writeFile(path.join(root, name), "malicious", "utf8");
  const launches = [];
  const trusted = path.join(path.parse(root).root, "trusted-system-tools");
  const resolver = { async resolve(name) { return path.join(trusted, `${name}.exe`); } };
  const tools = new DesktopExternalToolService("vscode", async (file, args, options) => { launches.push({ file, args, options }); }, resolver);
  await tools.openEditor({ repositoryRoot: root, path: "code.cmd" });
  await tools.openTerminal(root);
  await tools.openExplorer({ repositoryRoot: root, path: "explorer.exe" });
  const forge = new DesktopCliForge(root, resolver, async (file, args, cwd) => { launches.push({ file, args, cwd }); return "https://example.test/pr/1\n"; });
  await forge.push(root, "hive/test");
  await forge.createPR("Title", "Body", "hive/test", "main");
  assert.equal(launches.length, 5);
  for (const launch of launches) {
    assert.equal(path.isAbsolute(launch.file), true);
    assert.equal(path.relative(root, launch.file).startsWith(".."), true);
    for (const malicious of ["git.cmd", "code.cmd", "wt.exe", "explorer.exe", "gh.cmd"]) assert.notEqual(path.resolve(launch.file), path.resolve(root, malicious));
  }
  const maliciousResolver = { async resolve(name) { return path.join(root, name === "git" ? "git.cmd" : "code.cmd"); } };
  const blockedTools = new DesktopExternalToolService("vscode", async () => { throw new Error("must not launch"); }, maliciousResolver);
  await assert.rejects(() => blockedTools.openEditor({ repositoryRoot: root, path: "code.cmd" }), /untrusted/i);
  const blockedForge = new DesktopCliForge(root, maliciousResolver, async () => { throw new Error("must not launch"); });
  await assert.rejects(() => blockedForge.push(root, "hive/test"), /untrusted/i);
  await rm(root, { recursive: true, force: true });
});

test("worker supervisor forwards lifecycle/events, rejects duplicate repositories, and terminates bounded cancellations", async () => {
  const sent = [];
  const lifecycle = [];
  let exitListener;
  let messageListener;
  let killed = false;
  const child = {
    pid: 41,
    postMessage(message) { sent.push(message); },
    on(event, listener) {
      if (event === "exit") exitListener = listener;
      if (event === "message") messageListener = listener;
    },
    kill() { killed = true; },
  };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child,
    workerModule: "C:\\HIVE\\dist\\desktop\\electron\\worker.js",
    cancelTimeoutMs: 20,
    threadStoreFactory: () => {
      const thread = { schemaVersion: 1, id: "thread-1", title: "Run", createdAt: now, updatedAt: now, archived: false, messages: [{ id: "message-1", role: "user", content: "Run", createdAt: now }], runs: [{ userMessageId: "message-1", codingSessionId: "session-1", status: "running", createdAt: now, updatedAt: now }] };
      return { async list() { return [thread]; }, async save(value) { return value; } };
    },
    codingSessionStoreFactory: () => ({ async load() { return { id: "session-1", status: "running", updatedAt: now }; }, async save(value) { return value; } }),
    onEvent: (event) => lifecycle.push(event),
  });
  await supervisor.start("C:\\repo", { requestId: "r1", type: "run.start", input: {
    repositoryRoot: "C:\\repo", threadId: "thread-1", currentUserMessageId: "message-1",
    options: { mode: "auto", approvalPolicy: "safe" },
  } });
  assert.equal(supervisor.hasActiveRuns(), true);
  await assert.rejects(() => supervisor.start("C:\\repo", { requestId: "r2", type: "run.start", input: {
    repositoryRoot: "C:\\repo", threadId: "thread-1", currentUserMessageId: "message-2",
    options: { mode: "auto", approvalPolicy: "safe" },
  } }), /already active/i);
  messageListener({ type: "desktop-event", event: { type: "worker.started", timestamp: now, codingSessionId: "session-1", processId: 41 } });
  assert.equal(lifecycle.at(-1).type, "worker.started");
  const sentBeforeMismatch = sent.length;
  await assert.rejects(() => supervisor.dispatch("C:\\repo", { requestId: "pause-bad", type: "run.pause", input: { repositoryRoot: "C:\\repo", threadId: "wrong-thread", codingSessionId: "wrong-session" } }), /does not match/i);
  assert.equal(sent.length, sentBeforeMismatch);
  assert.equal(supervisor.hasActiveRuns(), true);
  await supervisor.dispatch("C:\\repo", { requestId: "pause-1", type: "run.pause", input: { repositoryRoot: "C:\\repo", threadId: "thread-1", codingSessionId: "session-1" } });
  assert.equal(sent.at(-1).command.type, "run.pause");
  const sentBeforeCancel = sent.length;
  const cancel = { requestId: "cancel-1", type: "run.cancel", input: { repositoryRoot: "C:\\repo", threadId: "thread-1", codingSessionId: "session-1" } };
  await supervisor.dispatch("C:\\repo", cancel);
  await supervisor.dispatch("C:\\repo", cancel);
  assert.equal(sent.length, sentBeforeCancel + 1, "a repeated pending cancellation must be forwarded only once");
  assert.equal(sent.at(-1).command.type, "run.cancel");
  messageListener({ type: "desktop-event", event: { type: "request.failed", timestamp: now, requestId: "pause-1", message: "pause rejected", recoverable: true } });
  assert.equal(lifecycle.some((event) => event.requestId === "pause-1" && event.type === "request.failed"), false);
  messageListener({ type: "desktop-event", event: { type: "request.completed", timestamp: now, requestId: "cancel-1" } });
  assert.equal(lifecycle.some((event) => event.requestId === "cancel-1" && event.type === "request.completed"), false);
  const sentAfterCancelSettled = sent.length;
  await supervisor.dispatch("C:\\repo", cancel);
  assert.equal(sent.length, sentAfterCancelSettled + 1, "settled control request ids must be released");
  messageListener({ type: "desktop-event", event: { type: "request.failed", timestamp: now, requestId: "cancel-1", message: "cancel rejected", recoverable: true } });
  assert.equal(lifecycle.some((event) => event.requestId === "cancel-1" && event.type === "request.failed"), false);
  assert.equal(lifecycle.some((event) => event.type === "worker.failed"), false);
  messageListener({ type: "desktop-event", event: { type: "run.changed", timestamp: now, run: { userMessageId: "message-1", codingSessionId: "session-1", status: "running", createdAt: now, updatedAt: now } } });
  assert.equal(lifecycle.at(-1).requestId, "r1");
  await supervisor.cancelRepository("C:\\repo");
  assert.equal(sent.at(-1).type, "cancel-all");
  assert.equal(killed, true);
  exitListener(1);
  assert.equal(lifecycle.some((event) => event.type === "worker.failed"), false);
});

test("forced shutdown durably cancels both records and retains ownership until a failed persistence can be retried", async () => {
  let exitListener;
  let threadSaveFails = false;
  const thread = { schemaVersion: 1, id: "thread-forced", title: "Forced", createdAt: now, updatedAt: now, archived: false, messages: [{ id: "message-forced", role: "user", content: "Run", createdAt: now }], runs: [{ userMessageId: "message-forced", codingSessionId: "session-forced", status: "running", createdAt: now, updatedAt: now }] };
  let session = { id: "session-forced", status: "running", updatedAt: now };
  const child = {
    postMessage() {},
    on(event, listener) { if (event === "exit") exitListener = listener; },
    kill() { exitListener(1); },
  };
  const events = [];
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child,
    workerModule: "worker.js",
    cancelTimeoutMs: 1,
    threadStoreFactory: () => ({
      async list() { return [structuredClone(thread)]; },
      async save(value) { if (threadSaveFails) throw new Error("thread disk failed"); Object.assign(thread, structuredClone(value)); return structuredClone(thread); },
      async mutate(_id, mutator) { if (threadSaveFails) throw new Error("thread disk failed"); const next = mutator(structuredClone(thread)); Object.assign(thread, structuredClone(next)); return structuredClone(thread); },
    }),
    codingSessionStoreFactory: () => ({ async load() { return structuredClone(session); }, async save(value) { session = structuredClone(value); return structuredClone(session); } }),
    onEvent: (event) => events.push(event),
  });
  await supervisor.start("C:\\repo-forced", { requestId: "run-forced", type: "run.resume", input: { repositoryRoot: "C:\\repo-forced", threadId: "thread-forced", codingSessionId: "session-forced", options: { mode: "auto", approvalPolicy: "safe" } } });
  threadSaveFails = true;
  await assert.rejects(() => supervisor.cancelRepository("C:\\repo-forced"), /thread disk failed/);
  assert.equal(session.status, "cancelled", "authoritative session is persisted before its thread projection");
  assert.equal(thread.runs[0].status, "running");
  assert.equal(supervisor.hasActiveRuns(), true, "failed durable reconciliation must keep the close guard active");
  threadSaveFails = false;
  await supervisor.cancelRepository("C:\\repo-forced");
  assert.equal(thread.runs[0].status, "cancelled");
  assert.equal(supervisor.hasActiveRuns(), false);
  assert.equal(events.at(-1).type, "run.changed");
  assert.equal(events.at(-1).run.status, "cancelled");
});

test("cancel-all worker failure exit is reconciled as a durable cancellation before ownership is released", async () => {
  let exitListener; let messageListener;
  const thread = { schemaVersion: 1, id: "thread-fast-exit", title: "Fast exit", createdAt: now, updatedAt: now, archived: false, messages: [{ id: "message-fast-exit", role: "user", content: "Run", createdAt: now }], runs: [{ userMessageId: "message-fast-exit", codingSessionId: "session-fast-exit", status: "running", createdAt: now, updatedAt: now }] };
  let session = { id: "session-fast-exit", status: "running", updatedAt: now };
  const child = {
    postMessage(message) {
      if (message.type === "cancel-all") {
        messageListener({ type: "error", message: "manager cancellation timed out" });
        exitListener(1);
      }
    },
    on(event, listener) { if (event === "exit") exitListener = listener; if (event === "message") messageListener = listener; },
    kill() { throw new Error("fast exit must not reach force kill"); },
  };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child, workerModule: "worker.js", cancelTimeoutMs: 100,
    threadStoreFactory: () => ({ async list() { return [structuredClone(thread)]; }, async save(value) { Object.assign(thread, structuredClone(value)); return structuredClone(thread); }, async mutate(_id, mutator) { const next = mutator(structuredClone(thread)); Object.assign(thread, structuredClone(next)); return structuredClone(thread); } }),
    codingSessionStoreFactory: () => ({ async load() { return structuredClone(session); }, async save(value) { session = structuredClone(value); return structuredClone(session); } }),
    onEvent() {},
  });
  await supervisor.start("C:\\repo-fast-exit", { requestId: "run-fast-exit", type: "run.resume", input: { repositoryRoot: "C:\\repo-fast-exit", threadId: thread.id, codingSessionId: "session-fast-exit", options: { mode: "auto", approvalPolicy: "safe" } } });
  await supervisor.cancelRepository("C:\\repo-fast-exit");
  assert.equal(session.status, "cancelled");
  assert.equal(thread.runs[0].status, "cancelled");
  assert.equal(supervisor.hasActiveRuns(), false);
});

test("worker supervisor bounds pending control correlation state and releases settled ids", async () => {
  const sent = [];
  let exitListener;
  let messageListener;
  const child = {
    pid: 42,
    postMessage(message) { sent.push(message); },
    on(event, listener) {
      if (event === "exit") exitListener = listener;
      if (event === "message") messageListener = listener;
    },
    kill() {},
  };
  const supervisor = new WorkerProcessSupervisor({ spawn: () => child, workerModule: "worker.js", onEvent() {} });
  await supervisor.start("C:\\repo-control-bound", { requestId: "run-bound", type: "run.resume", input: {
    repositoryRoot: "C:\\repo-control-bound", threadId: "thread-1", codingSessionId: "session-1",
    options: { mode: "auto", approvalPolicy: "safe" },
  } });
  messageListener({ type: "desktop-event", event: { type: "worker.started", timestamp: now, codingSessionId: "session-1", processId: 42 } });
  for (let index = 0; index < 64; index += 1) {
    await supervisor.dispatch("C:\\repo-control-bound", { requestId: `pause-${index}`, type: "run.pause", input: { repositoryRoot: "C:\\repo-control-bound", threadId: "thread-1", codingSessionId: "session-1" } });
  }
  await assert.rejects(() => supervisor.dispatch("C:\\repo-control-bound", { requestId: "pause-overflow", type: "run.pause", input: { repositoryRoot: "C:\\repo-control-bound", threadId: "thread-1", codingSessionId: "session-1" } }), /too many pending/i);
  messageListener({ type: "desktop-event", event: { type: "request.completed", timestamp: now, requestId: "pause-0" } });
  await supervisor.dispatch("C:\\repo-control-bound", { requestId: "pause-after-settle", type: "run.pause", input: { repositoryRoot: "C:\\repo-control-bound", threadId: "thread-1", codingSessionId: "session-1" } });
  assert.equal(sent.at(-1).command.requestId, "pause-after-settle");
  messageListener({ type: "desktop-event", event: { type: "worker.stopped", timestamp: now, codingSessionId: "session-1", exitCode: 0, expected: true } });
  exitListener(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(supervisor.hasActiveRuns(), false);
});

test("dispatchAndWait resolves only after the worker persistence acknowledgement and rejects crash-before-ack", async () => {
  let messageListener; let exitListener;
  const child = { pid: 77, postMessage() {}, on(event, listener) { if (event === "message") messageListener = listener; if (event === "exit") exitListener = listener; }, kill() {} };
  const supervisor = new WorkerProcessSupervisor({ spawn: () => child, workerModule: "worker.js", onEvent() {} });
  let settled = false;
  const pending = supervisor.dispatchAndWait("C:\\repo-ack", { requestId: "run-ack", type: "run.resume", input: { repositoryRoot: "C:\\repo-ack", threadId: "thread-1", codingSessionId: "session-1", options: { mode: "auto", approvalPolicy: "safe" } } }).then(() => { settled = true; });
  await Promise.resolve();
  messageListener({ type: "desktop-event", event: { type: "worker.started", timestamp: now, codingSessionId: "session-1", processId: 77 } });
  await Promise.resolve();
  assert.equal(settled, false);
  messageListener({ type: "desktop-event", event: { type: "request.completed", timestamp: now, requestId: "run-ack" } });
  await pending;
  assert.equal(settled, true);

  let secondExit;
  const failed = new WorkerProcessSupervisor({ spawn: () => ({ postMessage() {}, on(event, listener) { if (event === "exit") secondExit = listener; }, kill() {} }), workerModule: "worker.js", threadStoreFactory: () => ({ async list() { return []; }, async save(value) { return value; } }), codingSessionStoreFactory: () => ({ async load() { return null; } }), onEvent() {} });
  const rejected = failed.dispatchAndWait("C:\\repo-ack-fail", { requestId: "run-fail", type: "run.resume", input: { repositoryRoot: "C:\\repo-ack-fail", threadId: "thread-1", codingSessionId: "session-1", options: { mode: "auto", approvalPolicy: "safe" } } });
  await Promise.resolve(); secondExit(2);
  await assert.rejects(rejected, /before acknowledging/i);
  exitListener(0);
});

test("unexpected worker exits are reported as recoverable crashes with redacted detail", async () => {
  let exitListener;
  const lifecycle = [];
  const child = {
    pid: 99,
    postMessage() {},
    on(event, listener) { if (event === "exit") exitListener = listener; },
    kill() {},
  };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child,
    workerModule: "worker.js",
    threadStoreFactory: () => ({ async list() { return []; }, async save(value) { return value; } }),
    codingSessionStoreFactory: () => ({ async load() { return null; } }),
    onEvent: (event) => lifecycle.push(event),
  });
  await supervisor.start("C:\\repo-two", { requestId: "r1", type: "run.resume", input: {
    repositoryRoot: "C:\\repo-two", threadId: "thread-1", codingSessionId: "sk-1234567890ABCDEFGHI",
    options: { mode: "auto", approvalPolicy: "safe" },
  } });
  exitListener(2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failed = lifecycle.find((event) => event.type === "worker.failed");
  assert.ok(failed);
  assert.equal(failed.recoverable, true);
  assert.doesNotMatch(failed.message, /sk-123/);
});

test("a worker that reports persisted stop is not misclassified as a process crash", async () => {
  let exitListener; let messageListener;
  const events = [];
  const child = { pid: 8, postMessage() {}, on(event, listener) { if (event === "exit") exitListener = listener; if (event === "message") messageListener = listener; }, kill() {} };
  const supervisor = new WorkerProcessSupervisor({ spawn: () => child, workerModule: "worker.js", onEvent: (event) => events.push(event) });
  await supervisor.start("C:\\repo-clean-stop", { requestId: "r1", type: "run.resume", input: { repositoryRoot: "C:\\repo-clean-stop", threadId: "thread-1", codingSessionId: "session-1", options: { mode: "auto", approvalPolicy: "safe" } } });
  messageListener({ type: "desktop-event", event: { type: "worker.stopped", timestamp: now, codingSessionId: "session-1", exitCode: 0, expected: true } });
  exitListener(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.some((event) => event.type === "worker.failed"), false);
  assert.equal(supervisor.hasActiveRuns(), false);
});

test("worker.stopped expected false reconciles nonterminal records before releasing ownership", async () => {
  let exitListener; let messageListener;
  const events = [];
  const thread = { schemaVersion: 1, id: "thread-failed-stop", title: "Failed stop", createdAt: now, updatedAt: now, archived: false, messages: [{ id: "message-failed-stop", role: "user", content: "Run", createdAt: now }], runs: [{ userMessageId: "message-failed-stop", codingSessionId: "session-failed-stop", status: "running", createdAt: now, updatedAt: now }] };
  const child = { pid: 9, postMessage() {}, on(event, listener) { if (event === "exit") exitListener = listener; if (event === "message") messageListener = listener; }, kill() {} };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child, workerModule: "worker.js",
    threadStoreFactory: () => ({ async list() { return [structuredClone(thread)]; }, async save(value) { Object.assign(thread, structuredClone(value)); return structuredClone(thread); } }),
    codingSessionStoreFactory: () => ({ async load() { return null; } }),
    onEvent: (event) => events.push(event),
  });
  await supervisor.start("C:\\repo-failed-stop", { requestId: "run-failed-stop", type: "run.resume", input: { repositoryRoot: "C:\\repo-failed-stop", threadId: thread.id, codingSessionId: "session-failed-stop", options: { mode: "auto", approvalPolicy: "safe" } } });
  messageListener({ type: "desktop-event", event: { type: "worker.stopped", timestamp: now, codingSessionId: "session-failed-stop", exitCode: 1, expected: false } });
  exitListener(1);
  for (let attempt = 0; attempt < 20 && supervisor.hasActiveRuns(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(thread.runs[0].status, "failed");
  assert.equal(supervisor.hasActiveRuns(), false);
  assert.equal(events.some((event) => event.type === "worker.failed"), true);
});

test("desktop credential reaches only the ephemeral runtime registry and is removed immediately", async () => {
  const secret = "desktop-only-secret-value";
  let observed;
  await withDesktopCredentialRuntime({
    provider: { id: "desktop-openai", name: "Desktop OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true, defaultModel: "gpt-4o" },
    kind: "api-key",
    secret,
  }, async (registry) => {
    const config = await registry.get("desktop-openai");
    assert.equal(config.apiKeyEnv, undefined);
    const { adapter } = await registry.getAdapter("desktop-openai");
    const completion = await adapter.complete(config, { prompt: "test", model: "gpt-4o" });
    observed = completion.output;
    assert.equal(JSON.stringify(config).includes(secret), false);
  }, { adapterFactory: () => ({ kind: "openai", async healthCheck() { return { ok: true, providerId: "desktop-openai", message: "ok" }; }, async complete(_config, _input, credential) { assert.equal(credential.secret, secret); assert.equal(Object.values(process.env).includes(secret), false); return { output: `provider echoed ${secret}` }; } }) });
  assert.equal(observed, "provider echoed [REDACTED]");
  assert.equal(Object.values(process.env).includes(secret), false);
  process.env.HIVE_DESKTOP_SECRET_TEST = secret;
  assert.equal(filteredCodingToolEnvironment().HIVE_DESKTOP_SECRET_TEST, undefined);
  delete process.env.HIVE_DESKTOP_SECRET_TEST;
  const leaking = { provider: { id: "desktop-openai", name: "Desktop OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true }, kind: "api-key", secret };
  await assert.rejects(() => withDesktopCredentialRuntime(leaking, async () => { throw new Error(`provider echoed ${secret}`); }), (error) => !error.message.includes(secret) && error.message.includes("REDACTED"));
});

test("concurrent provider calls receive direct credentials without mutating process environment", async () => {
  const secret = "concurrent-desktop-secret";
  const credential = () => ({ provider: { id: "desktop-concurrent", name: "Concurrent", kind: "openai", authType: "api-key", approved: true, configured: true }, kind: "api-key", secret });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  let active = 0; let maximum = 0; let calls = 0;
  await withDesktopCredentialRuntime(credential(), async (registry) => {
    const config = await registry.get("desktop-concurrent");
    const { adapter } = await registry.getAdapter("desktop-concurrent");
    const first = adapter.complete(config, { prompt: "one", model: "model" });
    const second = adapter.complete(config, { prompt: "two", model: "model" });
    await entered;
    assert.equal(calls, 2);
    assert.equal(Object.values(process.env).includes(secret), false);
    releaseFirst();
    await Promise.all([first, second]);
  }, { adapterFactory: () => ({ kind: "openai", async healthCheck() { return { ok: true, providerId: "desktop-concurrent", message: "ok" }; }, async complete(_config, _input, direct) { calls += 1; active += 1; maximum = Math.max(maximum, active); assert.equal(direct.secret, secret); assert.equal(Object.values(process.env).includes(secret), false); if (calls === 1) { firstEntered(); await firstGate; } active -= 1; return { output: "ok" }; } }) });
  assert.equal(maximum, 2);

  let releaseFailure; let failureEntered;
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  const sawFailureEntry = new Promise((resolve) => { failureEntered = resolve; });
  calls = 0; active = 0; maximum = 0;
  await withDesktopCredentialRuntime(credential(), async (registry) => {
    const config = await registry.get("desktop-concurrent");
    const { adapter } = await registry.getAdapter("desktop-concurrent");
    const first = adapter.complete(config, { prompt: "fail", model: "model" });
    const second = adapter.complete(config, { prompt: "success", model: "model" });
    await sawFailureEntry;
    assert.equal(calls, 2);
    releaseFailure();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "fulfilled");
    assert.equal(Object.values(process.env).includes(secret), false);
  }, { adapterFactory: () => ({ kind: "openai", async healthCheck() { return { ok: true, providerId: "desktop-concurrent", message: "ok" }; }, async complete(_config, _input, direct) { calls += 1; active += 1; maximum = Math.max(maximum, active); assert.equal(direct.secret, secret); if (calls === 1) { failureEntered(); await failureGate; active -= 1; throw new Error("mixed failure"); } active -= 1; return { output: "ok" }; } }) });
  assert.equal(maximum, 2);
});

test("credential IPC is request-scoped and never projected into lifecycle events", async () => {
  const events = [];
  const sent = [];
  let messageListener;
  const child = { pid: 7, postMessage(message) { sent.push(message); }, on(event, listener) { if (event === "message") messageListener = listener; }, kill() {} };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child,
    workerModule: "worker.js",
    resolveCredential: async (providerId) => ({
      provider: { id: providerId, name: "OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true },
      kind: "api-key",
      secret: "ipc-secret-value",
    }),
    onEvent: (event) => events.push(event),
  });
  await supervisor.start("C:\\repo-credential", { requestId: "r1", type: "run.start", input: { repositoryRoot: "C:\\repo-credential", threadId: "thread-1", currentUserMessageId: "message-1", options: { mode: "auto", approvalPolicy: "safe", providerId: "desktop-openai" } } });
  messageListener({ type: "credential-request", requestId: "credential-1", providerId: "desktop-openai" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = sent.find((message) => message.type === "credential-response");
  assert.equal(response.credential.secret, "ipc-secret-value");
  assert.equal(JSON.stringify(events).includes("ipc-secret-value"), false);
});

test("delayed credential resolution is dropped and zeroized after the owned worker exits", async () => {
  const sent = []; let messageListener; let exitListener; let resolveCredential;
  const pendingCredential = new Promise((resolve) => { resolveCredential = resolve; });
  const child = { pid: 71, postMessage(message) { sent.push(message); }, on(event, listener) { if (event === "message") messageListener = listener; if (event === "exit") exitListener = listener; }, kill() {} };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child, workerModule: "worker.js", onEvent() {},
    resolveCredential: () => pendingCredential,
    threadStoreFactory: () => ({ async list() { return []; }, async save(value) { return value; } }),
    codingSessionStoreFactory: () => ({ async load() { return null; } }),
  });
  await supervisor.start("C:\\repo-delayed-credential", { requestId: "run-credential", type: "run.start", input: { repositoryRoot: "C:\\repo-delayed-credential", threadId: "thread-1", currentUserMessageId: "message-1", options: { mode: "auto", approvalPolicy: "safe", providerId: "provider-1" } } });
  messageListener({ type: "credential-request", requestId: "credential-delayed", providerId: "provider-1" });
  exitListener(1);
  for (let count = 0; count < 50 && supervisor.hasActiveRuns(); count += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  const credential = { provider: { id: "provider-1", name: "Provider", kind: "openai", authType: "api-key", approved: true, configured: true }, kind: "api-key", secret: "delayed-secret" };
  resolveCredential(credential);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.some((message) => message.type === "credential-response"), false);
  assert.equal(credential.secret, undefined);
});

test("worker rejects credential requests for any provider other than the run declaration", async () => {
  const sent = []; let messageListener; let resolverCalls = 0;
  const child = { pid: 10, postMessage(message) { sent.push(message); }, on(event, listener) { if (event === "message") messageListener = listener; }, kill() {} };
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => child, workerModule: "worker.js", onEvent() {},
    resolveCredential: async () => { resolverCalls += 1; throw new Error("must not run"); },
  });
  await supervisor.start("C:\\repo-bound-provider", { requestId: "r1", type: "run.start", input: { repositoryRoot: "C:\\repo-bound-provider", threadId: "thread-1", currentUserMessageId: "message-1", options: { mode: "auto", approvalPolicy: "safe", providerId: "allowed-provider" } } });
  messageListener({ type: "credential-request", requestId: "credential-cross", providerId: "different-provider" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resolverCalls, 0);
  const response = sent.find((message) => message.type === "credential-response");
  assert.match(response.error, /does not match/i);
  assert.equal(response.credential, undefined);
});

test("worker crash reconciles persisted run status before repository ownership is released", async () => {
  const timestamp = "2026-07-14T00:01:00.000Z";
  const thread = {
    schemaVersion: 1, id: "thread-1", title: "Crash", createdAt: now, updatedAt: now, archived: false, messages: [],
    runs: [{ userMessageId: "message-1", codingSessionId: "session-1", status: "running", createdAt: now, updatedAt: now }],
  };
  let saved;
  let exitListener;
  let spawnCount = 0;
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => { spawnCount += 1; return { pid: spawnCount, postMessage() {}, on(event, listener) { if (event === "exit") exitListener = listener; }, kill() {} }; },
    workerModule: "worker.js",
    threadStoreFactory: () => ({ async list() { return [thread]; }, async save(value) { saved = structuredClone(value); return value; } }),
    codingSessionStoreFactory: () => ({ async load() { return { status: "paused", updatedAt: timestamp }; } }),
    onEvent() {},
  });
  const command = { requestId: "r1", type: "run.resume", input: { repositoryRoot: "C:\\repo-crash", threadId: "thread-1", codingSessionId: "session-1", options: { mode: "auto", approvalPolicy: "safe" } } };
  await supervisor.start("C:\\repo-crash", command);
  exitListener(2);
  await assert.rejects(() => supervisor.start("C:\\repo-crash", command), /already active/i);
  for (let count = 0; count < 50 && !saved; count += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(saved.runs[0].status, "paused");
  await supervisor.start("C:\\repo-crash", command);
  assert.equal(spawnCount, 2);
});

test("worker rejection and failed reconciliation always release repository ownership", async () => {
  let messageListener; let exitListener; let spawnCount = 0;
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => { spawnCount += 1; return { pid: spawnCount, postMessage() {}, on(event, listener) { if (event === "message") messageListener = listener; if (event === "exit") exitListener = listener; }, kill() {} }; },
    workerModule: "worker.js", onEvent() {},
    threadStoreFactory: () => ({ async list() { return [{ schemaVersion: 1, id: "thread-1", title: "Run", createdAt: now, updatedAt: now, archived: false, messages: [], runs: [{ userMessageId: "message-1", codingSessionId: "session-1", status: "running", createdAt: now, updatedAt: now }] }]; }, async save() { throw new Error("disk failed"); } }),
    codingSessionStoreFactory: () => ({ async load() { return null; } }),
  });
  const command = { requestId: "r1", type: "run.resume", input: { repositoryRoot: "C:\\repo-release", threadId: "thread-1", codingSessionId: "session-1", options: { mode: "auto", approvalPolicy: "safe", providerId: "provider-1" } } };
  await supervisor.start("C:\\repo-release", command);
  messageListener({ type: "error", message: "start rejected" });
  exitListener(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await supervisor.start("C:\\repo-release", command);
  exitListener(2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(supervisor.hasActiveRuns(), false);
  await supervisor.start("C:\\repo-release", command);
  assert.equal(spawnCount, 3);
});

test("DesktopEvent validation rejects malformed, unbounded, and secret-bearing nested payloads", () => {
  assert.throws(() => validateDesktopEvent({ type: "worker.started", timestamp: now, codingSessionId: "session-1", processId: "7" }), /process id/i);
  assert.throws(() => validateDesktopEvent({ type: "request.failed", timestamp: now, requestId: "request-1", message: "Bearer topsecretvalue", recoverable: true }), /secret/i);
  assert.throws(() => validateDesktopEvent({ type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "event-1", sequence: 1, sessionId: "session-1", timestamp: now, type: "task.progress", payload: { taskId: "task-1", message: "x".repeat(20_001) } } }), /invalid|large/i);
  assert.throws(() => validateDesktopEvent({ type: "credential.changed", timestamp: now, credential: { providerId: "provider-1", kind: "api-key", configured: true, secret: "leak" } }), /unexpected/i);
});

test("shared secret boundary rejects and redacts every supported credential format", () => {
  const secrets = [
    "sk-1234567890ABCDEFGHI", "ghp_1234567890ABCDEFGHI", "github_pat_1234567890ABCDEFGHI",
    "xoxb-1234567890-ABCDEFGHI", "AKIA1234567890ABCDEF", "AIza1234567890abcdefghijklmnopqrstuv",
    "hf_1234567890ABCDEFGHIJKLMN", "Bearer topsecretvalue", "AWS_SECRET_ACCESS_KEY=verysecretvalue",
    "GOOGLE_API_KEY=anothersecretvalue",
  ];
  for (const secret of secrets) {
    const redacted = redactDesktopFailure(new Error(`failure ${secret}`));
    assert.equal(redacted.includes(secret), false, secret);
    assert.match(redacted, /REDACTED/);
    assert.throws(() => validateDesktopEvent({ type: "request.failed", timestamp: now, requestId: "request-secret", message: secret, recoverable: true }), /secret/i);
  }
});

test("valid status change tokenUsage passes while malformed usage and exact credential fields fail", () => {
  const task = {
    id: "bee-1", sessionId: "session-1", role: "builder", title: "Build", objective: "Implement",
    status: "working", providerId: "provider-1", dependencies: [], fileScope: ["src/file.ts"], expectedOutput: "Code",
    completionCriteria: ["Done"], validationCommands: ["npm test"], depth: 1, attempt: 1, maxAttempts: 2,
    createdAt: now, tokenUsage: { input: 10, output: 20, total: 30 },
  };
  const event = { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "event-status", sequence: 1, sessionId: "session-1", timestamp: now, type: "subagent.status_changed", payload: { subagentId: "bee-1", previousStatus: "starting", status: "working", task } } };
  assert.equal(validateDesktopEvent(event).type, "runtime.event");
  assert.throws(() => validateDesktopEvent({ ...event, event: { ...event.event, payload: { ...event.event.payload, task: { ...task, tokenUsage: { input: -1 } } } } }), /token usage/i);
  assert.throws(() => validateDesktopEvent({ ...event, event: { ...event.event, payload: { ...event.event.payload, task: { ...task, apiKey: "leak" } } } }), /unexpected|sensitive/i);
});

test("startup reconciliation persists stale runs before allowing follow-up or resume", async () => {
  const failedRoot = await temporaryDirectory("hive-reconcile-failed-");
  const pausedRoot = await temporaryDirectory("hive-reconcile-paused-");
  const order = [];
  const makeThread = (root, status, sessionId, messageId) => ({ schemaVersion: 1, id: "thread-1", title: "Recovered", createdAt: now, updatedAt: now, archived: false, messages: [{ id: messageId, role: "user", content: "Continue", createdAt: now }], runs: [{ userMessageId: "old-message", codingSessionId: sessionId, status, createdAt: now, updatedAt: now }], repositoryRoot: root });
  const failedThread = makeThread(failedRoot, "running", "session-failed", "message-next");
  const pausedThread = makeThread(pausedRoot, "running", "session-paused", "message-next");
  const stores = new Map([[failedRoot, failedThread], [pausedRoot, pausedThread]]);
  const storeFactory = (root) => ({ async list() { return [stores.get(root)]; }, async load() { return stores.get(root); }, async save(value) { order.push(`save:${root}`); stores.set(root, structuredClone(value)); return value; } });
  const supervisor = new WorkerProcessSupervisor({
    spawn: () => { throw new Error("unused"); }, workerModule: "worker.js", threadStoreFactory: storeFactory,
    codingSessionStoreFactory: (root) => ({ async load() { return root === pausedRoot ? { status: "paused", updatedAt: now } : null; } }),
    canonicalize: async (root) => root, onEvent: (event) => { if (event.type === "run.changed") order.push(`event:${event.run.status}`); },
  });
  await supervisor.reconcileRepositoryRuns(failedRoot);
  await supervisor.reconcileRepositoryRuns(pausedRoot);
  assert.equal(stores.get(failedRoot).runs[0].status, "failed");
  assert.equal(stores.get(pausedRoot).runs[0].status, "paused");
  assert.ok(order.indexOf(`save:${failedRoot}`) < order.indexOf("event:failed"));
  const completed = (root, id) => ({ schemaVersion: 1, id, objective: "Continue", mode: "auto", approvalPolicy: "safe", status: "completed", createdAt: now, updatedAt: now, repository: { root, capturedAt: now, dirty: false, changedFiles: [] }, tasks: [], events: [], providerBindings: [], validationResults: [], reviewResults: [], files: [] });
  const failedManager = new DefaultDesktopRunManager({ threadStoreFactory: storeFactory, launcher: (input) => completed(failedRoot, input.sessionId), sessionIdFactory: () => "session-next" });
  const next = await failedManager.start({ repositoryRoot: failedRoot, threadId: "thread-1", currentUserMessageId: "message-next", options: { mode: "auto", approvalPolicy: "safe" } });
  assert.equal(next.codingSessionId, "session-next");
  const pausedManager = new DefaultDesktopRunManager({ threadStoreFactory: storeFactory, launcher: (input) => completed(pausedRoot, input.sessionId) });
  const resumed = await pausedManager.resume({ repositoryRoot: pausedRoot, threadId: "thread-1", codingSessionId: "session-paused", options: { mode: "auto", approvalPolicy: "changes" } });
  assert.equal(resumed.codingSessionId, "session-paused");
  await rm(failedRoot, { recursive: true, force: true }); await rm(pausedRoot, { recursive: true, force: true });
});

test("main router connects repository/AppData/thread boundaries and returns typed failures", async () => {
  const root = await temporaryDirectory("hive-desktop-router-");
  const appData = await temporaryDirectory("hive-desktop-router-state-");
  const stateStore = new JsonDesktopAppStateStore(appData, { clock: () => now });
  const credentialVault = {
    async list() { return []; }, async metadata() { return null; },
    async set() { throw new Error("unused"); }, async replace() { throw new Error("unused"); },
    async remove() {}, async test(input) { return { providerId: input.providerId, ok: false, message: "not configured" }; },
  };
  const linkedThread = { schemaVersion: 1, id: "thread-report", title: "Report", createdAt: now, updatedAt: now, archived: false, messages: [{ id: "message-report", role: "user", content: "Build it", createdAt: now }], runs: [{ userMessageId: "message-report", codingSessionId: "session-report", status: "completed", createdAt: now, updatedAt: now }] };
  const finalReport = { result: "Complete", subagents: { total: 1, active: 0, working: 0, waiting: 0, blocked: 0, done: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 }, filesChanged: ["src/a.ts"], validation: [{ label: "tests", status: "passed" }], review: [], outstanding: [], completedAt: now };
  const router = new DesktopCommandRouter({
    stateStore,
    credentialVault,
    workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: () => ({ async list() { return []; }, async load(id) { return id === linkedThread.id ? linkedThread : null; }, async create() { throw new Error("unused"); }, async save() { throw new Error("unused"); }, async archive() { throw new Error("unused"); } }),
    codingSessionStoreFactory: () => ({ async load(id) { return id === "session-report" ? { finalReport } : null; } }),
    clock: () => now,
  });
  const emptyRecent = await router.handle({ requestId: "request-recent-empty", type: "repository.list" });
  assert.equal(emptyRecent.type, "repository.listed");
  assert.deepEqual(emptyRecent.repositories, []);
  const ready = await router.handle({ requestId: "request-open", type: "repository.open", repositoryRoot: root });
  assert.equal(ready.type, "desktop.ready");
  const listed = await router.handle({ requestId: "request-list", type: "thread.list" });
  assert.equal(listed.type, "thread.listed");
  assert.deepEqual(listed.threads, []);
  const recent = await router.handle({ requestId: "request-recent", type: "repository.list" });
  assert.equal(recent.type, "repository.listed");
  assert.equal(recent.repositories.length, 1);
  const report = await router.handle({ requestId: "request-report", type: "run.report", input: { repositoryRoot: root, threadId: "thread-report", codingSessionId: "session-report" } });
  assert.equal(report.type, "run.reported");
  assert.deepEqual(report.report, finalReport);
  const persisted = await stateStore.load();
  assert.equal(persisted.recentRepositories[0].path, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
  const failed = await router.handle({ requestId: "request-bad", type: "thread.list", command: "calc.exe" });
  assert.equal(failed.type, "request.failed");
  assert.doesNotMatch(failed.message, /calc\.exe/);
  await rm(root, { recursive: true, force: true });
  await rm(appData, { recursive: true, force: true });
});

test("main router binds run and Git repository roots to the canonical selected project", async () => {
  const selected = await temporaryDirectory("hive-selected-");
  const other = await temporaryDirectory("hive-other-");
  const appData = await temporaryDirectory("hive-selected-state-");
  const dispatched = [];
  let gitCalls = 0;
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait(root, command) { dispatched.push([root, command]); }, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => ({ async inspect(root) { gitCalls += 1; return { repositoryRoot: root, branch: null, head: null, dirty: false, changedFiles: [], ahead: 0, behind: 0 }; } }),
    clock: () => now,
  });
  await router.handle({ requestId: "open", type: "repository.open", repositoryRoot: selected });
  const mismatch = await router.handle({ requestId: "bad-run", type: "run.start", input: { repositoryRoot: other, threadId: "thread-1", currentUserMessageId: "message-1", options: { mode: "auto", approvalPolicy: "safe" } } });
  assert.equal(mismatch.type, "request.failed");
  assert.equal(dispatched.length, 0);
  const badGit = await router.handle({ requestId: "bad-git", type: "git.inspect", repositoryRoot: other });
  assert.equal(badGit.type, "request.failed");
  assert.equal(gitCalls, 0);
  const alias = path.join(selected, "..", path.basename(selected));
  const accepted = await router.handle({ requestId: "good-run", type: "run.start", input: { repositoryRoot: alias, threadId: "thread-1", currentUserMessageId: "message-1", options: { mode: "auto", approvalPolicy: "safe" } } });
  assert.equal(accepted.type, "request.completed");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0][0], await import("node:fs/promises").then(({ realpath }) => realpath(selected)));
  const pause = await router.handle({ requestId: "pause-run", type: "run.pause", input: { repositoryRoot: alias, threadId: "thread-1", codingSessionId: "session-1" } });
  assert.equal(pause.type, "request.completed");
  assert.equal(pause.requestId, "pause-run");
  assert.equal(pause.repositoryRoot, dispatched[0][0]);
  assert.equal(dispatched.at(-1)[1].type, "run.pause");
  await rm(selected, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

test("main router serializes append with run ownership and rejects thread writes while a utility worker owns the repository", async () => {
  const root = await temporaryDirectory("hive-router-thread-owner-");
  const appData = await temporaryDirectory("hive-router-thread-owner-state-");
  let active = false;
  let releaseStart;
  let startEntered;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const enteredGate = new Promise((resolve) => { startEntered = resolve; });
  const thread = { schemaVersion: 1, id: "thread-owner", title: "Owner", createdAt: now, updatedAt: now, archived: false, messages: [], runs: [] };
  let appendCalls = 0;
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: {
      async dispatchAndWait() { active = true; startEntered(); await startGate; },
      async reconcileRepositoryRuns() {},
      hasActiveRuns() { return active; },
      hasActiveRepository() { return active; },
    },
    threadStoreFactory: () => ({
      async list() { return [structuredClone(thread)]; }, async load() { return structuredClone(thread); }, async create() { throw new Error("unused"); }, async save(value) { return value; }, async archive(value) { return value; },
      async appendMessage(_id, message) { appendCalls += 1; thread.messages.push(structuredClone(message)); return structuredClone(thread); },
    }),
    guardedGitFactory: () => { throw new Error("unused"); },
    clock: () => now,
  });
  await router.handle({ requestId: "owner-open", type: "repository.open", repositoryRoot: root });
  const start = router.handle({ requestId: "owner-start", type: "run.start", input: { repositoryRoot: root, threadId: thread.id, currentUserMessageId: "message-owner", options: { mode: "auto", approvalPolicy: "safe" } } });
  await enteredGate;
  const append = router.handle({ requestId: "owner-append", type: "thread.message.append", input: { threadId: thread.id, message: { id: "message-owner-2", role: "user", content: "must wait", createdAt: now } } });
  releaseStart();
  assert.equal((await start).type, "request.completed");
  const rejected = await append;
  assert.equal(rejected.type, "request.failed");
  assert.match(rejected.message, /active repository run|stop/i);
  assert.equal(appendCalls, 0);
  await rm(root, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

test("newer repository open supersedes a late older canonicalization and provenance is attached", async () => {
  const rootA = await temporaryDirectory("hive-open-a-");
  const rootB = await temporaryDirectory("hive-open-b-");
  const appData = await temporaryDirectory("hive-open-state-");
  let releaseA;
  const waitA = new Promise((resolve) => { releaseA = resolve; });
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: (root) => ({ async list() { return [{ schemaVersion: 1, id: root === rootB ? "thread-b" : "thread-a", title: root, createdAt: now, updatedAt: now, archived: false, messages: [], runs: [] }]; } }),
    canonicalize: async (root) => { if (root === rootA) await waitA; return root; },
    clock: () => now,
  });
  const older = router.handle({ requestId: "open-a", type: "repository.open", repositoryRoot: rootA });
  const newer = await router.handle({ requestId: "open-b", type: "repository.open", repositoryRoot: rootB });
  assert.equal(newer.type, "desktop.ready"); assert.equal(newer.requestId, "open-b"); assert.equal(newer.repositoryRoot, rootB);
  releaseA();
  const stale = await older;
  assert.equal(stale.type, "request.failed"); assert.equal(stale.requestId, "open-a");
  const threads = await router.handle({ requestId: "list-b", type: "thread.list" });
  assert.equal(threads.repositoryRoot, rootB); assert.equal(threads.requestId, "list-b"); assert.equal(threads.threads[0].id, "thread-b");
  await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

test("repository command provenance is snapshotted before dispatch and cannot be relabeled by a switch", async () => {
  const rootA = await temporaryDirectory("hive-provenance-a-");
  const rootB = await temporaryDirectory("hive-provenance-b-");
  const appData = await temporaryDirectory("hive-provenance-state-");
  let releaseList;
  const blockedList = new Promise((resolve) => { releaseList = resolve; });
  const broadcasts = [];
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: (root) => ({ async list() { if (root === rootA) await blockedList; return []; } }),
    canonicalize: async (root) => root,
    clock: () => now,
    onEvent: (event) => broadcasts.push(event),
  });
  await router.handle({ requestId: "open-a", type: "repository.open", repositoryRoot: rootA });
  const pendingA = router.handle({ requestId: "list-a", type: "thread.list" });
  await router.handle({ requestId: "open-b", type: "repository.open", repositoryRoot: rootB });
  releaseList();
  const resultA = await pendingA;
  assert.equal(resultA.type, "thread.listed"); assert.equal(resultA.repositoryRoot, rootA); assert.equal(resultA.requestId, "list-a");
  const broadcastA = broadcasts.find((event) => event.requestId === "list-a");
  assert.equal(broadcastA.repositoryRoot, rootA);
  await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

const providerMetadataMarker = "audit-only-marker";
const rejectedProviderMetadata = [
  ["base URL", { baseUrl: `https://gateway.invalid/v1?token=${providerMetadataMarker}` }],
  ["name", { name: `Bearer ${providerMetadataMarker}` }],
  ["default model", { defaultModel: `sk-${providerMetadataMarker}` }],
];

function providerConfigurationRouter(stateStore, onEvent = () => {}) {
  return new DesktopCommandRouter({
    stateStore,
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    onEvent,
    clock: () => now,
  });
}

for (const [label, fields] of rejectedProviderMetadata) {
  test(`provider.configure rejects secret-shaped ${label} at the command boundary`, () => {
    assert.throws(() => validateDesktopCommand({
      requestId: "configure-rejected",
      type: "provider.configure",
      input: { id: "gateway", name: "Gateway", kind: "openai-compatible", authType: "none", approved: true, ...fields },
    }), (error) => {
      assert.match(error.message, /secret-shaped/i);
      assert.equal(error.message.includes(providerMetadataMarker), false);
      return true;
    });
  });

  test(`provider.configure rejected ${label} cannot poison saved settings`, async (t) => {
    for (const updating of [false, true]) {
      await t.test(updating ? "update preserves the previous disk bytes" : "fresh rejection creates no state file or row", async (t) => {
        const appData = await temporaryDirectory("hive-provider-configure-rejected-");
        t.after(() => rm(appData, { recursive: true, force: true }));
        const stateStore = new JsonDesktopAppStateStore(appData, { clock: () => now });
        const stateFile = path.join(appData, "desktop-state.json");
        const events = [];
        const router = providerConfigurationRouter(stateStore, (event) => events.push(event));
        const input = { id: "gateway", name: "Gateway", kind: "openai-compatible", authType: "none", approved: true, baseUrl: "https://gateway.invalid/v1", defaultModel: "vendor/model:latest" };
        if (updating) {
          assert.equal((await router.handle({ requestId: "configure-initial", type: "provider.configure", input })).type, "provider.changed");
          events.length = 0;
        }
        const before = updating ? await readFile(stateFile) : null;
        const failed = await router.handle({ requestId: "configure-rejected", type: "provider.configure", input: { ...input, ...fields } });
        assert.equal(failed.type, "request.failed");
        assert.equal(failed.recoverable, true);
        assert.equal(JSON.stringify([failed, ...events]).includes(providerMetadataMarker), false);
        assert.deepEqual(events, []);
        if (updating) assert.deepEqual(await readFile(stateFile), before, "rejected metadata must not change saved bytes");
        else await assert.rejects(readFile(stateFile), { code: "ENOENT" });
        const expected = updating ? { ...input, configured: true } : undefined;
        assert.deepEqual((await stateStore.load()).providers.find((provider) => provider.id === input.id), expected);
        for (const reader of [router, providerConfigurationRouter(new JsonDesktopAppStateStore(appData, { clock: () => now }), (event) => events.push(event))]) {
          const listed = await reader.handle({ requestId: "list-after-rejection", type: "provider.list" });
          assert.equal(listed.type, "provider.listed");
          assert.deepEqual(listed.providers.find((provider) => provider.id === input.id), expected);
          assert.equal(JSON.stringify([listed, ...events]).includes(providerMetadataMarker), false);
        }
      });
    }
  });
}

test("provider.configure keeps metadata limits and exact fields at both boundaries", () => {
  const input = { id: "gateway", name: "Gateway", kind: "openai-compatible", authType: "api-key", approved: true };
  for (const fields of [{ name: "n".repeat(201) }, { defaultModel: "m".repeat(257) }, { baseUrl: `https://gateway.invalid/${"p".repeat(2_048)}` }, { baseUrl: "file:///gateway" }]) {
    assert.throws(() => validateDesktopCommand({ requestId: "configure-invalid", type: "provider.configure", input: { ...input, ...fields } }));
    assert.throws(() => validateDesktopEvent({ type: "provider.changed", timestamp: now, provider: { ...input, configured: false, ...fields } }));
  }
  for (const fields of [{ configured: true }, { secret: providerMetadataMarker }]) {
    assert.throws(() => validateDesktopCommand({ requestId: "configure-extra", type: "provider.configure", input: { ...input, ...fields } }));
  }
});

test("provider.configure preserves valid metadata, loopback URLs, and boundary lengths", async (t) => {
  const appData = await temporaryDirectory("hive-provider-configure-valid-");
  t.after(() => rm(appData, { recursive: true, force: true }));
  const stateStore = new JsonDesktopAppStateStore(appData, { clock: () => now });
  const events = [];
  const router = providerConfigurationRouter(stateStore, (event) => events.push(event));
  const cases = [
    { id: "gateway", name: "Gateway", kind: "openai-compatible", authType: "api-key", approved: true, baseUrl: "https://Gateway.invalid:443/v1/?region=us%2Feast#models", defaultModel: "vendor/model:latest" },
    { id: "gateway", name: "Updated gateway", kind: "openai-compatible", authType: "bearer", approved: true, baseUrl: "http://gateway.invalid:8080/v1", defaultModel: "vendor/next-model" },
    { id: "ollama", name: "Ollama (local)", kind: "ollama", authType: "none", approved: true, baseUrl: "http://127.0.0.1:11434", defaultModel: "llama3.2:latest" },
    { id: "local-host", name: "Local host", kind: "local", authType: "none", approved: true, baseUrl: "http://localhost:8080/v1" },
    { id: "local-ipv6", name: "IPv6 local", kind: "local", authType: "none", approved: true, baseUrl: "http://[::1]:8080/v1?mode=local" },
    { id: "oauth-provider", name: "Token usage", kind: "oauth", authType: "oauth", approved: false },
    { id: "metadata-limits", name: "n".repeat(200), kind: "custom", authType: "none", approved: true, baseUrl: `https://gateway.invalid/${"p".repeat(2_048 - "https://gateway.invalid/".length)}`, defaultModel: "m".repeat(256) },
  ];
  for (const input of cases) {
    const command = { requestId: "configure-valid", type: "provider.configure", input };
    assert.deepEqual(validateDesktopCommand(command), command);
    const changed = await router.handle(command);
    assert.equal(changed.type, "provider.changed");
    const expected = { ...input, configured: input.approved && input.authType === "none" };
    assert.deepEqual(changed.provider, expected);
    assert.deepEqual(JSON.parse(await readFile(path.join(appData, "desktop-state.json"), "utf8")).providers.find((provider) => provider.id === input.id), expected);
    const listed = await providerConfigurationRouter(new JsonDesktopAppStateStore(appData, { clock: () => now })).handle({ requestId: "list-valid", type: "provider.list" });
    assert.equal(listed.type, "provider.listed");
    assert.deepEqual(listed.providers.find((provider) => provider.id === input.id), expected);
    assert.deepEqual(events.at(-1), changed);
  }
});

test("provider configured state is derived from vault across set, remove, list, and reopen", async () => {
  const appData = await temporaryDirectory("hive-provider-sync-");
  const stateStore = new JsonDesktopAppStateStore(appData, { clock: () => now });
  await stateStore.save({ ...stateStore.defaultState(), providers: [{ id: "provider-1", name: "Provider", kind: "openai", authType: "api-key", approved: true, configured: true }] });
  let configured = false;
  const vault = {
    async list() { return configured ? [{ providerId: "provider-1", kind: "api-key", configured: true, updatedAt: now }] : []; },
    async metadata(id) { return configured && id === "provider-1" ? { providerId: id, kind: "api-key", configured: true, updatedAt: now } : null; },
    async set(input) { configured = true; return { providerId: input.providerId, kind: input.kind, configured: true, updatedAt: now }; },
    async replace(input) { configured = true; return { providerId: input.providerId, kind: input.kind, configured: true, updatedAt: now }; },
    async remove() { configured = false; }, async test(input) { return { providerId: input.providerId, ok: configured, message: "tested" }; },
  };
  const makeRouter = () => new DesktopCommandRouter({ stateStore, credentialVault: vault, workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } }, guardedGitFactory: () => { throw new Error("unused"); }, clock: () => now });
  let event = await makeRouter().handle({ requestId: "list-1", type: "provider.list" });
  assert.equal(event.providers[0].configured, false);
  await makeRouter().handle({ requestId: "set", type: "credential.set", input: { providerId: "provider-1", kind: "api-key", secret: "value" } });
  event = await makeRouter().handle({ requestId: "list-2", type: "provider.list" });
  assert.equal(event.providers[0].configured, true);
  await makeRouter().handle({ requestId: "remove", type: "credential.remove", input: { providerId: "provider-1", kind: "api-key" } });
  event = await makeRouter().handle({ requestId: "list-3", type: "provider.list" });
  assert.equal(event.providers[0].configured, false);
  assert.equal((await stateStore.load()).providers[0].configured, false);
  await rm(appData, { recursive: true, force: true });
});

test("credential mutation queue prevents stale remove snapshot from overwriting later set", async () => {
  const appData = await temporaryDirectory("hive-provider-interleave-");
  const stateStore = new JsonDesktopAppStateStore(appData, { clock: () => now });
  await stateStore.save({ ...stateStore.defaultState(), providers: [{ id: "provider-1", name: "Provider", kind: "openai", authType: "api-key", approved: true, configured: true }] });
  let configured = true; let releaseSnapshot; let snapshotCaptured;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  const captured = new Promise((resolve) => { snapshotCaptured = resolve; });
  let delayNextList = false;
  const vault = {
    async list() { const snapshot = configured; if (delayNextList) { delayNextList = false; snapshotCaptured(); await snapshotGate; } return snapshot ? [{ providerId: "provider-1", kind: "api-key", configured: true, updatedAt: now }] : []; },
    async metadata() { return configured ? { providerId: "provider-1", kind: "api-key", configured: true } : null; },
    async set(input) { configured = true; return { providerId: input.providerId, kind: input.kind, configured: true, updatedAt: now }; }, async replace(input) { return this.set(input); },
    async remove() { configured = false; delayNextList = true; }, async test() { return { providerId: "provider-1", ok: configured, message: "ok" }; },
  };
  const router = new DesktopCommandRouter({ stateStore, credentialVault: vault, workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } }, guardedGitFactory: () => { throw new Error("unused"); }, clock: () => now });
  const removing = router.handle({ requestId: "remove-race", type: "credential.remove", input: { providerId: "provider-1", kind: "api-key" } });
  await captured;
  const setting = router.handle({ requestId: "set-race", type: "credential.set", input: { providerId: "provider-1", kind: "api-key", secret: "new-value" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(configured, false);
  releaseSnapshot();
  await Promise.all([removing, setting]);
  assert.equal(configured, true);
  const reopened = await router.handle({ requestId: "reopen-list", type: "provider.list" });
  assert.equal(reopened.providers[0].configured, true);
  assert.equal((await stateStore.load()).providers[0].configured, true);
  await rm(appData, { recursive: true, force: true });
});

test("models.list returns a sorted catalog for a known provider", async () => {
  const appData = await temporaryDirectory("hive-models-list-");
  const stateStore = new JsonDesktopAppStateStore(appData, { clock: () => now });
  await stateStore.save({
    ...stateStore.defaultState(),
    providers: [{ id: "anthropic", name: "Anthropic", kind: "anthropic", authType: "api-key", approved: true, configured: true }],
  });
  const router = new DesktopCommandRouter({
    stateStore,
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait() {}, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    clock: () => now,
  });
  const event = await router.handle({ requestId: "models-1", type: "models.list", providerId: "anthropic" });
  assert.equal(event.type, "models.listed");
  assert.equal(event.providerId, "anthropic");
  assert.ok(event.models.some((model) => String(model.id).includes("claude")));
  const ids = event.models.map((model) => model.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  const missing = await router.handle({ requestId: "models-2", type: "models.list", providerId: "missing-provider" });
  assert.equal(missing.type, "request.failed");
  await rm(appData, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shell window registry (pop-out coder window)
// ---------------------------------------------------------------------------

function mockShellWindow() {
  const listeners = new Map();
  const sent = [];
  const window = {
    destroyed: false,
    focused: 0,
    closed: 0,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
    on(event, listener) { listeners.set(event, listener); },
    focus() { this.focused += 1; },
    show() {},
    close() { this.closed += 1; this.destroyed = true; listeners.get("closed")?.(); },
    isDestroyed() { return this.destroyed; },
    sent,
  };
  return window;
}

test("ShellWindowRegistry enforces one window per view, focuses existing ones, and publishes views", () => {
  const created = [];
  const shellEvents = [];
  const registry = new ShellWindowRegistry({
    create: (view) => { const window = mockShellWindow(); created.push({ view, window }); return window; },
    onShellEvent: (event) => shellEvents.push(event),
    eventChannel: "hive-desktop:event",
    clock: () => now,
  });

  registry.open("chat");
  registry.open("coder");
  assert.equal(created.length, 2, "one window per view");

  const coderBefore = created.find((entry) => entry.view === "coder").window;
  registry.open("coder");
  assert.equal(created.length, 2, "second coder open focuses instead of creating");
  assert.equal(coderBefore.focused, 1);

  const viewEvents = shellEvents.filter((event) => event.type === "shell.views");
  assert.deepEqual(viewEvents.at(-1).views, ["chat", "coder"]);
});

test("ShellWindowRegistry broadcasts to every live window and drops destroyed ones", () => {
  const created = [];
  const registry = new ShellWindowRegistry({
    create: (view) => { const window = mockShellWindow(); created.push({ view, window }); return window; },
    onShellEvent: () => {},
    eventChannel: "hive-desktop:event",
    clock: () => now,
  });
  const chat = registry.open("chat");
  const coder = registry.open("coder");

  registry.broadcast({ type: "request.completed", timestamp: now, requestId: "request-1" });
  assert.equal(chat.sent.length, 1);
  assert.equal(coder.sent.length, 1);
  assert.equal(coder.sent[0][0], "hive-desktop:event");

  coder.destroyed = true;
  registry.broadcast({ type: "request.completed", timestamp: now, requestId: "request-2" });
  assert.equal(chat.sent.length, 2);
  assert.equal(coder.sent.length, 1, "destroyed windows stop receiving events");
  assert.deepEqual(registry.views(), ["chat"]);
});

test("ShellWindowRegistry refuses to close the last window and republishes after closes", () => {
  const created = [];
  const shellEvents = [];
  const registry = new ShellWindowRegistry({
    create: (view) => { const window = mockShellWindow(); created.push({ view, window }); return window; },
    onShellEvent: (event) => shellEvents.push(event),
    eventChannel: "hive-desktop:event",
    clock: () => now,
  });
  registry.open("chat");
  assert.throws(() => registry.close("chat"), /last shell window/i);

  registry.open("coder");
  registry.close("coder");
  const viewEvents = shellEvents.filter((event) => event.type === "shell.views");
  assert.deepEqual(viewEvents.at(-1).views, ["chat"]);
  assert.throws(() => registry.close("coder"), /No shell window/i);
});

test("ShellWindowRegistry focusFirstOrCreate focuses a live window or recreates one when none exist", () => {
  const created = [];
  const registry = new ShellWindowRegistry({
    create: (view) => { const window = mockShellWindow(); created.push({ view, window }); return window; },
    onShellEvent: () => {},
    eventChannel: "hive-desktop:event",
    clock: () => now,
  });

  // No windows yet: a second-instance relaunch must recreate the chat surface.
  const recreated = registry.focusFirstOrCreate("chat");
  assert.equal(created.length, 1, "creates a window when the registry is empty");
  assert.equal(created[0].view, "chat");
  assert.equal(recreated, created[0].window);

  // With a live window: relaunch focuses it instead of creating another.
  const focused = registry.focusFirstOrCreate("chat");
  assert.equal(created.length, 1, "does not create a second window");
  assert.equal(focused, created[0].window);
  assert.equal(created[0].window.focused, 1);

  // After the window is destroyed, relaunch recreates it again.
  created[0].window.close();
  registry.focusFirstOrCreate("chat");
  assert.equal(created.length, 2, "recreates after the last window is destroyed");
});

test("shell commands and the views event validate strictly", () => {
  assert.equal(validateDesktopCommand({ requestId: "request-1", type: "shell.open-view", view: "coder" }).type, "shell.open-view");
  assert.equal(validateDesktopCommand({ requestId: "request-1", type: "shell.close-view", view: "chat" }).type, "shell.close-view");
  assert.throws(() => validateDesktopCommand({ requestId: "request-1", type: "shell.open-view", view: "terminal" }), /view is invalid/);
  assert.throws(() => validateDesktopCommand({ requestId: "request-1", type: "shell.open-view" }), /unexpected or missing fields/);
  assert.equal(validateDesktopEvent({ type: "shell.views", timestamp: now, views: ["chat", "coder"] }).type, "shell.views");
  assert.throws(() => validateDesktopEvent({ type: "shell.views", timestamp: now, views: [] }), /views are invalid/);
  assert.throws(() => validateDesktopEvent({ type: "shell.views", timestamp: now, views: ["chat", "coder", "chat"] }), /views are invalid/);
});

test("workspace commands and events validate strictly", () => {
  assert.equal(validateDesktopCommand({ requestId: "request-1", type: "workspace.list", input: { repositoryRoot: repoRoot } }).type, "workspace.list");
  assert.equal(validateDesktopCommand({ requestId: "request-1", type: "workspace.list", input: { repositoryRoot: repoRoot, path: "src" } }).type, "workspace.list");
  assert.equal(validateDesktopCommand({ requestId: "request-1", type: "workspace.read", input: { repositoryRoot: repoRoot, path: "src/main.js" } }).type, "workspace.read");
  assert.equal(validateDesktopCommand({ requestId: "request-1", type: "workspace.pick" }).type, "workspace.pick");
  assert.throws(() => validateDesktopCommand({ requestId: "request-1", type: "workspace.list", input: { repositoryRoot: repoRoot, path: "../escape" } }), /invalid/);
  assert.throws(() => validateDesktopCommand({ requestId: "request-1", type: "workspace.read", input: { repositoryRoot: repoRoot } }), /unexpected or missing fields/);
  assert.throws(() => validateDesktopCommand({ requestId: "request-1", type: "workspace.pick", extra: true }), /unexpected or missing fields/);
  assert.equal(validateDesktopEvent({
    type: "workspace.listed",
    timestamp: now,
    listing: { repositoryRoot: repoRoot, path: "", truncated: false, entries: [{ name: "src", path: "src", kind: "dir" }] },
  }).type, "workspace.listed");
  assert.equal(validateDesktopEvent({
    type: "workspace.file",
    timestamp: now,
    file: { repositoryRoot: repoRoot, path: "src/main.js", content: "ok", truncated: false, languageHint: "js" },
  }).type, "workspace.file");
  assert.equal(validateDesktopEvent({ type: "workspace.picked", timestamp: now, path: null }).type, "workspace.picked");
  assert.throws(() => validateDesktopEvent({
    type: "workspace.listed",
    timestamp: now,
    listing: { repositoryRoot: repoRoot, path: "../x", truncated: false, entries: [] },
  }), /invalid/);
});

test("coder.handoff creates a thread, appends the brief, and starts a run", async () => {
  const root = await temporaryDirectory("hive-handoff-");
  const appData = await temporaryDirectory("hive-handoff-state-");
  const dispatched = [];
  const threads = [];
  const threadStore = {
    async list() { return threads; },
    async create(input) { const thread = { schemaVersion: 1, id: input.id ?? `thread-${threads.length + 1}`, title: input.title, createdAt: now, updatedAt: now, archived: false, messages: [], runs: [] }; threads.push(thread); return thread; },
    async load(id) { return threads.find((thread) => thread.id === id) ?? null; },
    async save(thread) { return thread; },
    async appendMessage(id, message) { const thread = threads.find((entry) => entry.id === id); thread.messages.push(message); return thread; },
    async mutate() { throw new Error("unused"); },
    async archive() { throw new Error("unused"); },
  };
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait(rootArg, command) { dispatched.push(command); }, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: () => threadStore,
    chatService: { async load() { return { id: "chat-1789200000000-ab12", cwd: root, role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [ { id: "msg-0", role: "user", content: "q", at: now }, { id: "msg-1", role: "assistant", content: "Step one. Step two.", at: now } ] }; } },
    clock: () => now,
  });
  await router.handle({ requestId: "open", type: "repository.open", repositoryRoot: root });
  const event = await router.handle({ requestId: "r-9", type: "coder.handoff", input: { conversationId: "chat-1789200000000-ab12", sourceMessageId: "msg-1" } });
  assert.equal(event.type, "coder.handoff.started");
  assert.ok(event.threadId);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "run.start");
  assert.equal(dispatched[0].input.currentUserMessageId, event.userMessageId);
  assert.deepEqual(dispatched[0].input.options, { mode: "auto", approvalPolicy: "changes" });
  assert.equal(threads[0].messages[0].content.includes("Step one. Step two."), true);
  await rm(root, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

test("coder.handoff clamps a long assistant answer so the brief fits the thread message cap", async () => {
  const root = await temporaryDirectory("hive-handoff-long-");
  const appData = await temporaryDirectory("hive-handoff-long-state-");
  const dispatched = [];
  const threads = [];
  const threadStore = {
    async list() { return threads; },
    async create(input) { const thread = { schemaVersion: 1, id: input.id ?? `thread-${threads.length + 1}`, title: input.title, createdAt: now, updatedAt: now, archived: false, messages: [], runs: [] }; threads.push(thread); return thread; },
    async load(id) { return threads.find((thread) => thread.id === id) ?? null; },
    async save(thread) { return thread; },
    async appendMessage(id, message) { const thread = threads.find((entry) => entry.id === id); thread.messages.push(message); return thread; },
    async mutate() { throw new Error("unused"); },
    async archive() { throw new Error("unused"); },
  };
  const longAnswer = `Plan. ${"x".repeat(23_000)}`;
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait(rootArg, command) { dispatched.push(command); }, async reconcileRepositoryRuns() {}, hasActiveRuns() { return false; }, hasActiveRepository() { return false; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: () => threadStore,
    chatService: { async load() { return { id: "chat-1789200000000-ab12", cwd: root, role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [ { id: "msg-0", role: "user", content: "q", at: now }, { id: "msg-1", role: "assistant", content: longAnswer, at: now } ] }; } },
    clock: () => now,
  });
  await router.handle({ requestId: "open", type: "repository.open", repositoryRoot: root });
  const event = await router.handle({ requestId: "r-11", type: "coder.handoff", input: { conversationId: "chat-1789200000000-ab12", sourceMessageId: "msg-1" } });
  assert.equal(event.type, "coder.handoff.started");
  assert.equal(dispatched.length, 1);
  assert.ok(threads[0].messages[0].content.length <= 20_000, `brief clamped to the 20,000-char thread cap, got ${threads[0].messages[0].content.length}`);
  assert.equal(threads[0].messages[0].content.startsWith("Implement the following plan produced by HiveBot in HiveChat:"), true);
  await rm(root, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});

test("coder.handoff refuses when a repository run is already active", async () => {
  const root = await temporaryDirectory("hive-handoff-busy-");
  const appData = await temporaryDirectory("hive-handoff-busy-state-");
  const dispatched = [];
  const threads = [];
  const threadStore = {
    async list() { return threads; },
    async create(input) { const thread = { schemaVersion: 1, id: input.id ?? `thread-${threads.length + 1}`, title: input.title, createdAt: now, updatedAt: now, archived: false, messages: [], runs: [] }; threads.push(thread); return thread; },
    async load(id) { return threads.find((thread) => thread.id === id) ?? null; },
    async save(thread) { return thread; },
    async appendMessage(id, message) { const thread = threads.find((entry) => entry.id === id); thread.messages.push(message); return thread; },
    async mutate() { throw new Error("unused"); },
    async archive() { throw new Error("unused"); },
  };
  const router = new DesktopCommandRouter({
    stateStore: new JsonDesktopAppStateStore(appData, { clock: () => now }),
    credentialVault: { async list() { return []; }, async metadata() { return null; }, async set() {}, async replace() {}, async remove() {}, async test() {} },
    workerSupervisor: { async dispatchAndWait(rootArg, command) { dispatched.push(command); }, async reconcileRepositoryRuns() {}, hasActiveRuns() { return true; }, hasActiveRepository() { return true; } },
    guardedGitFactory: () => { throw new Error("unused"); },
    threadStoreFactory: () => threadStore,
    chatService: { async load() { return { id: "chat-1789200000000-ab12", cwd: root, role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] }; } },
    clock: () => now,
  });
  await router.handle({ requestId: "open", type: "repository.open", repositoryRoot: root });
  const failed = await router.handle({ requestId: "r-10", type: "coder.handoff", input: { conversationId: "chat-1789200000000-ab12", sourceMessageId: "msg-1" } });
  assert.equal(failed.type, "request.failed");
  assert.match(failed.message, /active Hive Code run/i);
  assert.equal(dispatched.length, 0);
  assert.equal(threads.length, 0);
  await rm(root, { recursive: true, force: true }); await rm(appData, { recursive: true, force: true });
});
