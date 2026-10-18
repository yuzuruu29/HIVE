import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectSessionService } from "../dist/projects/service.js";

test("production migration requires reviewed digest, preserves originals, and survives restart with backups", async () => {
  const root = path.join(os.tmpdir(), `hive-history-entry-${randomUUID()}`);
  if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, root + "\n");
  await fs.mkdir(root);
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const catalogPath = path.join(root, "catalog.json");
  const service = new ProjectSessionService({ catalogPath });
  const attached = await service.action({ type: "project.attach", path: workspace, requestId: randomUUID() });
  const projectId = attached.result.projectId;
  const id = `cli-${randomUUID()}`;
  const file = path.join(workspace, ".hivemind", "cli-sessions", `${id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ id, messages: [{ role: "user", content: "Existing question" }, { role: "assistant", content: "Existing answer" }], unknownProviderMetadata: { preserved: true } });
  await fs.writeFile(file, original);
  try {
    const preview = await service.previewImport(projectId);
    assert.equal(preview.counts.cli, 1); assert.equal(preview.counts.messages, 2);
    assert.equal((await service.snapshot()).sessions.length, 0);
    await assert.rejects(service.importHistory(projectId, "0".repeat(64)), /changed after preview/);
    const result = await service.importHistory(projectId, preview.digest);
    assert.equal(result.imported, 1);
    assert.equal(result.snapshot.sessions[0].id, id);
    assert.equal(await fs.readFile(file, "utf8"), original);
    const journal = JSON.parse(await fs.readFile(path.join(result.backupDirectory, "migration-journal.json"), "utf8"));
    const backup = JSON.parse(await fs.readFile(journal.entries[0].backup, "utf8"));
    assert.deepEqual(backup.unknownProviderMetadata, { preserved: true });
    assert.equal((await service.importHistory(projectId, preview.digest)).duplicate, true);
    await service.close();
    const restarted = new ProjectSessionService({ catalogPath });
    try { assert.equal((await restarted.snapshot()).sessions[0].messages[1].text, "Existing answer"); }
    finally { await restarted.close(); }
  } finally { await service.close(); }
  // Backups and journals are intentionally retained under this manifested fixture root.
});

test("production migration rejects changed sources after preview", async () => {
  const root = path.join(os.tmpdir(), `hive-history-change-${randomUUID()}`);
  if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, root + "\n");
  await fs.mkdir(root); const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const service = new ProjectSessionService({ catalogPath: path.join(root, "catalog.json") });
  const { result } = await service.action({ type: "project.attach", path: workspace, requestId: randomUUID() });
  const id = `cli-${randomUUID()}`; const file = path.join(workspace, ".hivemind", "cli-sessions", `${id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ id, messages: [{ role: "user", content: "First" }] }));
  try {
    const preview = await service.previewImport(result.projectId);
    await fs.writeFile(file, JSON.stringify({ id, messages: [{ role: "user", content: "Changed" }] }));
    await assert.rejects(service.importHistory(result.projectId, preview.digest), /changed after preview/);
    assert.equal((await service.snapshot()).sessions.length, 0);
  } finally { await service.close(); await fs.rm(root, { recursive: true }); }
});
