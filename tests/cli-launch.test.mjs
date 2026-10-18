import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCoderCli } from "../dist/cli.js";
import { maybeLaunchSession } from "../dist/tui/launch.js";
import { CliConversationStore } from "../dist/tui/conversations.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { ConfigStore } from "../dist/config.js";

async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hive-launch-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function event(type, payload, sequence = 1) {
  return { schemaVersion: 1, id: `event-${sequence}`, sequence, sessionId: "coding-fixture", timestamp: "2026-10-16T00:00:00.000Z", type, payload };
}

function completed(text = "Verified fixture response") {
  return { id: "coding-fixture", status: "completed", finalReport: { result: text } };
}

test("quoted prompts open an interactive session with startup commands", async (t) => {
  const cwd = await workspace(t);
  const starts = [];
  const result = await runCoderCli(["Inspect this repository"], {
    cwd, isTTY: true,
    startTui: async (...args) => { starts.push(args); },
    tuiSessionRunner: async () => assert.fail("interactive launch must not run headless"),
  });
  assert.equal(result.output, "__TUI_STARTED__");
  assert.deepEqual(starts, [[cwd, { initialCommands: ["Inspect this repository"], initialMode: undefined }]]);
});

test("fork-session restores then forks before applying conversation-local model and prompt overrides", async (t) => {
  const cwd = await workspace(t);
  let started;
  const result = await runCoderCli(["--resume", "cli-fixture", "--fork-session", "--model", "fixture/model", "Try another approach"], {
    cwd, isTTY: true, startTui: async (_cwd, options) => { started = options.initialCommands; },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(started, ["/resume cli-fixture", "/fork", "/model fixture/model", "Try another approach"]);
  const invalid = await runCoderCli(["--fork-session", "-p", "missing session"], { cwd, isTTY: false });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.output, /requires --resume/);
});

test("launch plan mode is invocation-local, including resumed interactive sessions", async (t) => {
  const cwd = await workspace(t);
  let started;
  await runCoderCli(["--plan", "-r", "cli-fixture", "-m", "fixture/org/model", "--image", "with spaces.png", "Plan the feature"], {
    cwd, isTTY: true, startTui: async (_cwd, options) => { started = options; },
  });
  assert.deepEqual(started, { initialMode: "plan", initialCommands: ["/resume cli-fixture", "/model fixture/org/model", "/image with spaces.png", "Plan the feature"] });
  assert.equal(await new ConfigStore(cwd).getMode(), "guarded");
});

test("interactive review launch invokes a read-only review run rather than the completed-run marker", async (t) => {
  const cwd = await workspace(t);
  const starts = [];
  for (const prompt of [[], ["Inspect authorization"]]) {
    const result = await runCoderCli(["--review", ...prompt], { cwd, isTTY: true, startTui: async (_cwd, options) => { starts.push(options); } });
    assert.equal(result.exitCode, 0);
  }
  assert.deepEqual(starts, [
    { initialMode: "review", initialCommands: ["/review run"] },
    { initialMode: "review", initialCommands: ["/review run Inspect authorization"] },
  ]);
});

test("-p runs headlessly even on a terminal and persists real conversation messages", async (t) => {
  const cwd = await workspace(t);
  const requests = [];
  const result = await runCoderCli(["-p", "Inspect the parser"], {
    cwd, isTTY: true,
    startTui: async () => assert.fail("-p must not start the TUI"),
    tuiSessionRunner: async (request) => { requests.push(request); request.onText("Parser checked"); return completed(); },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Parser checked/);
  assert.equal(requests[0].approvalPolicy, "safe");
  assert.equal(requests[0].requestToolPermission, undefined);
  const records = await new CliConversationStore(cwd).list();
  const saved = await new CliConversationStore(cwd).load(records.records[0].id);
  assert.equal(saved.messages[0].content, "Inspect the parser");
  assert.match(saved.messages[1].content, /Parser checked/);
});

test("stdin is read only for explicit '-' and is bounded before the runner starts", async (t) => {
  const cwd = await workspace(t);
  let reads = 0;
  let objective;
  const options = {
    cwd, isTTY: false,
    readStdin: async () => { reads += 1; return "Read the piped task\n"; },
    tuiSessionRunner: async (request) => { objective = request.objective; return completed(); },
  };
  assert.equal(await maybeLaunchSession([], options), null);
  assert.equal(reads, 0);
  await runCoderCli(["-p", "Ordinary prompt"], options);
  assert.equal(reads, 0);
  const result = await runCoderCli(["-p", "-"], options);
  assert.equal(result.exitCode, 0);
  assert.equal(reads, 1);
  assert.equal(objective, "Read the piped task");
  const over = await runCoderCli(["-p", "-"], {
    ...options, readStdin: async () => "x".repeat(20_001),
    tuiSessionRunner: async () => assert.fail("oversized input must be rejected first"),
  });
  assert.equal(over.exitCode, 1);
  assert.match(over.output, /20,000/);
});

test("--cwd, slash-containing model IDs, repeat images, and plan posture reach the same runtime", async (t) => {
  const cwd = await workspace(t);
  const nested = path.join(cwd, "nested workspace");
  await fs.mkdir(nested);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO6kAAAAASUVORK5CYII=", "base64");
  await fs.writeFile(path.join(nested, "one image.png"), png);
  await fs.writeFile(path.join(nested, "two.png"), png);
  const registry = new ProviderRegistry(nested);
  await registry.add({ id: "fixture", name: "Fixture provider", kind: "local", authType: "none", defaultModel: "org/model" });
  await registry.approve("fixture");
  let request;
  const result = await runCoderCli(["--cwd", "nested workspace", "-p", "Plan this", "--model", "fixture/org/model", "--image", "one image.png", "--image", "two.png", "--plan", "--json"], {
    cwd, isTTY: false, tuiSessionRunner: async (options) => { request = options; return completed(); },
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(request.cwd, nested);
  assert.deepEqual(request.providerOverride, { providerId: "fixture", model: "org/model" });
  assert.equal(request.images.length, 2);
  assert.equal(request.codeMode, "plan");
  assert.equal(request.approvalPolicy, "safe");
  assert.equal(await new ConfigStore(nested).getMode(), "guarded");
  assert.deepEqual(await registry.getRoles(), {});
  assert.equal(result.output.includes(png.toString("base64")), false);
});

test("--review has a useful default objective and does not persist project mode", async (t) => {
  const cwd = await workspace(t);
  let request;
  const result = await runCoderCli(["--review", "-p"], { cwd, isTTY: false, tuiSessionRunner: async (options) => { request = options; return completed(); } });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(request.codeMode, "review");
  assert.equal(request.approvalPolicy, "safe");
  assert.match(request.objective, /Review the current changes/);
  assert.equal(await new ConfigStore(cwd).getMode(), "guarded");
});

test("resume and continue restore durable history and previous coding identity", async (t) => {
  const cwd = await workspace(t);
  const requests = [];
  const options = { cwd, isTTY: false, tuiSessionRunner: async (request) => { requests.push(request); return completed(`Result ${requests.length}`); } };
  const first = JSON.parse((await runCoderCli(["-p", "First task", "--json"], options)).output);
  const second = JSON.parse((await runCoderCli(["-r", first.conversationId, "-p", "Second task", "--json"], options)).output);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(requests[1].continuationId, "coding-fixture");
  assert.match(requests[1].context, /First task/);
  assert.match(requests[1].context, /Result 1/);
  const third = await runCoderCli(["-c", "-p", "Third task", "--json"], options);
  assert.equal(JSON.parse(third.output).conversationId, first.conversationId);
  const saved = await new CliConversationStore(cwd).load(first.conversationId);
  assert.equal(saved.messages.length, 6);
  assert.deepEqual(saved.history, ["Third task", "Second task", "First task"]);
});

test("JSON returns actual status while streaming JSON emits canonical events and redacted cumulative text", async (t) => {
  const cwd = await workspace(t);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  const lines = [];
  const result = await runCoderCli(["-p", "Inspect", "--output-format", "streaming-json"], {
    cwd, isTTY: false, stream: (line) => lines.push(JSON.parse(line)),
    tuiSessionRunner: async (request) => {
      request.onEvent(event("session.created", { objective: `Inspect ${secret}`, mode: "auto", approvalPolicy: "safe" }));
      request.onText("Found sk-");
      request.onText(`Found ${secret}`);
      return completed(`Safe result ${secret}`);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(lines[0].schemaVersion, 1);
  assert.equal(lines[0].type, "session.created");
  assert.equal(lines[0].payload.objective, "Inspect [REDACTED]");
  assert.deepEqual(lines.filter((line) => line.type === "assistant.text").map((line) => line.text), ["Found [REDACTED]"]);
  const final = JSON.parse(result.output);
  assert.equal(final.type, "result");
  assert.equal(final.status, "completed");
  assert.equal(final.sessionId, "coding-fixture");
  assert.equal(JSON.stringify(lines).includes(secret), false);
  assert.equal(result.output.includes(secret), false);
  assert.equal("tokens" in final, false);
  assert.equal("cost" in final, false);
});

test("streaming JSON remains valid NDJSON without a live stream callback", async (t) => {
  const cwd = await workspace(t);
  const result = await runCoderCli(["--print=Inspect", "--output-format=streaming-json"], {
    cwd, isTTY: false, tuiSessionRunner: async (request) => { request.onEvent(event("session.created", { objective: "Inspect", mode: "auto", approvalPolicy: "safe" })); request.onText("Observed"); return completed(); },
  });
  const lines = result.output.split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "session.created");
  assert.equal(lines[1].type, "assistant.text");
  assert.equal(lines.at(-1).type, "result");
});

test("paused approval produces exit 2 without granting permission", async (t) => {
  const cwd = await workspace(t);
  const result = await runCoderCli(["-p", "Edit a file", "--json"], {
    cwd, isTTY: false, tuiSessionRunner: async (request) => {
      assert.equal(request.approvalPolicy, "safe");
      assert.equal(request.requestToolPermission, undefined);
      request.onEvent(event("session.paused", { reason: "Tool approval required: write_file src/a.ts" }));
      return { id: "coding-fixture", status: "paused" };
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output).status, "paused");
});

test("runner failure returns exit 1 and its redacted error", async (t) => {
  const cwd = await workspace(t);
  const result = await runCoderCli(["-p", "Inspect", "--json"], { cwd, isTTY: false, tuiSessionRunner: async () => { throw new Error("Failed API_KEY=private-value"); } });
  assert.equal(result.exitCode, 1);
  const final = JSON.parse(result.output);
  assert.equal(final.status, "failed");
  assert.match(final.text, /Failed API_KEY=\[REDACTED\]/);
  assert.equal(result.output.includes("private-value"), false);
});

test("AbortSignal reaches the runner, returns exit 130, and removes its listener", async (t) => {
  const cwd = await workspace(t);
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  const result = await runCoderCli(["-p", "Inspect", "--json"], {
    cwd, isTTY: false, signal: controller.signal,
    tuiSessionRunner: (request) => new Promise((resolve) => {
      request.signal.addEventListener("abort", () => resolve({ id: "coding-fixture", status: "cancelled" }), { once: true });
      controller.abort("test cancellation");
    }),
  });
  assert.equal(result.exitCode, 130);
  assert.equal(JSON.parse(result.output).status, "cancelled");
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
});

test("headless prompts beginning with slash stay user text", async (t) => {
  const cwd = await workspace(t);
  let objective;
  const result = await runCoderCli(["-p", "/mode autonomous"], { cwd, isTTY: false, tuiSessionRunner: async (request) => { objective = request.objective; return completed(); } });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(objective, "/mode autonomous");
  assert.equal(await new ConfigStore(cwd).getMode(), "guarded");
});

test("reserved commands retain their existing dispatcher", async (t) => {
  const cwd = await workspace(t);
  for (const command of ["code", "run", "chat", "providers", "mcp", "scout", "help"]) {
    assert.equal(await maybeLaunchSession([command, "--json"], { cwd, isTTY: false }), null);
  }
  const help = await runCoderCli(["help"], { cwd, isTTY: false });
  assert.equal(help.exitCode, 0);
  assert.match(help.output, /hive code/);
});

test("invalid launch options fail before touching the runner", async (t) => {
  const cwd = await workspace(t);
  for (const args of [["-p"], ["-r"], ["-p", "task", "--plan", "--review"], ["-p", "task", "--output-format", "xml"], ["-p", "task", "--unknown"], ["-p", "task", "-r", "id", "-c"]]) {
    const result = await runCoderCli(args, { cwd, isTTY: false, tuiSessionRunner: async () => assert.fail("invalid options cannot start a runner") });
    assert.equal(result.exitCode, 1, args.join(" "));
  }
  const model = await runCoderCli(["-p", "task", "--model", "unconfigured/model"], { cwd, isTTY: false, tuiSessionRunner: async () => assert.fail("unapproved model cannot run") });
  assert.equal(model.exitCode, 1);
  assert.match(model.output, /approved/);
});
