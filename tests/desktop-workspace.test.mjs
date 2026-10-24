import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_WORKSPACE_LIST_ENTRIES,
  isDeniedWorkspacePath,
  listWorkspaceEntries,
  readWorkspaceFile,
  resolveWorkspacePath,
} from "../dist/desktop/workspace-tree.js";
import { validateDesktopCommand, validateDesktopEvent } from "../dist/desktop/electron/contracts.js";

async function temporaryDirectory(prefix = "hive-workspace-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (process.env.HIVE_TASK_MANIFEST) await appendFile(process.env.HIVE_TASK_MANIFEST, root + "\n");
  return root;
}

async function removeTemporaryDirectory(root) {
  const relative = path.relative(await realpath(os.tmpdir()), await realpath(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.ok(path.basename(root).startsWith("hive-workspace-"));
  await rm(root, { recursive: true });
}

async function tempRoot() {
  const root = await temporaryDirectory();
  await writeFile(path.join(root, "README.md"), "# hive\n", "utf8");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.js"), "export default 1;\n", "utf8");
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  return root;
}

test("listWorkspaceEntries lists root files and skips deny-listed directories", async () => {
  const root = await tempRoot();
  try {
    const listing = await listWorkspaceEntries(root, "");
    const names = listing.entries.map((entry) => entry.name);
    assert.ok(names.includes("README.md"));
    assert.ok(names.includes("src"));
    assert.ok(!names.includes("node_modules"));
    assert.ok(!names.includes(".git"));
    assert.equal(listing.path, "");
    assert.equal(listing.truncated, false);
    const src = listing.entries.find((entry) => entry.name === "src");
    assert.equal(src?.kind, "dir");
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test("listWorkspaceEntries lists a nested directory and refuses escapes", async () => {
  const root = await tempRoot();
  try {
    const listing = await listWorkspaceEntries(root, "src");
    assert.deepEqual(listing.entries.map((entry) => entry.path), ["src/main.js"]);
    await assert.rejects(() => listWorkspaceEntries(root, "../escape"), /outside/);
    assert.equal(resolveWorkspacePath(root, "../escape"), null);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test("listWorkspaceEntries skips symlinks and deny-listed nested paths", async () => {
  const root = await tempRoot();
  try {
    try {
      await symlink(path.join(root, "README.md"), path.join(root, "linked-readme"));
    } catch {
      // Windows may refuse symlink creation without privilege.
    }
    const listing = await listWorkspaceEntries(root, "");
    assert.ok(!listing.entries.some((entry) => entry.name === "linked-readme"));
    await assert.rejects(() => listWorkspaceEntries(root, "node_modules"), /deny-listed/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test("listWorkspaceEntries sets truncated when a directory exceeds the cap", async () => {
  const root = await temporaryDirectory("hive-workspace-cap-");
  try {
    for (let index = 0; index < MAX_WORKSPACE_LIST_ENTRIES + 5; index += 1) {
      await writeFile(path.join(root, `file-${String(index).padStart(4, "0")}.txt`), "x\n", "utf8");
    }
    const listing = await listWorkspaceEntries(root, "");
    assert.equal(listing.entries.length, MAX_WORKSPACE_LIST_ENTRIES);
    assert.equal(listing.truncated, true);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test("readWorkspaceFile returns text, language hint, and refuses binary and deny-listed files", async () => {
  const root = await tempRoot();
  try {
    const preview = await readWorkspaceFile(root, "src/main.js");
    assert.equal(preview.path, "src/main.js");
    assert.match(preview.content, /export default 1/);
    assert.equal(preview.languageHint, "js");
    assert.equal(preview.truncated, false);
    await assert.rejects(() => readWorkspaceFile(root, "node_modules/left-pad/index.js"), /deny-listed/);
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await assert.rejects(() => readWorkspaceFile(root, "blob.bin"), /binary/);
    await assert.rejects(() => readWorkspaceFile(root, "../secret.txt"), /outside/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test("workspace reads and listings reject ancestor junction escapes", async () => {
  const root = await tempRoot();
  const external = await temporaryDirectory("hive-workspace-outside-");
  try {
    await mkdir(path.join(external, "nested"));
    await writeFile(path.join(external, "nested", "external.txt"), "external fixture\n");
    await symlink(external, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => readWorkspaceFile(root, "linked/nested/external.txt"), /outside/);
    await assert.rejects(() => listWorkspaceEntries(root, "linked/nested"), /outside/);
    assert.ok(!(await listWorkspaceEntries(root)).entries.some((entry) => entry.name === "linked"));
  } finally {
    await removeTemporaryDirectory(root);
    await removeTemporaryDirectory(external);
  }
});

test("canonical paths retain normal workspace reads and reject aliases into protected directories", async () => {
  const root = await tempRoot();
  const holder = await temporaryDirectory("hive-workspace-root-");
  try {
    const type = process.platform === "win32" ? "junction" : "dir";
    const rootAlias = path.join(holder, "repository");
    await symlink(root, rootAlias, type);
    assert.match((await readWorkspaceFile(rootAlias, "src/main.js")).content, /export default 1/);
    assert.ok((await listWorkspaceEntries(rootAlias)).entries.some((entry) => entry.name === "README.md"));

    await symlink(path.join(root, "src"), path.join(root, "source-alias"), type);
    assert.match((await readWorkspaceFile(root, "source-alias/main.js")).content, /export default 1/);
    await assert.rejects(() => listWorkspaceEntries(root, "source-alias"), /symlink/);

    await symlink(path.join(root, ".git"), path.join(root, "metadata-alias"), type);
    await assert.rejects(() => readWorkspaceFile(root, "metadata-alias/HEAD"), /deny-listed/);
  } finally {
    await removeTemporaryDirectory(holder);
    await removeTemporaryDirectory(root);
  }
});

test("protected workspace paths use case-insensitive checks across reads, commands, and events", async () => {
  const root = await tempRoot();
  const timestamp = "2026-10-24T00:00:00.000Z";
  try {
    for (const relative of [".GIT/HEAD", ".ENV", ".ENV.local", "nested/.GiT/config", "NODE_MODULES/private.js", "src/.HiVeMiNd/state.json"]) {
      assert.equal(isDeniedWorkspacePath(relative), true, relative);
      await assert.rejects(() => readWorkspaceFile(root, relative), /deny-listed/, relative);
      await assert.rejects(() => listWorkspaceEntries(root, relative), /deny-listed/, relative);
      for (const type of ["workspace.read", "workspace.list"]) {
        assert.throws(() => validateDesktopCommand({ requestId: "protected-path", type, input: { repositoryRoot: root, path: relative } }), /invalid|deny-listed/i, relative);
      }
      assert.throws(() => validateDesktopEvent({ type: "workspace.file", timestamp, file: { repositoryRoot: root, path: relative, content: "fixture", truncated: false, languageHint: "text" } }), /invalid|deny-listed/i, relative);
      assert.throws(() => validateDesktopEvent({ type: "workspace.listed", timestamp, listing: { repositoryRoot: root, path: relative, truncated: false, entries: [] } }), /invalid|deny-listed/i, relative);
      assert.throws(() => validateDesktopEvent({ type: "workspace.listed", timestamp, listing: { repositoryRoot: root, path: "", truncated: false, entries: [{ name: path.basename(relative), path: relative, kind: "file" }] } }), /invalid|deny-listed/i, relative);
    }
    assert.equal(isDeniedWorkspacePath("src/environment.ts"), false);
    assert.equal(isDeniedWorkspacePath("src/git-utils.ts"), false);
  } finally {
    await removeTemporaryDirectory(root);
  }
});
