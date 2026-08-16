import assert from "node:assert/strict";
import test from "node:test";

import { DesktopCouncilService } from "../dist/desktop/council-service.js";

const clock = () => "2026-08-17T00:00:00.000Z";

function summary(overrides = {}) {
  return {
    status: "COMPLETE",
    reason: "All criteria satisfied; Sentinel PASS.",
    preset: "quick",
    runId: "hivebot-1789200000000-ab12",
    stages: [
      { agent: "Queen", role: "queen", output: "analysis", receipt: { role: "queen", providerId: "p1", model: "m1", promptTokens: 3, completionTokens: 4, totalTokens: 7, latencyMs: 5 }, phase: "Orchestrate & classify", attempt: 1 },
    ],
    totalTokens: 7,
    artifactDir: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12",
    runPath: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12\\run.json",
    reportPath: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12\\report.md",
    ...overrides,
  };
}

async function until(predicate, label, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("council service runs start -> stage -> completed and strips CLI-only summary fields", async () => {
  const events = [];
  const seen = [];
  const service = new DesktopCouncilService(
    () => "C:\\repo",
    (event) => events.push(event),
    {
      clock,
      runner: async (task, options) => {
        seen.push({ task, options });
        options.onStage({ type: "stage-started", agent: "Queen", attempt: 1 });
        options.onStage({ type: "stage-completed", agent: "Queen", attempt: 1, receipt: { role: "queen", providerId: "p1", model: "m1", totalTokens: 7 }, output: "analysis" });
        return { exitCode: 0, output: "stream", ...summary({ runId: options.runId, artifactDir: `C:\\repo\\.hivemind\\hivebot-runs\\${options.runId}` }) };
      },
    },
  );

  const runId = await service.start({ task: "refactor the parser", preset: "quick" });
  await until(() => events.some((event) => event.type === "council.completed"), "council.completed");

  assert.match(runId, /^hivebot-\d+-[0-9a-f]{4}$/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].task, "refactor the parser");
  assert.equal(seen[0].options.cwd, "C:\\repo");
  assert.equal(seen[0].options.preset, "quick");
  assert.equal(seen[0].options.runId, runId);

  const started = events.find((event) => event.type === "council.started");
  assert.equal(started.runId, runId);
  assert.equal(started.preset, "quick");

  const stages = events.filter((event) => event.type === "council.stage");
  assert.equal(stages.length, 2);
  assert.equal(stages[0].stage.type, "stage-started");

  const completed = events.find((event) => event.type === "council.completed");
  assert.equal(completed.runId, runId);
  assert.equal(completed.summary.status, "COMPLETE");
  assert.ok(!("exitCode" in completed.summary) && !("output" in completed.summary), "CLI-only fields do not cross the bridge");
});

test("council cancel aborts the active run and failures emit council.failed", async () => {
  const events = [];
  const service = new DesktopCouncilService(
    () => "C:\\repo",
    (event) => events.push(event),
    {
      clock,
      runner: (task, options) =>
        new Promise((_resolve, reject) => {
          options.onStage({ type: "stage-started", agent: "Queen", attempt: 1 });
          options.signal.addEventListener("abort", () => reject(new Error("council aborted")));
        }),
    },
  );

  const runId = await service.start({ task: "long task" });
  await until(() => events.some((event) => event.type === "council.stage"), "council.stage");
  service.cancel(runId);
  await until(() => events.some((event) => event.type === "council.failed"), "council.failed");
  const failed = events.find((event) => event.type === "council.failed");
  assert.equal(failed.runId, runId);
  assert.equal(failed.message, "council aborted");
  assert.ok(!events.some((event) => event.type === "council.completed"));
});

test("runner crashes surface as recoverable-looking council.failed messages", async () => {
  const events = [];
  const service = new DesktopCouncilService(
    () => "C:\\repo",
    (event) => events.push(event),
    { clock, runner: async () => { throw new Error("artifacts unwritable"); } },
  );
  await service.start({ task: "boom" });
  await until(() => events.some((event) => event.type === "council.failed"), "council.failed");
  assert.equal(events.find((event) => event.type === "council.failed").message, "artifacts unwritable");
});
