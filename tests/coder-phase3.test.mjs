import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CoderOrchestrator } from "../dist/orchestrator.js";
import { WorktreeManager } from "../dist/worktree.js";
import { GitHubForge } from "../dist/forge.js";
import { TaskStore } from "../dist/store.js";


const execFileAsync = promisify(execFile);

test("HIVE Phase 3 - Orchestrator and RemoteForge integration", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hive-coder-repo-"));
  const remote = await mkdtemp(path.join(os.tmpdir(), "hive-coder-remote-"));
  
  try {
    // Setup remote bare repo
    await execFileAsync("git", ["init", "--bare", "-b", "main"], { cwd: remote });

    // Setup local repo
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Hive Coder Test"], { cwd: repo });
    
    // Add remote to local repo
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repo });
    
    await writeFile(path.join(repo, "README.md"), "Initial commit\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repo });

    const taskId = "test-phase3-pr";
    const wm = new WorktreeManager(repo);
    await wm.createWorktree(taskId);
    
    const worktreePath = wm.getWorktreePath(taskId);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: worktreePath });
    await execFileAsync("git", ["config", "user.name", "Hive Coder Test"], { cwd: worktreePath });
    
    await writeFile(path.join(worktreePath, "hello.txt"), "Hello Phase 3");

    const store = new TaskStore(repo);
    const existingRecord = {
      taskId,
      state: 'AWAITING_APPROVAL',
      branchName: `hive-coder/${taskId}`,
      verificationResults: [{ command: "test", passed: true, output: "OK" }],
      diffSummary: { filesChanged: ['hello.txt'], submodulesChanged: [], insertions: 1, deletions: 0, patch: "..." },
      plan: "Add hello.txt",
      reviewerVerdict: "Approved",
      providers: [],
      expectedFiles: ['hello.txt']
    };
    await store.save(existingRecord);

    const orchestrator = await CoderOrchestrator.fromRecord(existingRecord, repo);

    // Initialize Forge
    const forge = new GitHubForge("test-owner", "test-repo", "fake-token");

    // Negative test: Cannot push before local approval
    await assert.rejects(
      async () => { await orchestrator.push(forge); },
      /Cannot push in state AWAITING_APPROVAL/
    );

    // 1. Approve task (Transitions to COMMITTING -> COMPLETED)
    await orchestrator.approve("Approving task");
    assert.equal(orchestrator.getRecord().state, "COMPLETED");

    // Negative test: Cannot create PR before pushed state
    await assert.rejects(
      async () => { await orchestrator.createPR(forge, "main"); },
      /Cannot create PR in state COMPLETED/
    );

    // Negative test: Failed push preserves task state
    const originalPush = forge.push;
    forge.push = async () => { throw new Error("Mock push failure"); };
    await assert.rejects(
      async () => { await orchestrator.push(forge); },
      /Mock push failure/
    );
    assert.equal(orchestrator.getRecord().state, "COMPLETED"); // state is preserved
    forge.push = originalPush; // Restore push

    // 2. Push task (Transitions to PUSHED)
    await orchestrator.push(forge);
    assert.equal(orchestrator.getRecord().state, "PUSHED");
    
    // Verify it was pushed to remote
    const { stdout: branches } = await execFileAsync("git", ["branch", "-a"], { cwd: repo });
    assert.match(branches, new RegExp(`remotes/origin/hive-coder/${taskId}`));

    // 3. Mock fetch for createPR
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    let fetchUrl = "";
    let fetchOptions = {};
    
    globalThis.fetch = async (url, options) => {
      fetchCalled = true;
      fetchUrl = url;
      fetchOptions = options;
      return {
        ok: true,
        json: async () => ({ html_url: "https://github.com/test-owner/test-repo/pull/1" })
      };
    };

    try {
      // 4. Create PR (Transitions to PR_CREATED)
      const prUrl = await orchestrator.createPR(forge, "main");
      assert.equal(orchestrator.getRecord().state, "PR_CREATED");
      assert.equal(prUrl, "https://github.com/test-owner/test-repo/pull/1");
      
      assert.equal(fetchCalled, true);
      assert.equal(fetchUrl, "https://api.github.com/repos/test-owner/test-repo/pulls");
      assert.equal(fetchOptions.headers.Authorization, "Bearer fake-token");
      
      const bodyPayload = JSON.parse(fetchOptions.body);
      assert.equal(bodyPayload.title, `HIVE Task: ${taskId}`);
      assert.equal(bodyPayload.head, `hive-coder/${taskId}`);
      assert.equal(bodyPayload.base, "main");
      
      // Ensure PR body contains HIVE artifacts
      assert.match(bodyPayload.body, /HIVE Task Report/);
      assert.match(bodyPayload.body, /Verification Results/);
      assert.match(bodyPayload.body, /✅ Passed/);
      assert.match(bodyPayload.body, /Guardrail Checklist/);
      
      // Ensure token is never persisted in task store
      const savedRecord = await store.load(taskId);
      assert.ok(savedRecord !== null);
      assert.equal(savedRecord.token, undefined);
      assert.equal(JSON.stringify(savedRecord).includes("fake-token"), false);
    } finally {
      globalThis.fetch = originalFetch; // Restore fetch
    }
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
    await rm(remote, { recursive: true, force: true }).catch(() => {});
  }
});
