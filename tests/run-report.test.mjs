import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HIVE_RUN_REPORT_SCHEMA_VERSION,
  createHiveRunReport,
  formatHiveRunReportMarkdown,
  writeHiveRunReport,
} from "../dist/coding/report.js";
import {
  COMMERCIAL_ENTITLEMENTS,
  PLAN_IDS,
  isCommercialEntitlement,
  isPlanId,
} from "../dist/commercial/contracts.js";
import { runCoderCli } from "../dist/cli.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";

function session(root, overrides = {}) {
  const record = {
    schemaVersion: 1,
    id: "session-report-1",
    objective: "Produce verified evidence",
    mode: "auto",
    approvalPolicy: "safe",
    status: "completed",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:01:00.000Z",
    repository: {
      root,
      capturedAt: "2026-07-11T00:00:00.000Z",
      baseCommit: "abc123",
      branch: "main",
      dirty: false,
      changedFiles: [],
    },
    tasks: [{
      id: "bee-001",
      sessionId: "session-report-1",
      role: "builder",
      title: "Build report",
      objective: "Build report",
      status: "completed",
      providerId: "provider-main",
      model: "model-1",
      dependencies: [],
      fileScope: ["src/report.ts"],
      expectedOutput: "report",
      completionCriteria: ["tests pass"],
      validationCommands: ["npm test"],
      depth: 0,
      attempt: 2,
      maxAttempts: 3,
      createdAt: "2026-07-11T00:00:00.000Z",
      startedAt: "2026-07-11T00:00:01.000Z",
      completedAt: "2026-07-11T00:00:30.000Z",
      tokenUsage: { input: 10, output: 5, total: 15 },
    }, {
      id: "bee-002",
      sessionId: "session-report-1",
      role: "fixer",
      title: "Fix validation",
      objective: "Fix validation",
      status: "completed",
      providerId: "provider-main",
      dependencies: ["bee-001"],
      fileScope: ["src/report.ts"],
      expectedOutput: "fix",
      completionCriteria: ["tests pass"],
      validationCommands: [],
      depth: 1,
      attempt: 1,
      maxAttempts: 2,
      createdAt: "2026-07-11T00:00:30.000Z",
      summary: "fixed",
    }],
    events: [{
      schemaVersion: 1,
      id: "evt-1",
      sequence: 1,
      sessionId: "session-report-1",
      timestamp: "2026-07-11T00:00:05.000Z",
      type: "command.started",
      payload: { commandId: "cmd-1", taskId: "bee-001", command: "npm test", cwd: root },
    }, {
      schemaVersion: 1,
      id: "evt-2",
      sequence: 2,
      sessionId: "session-report-1",
      timestamp: "2026-07-11T00:00:20.000Z",
      type: "command.output",
      payload: { commandId: "cmd-1", stream: "stdout", chunk: "sk-secret-value-123456789" },
    }, {
      schemaVersion: 1,
      id: "evt-3",
      sequence: 3,
      sessionId: "session-report-1",
      timestamp: "2026-07-11T00:00:21.000Z",
      type: "command.completed",
      payload: { commandId: "cmd-1", exitCode: 0, durationMs: 16000 },
    }],
    providerBindings: [],
    validationResults: [{
      id: "val-1",
      taskId: "bee-001",
      command: "npm test",
      status: "passed",
      startedAt: "2026-07-11T00:00:05.000Z",
      completedAt: "2026-07-11T00:00:21.000Z",
      exitCode: 0,
      output: "secret raw output",
    }],
    reviewResults: [{
      id: "review-1",
      status: "passed",
      summary: "clean",
      findings: [],
      completedAt: "2026-07-11T00:00:40.000Z",
    }],
    files: [{ path: "src/report.ts", operation: "created", taskId: "bee-001", recordedAt: "2026-07-11T00:00:15.000Z" }],
    finalReport: {
      result: "Completed \u001b[31msafely\u001b[0m",
      subagents: { total: 2, active: 0, working: 0, waiting: 0, blocked: 0, done: 2, completed: 2, failed: 0, cancelled: 0, skipped: 0 },
      filesChanged: ["src/report.ts"],
      validation: [{ label: "npm test", status: "passed" }],
      review: [],
      outstanding: [],
      completedAt: "2026-07-11T00:01:00.000Z",
    },
  };
  return { ...record, ...overrides };
}

test("commercial identifiers are stable, exhaustive, and reject unknown values", () => {
  assert.deepEqual(PLAN_IDS, ["community", "pro", "power", "team", "enterprise"]);
  assert.equal(COMMERCIAL_ENTITLEMENTS.length, 13);
  assert.equal(new Set(COMMERCIAL_ENTITLEMENTS).size, COMMERCIAL_ENTITLEMENTS.length);
  assert.equal(isPlanId("team"), true);
  assert.equal(isPlanId("unknown"), false);
  assert.equal(isCommercialEntitlement("remote_runs"), true);
  assert.equal(isCommercialEntitlement("local_runtime"), false);
});

test("report projection is deterministic, non-mutating, redacted, and factual", () => {
  const record = session("C:/work/repo");
  const before = JSON.stringify(record);
  const first = createHiveRunReport(record);
  const second = createHiveRunReport(record);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(record), before);
  assert.equal(first.schemaVersion, HIVE_RUN_REPORT_SCHEMA_VERSION);
  assert.equal(first.outcome.status, "completed");
  assert.equal(first.agents[0].retryCount, 1);
  assert.equal(first.usage.totalTokens.value, 15);
  assert.equal(first.usage.totalTokens.provenance, "provider_reported");
  assert.equal(first.usage.providerCost.provenance, "unavailable");
  assert.equal(first.engineering.fixerAttempts.length, 1);
  assert.equal(first.engineering.tests.length, 1);
  assert.equal(first.engineering.validation[0].output, "[OMITTED FROM REPORT]");
  assert.doesNotMatch(JSON.stringify(first), /sk-secret|secret raw output|C:\/work\/repo|\u001b/);
  assert.match(formatHiveRunReportMarkdown(first), /Provider cost: Unavailable/);

  first.usage.providerCost = {
    decimalValue: "0.00125",
    currency: "USD",
    unit: "currency",
    provenance: "estimated",
    source: "customer pricing catalog",
    pricingVersion: "2026-07",
    pricingTimestamp: "2026-07-01T00:00:00.000Z",
    confidence: "high",
    billingGrade: false,
  };
  assert.match(formatHiveRunReportMarkdown(first), /USD 0\.00125 \(estimated; source customer pricing catalog; pricing 2026\-07; confidence high\)/);
});

test("all material session outcomes and absent usage degrade honestly", () => {
  for (const [status, expected] of [
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["paused", "partial"],
    ["running", "running"],
    ["created", "pending"],
  ]) {
    const record = session("C:/repo", { status, tasks: [], finalReport: undefined });
    const report = createHiveRunReport(record);
    assert.equal(report.outcome.status, expected);
    assert.equal(report.usage.totalTokens.value, undefined);
    assert.equal(report.usage.totalTokens.provenance, "unavailable");
  }

  const legacy = session("C:/repo");
  delete legacy.tasks;
  delete legacy.events;
  delete legacy.validationResults;
  delete legacy.reviewResults;
  delete legacy.files;
  delete legacy.finalReport;
  const legacyReport = createHiveRunReport(legacy);
  assert.equal(legacyReport.agents.length, 0);
  assert.equal(legacyReport.usage.totalTokens.provenance, "unavailable");
});

test("report writer contains output, rejects traversal, and never overwrites", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-report-writer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const written = await writeHiveRunReport(root, "report.md", "evidence");
  assert.equal(await fs.readFile(written, "utf8"), "evidence");
  await assert.rejects(writeHiveRunReport(root, "report.md", "replace"), /refusing to overwrite/);
  await assert.rejects(writeHiveRunReport(root, "../escape.md", "escape"), /inside the repository root/);
  await assert.rejects(writeHiveRunReport(root, "missing/report.md", "missing"), /parent directory must already exist/);
  await assert.rejects(writeHiveRunReport(root, "report.md:secret", "stream"), /stream syntax/);
  await assert.rejects(writeHiveRunReport(root, "NUL.txt", "device"), /reserved filesystem name/);

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hive-report-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const link = path.join(root, "outside-link");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(writeHiveRunReport(root, "outside-link/report.md", "escape"), /parent escapes/);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }
});

test("CLI emits JSON and Markdown and safely rejects invalid sessions and output paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-report-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new CodingSessionStore(root).save(session(root));
  const json = await runCoderCli(["report", "session-report-1", "--json"], { cwd: root });
  assert.equal(json.exitCode, 0);
  assert.equal(JSON.parse(json.output).sessionId, "session-report-1");
  const markdown = await runCoderCli(["report", "session-report-1", "--markdown"], { cwd: root });
  assert.equal(markdown.exitCode, 0);
  assert.match(markdown.output, /^# HIVE run report:/);
  const invalid = await runCoderCli(["report", "../escape"], { cwd: root });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.output, /Invalid session id/);
  const traversal = await runCoderCli(["report", "session-report-1", "--output", "../escape.md"], { cwd: root });
  assert.equal(traversal.exitCode, 1);
  assert.match(traversal.output, /inside the repository root/);
});
