import type {
  ApprovalPolicy,
  CodeMode,
  CodingFinalReport,
  CodingSessionStatus,
  RuntimeEvent,
} from "../coding/types.js";
import type { ProviderKind } from "../providers/types.js";

export const DESKTOP_THREAD_SCHEMA_VERSION = 1 as const;
export const MAX_THREAD_MESSAGE_CHARS = 20_000;
export const MAX_THREAD_CONTEXT_CHARS = 20_000;

export type ThreadMessageRole = "user" | "assistant" | "system";

export interface ThreadMessage {
  id: string;
  role: ThreadMessageRole;
  content: string;
  createdAt: string;
}

export interface ThreadRunRef {
  userMessageId: string;
  codingSessionId: string;
  status: CodingSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRecordV1 {
  schemaVersion: typeof DESKTOP_THREAD_SCHEMA_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: ThreadMessage[];
  runs: ThreadRunRef[];
}

export interface CreateThreadInput {
  id?: string;
  title: string;
}

export interface ThreadStore {
  list(): Promise<ThreadRecordV1[]>;
  create(input: CreateThreadInput): Promise<ThreadRecordV1>;
  load(threadId: string): Promise<ThreadRecordV1 | null>;
  save(thread: ThreadRecordV1): Promise<ThreadRecordV1>;
  appendMessage(threadId: string, message: ThreadMessage): Promise<ThreadRecordV1>;
  mutate(threadId: string, update: (thread: ThreadRecordV1) => ThreadRecordV1 | void): Promise<ThreadRecordV1>;
  archive(threadId: string): Promise<ThreadRecordV1>;
}

export type DesktopCredentialKind = "api-key" | "bearer" | "oauth";

export interface ResolvedDesktopCredential {
  providerId: string;
  kind: DesktopCredentialKind;
  secret: string;
}

export interface CredentialResolver {
  resolve(providerId: string): Promise<ResolvedDesktopCredential | null>;
}

export interface DesktopRunOptions {
  mode: CodeMode;
  approvalPolicy: ApprovalPolicy;
  maxAgents?: number;
  maxRetries?: number;
  providerId?: string;
  model?: string;
}

export interface DesktopRunStartRequest {
  repositoryRoot: string;
  threadId: string;
  currentUserMessageId: string;
  options: DesktopRunOptions;
}

export interface DesktopRunResumeRequest {
  repositoryRoot: string;
  threadId: string;
  codingSessionId: string;
  options: DesktopRunOptions;
}

export interface DesktopRunReferenceRequest {
  repositoryRoot: string;
  threadId: string;
  codingSessionId: string;
}

export interface DesktopRunManager {
  start(request: DesktopRunStartRequest): Promise<ThreadRunRef>;
  pause(request: DesktopRunReferenceRequest): Promise<void>;
  resume(request: DesktopRunResumeRequest): Promise<ThreadRunRef>;
  cancel(request: DesktopRunReferenceRequest): Promise<void>;
  get(request: DesktopRunReferenceRequest): Promise<ThreadRunRef | null>;
}

export interface GuardedGitStatus {
  repositoryRoot: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changedFiles: string[];
  ahead: number;
  behind: number;
}

interface GuardedGitPreviewBase {
  repositoryRoot: string;
  codingSessionId: string;
}

export interface GuardedGitCommitPreviewInput extends GuardedGitPreviewBase {
  action: "commit";
  message: string;
  paths: string[];
}

export interface GuardedGitPushPreviewInput extends GuardedGitPreviewBase {
  action: "push";
  remote: string;
}

export interface GuardedGitPullRequestPreviewInput extends GuardedGitPreviewBase {
  action: "pull-request";
  remote: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface GuardedGitDiscardPreviewInput extends GuardedGitPreviewBase {
  action: "discard";
}

export type GuardedGitPreviewInput =
  | GuardedGitCommitPreviewInput
  | GuardedGitPushPreviewInput
  | GuardedGitPullRequestPreviewInput
  | GuardedGitDiscardPreviewInput;

export interface GuardedGitActionPreview {
  confirmationToken: string;
  proposal: GuardedGitPreviewInput;
  observedHead: string | null;
  summary: string;
  createdAt: string;
  expiresAt: string;
  oneUse: true;
}

export interface GuardedGitDiscardConfirmationInput {
  confirmationToken: string;
  proposal: GuardedGitDiscardPreviewInput;
}

export interface GuardedGitCommitConfirmationInput {
  confirmationToken: string;
  proposal: GuardedGitCommitPreviewInput;
}

export interface GuardedGitPushConfirmationInput {
  confirmationToken: string;
  proposal: GuardedGitPushPreviewInput;
}

export interface GuardedGitPullRequestConfirmationInput {
  confirmationToken: string;
  proposal: GuardedGitPullRequestPreviewInput;
}

export type GuardedGitConfirmationInput =
  | GuardedGitCommitConfirmationInput
  | GuardedGitPushConfirmationInput
  | GuardedGitPullRequestConfirmationInput
  | GuardedGitDiscardConfirmationInput;

export interface GuardedGitResult {
  head: string | null;
  summary: string;
}

export interface GuardedGitService {
  inspect(repositoryRoot: string): Promise<GuardedGitStatus>;
  inspectDiff(request: DesktopChangesDiffRequest): Promise<DesktopChangesDiff>;
  prepareConfirmation(proposal: GuardedGitPreviewInput): Promise<GuardedGitActionPreview>;
  confirmCommit(input: GuardedGitCommitConfirmationInput): Promise<GuardedGitResult>;
  confirmPush(input: GuardedGitPushConfirmationInput): Promise<GuardedGitResult>;
  confirmPullRequest(input: GuardedGitPullRequestConfirmationInput): Promise<{ url: string }>;
  confirmDiscard(input: GuardedGitDiscardConfirmationInput): Promise<void>;
}

export interface DesktopProviderMetadata {
  id: string;
  name: string;
  kind: ProviderKind;
  authType: "api-key" | "bearer" | "oauth" | "none";
  baseUrl?: string;
  defaultModel?: string;
  approved: boolean;
  configured: boolean;
}

export interface DesktopProviderConfigurationInput {
  id: string;
  name: string;
  kind: ProviderKind;
  authType: DesktopProviderMetadata["authType"];
  baseUrl?: string;
  defaultModel?: string;
  approved: boolean;
}

export interface DesktopCredentialMetadata {
  providerId: string;
  kind: DesktopCredentialKind;
  configured: boolean;
  updatedAt?: string;
  displayHint?: string;
}

export interface DesktopCredentialWriteInput {
  providerId: string;
  kind: DesktopCredentialKind;
  secret: string;
}

export interface DesktopCredentialReference {
  providerId: string;
  kind: DesktopCredentialKind;
}

export interface DesktopCredentialTestResult {
  providerId: string;
  ok: boolean;
  message: string;
}

export interface DesktopChangesDiffRequest {
  repositoryRoot: string;
  codingSessionId: string;
  paths?: string[];
  staged?: boolean;
}

export interface DesktopChangesDiff {
  repositoryRoot: string;
  codingSessionId: string;
  patch: string;
  truncated: boolean;
  recordedFiles: string[];
  reviewedFiles: string[];
  commitEligibility: "eligible" | "session-not-completed" | "validation-required" | "review-required" | "no-recorded-files";
}

export interface DesktopRecentRepository {
  path: string;
  lastOpenedAt: string;
}

export interface DesktopOpenEditorRequest {
  repositoryRoot: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface DesktopOpenExplorerRequest {
  repositoryRoot: string;
  path?: string;
}

type DesktopCommandBase = { requestId: string };

export type DesktopCommand =
  | (DesktopCommandBase & { type: "repository.list" })
  | (DesktopCommandBase & { type: "repository.open"; repositoryRoot: string })
  | (DesktopCommandBase & { type: "thread.list" })
  | (DesktopCommandBase & { type: "thread.create"; input: CreateThreadInput })
  | (DesktopCommandBase & { type: "thread.load"; threadId: string })
  | (DesktopCommandBase & { type: "thread.message.append"; input: { threadId: string; message: ThreadMessage } })
  | (DesktopCommandBase & { type: "thread.archive"; threadId: string })
  | (DesktopCommandBase & { type: "run.start"; input: DesktopRunStartRequest })
  | (DesktopCommandBase & { type: "run.pause"; input: DesktopRunReferenceRequest })
  | (DesktopCommandBase & { type: "run.resume"; input: DesktopRunResumeRequest })
  | (DesktopCommandBase & { type: "run.cancel"; input: DesktopRunReferenceRequest })
  | (DesktopCommandBase & { type: "run.report"; input: DesktopRunReferenceRequest })
  | (DesktopCommandBase & { type: "provider.list" })
  | (DesktopCommandBase & { type: "provider.metadata"; providerId: string })
  | (DesktopCommandBase & { type: "provider.configure"; input: DesktopProviderConfigurationInput })
  | (DesktopCommandBase & { type: "credential.list" })
  | (DesktopCommandBase & { type: "credential.metadata"; providerId: string })
  | (DesktopCommandBase & { type: "credential.set"; input: DesktopCredentialWriteInput })
  | (DesktopCommandBase & { type: "credential.replace"; input: DesktopCredentialWriteInput })
  | (DesktopCommandBase & { type: "credential.remove"; input: DesktopCredentialReference })
  | (DesktopCommandBase & { type: "credential.test"; input: DesktopCredentialReference })
  | (DesktopCommandBase & { type: "git.inspect"; repositoryRoot: string })
  | (DesktopCommandBase & { type: "changes.diff"; input: DesktopChangesDiffRequest })
  | (DesktopCommandBase & { type: "git.commit.preview"; input: GuardedGitCommitPreviewInput })
  | (DesktopCommandBase & { type: "git.commit.confirm"; input: GuardedGitCommitConfirmationInput })
  | (DesktopCommandBase & { type: "git.push.preview"; input: GuardedGitPushPreviewInput })
  | (DesktopCommandBase & { type: "git.push.confirm"; input: GuardedGitPushConfirmationInput })
  | (DesktopCommandBase & { type: "git.pull-request.preview"; input: GuardedGitPullRequestPreviewInput })
  | (DesktopCommandBase & {
      type: "git.pull-request.confirm";
      input: GuardedGitPullRequestConfirmationInput;
    })
  | (DesktopCommandBase & { type: "git.discard.preview"; input: GuardedGitDiscardPreviewInput })
  | (DesktopCommandBase & { type: "git.discard.confirm"; input: GuardedGitDiscardConfirmationInput })
  | (DesktopCommandBase & { type: "external.open-editor"; input: DesktopOpenEditorRequest })
  | (DesktopCommandBase & { type: "external.open-terminal"; repositoryRoot: string })
  | (DesktopCommandBase & { type: "external.open-explorer"; input: DesktopOpenExplorerRequest });

type DesktopEventBase = { timestamp: string; requestId?: string; repositoryRoot?: string };

export type DesktopEvent =
  | (DesktopEventBase & { type: "desktop.ready"; repositoryRoot: string })
  | (DesktopEventBase & { type: "repository.listed"; repositories: DesktopRecentRepository[] })
  | (DesktopEventBase & { type: "thread.changed"; thread: ThreadRecordV1 })
  | (DesktopEventBase & { type: "thread.listed"; threads: ThreadRecordV1[] })
  | (DesktopEventBase & { type: "run.changed"; run: ThreadRunRef })
  | (DesktopEventBase & { type: "run.pause-requested"; codingSessionId: string })
  | (DesktopEventBase & { type: "run.reported"; codingSessionId: string; report: CodingFinalReport | null })
  | (DesktopEventBase & { type: "runtime.event"; event: RuntimeEvent })
  | (DesktopEventBase & { type: "worker.starting"; codingSessionId: string })
  | (DesktopEventBase & { type: "worker.started"; codingSessionId: string; processId: number })
  | (DesktopEventBase & {
      type: "worker.stopped";
      codingSessionId: string;
      exitCode: number | null;
      signal?: string;
      expected: boolean;
    })
  | (DesktopEventBase & {
      type: "worker.failed";
      codingSessionId?: string;
      message: string;
      recoverable: boolean;
    })
  | (DesktopEventBase & { type: "provider.listed"; providers: DesktopProviderMetadata[] })
  | (DesktopEventBase & { type: "provider.changed"; provider: DesktopProviderMetadata })
  | (DesktopEventBase & { type: "credential.listed"; credentials: DesktopCredentialMetadata[] })
  | (DesktopEventBase & { type: "credential.changed"; credential: DesktopCredentialMetadata })
  | (DesktopEventBase & { type: "credential.tested"; result: DesktopCredentialTestResult })
  | (DesktopEventBase & { type: "git.changed"; status: GuardedGitStatus })
  | (DesktopEventBase & { type: "git.previewed"; preview: GuardedGitActionPreview })
  | (DesktopEventBase & {
      type: "git.action-completed";
      action: GuardedGitPreviewInput["action"];
      head?: string | null;
      summary?: string;
      url?: string;
    })
  | (DesktopEventBase & { type: "changes.diffed"; diff: DesktopChangesDiff })
  | (DesktopEventBase & { type: "request.completed"; requestId: string })
  | (DesktopEventBase & {
      type: "request.failed";
      requestId: string;
      message: string;
      recoverable: boolean;
    });
