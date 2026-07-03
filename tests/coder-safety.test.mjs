import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SafeRunner, parseSafeCommand, redactSecrets } from "../dist/runner.js";
import { WorktreeManager, branchNameForTask, isHiveCoderBranch, validateTaskId } from "../dist/worktree.js";


const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(process.cwd());

test("SafeRunner blocks destructive or shell-composed command input", async () => {
  const runner = new SafeRunner(REPO_ROOT);
  const result = await runner.runVerification("npm run lint && del package.json");
  assert.equal(result.passed, false);
  assert.match(result.output, /shell metacharacters/i);

  assert.throws(() => parseSafeCommand("npx rimraf dist"), /destructive/i);
  assert.throws(() => parseSafeCommand("git status"), /Only npm, npx, or node/i);
});

test("SafeRunner strips inherited environment and redacts secret-looking output", async () => {
  const previous = process.env.TEST_INHERITED_VAR;
  process.env.TEST_INHERITED_VAR = "sk-test-secret";
  try {
    const runner = new SafeRunner(REPO_ROOT);
    const result = await runner.runVerification("node -e console.log(process.env.TEST_INHERITED_VAR)");
    assert.equal(result.passed, true);
    assert.equal(result.output, "undefined");
  } finally {
    if (previous === undefined) delete process.env.TEST_INHERITED_VAR;
    else process.env.TEST_INHERITED_VAR = previous;
  }

  assert.equal(redactSecrets("API_KEY=abc Bearer token123"), "API_KEY=[REDACTED] Bearer [REDACTED]");
});

test("branch prefix and task id validation prevent unsafe branch names", () => {
  assert.equal(branchNameForTask("task_123"), "hive-coder/task_123");
  assert.equal(isHiveCoderBranch("hive-coder/task_123"), true);
  assert.equal(isHiveCoderBranch("main"), false);
  assert.equal(isHiveCoderBranch("feature/test"), false);
  assert.throws(() => validateTaskId("../main"), /Invalid taskId/i);
  assert.throws(() => validateTaskId("feature/test"), /Invalid taskId/i);
});

test("implementation does not contain git push", async () => {
  const files = [
    "src/worktree.ts",
    "src/runner.ts",
    "src/orchestrator.ts",
  ];
  const contents = await Promise.all(files.map((file) => readFile(path.join(REPO_ROOT, file), "utf8")));
  assert.equal(contents.join("\n").includes("git push"), false);
});



test("approve refuses to commit from a non-hive-coder branch worktree", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hive-coder-git-"));
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Hive Coder Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "test\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
    await execFileAsync("git", ["branch", "feature-review"], { cwd: repo });
    await mkdir(path.join(repo, ".hivemind", "worktrees"), { recursive: true });
    await execFileAsync("git", ["worktree", "add", path.join(repo, ".hivemind", "worktrees", "review"), "feature-review"], {
      cwd: repo,
    });

    const manager = new WorktreeManager(repo);
    await assert.rejects(
      () => manager.commitWorktree("review", "should not commit"),
      /Refusing to approve non-HIVE coder branch/i,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
