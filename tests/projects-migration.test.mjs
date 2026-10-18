import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ProjectSessionService } from "../dist/projects/service.js";
import { previewLegacyImport, importLegacyPreview } from "../dist/projects/migration.js";

test("legacy preview is read-only, import retains source ids and metadata backups, and journal makes it repeatable", async (t) => {
  const directory = path.join(os.tmpdir(), `hive-project-import-${randomUUID()}`);
  if (process.env.HIVE_TASK_MANIFEST) await fs.appendFile(process.env.HIVE_TASK_MANIFEST, `${directory}\n`);
  await fs.mkdir(directory); const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace);
  const service = new ProjectSessionService({ catalogPath: path.join(directory, "catalog.json") });
  // Migration backups are intentionally retained under the task's external TEMP for rollback inspection.
  t.after(async () => { await service.close(); });
  const attached = await service.action({ type: "project.attach", requestId: randomUUID(), path: workspace }); const project = attached.snapshot.projects[0];
  const cliId = `cli-${randomUUID()}`; const file = path.join(workspace, ".hivemind", "cli-sessions", `${cliId}.json`); await fs.mkdir(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ schemaVersion: 1, id: cliId, cwd: workspace, title: "Preserved history", createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z", mode: "plan", messages: [{ role: "user", content: "Inspect only" }], transcript: ["Original terminal rendering"], history: ["Inspect only"], summary: "", skillIds: ["trusted-skill"], model: { providerId: "provider-one", model: "model-one" }, futureMetadata: { keep: true } }); await fs.writeFile(file, original);
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const preview = await previewLegacyImport(workspace, project); assert.equal(preview.counts.cli, 1); assert.equal(preview.counts.messages, 1); assert.equal(preview.sessions[0].id, cliId); assert.equal(preview.sessions[0].settings.mode, "plan"); assert.equal(preview.sessions[0].settings.providerId, "provider-one"); assert.equal(await fs.readFile(file, "utf8"), original);
  const result = await importLegacyPreview(service.store, preview, path.join(directory, "backups")); assert.equal(result.imported, 1); assert.equal((await service.snapshot()).sessions[0].id, cliId); assert.equal(hash(await fs.readFile(file)), hash(original));
  const repeated = await importLegacyPreview(service.store, preview, path.join(directory, "backups")); assert.equal(repeated.duplicate, true); assert.equal((await service.snapshot()).sessions.length, 1);
  const [backupDirectory] = await fs.readdir(path.join(directory, "backups")); const backups = path.join(directory, "backups", backupDirectory); const journal = JSON.parse(await fs.readFile(path.join(backups, "migration-journal.json"), "utf8")); const backup = JSON.parse(await fs.readFile(journal.entries[0].backup, "utf8")); assert.deepEqual(backup.futureMetadata, { keep: true }); assert.deepEqual(backup.skillIds, ["trusted-skill"]);
  await fs.writeFile(file, original + "\n"); await assert.rejects(importLegacyPreview(service.store, preview, path.join(directory, "backups")), /changed after preview/);
});
