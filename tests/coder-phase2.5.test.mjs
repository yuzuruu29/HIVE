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

test("WorktreeManager.commitWorktree blocks forbidden files and requires scoped staging", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hive-coder-git-2-"));
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Hive Coder Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "test\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
    await execFileAsync("git", ["branch", "hive-coder/test101"], { cwd: repo });
    await mkdir(path.join(repo, ".hivemind", "worktrees"), { recursive: true });
    const wtPath = path.join(repo, ".hivemind", "worktrees", "test101");
    await execFileAsync("git", ["worktree", "add", wtPath, "hive-coder/test101"], {
      cwd: repo,
    });

    const manager = new WorktreeManager(repo);

    // Empty staging attempt
    await assert.rejects(
      () => manager.commitWorktree("test101", "msg", []),
      /No files declared to commit/i,
    );

    // Blocked paths
    await assert.rejects(
      () => manager.commitWorktree("test101", "msg", [".env.local"]),
      /Blocked file staging attempt/i,
    );
    await assert.rejects(
      () => manager.commitWorktree("test101", "msg", [".hivemind/coder/test101.json"]),
      /Blocked file staging attempt/i,
    );

    // Valid path
    await writeFile(path.join(wtPath, "valid.txt"), "hello");
    await manager.commitWorktree("test101", "valid msg", ["valid.txt"]);

    // Check it committed properly
    const { stdout } = await execFileAsync("git", ["log", "-1", "--name-only"], { cwd: wtPath });
    assert.match(stdout, /valid\.txt/);

  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
