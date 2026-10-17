import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { forkCodingSession } from "../dist/coding/fork.js";
import { createQueenSession, getCodingWorkspace, inspectManagedWorktree } from "../dist/coding/runtime.js";
import { acquireCodingSessionLease } from "../dist/coding/session-lease.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { WorktreeManager } from "../dist/worktree.js";

const exec = promisify(execFile);
async function git(root, args) { return (await exec("git", ["-c", "diff.autoRefreshIndex=false", ...args], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout; }

async function fixture(t, id = "source") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-worktree-fork-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "hive@example.test"]);
  await git(root, ["config", "user.name", "HIVE Test"]);
  for (const name of ["text.txt", "deleted.txt", "missing.txt", "rename.txt", "mode.sh"]) await fs.writeFile(path.join(root, name), "baseline\r\n");
  await fs.writeFile(path.join(root, "swap-file"), "file before transition\n");
  await fs.mkdir(path.join(root, "swap-dir"));
  await fs.writeFile(path.join(root, "swap-dir", "child.txt"), "directory before transition\n");
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 255, 2]));
  await fs.writeFile(path.join(root, ".gitignore"), ".hivemind/\nignored-cache/\nnode_modules\n.env\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "fixture"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const workspace = await new WorktreeManager(root).createWorktreeFrom(id, head);
  await fs.writeFile(path.join(workspace, "text.txt"), "staged\r\n");
  await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 3, 255, 4]));
  await git(workspace, ["add", "text.txt", "binary.bin"]);
  await fs.writeFile(path.join(workspace, "text.txt"), "unstaged\r\n");
  await fs.appendFile(path.join(workspace, "binary.bin"), Buffer.from([0, 8]));
  await git(workspace, ["mv", "rename.txt", "renamed.txt"]);
  await fs.appendFile(path.join(workspace, "renamed.txt"), "unstaged rename\n");
  await git(workspace, ["rm", "deleted.txt"]);
  await fs.writeFile(path.join(workspace, "deleted.txt"), "recreated untracked\n");
  await fs.unlink(path.join(workspace, "missing.txt"));
  await git(workspace, ["update-index", "--chmod=+x", "mode.sh"]);
  await fs.mkdir(path.join(workspace, "nested"));
  await fs.writeFile(path.join(workspace, "nested", "untracked.bin"), Buffer.from([0, 255, 32]));
  await fs.mkdir(path.join(workspace, "ignored-cache"));
  await fs.writeFile(path.join(workspace, "ignored-cache", "cache.txt"), "ignored");
  await fs.writeFile(path.join(workspace, ".env"), "PRIVATE=not-copied\n");
  await fs.mkdir(path.join(workspace, ".hivemind"));
  await fs.writeFile(path.join(workspace, ".hivemind", "metadata.txt"), "runtime metadata");
  const fingerprint = (await inspectManagedWorktree(root, id, workspace)).fingerprint;
  const now = new Date().toISOString();
  const record = { schemaVersion: 1, id, objective: "Fixture implementation", mode: "auto", approvalPolicy: "changes", status: "completed",
    createdAt: now, updatedAt: now, repository: { root, worktreePath: workspace, worktreeBaseCommit: head,
      worktreeFingerprint: fingerprint, baseCommit: head, branch: "main", capturedAt: now, dirty: false, changedFiles: [] },
    tasks: [], events: [{ schemaVersion: 1, id: "source-created", sequence: 1, sessionId: id, timestamp: now,
      type: "session.created", payload: { objective: "Fixture implementation", mode: "auto", approvalPolicy: "changes" } }],
    providerBindings: [], validationResults: [], reviewResults: [],
    files: ["text.txt", "binary.bin", "rename.txt", "renamed.txt", "deleted.txt", "missing.txt", "mode.sh", "nested/untracked.bin"].map((name) => ({ path: name, operation: "modified", recordedAt: now })),
    finalReport: { evidenceCurrent: true }, verdict: "ACCEPTED" };
  const store = new CodingSessionStore(root); await store.save(record);
  return { root, workspace, store, record };
}

async function indexBytes(workspace) { return fs.readFile((await git(workspace, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim()); }
async function state(workspace) {
  return { head: await git(workspace, ["rev-parse", "HEAD"]), status: await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude,top).hivemind"]),
    staged: await git(workspace, ["diff", "--cached", "--binary", "--no-ext-diff"]), working: await git(workspace, ["diff", "--binary", "--no-ext-diff"]), index: await indexBytes(workspace) };
}

test("fork preserves staged, unstaged, binary, rename, deletion, modes and Git-visible untracked files without altering the source", async (t) => {
  const { root, workspace, store } = await fixture(t);
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "shared-cache.txt"), "ignored shared dependency cache\n");
  const staleIndex = await indexBytes(workspace);
  const changedStat = new Date(Date.now() + 5_000);
  await fs.utimes(path.join(workspace, "mode.sh"), changedStat, changedStat);
  await inspectManagedWorktree(root, "source", workspace);
  assert.deepEqual(await indexBytes(workspace), staleIndex, "read-only inspection cannot refresh even a stale index stat cache");
  const before = await state(workspace);
  const sourceBytes = await fs.readFile(path.join(store.getSessionDirectory("source"), "session.json"));
  await fs.mkdir(path.join(root, "launch-subdirectory"));
  const fork = await forkCodingSession(path.join(root, "launch-subdirectory"), "source", { sessionId: "independent" });
  assert.equal(fork.forkedFrom, "source"); assert.equal(fork.status, "cancelled"); assert.equal(fork.verdict, "BLOCKED");
  assert.deepEqual(fork.tasks, []); assert.deepEqual(fork.validationResults, []); assert.deepEqual(fork.reviewResults, []); assert.equal(fork.finalReport, undefined);
  assert.equal(fork.turnHistory[0].id, fork.id); assert.equal(fork.turnHistory[0].forkedFrom, "source"); assert.equal(fork.turnHistory[0].finalReport.evidenceCurrent, true);
  assert.equal(fork.turnStartSequence, 2); assert.equal(fork.events[0].sessionId, fork.id); assert.notEqual(fork.events[0].id, "source-created");
  assert.equal((await git(fork.repository.worktreePath, ["branch", "--show-current"])).trim(), "hive-coder/independent");
  assert.deepEqual(await state(fork.repository.worktreePath), before);
  assert.deepEqual(await state(workspace), before);
  assert.deepEqual(await fs.readFile(path.join(store.getSessionDirectory("source"), "session.json")), sourceBytes);
  assert.deepEqual(await fs.readFile(path.join(fork.repository.worktreePath, "nested", "untracked.bin")), Buffer.from([0, 255, 32]));
  for (const excluded of ["ignored-cache", ".env", ".hivemind"]) await assert.rejects(fs.lstat(path.join(fork.repository.worktreePath, excluded)), { code: "ENOENT" });
  assert.equal(await fs.realpath(path.join(fork.repository.worktreePath, "node_modules")), await fs.realpath(path.join(root, "node_modules")));
  assert.equal(await getCodingWorkspace(root, fork.id), fork.repository.worktreePath);
  assert.equal(await getCodingWorkspace(root, "source"), workspace);
});

async function followup(root, id, expected, next) {
  const runtime = await createQueenSession({ repositoryPath: root, continuationId: id, objective: `Write ${next}`, mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0 });
  let wrote = false;
  runtime.providerRouter.bindingForRole = async (role) => ({ role, providerId: "fixture" });
  runtime.providerRouter.complete = async (request) => {
    if (request.role === "planner") {
      assert.equal(await fs.readFile(path.join(request.cwd, "text.txt"), "utf8"), expected);
      return { output: JSON.stringify({ summary: "Continue fork", architecture: "One file", risks: [], acceptanceCriteria: ["Write file"], validationCommands: ["node --version"],
        tasks: [{ key: "write", role: "builder", title: "Write file", objective: "Write file", dependencies: [], fileScope: ["text.txt"], expectedOutput: "File", completionCriteria: ["Correct content"], validationCommands: [] }] }) };
    }
    if (request.role === "builder" && !wrote) { wrote = true; return { output: JSON.stringify({ done: false, toolCalls: [{ name: "write_file", arguments: { path: "text.txt", content: next } }] }) }; }
    return { output: JSON.stringify({ done: true, summary: "Done", data: { status: "passed", findings: [] } }) };
  };
  runtime.providerRouter.streamComplete = (request) => runtime.providerRouter.complete(request);
  return runtime.orchestrator.run();
}

test("new turns on a fork and its source remain independent and do not reuse acceptance evidence", async (t) => {
  const { root, workspace } = await fixture(t);
  const fork = await forkCodingSession(root, "source", { sessionId: "independent" });
  const forkTurn = await followup(root, fork.id, "unstaged\r\n", "fork-only\n");
  assert.equal(forkTurn.status, "completed", JSON.stringify(forkTurn.finalReport));
  assert.equal(forkTurn.forkedFrom, "source");
  assert.ok(forkTurn.events.some((event) => event.sequence >= 2 && event.type === "session.created"));
  assert.equal(forkTurn.id, fork.id); assert.equal(forkTurn.repository.worktreePath, fork.repository.worktreePath);
  assert.equal(await fs.readFile(path.join(workspace, "text.txt"), "utf8"), "unstaged\r\n");
  const sourceTurn = await followup(root, "source", "unstaged\r\n", "source-only\n");
  assert.equal(sourceTurn.status, "completed", JSON.stringify(sourceTurn.finalReport));
  assert.equal(await fs.readFile(path.join(fork.repository.worktreePath, "text.txt"), "utf8"), "fork-only\n");
  assert.equal(await fs.readFile(path.join(workspace, "text.txt"), "utf8"), "source-only\n");
});

test("fork refuses busy, drifted, archived and unsettled sessions without allocating a new worktree", async (t) => {
  const { root, workspace, store, record } = await fixture(t);
  const lease = await acquireCodingSessionLease(root, "source");
  try { await assert.rejects(forkCodingSession(root, "source", { sessionId: "blocked" }), /already in use/); }
  finally { await lease.release(); }
  await fs.writeFile(path.join(workspace, "text.txt"), "external drift\n");
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "blocked" }), /changed/);
  await fs.writeFile(path.join(workspace, "text.txt"), "unstaged\r\n");
  await store.save({ ...record, archived: true });
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "blocked" }), /archived/);
  await store.save({ ...record, status: "running" });
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "blocked" }), /Only settled/);
  assert.equal((await git(root, ["worktree", "list", "--porcelain"])).split("worktree ").length - 1, 2);
  assert.equal(await store.load("blocked"), null);
});

test("fork rejects private and linked Git-visible state before creating the destination", async (t) => {
  const { root, workspace, store, record } = await fixture(t);
  await fs.writeFile(path.join(workspace, "credentials.json"), "private");
  await store.save({ ...record, repository: { ...record.repository, worktreeFingerprint: (await inspectManagedWorktree(root, "source", workspace)).fingerprint } });
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "blocked" }), /credential file/);
  await fs.unlink(path.join(workspace, "credentials.json"));
  await fs.link(path.join(workspace, "text.txt"), path.join(workspace, "hardlink.txt"));
  await store.save({ ...record, repository: { ...record.repository, worktreeFingerprint: (await inspectManagedWorktree(root, "source", workspace)).fingerprint } });
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "blocked" }), /non-regular or linked/);
  assert.equal((await git(root, ["worktree", "list", "--porcelain"])).split("worktree ").length - 1, 2);
  assert.equal(await store.load("blocked"), null);
});

test("fork rejects an unresolved index without changing its conflict stages", async (t) => {
  const { root, workspace, store, record } = await fixture(t);
  const oid = (await git(workspace, ["rev-parse", "HEAD:text.txt"])).trim();
  const entries = `0 ${"0".repeat(40)}\ttext.txt\n100644 ${oid} 1\ttext.txt\n100644 ${oid} 2\ttext.txt\n100644 ${oid} 3\ttext.txt\n`;
  await new Promise((resolve, reject) => {
    const child = execFile("git", ["update-index", "--index-info"], { cwd: workspace }, (error) => error ? reject(error) : resolve());
    child.stdin.end(entries);
  });
  await store.save({ ...record, repository: { ...record.repository, worktreeFingerprint: (await inspectManagedWorktree(root, "source", workspace)).fingerprint } });
  const before = await indexBytes(workspace);
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "unmerged" }), /unresolved Git index/);
  assert.deepEqual(await indexBytes(workspace), before);
  await assert.rejects(fs.lstat(new WorktreeManager(root).getWorktreePath("unmerged")), { code: "ENOENT" });
});

test("fork preserves file-to-directory and directory-to-file transitions in the index and working tree", async (t) => {
  const { root, workspace, store, record } = await fixture(t);
  await git(workspace, ["rm", "swap-file", "swap-dir/child.txt"]);
  await fs.rmdir(path.join(workspace, "swap-dir")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await fs.mkdir(path.join(workspace, "swap-file"));
  await fs.writeFile(path.join(workspace, "swap-file", "child.txt"), "directory after transition\n");
  await fs.writeFile(path.join(workspace, "swap-dir"), "file after transition\n");
  await git(workspace, ["add", "swap-file/child.txt", "swap-dir"]);
  await store.save({ ...record, repository: { ...record.repository, worktreeFingerprint: (await inspectManagedWorktree(root, "source", workspace)).fingerprint } });
  const before = await state(workspace);
  const fork = await forkCodingSession(root, "source", { sessionId: "transitions" });
  assert.deepEqual(await state(fork.repository.worktreePath), before);
  assert.deepEqual(await state(workspace), before);
  assert.equal(await fs.readFile(path.join(fork.repository.worktreePath, "swap-file", "child.txt"), "utf8"), "directory after transition\n");
  assert.equal(await fs.readFile(path.join(fork.repository.worktreePath, "swap-dir"), "utf8"), "file after transition\n");
});

test("fork refuses aliased session metadata before allocating a worktree", async (t) => {
  const { root, store } = await fixture(t);
  const file = path.join(store.getSessionDirectory("source"), "session.json");
  await fs.link(file, path.join(root, ".hivemind", "session-alias.json"));
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "aliased" }), /regular single-link session file/);
  assert.equal((await git(root, ["worktree", "list", "--porcelain"])).split("worktree ").length - 1, 2);
});

test("fork keeps the source lease throughout copying and aborts cleanly if an external writer changes source bytes", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const target = new WorktreeManager(root).getWorktreePath("changed-source");
  const sourceRecord = await fs.readFile(path.join(store.getSessionDirectory("source"), "session.json"));
  const originalOpen = fs.open;
  let intercepted = false;
  fs.open = async (file, flags, ...rest) => {
    if (!intercepted && String(file) === path.join(target, "text.txt") && typeof flags === "number" && (flags & 1) === 1) {
      intercepted = true;
      await assert.rejects(acquireCodingSessionLease(root, "source"), /already in use/);
      await fs.writeFile(path.join(workspace, "text.txt"), "external write during copy\n");
    }
    return originalOpen(file, flags, ...rest);
  };
  try { await assert.rejects(forkCodingSession(root, "source", { sessionId: "changed-source" }), /Source workspace changed/); }
  finally { fs.open = originalOpen; }
  assert.equal(intercepted, true);
  assert.equal(await fs.readFile(path.join(workspace, "text.txt"), "utf8"), "external write during copy\n");
  assert.deepEqual(await fs.readFile(path.join(store.getSessionDirectory("source"), "session.json")), sourceRecord);
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  assert.equal(await store.load("changed-source"), null);
});

test("failed destination writes clean up only the new managed worktree and leave source bytes and index unchanged", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const before = await state(workspace);
  const target = new WorktreeManager(root).getWorktreePath("failed-copy");
  const originalOpen = fs.open;
  fs.open = async (file, flags, ...rest) => {
    if (String(file) === path.join(target, "text.txt") && typeof flags === "number" && (flags & 1) === 1) throw new Error("Injected fork write failure");
    return originalOpen(file, flags, ...rest);
  };
  try { await assert.rejects(forkCodingSession(root, "source", { sessionId: "failed-copy" }), /Injected fork write failure/); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(await state(workspace), before);
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  assert.equal(await store.load("failed-copy"), null);
  assert.equal((await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/hive-coder/failed-copy"])).trim(), "");
  const after = await acquireCodingSessionLease(root, "source"); await after.release();
});

test("existing destination IDs and branches are never adopted or changed", async (t) => {
  const { root, workspace } = await fixture(t);
  await git(root, ["branch", "hive-coder/collision"]);
  const before = await state(workspace);
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "collision" }), /already exists/);
  await assert.rejects(forkCodingSession(root, "source", { sessionId: "source" }), /new coding session identity/);
  assert.deepEqual(await state(workspace), before);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await assert.rejects(new WorktreeManager(root).createWorktreeFromExclusive("collision", head), /already exists/);
  assert.equal((await git(root, ["rev-parse", "hive-coder/collision"])).trim(), head);
  await assert.rejects(fs.lstat(new WorktreeManager(root).getWorktreePath("collision")), { code: "ENOENT" });
});

test("fork materializes exact bytes without running checkout hooks or smudge filters", async (t) => {
  const { root, workspace, store, record } = await fixture(t);
  const hooks = path.join(root, ".hivemind", "fork-hooks");
  const hookMarker = path.join(root, ".hivemind", "hook-ran");
  const referenceMarker = path.join(root, ".hivemind", "reference-hook-ran");
  const filterMarker = path.join(root, ".hivemind", "filter-ran");
  const shellPath = (file) => `'${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  await fs.mkdir(hooks);
  await fs.writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\nprintf ran > ${shellPath(hookMarker)}\nprintf mutated > ${shellPath(path.join(workspace, "text.txt"))}\nexit 73\n`, { mode: 0o755 });
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf ran > ${shellPath(referenceMarker)}\nexit 73\n`, { mode: 0o755 });
  await git(root, ["config", "core.hooksPath", hooks.replaceAll("\\", "/")]);
  await git(root, ["config", "filter.fork-smudge.smudge", `printf ran > ${shellPath(filterMarker)}; cat`]);
  await fs.writeFile(path.join(workspace, ".gitattributes"), "text.txt filter=fork-smudge\n");
  await store.save({ ...record, repository: { ...record.repository, worktreeFingerprint: (await inspectManagedWorktree(root, "source", workspace)).fingerprint } });
  const before = await state(workspace);
  const fork = await forkCodingSession(root, "source", { sessionId: "no-checkout" });
  assert.deepEqual(await state(workspace), before);
  assert.deepEqual(await state(fork.repository.worktreePath), before);
  await assert.rejects(fs.lstat(hookMarker), { code: "ENOENT" });
  await assert.rejects(fs.lstat(referenceMarker), { code: "ENOENT" });
  await assert.rejects(fs.lstat(filterMarker), { code: "ENOENT" });
  const lease = await acquireCodingSessionLease(root, "source"); await lease.release();
});

test("rollback preserves an externally replaced directory even when its branch and registration match the new fork", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const target = new WorktreeManager(root).getWorktreePath("replaced");
  const before = await state(workspace);
  const originalOpen = fs.open;
  let replaced = false;
  fs.open = async (file, flags, ...rest) => {
    if (!replaced && String(file) === path.join(target, "text.txt") && typeof flags === "number" && (flags & 1) === 1) {
      replaced = true;
      const previous = await fs.lstat(target, { bigint: true });
      await git(root, ["worktree", "remove", "--force", target]);
      await git(root, ["worktree", "add", target, "hive-coder/replaced"]);
      const replacement = await fs.lstat(target, { bigint: true });
      // Linux may reuse the freed inode; creation time still distinguishes the replacement.
      assert.ok(replacement.ino !== previous.ino || replacement.birthtimeNs !== previous.birthtimeNs);
      await fs.writeFile(path.join(target, "external-only.txt"), "preserve external data\n");
      throw new Error("Injected external replacement");
    }
    return originalOpen(file, flags, ...rest);
  };
  try { await assert.rejects(forkCodingSession(root, "source", { sessionId: "replaced" }), /Partial fork cleanup needs inspection.*directory was replaced/); }
  finally { fs.open = originalOpen; }
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(path.join(target, "external-only.txt"), "utf8"), "preserve external data\n");
  assert.deepEqual(await state(workspace), before);
  assert.equal(await store.load("replaced"), null);
  assert.ok((await git(root, ["worktree", "list", "--porcelain"])).includes(target.replaceAll("\\", "/")));
});
