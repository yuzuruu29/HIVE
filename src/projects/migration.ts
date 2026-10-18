import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactKnownSecrets } from "../security/secrets.js";
import { ProjectStore, type StoredProjectState } from "./store.js";
import type { LegacySource, SessionSettings, SharedProject, SharedSession } from "./types.js";

export interface LegacyImportPreview {
  projectId: string; digest: string; sessions: SharedSession[]; sources: LegacySource[];
  counts: { cli: number; thread: number; chat: number; messages: number }; warnings: string[];
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
async function regularFile(file: string): Promise<Buffer> { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Legacy history must be a bounded regular file."); return fs.readFile(file); }
async function entries(directory: string): Promise<string[]> { try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Legacy history directory must not be a link."); return await fs.readdir(directory); } catch (error) { if (isMissing(error)) return []; throw error; } }
function timestamp(value: unknown, fallback: string): string { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback; }
function settings(value: Record<string, unknown>): SessionSettings {
  const mode = value.mode === "plan" ? "plan" : value.mode === "review" ? "review" : "code";
  const permissions = value.mode === "standard" ? "standard" : value.mode === "autonomous" ? "autonomous" : "guarded";
  const selected = object(value.model) ? value.model : object(value.override) ? value.override : undefined;
  return { mode, permissions, ...(selected && typeof selected.providerId === "string" ? { providerId: selected.providerId } : {}), ...(selected && typeof selected.model === "string" ? { model: selected.model } : {}) };
}
/** Read-only preview. Original files and unsupported provider/extension metadata remain intact. */
export async function previewLegacyImport(repositoryRoot: string, project: SharedProject, now = new Date().toISOString()): Promise<LegacyImportPreview> {
  const root = await fs.realpath(repositoryRoot); const workspace = project.workspaces.find((entry) => path.resolve(entry.path).toLowerCase() === root.toLowerCase()); if (!workspace) throw new Error("Import workspace is not attached to this project.");
  const preview: LegacyImportPreview = { projectId: project.id, digest: "", sessions: [], sources: [], counts: { cli: 0, thread: 0, chat: 0, messages: 0 }, warnings: [] };
  const candidates: Array<{ file: string; kind: "cli" | "thread" | "chat" }> = [];
  const hive = path.join(root, ".hivemind");
  for (const name of await entries(path.join(hive, "cli-sessions"))) if (/^cli-[0-9a-f-]{36}\.json$/.test(name)) candidates.push({ kind: "cli", file: path.join(hive, "cli-sessions", name) });
  for (const name of await entries(path.join(hive, "threads"))) if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(name)) candidates.push({ kind: "thread", file: path.join(hive, "threads", name, "thread.json") });
  for (const directory of [path.join(hive, "chat-sessions"), path.join(hive, "chat-sessions", "archived")]) for (const name of await entries(directory)) if (/^chat-\d+-[0-9a-f]{4}\.json$/.test(name)) candidates.push({ kind: "chat", file: path.join(directory, name) });
  const seen = new Set<string>();
  for (const candidate of candidates.sort((left, right) => left.file.localeCompare(right.file))) {
    try {
      const bytes = await regularFile(candidate.file); const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!object(value) || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id) || !Array.isArray(value.messages)) throw new Error("Invalid legacy session.");
      if (seen.has(value.id)) throw new Error(`Duplicate legacy session id ${value.id}; resolve the collision before importing.`);
      const createdAt = timestamp(value.createdAt, now); const updatedAt = timestamp(value.updatedAt, createdAt);
      const source: LegacySource = { kind: candidate.kind, id: value.id, path: candidate.file, digest: digest(bytes) };
      const messages = value.messages.map((message, index) => {
        if (!object(message) || !["user", "assistant", "system"].includes(String(message.role)) || typeof message.content !== "string") throw new Error("Invalid legacy message.");
        return { id: typeof message.id === "string" ? message.id : `message-${digest(`${value.id}:${index}`).slice(0, 24)}`, role: message.role as "user" | "assistant" | "system", text: redactKnownSecrets(message.content), createdAt: timestamp(message.createdAt ?? message.at, createdAt) };
      });
      const firstUser = messages.find((message) => message.role === "user");
      const selected = settings(value); if (candidate.kind === "chat") selected.mode = "chat";
      const session: SharedSession = { id: value.id, projectId: project.id, workspaceId: workspace.id, title: redactKnownSecrets(typeof value.title === "string" && value.title.trim() ? value.title.slice(0, 200) : firstUser?.text.replace(/\s+/g, " ").trim().slice(0, 80) || "Imported session"), archived: value.archived === true || path.basename(path.dirname(candidate.file)) === "archived", createdAt, updatedAt, settings: selected, messages, runs: [], sources: [source] };
      // Source refs preserve legacy run/provider/extension metadata without guessing a completed attempt.
      const codingIds = new Set<string>();
      if (typeof value.codingSessionId === "string") codingIds.add(value.codingSessionId);
      if (Array.isArray(value.runs)) for (const run of value.runs) if (object(run) && typeof run.codingSessionId === "string") codingIds.add(run.codingSessionId);
      for (const id of codingIds) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id)) throw new Error("Unsafe linked coding session id.");
        const file = path.join(hive, "sessions", id, "session.json");
        try { const bytes = await regularFile(file); const linked: unknown = JSON.parse(bytes.toString("utf8")); if (!object(linked) || linked.id !== id) throw new Error("Linked coding identity mismatch."); session.sources.push({ kind: "coding", id, path: file, digest: digest(bytes) }); }
        catch (error) { if (!isMissing(error)) throw error; preview.warnings.push(`Legacy coding history ${id} is missing; conversation ${value.id} remains readable.`); }
      }
      seen.add(session.id); preview.sessions.push(session); preview.sources.push(...session.sources); preview.counts[candidate.kind] += 1; preview.counts.messages += messages.length;
    } catch (error) { preview.warnings.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)} Original preserved.`); }
  }
  preview.digest = digest(JSON.stringify(preview.sources)); return preview;
}
export async function importLegacyPreview(store: ProjectStore, preview: LegacyImportPreview, backupDirectory: string): Promise<{ imported: number; duplicate: boolean }> {
  if (!path.isAbsolute(backupDirectory)) throw new Error("Migration backup directory must be absolute.");
  if (preview.warnings.some((warning) => warning.includes("Duplicate legacy session id"))) throw new Error("Legacy import has an identity collision; original files preserved.");
  if (digest(JSON.stringify(preview.sources)) !== preview.digest) throw new Error("Legacy preview has changed.");
  const sources = new Map(preview.sources.map((source) => [source.path, source]));
  for (const source of sources.values()) if (digest(await regularFile(source.path)) !== source.digest) throw new Error("Legacy history changed after preview; create a fresh preview.");
  const journalId = `${preview.projectId}:${preview.digest}`;
  const before = await store.load(); if (before.migrations[journalId]) return { imported: 0, duplicate: true };
  for (const session of preview.sessions) if (before.sessions.some((existing) => existing.id === session.id)) throw new Error(`Shared session ${session.id} already exists; no history was overwritten.`);
  const directory = path.join(backupDirectory, `import-${randomUUID()}`); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const backupEntries: Array<{ source: LegacySource; backup: string }> = [];
  for (const source of sources.values()) { const backup = path.join(directory, `${source.kind}-${digest(source.path).slice(0, 24)}.json`); const bytes = await regularFile(source.path); if (digest(bytes) !== source.digest) throw new Error("Legacy source changed while backing up; import stopped."); await fs.writeFile(backup, bytes, { flag: "wx", mode: 0o600 }); backupEntries.push({ source, backup }); }
  await fs.writeFile(path.join(directory, "migration-journal.json"), JSON.stringify({ schemaVersion: 1, projectId: preview.projectId, digest: preview.digest, counts: preview.counts, entries: backupEntries, rollback: "Switch clients back to their original stores; all original records are retained." }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const { result } = await store.mutate((state: StoredProjectState) => {
    if (state.migrations[journalId]) return { imported: 0, duplicate: true };
    if (!state.projects.some((project) => project.id === preview.projectId)) throw new Error("Migration project is not attached.");
    if (state.sessions.some((session) => session.projectId === preview.projectId && session.runs.some((run) => ["queued", "running", "awaiting_approval", "stopping"].includes(run.status)))) throw new Error("Stop active project runs before importing history.");
    for (const session of preview.sessions) if (state.sessions.some((existing) => existing.id === session.id)) throw new Error(`Shared session ${session.id} already exists; original history preserved.`);
    state.sessions.push(...structuredClone(preview.sessions)); state.warnings.push(...preview.warnings); state.migrations[journalId] = directory;
    return { imported: preview.sessions.length, duplicate: false };
  });
  return result;
}
