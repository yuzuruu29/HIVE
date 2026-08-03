import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeDesktopChecksums } from "../scripts/checksum-desktop-artifacts.mjs";
import { DefaultDesktopRunManager } from "../dist/desktop/run-manager.js";
import { JsonThreadStore } from "../dist/desktop/thread-store.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { PACKAGED_SMOKE_MESSAGE, PACKAGED_SMOKE_PROVIDER_ID, PACKAGED_SMOKE_REPORT_RESULT, packagedSmokeLauncher } from "../dist/desktop/electron/packaged-smoke-runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generated preload command allowlist exactly matches the canonical TypeScript manifest", async () => {
  const source = await readFile(path.join(root, "src", "desktop", "electron", "command-manifest.ts"), "utf8");
  const match = source.match(/DESKTOP_COMMAND_TYPES\s*=\s*(\[[\s\S]*?\])\s*as const/);
  assert.ok(match, "canonical command manifest must remain machine-readable");
  const commands = JSON.parse(match[1]);
  const preload = await readFile(path.join(root, "desktop", "preload.cjs"), "utf8");
  const compiledPreload = await readFile(path.join(root, "dist", "desktop", "electron", "preload.cjs"), "utf8");
  const generated = preload.match(/const COMMANDS = new Set\((\[[\s\S]*?\])\);/);
  assert.ok(generated, "preload must embed the generated command manifest");
  assert.deepEqual(JSON.parse(generated[1]), commands);
  assert.equal(compiledPreload, preload);
});

test("packaging unpacks only the bundled production utility worker", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.build.asarUnpack, ["dist/desktop/electron/worker.mjs"]);
  assert.match(pkg.scripts["build:desktop"], /build:desktop-worker/);
  assert.deepEqual(pkg.build.files, ["dist/**/*", "dist-desktop/renderer/**/*", "package.json"]);
  for (const forbidden of ["cli", "tui", "commercial", "main", "preload", "fixture", "test"]) {
    assert.ok(pkg.build.asarUnpack.every((entry) => !entry.toLowerCase().includes(forbidden)), `unpack pattern leaks ${forbidden}`);
  }
});

test("internal packaged diagnostic completes through DefaultDesktopRunManager and persists a report without an adapter", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "hive-packaged-runtime-repository-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "hive-packaged-runtime-user-data-"));
  try {
    const environment = { HIVE_DESKTOP_PACKAGED_SMOKE: "1", HIVE_DESKTOP_SMOKE_USER_DATA: userData };
    const launcher = packagedSmokeLauncher(environment);
    assert.ok(launcher);
    const store = new JsonThreadStore(repository);
    const thread = await store.create({ id: "smoke-thread", title: "Packaged diagnostic" });
    thread.messages.push({ id: "smoke-message", role: "user", content: PACKAGED_SMOKE_MESSAGE, createdAt: new Date().toISOString() });
    await store.save(thread);
    const manager = new DefaultDesktopRunManager({ launcher, sessionIdFactory: () => "smoke-session" });
    await manager.start({ repositoryRoot: repository, threadId: thread.id, currentUserMessageId: "smoke-message", options: { mode: "auto", approvalPolicy: "changes", providerId: PACKAGED_SMOKE_PROVIDER_ID } });
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = (await store.load(thread.id))?.runs[0]?.status;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status, "completed");
    const session = await new CodingSessionStore(repository).load("smoke-session");
    assert.equal(session?.status, "completed");
    assert.equal(session?.finalReport?.result, PACKAGED_SMOKE_REPORT_RESULT);
    await assert.rejects(() => launcher({ repositoryRoot: repository, sessionId: "bad", objective: "wrong", options: { mode: "auto", approvalPolicy: "changes", providerId: PACKAGED_SMOKE_PROVIDER_ID }, signal: new AbortController().signal, onEvent() {} }), /non-diagnostic/i);
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("checksum generation requires the exact versioned x64 installer and portable artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hive-checksum-"));
  try {
    await writeFile(path.join(directory, "HIVE-0.5.0-x64-setup.exe"), "setup");
    await assert.rejects(() => writeDesktopChecksums({ directory, version: "0.5.0" }), /portable/i);
    await writeFile(path.join(directory, "HIVE-0.5.0-x64-portable.exe"), "portable");
    const output = await writeDesktopChecksums({ directory, version: "0.5.0" });
    assert.deepEqual(output.names, ["HIVE-0.5.0-x64-portable.exe", "HIVE-0.5.0-x64-setup.exe"]);
    const lines = (await readFile(path.join(directory, "SHA256SUMS.txt"), "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((line) => line.slice(line.indexOf("*") + 1)), output.names);
    await writeFile(path.join(directory, "unexpected.exe"), "unexpected");
    await assert.rejects(() => writeDesktopChecksums({ directory, version: "0.5.0" }), /unexpected/i);
    assert.ok((await readdir(directory)).includes("SHA256SUMS.txt"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
