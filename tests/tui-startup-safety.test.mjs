import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TuiApp } from "../dist/tui/app.js";
import { CliConversationStore, newConversation } from "../dist/tui/conversations.js";
import { ProjectSessionService } from "../dist/projects/service.js";

async function until(condition) {
  for (let count = 0; count < 400 && !condition(); count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "Startup safety fixture did not settle");
}

for (const failed of ["/fork", "/model unavailable/model", "/image absent.png"]) {
  test(`failed startup ${failed} stops dependent prompts without continuing the source`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-startup-safety-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = { ...newConversation(root), codingSessionId: "missing-coding-source", codingStatus: "completed", messages: [{ role: "user", content: "Original source request" }] };
    await new CliConversationStore(root).save(source);
    const requests = [];
    const app = new TuiApp(root, { initialCommands: [`/resume ${source.id}`, failed, "Do not run after failed setup"], persistSession: false,
      readGitBranch: async () => undefined, runSession: async (request) => { requests.push(request); return { id: "explicit-next-turn", status: "completed" }; } });
    app.render = () => {};
    app.state.messageQueue = ["Queued during startup"];
    app.enqueueInitialCommands();
    await until(() => !app.activeRuntime && !app.commandPending && app.state.taskStatus === "error");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0);
    assert.equal(app.state.conversation.id, source.id);
    assert.equal(app.state.conversation.codingSessionId, source.codingSessionId);
    assert.equal(app.state.input, "Do not run after failed setup");
    assert.deepEqual(app.state.messageQueue, ["Queued during startup"]);
    assert.ok(app.state.transcript.some((line) => line.includes("dependent commands were stopped")));
    app.startCommand("/help");
    await until(() => !app.commandPending && !app.activeRuntime);
    assert.equal(requests.length, 0, "inspecting help must not release the paused prompt queue");
    app.state.messageQueue = [];
  });
}

test("a failed initial resume cannot run the prompt as a fresh coding session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-startup-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let ran = false;
  const app = new TuiApp(root, { initialCommands: ["/continue", "Do not run without the requested history"], persistSession: false,
    readGitBranch: async () => undefined, runSession: async () => { ran = true; } });
  app.render = () => {};
  app.enqueueInitialCommands();
  await until(() => !app.commandPending && app.state.taskStatus === "error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  assert.equal(app.state.conversation, undefined);
  assert.equal(app.state.input, "Do not run without the requested history");
});

for (const setup of ["/resume session-never-existed", "/model never-configured-provider/model"]) {
  test(`production shared startup ${setup} retains the task draft and never sends to the engine`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-shared-startup-"));
    let engineCalls = 0;
    const service = new ProjectSessionService({ catalogPath: path.join(root, "catalog.json"), engine: { start() { engineCalls++; assert.fail("failed shared setup must not start an engine"); } } });
    const app = new TuiApp(root, { projectService: service, initialCommands: [setup, "Do not execute after failed setup"], readGitBranch: async () => undefined });
    app.render = () => {};
    t.after(async () => { await app.projectClient?.close(); await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    app.sharedReady = app.hydrateSharedSession();
    await app.sharedReady;
    app.enqueueInitialCommands();
    await until(() => app.queueSuspended && !app.sharedSubmission);
    assert.equal(engineCalls, 0);
    assert.equal(app.state.input, "Do not execute after failed setup");
    assert.equal((await service.snapshot()).sessions.flatMap((session) => session.runs).length, 0);
    assert.ok(app.state.transcript.some((entry) => entry.includes("dependent commands were stopped")));
    await app.projectClient.refresh();
    assert.equal(app.state.input, "Do not execute after failed setup");
    assert.equal(engineCalls, 0);
  });
}
