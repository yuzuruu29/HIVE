/** Shared client contract. UI selection, drafts and scroll never belong in this model. */
export type SessionMode = "chat" | "code" | "plan" | "review";
export type SessionPermissions = "guarded" | "standard" | "autonomous";
export type SharedRunStatus = "queued" | "running" | "awaiting_approval" | "stopping" | "completed" | "cancelled" | "failed" | "interrupted";
export interface SessionSettings {
  mode: SessionMode;
  permissions: SessionPermissions;
  providerId?: string;
  model?: string;
}
export interface SharedExecutionContext {
  skillIds?: string[]; enabledMcpServers?: string[]; enabledLspServers?: string[];
  pluginAgentId?: string | null; outputStyleId?: string | null;
  invokedSkills?: Array<{ id: string; arguments: string }>; imagePaths?: string[];
}
export interface WorkspaceRef { id: string; path: string; branch: string; repositoryId: string }
export interface SharedProject {
  id: string; name: string; repositoryId: string; repositoryPath: string;
  workspaces: WorkspaceRef[]; lastSessionId: string | null; createdAt: string; updatedAt: string;
}
export interface LegacySource { kind: "cli" | "thread" | "chat" | "coding"; id: string; path: string; digest: string }
export interface SharedMessage { id: string; role: "user" | "assistant" | "system"; text: string; createdAt: string; runId?: string }
export interface RunPatch {
  path: string; previousPath?: string; additions: number; deletions: number;
  state: "proposed" | "applied"; workspace: string; baseRevision?: string;
  diff?: string; binary?: boolean; truncated?: boolean; stale?: boolean;
}
export interface RunCheck {
  id: string; name: string; command: string; workspace: string;
  status: "passed" | "failed" | "not_run" | "cancelled"; exitCode: number | null;
  startedAt?: string; endedAt?: string; output?: string;
}
export interface SharedActivity {
  id: string; sequence: number; role: string; kind: string; text: string; createdAt: string;
  source?: { codingSessionId: string; sequence: number };
}
export interface SharedApproval {
  id: string; runId: string; tool: string; description: string; input: Record<string, unknown>;
  workspace: string; external: boolean; createdAt: string; expiresAt: string;
  status: "pending" | "approved" | "declined" | "expired";
}
export interface SharedRun {
  id: string; sessionId: string; requestId: string; workspaceId: string; workspace: string;
  status: SharedRunStatus; settings: SessionSettings; effectivePolicy: string;
  startedAt: string; endedAt: string | null; summary: string; events: SharedActivity[];
  patches: RunPatch[]; checks: RunCheck[]; reviewedAt?: string;
  engine: "live" | "unavailable" | "imported"; engineSessionId?: string;
  parentRunId?: string; approvals: SharedApproval[];
  executionContext?: SharedExecutionContext;
}
export interface SharedSession {
  id: string; projectId: string; workspaceId: string; title: string; archived: boolean;
  createdAt: string; updatedAt: string; settings: SessionSettings;
  messages: SharedMessage[]; runs: SharedRun[]; sources: LegacySource[];
  forkedFrom?: string;
}
export interface ProjectSnapshot { schemaVersion: 1; revision: number; projects: SharedProject[]; sessions: SharedSession[]; warnings: string[] }
export interface HistoryImportPreview {
  projectId: string; workspaceId: string; digest: string;
  counts: { cli: number; thread: number; chat: number; messages: number };
  warnings: string[]; sessions: Array<{ id: string; title: string; messages: number }>; alreadyImported: boolean;
}
export interface HistoryImportResult {
  imported: number; duplicate: boolean; backupDirectory: string; snapshot: ProjectSnapshot;
}
export type ProjectAction = { requestId: string } & (
  | { type: "project.attach"; path: string; name?: string }
  | { type: "project.rename"; projectId: string; name: string }
  | { type: "session.create"; projectId: string; workspaceId?: string; title?: string; settings?: Partial<SessionSettings> }
  | { type: "session.select" | "session.archive" | "session.restore"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.fork"; sessionId: string; title?: string }
  | { type: "session.settings"; sessionId: string; settings: Partial<SessionSettings> }
  | { type: "session.send"; sessionId: string; text: string; parentRunId?: string; executionContext?: SharedExecutionContext }
  | { type: "run.cancel" | "run.review"; sessionId: string; runId: string }
  | { type: "run.approve"; sessionId: string; runId: string; approvalId: string; approved: boolean }
);
export interface ProjectActionResult { projectId?: string; sessionId?: string; runId?: string; duplicate?: boolean }
export interface ProjectActionResponse { snapshot: ProjectSnapshot; result: ProjectActionResult }
export interface AcceptedRun { project: SharedProject; session: SharedSession; run: SharedRun; text: string }
export type EngineUserEvent =
  | { type: "activity"; role: string; kind: string; text: string; source?: SharedActivity["source"] }
  | { type: "text"; text: string }
  | { type: "evidence"; patches?: RunPatch[]; checks?: RunCheck[] }
  | { type: "engine"; engineSessionId: string; effectivePolicy?: string };
export interface EngineOutcome {
  status: "completed" | "cancelled" | "failed" | "interrupted";
  summary: string; text?: string; engineSessionId?: string; patches?: RunPatch[]; checks?: RunCheck[];
}
export interface EngineHooks {
  persist(event: EngineUserEvent): Promise<void>;
  requestApproval(input: { tool: string; description: string; input: Record<string, unknown>; external: boolean; workspace?: string; timeoutMs?: number }): Promise<boolean>;
}
export interface EngineHandle { completion: Promise<EngineOutcome>; cancel(reason: string): Promise<void> | void; pause?(reason: string): Promise<boolean> }
export interface SessionEngineAdapter { start(input: AcceptedRun, hooks: EngineHooks): EngineHandle | Promise<EngineHandle> }
