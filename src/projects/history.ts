import path from "node:path";
import { previewLegacyImport, importLegacyPreview } from "./migration.js";
import { identifyProject, ACTIVE_RUN_STATUSES } from "./run-control.js";
import type { ProjectSessionService } from "./service.js";
import type { HistoryImportPreview, HistoryImportResult } from "./types.js";
export type { HistoryImportPreview, HistoryImportResult } from "./types.js";

/** Explicit migration entry point shared by both clients. Source stores remain the rollback path. */
export class ProjectHistoryService {
  constructor(private readonly projects: Pick<ProjectSessionService, "snapshot" | "store">) {}
  private async preview(projectId: string, workspaceId?: string) {
    const snapshot = await this.projects.snapshot();
    const project = snapshot.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error("Migration project is not attached.");
    const workspace = project.workspaces.find((entry) => !workspaceId || entry.id === workspaceId);
    if (!workspace) throw new Error("Migration workspace is not attached.");
    const identity = await identifyProject(workspace.path, { create: false });
    if (identity.id !== project.id || identity.workspace.id !== workspace.id) throw new Error("Migration workspace identity changed; attach the correct project again.");
    const preview = await previewLegacyImport(workspace.path, project);
    const state = await this.projects.store.load();
    const journal = state.migrations[`${projectId}:${preview.digest}`];
    return { preview, workspace, journal };
  }
  async previewImport(projectId: string, workspaceId?: string): Promise<HistoryImportPreview> {
    const { preview, workspace, journal } = await this.preview(projectId, workspaceId);
    return { projectId, workspaceId: workspace.id, digest: preview.digest, counts: preview.counts, warnings: preview.warnings, sessions: preview.sessions.map((session) => ({ id: session.id, title: session.title, messages: session.messages.length })), alreadyImported: Boolean(journal) };
  }
  async importHistory(projectId: string, digest: string, workspaceId?: string): Promise<HistoryImportResult> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Migration confirmation digest is invalid.");
    const { preview, workspace } = await this.preview(projectId, workspaceId);
    if (preview.digest !== digest) throw new Error("Legacy history changed after preview; inspect a new preview before importing.");
    const before = await this.projects.snapshot();
    if (before.sessions.some((session) => session.projectId === projectId && session.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)))) throw new Error("Stop active project runs before importing history.");
    const result = await importLegacyPreview(this.projects.store, preview, path.join(path.dirname(this.projects.store.file), "migration-backups"));
    const state = await this.projects.store.load();
    const backupDirectory = state.migrations[`${projectId}:${digest}`];
    if (!backupDirectory || !workspace.id) throw new Error("Import journal could not be verified. Original stores remain preserved.");
    return { ...result, backupDirectory, snapshot: await this.projects.snapshot() };
  }
}
