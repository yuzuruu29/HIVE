import path from "node:path";
import type { DesktopCommand, DesktopEvent, ThreadRecordV1 } from "../types.js";
import { containsKnownSecret, isCredentialFieldName } from "../../security/secrets.js";
import { DESKTOP_COMMAND_TYPE_SET } from "./command-manifest.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MODES = new Set(["auto", "plan", "review"]);
const APPROVAL_POLICIES = new Set(["safe", "changes", "always"]);
const CREDENTIAL_KINDS = new Set(["api-key", "bearer", "oauth"]);
const PROVIDER_KINDS = new Set(["openai", "openai-compatible", "openrouter", "anthropic", "google", "ollama", "local", "oauth", "custom"]);
const AUTH_TYPES = new Set(["api-key", "bearer", "oauth", "none"]);
const RUN_STATUSES = new Set(["created", "planning", "planned", "running", "paused", "validating", "reviewing", "fixing", "completed", "failed", "cancelled"]);
const RUNTIME_EVENT_TYPES = new Set(["session.created", "session.started", "session.paused", "session.resumed", "session.cancelled", "session.completed", "plan.created", "task.created", "task.ready", "task.started", "task.progress", "task.blocked", "task.retrying", "task.completed", "task.failed", "task.cancelled", "task.skipped", "subagent.created", "subagent.queued", "subagent.started", "subagent.progress", "subagent.tool_call", "subagent.file_changed", "subagent.blocked", "subagent.retrying", "subagent.validating", "subagent.completed", "subagent.failed", "subagent.cancelled", "subagent.skipped", "subagent.status_changed", "file.changed", "command.started", "command.output", "command.completed", "validation.started", "validation.completed", "review.completed"]);
const RUNTIME_PAYLOAD_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  "session.created": { required: ["objective", "mode", "approvalPolicy"], optional: [] }, "session.started": { required: ["repository"], optional: [] }, "session.paused": { required: ["reason"], optional: [] }, "session.resumed": { required: [], optional: ["repository", "staleTaskIds"] }, "session.cancelled": { required: [], optional: ["reason"] }, "session.completed": { required: ["report"], optional: [] }, "plan.created": { required: ["summary", "taskIds"], optional: [] }, "task.created": { required: ["task"], optional: [] }, "task.ready": { required: ["taskId"], optional: [] }, "task.started": { required: ["taskId", "attempt"], optional: [] }, "task.progress": { required: ["taskId", "message"], optional: ["percent"] }, "task.blocked": { required: ["taskId", "reason"], optional: [] }, "task.retrying": { required: ["taskId", "attempt", "delayMs", "error"], optional: [] }, "task.completed": { required: ["taskId"], optional: ["summary"] }, "task.failed": { required: ["taskId", "error"], optional: [] }, "task.cancelled": { required: ["taskId"], optional: ["reason"] }, "task.skipped": { required: ["taskId", "reason"], optional: [] }, "subagent.created": { required: ["subagentId", "task"], optional: [] }, "subagent.queued": { required: ["subagentId"], optional: [] }, "subagent.started": { required: ["subagentId", "attempt"], optional: [] }, "subagent.progress": { required: ["subagentId", "message"], optional: ["percent"] }, "subagent.tool_call": { required: ["subagentId", "tool"], optional: ["input"] }, "subagent.file_changed": { required: ["subagentId", "path", "operation"], optional: [] }, "subagent.blocked": { required: ["subagentId", "reason"], optional: [] }, "subagent.retrying": { required: ["subagentId", "attempt", "delayMs", "error"], optional: [] }, "subagent.validating": { required: ["subagentId", "commands"], optional: [] }, "subagent.completed": { required: ["subagentId"], optional: ["summary"] }, "subagent.failed": { required: ["subagentId", "error"], optional: [] }, "subagent.cancelled": { required: ["subagentId"], optional: ["reason"] }, "subagent.skipped": { required: ["subagentId", "reason"], optional: [] }, "subagent.status_changed": { required: ["subagentId", "previousStatus", "status", "task"], optional: ["reason"] }, "file.changed": { required: ["change"], optional: [] }, "command.started": { required: ["commandId", "command", "cwd"], optional: ["taskId"] }, "command.output": { required: ["commandId", "stream", "chunk"], optional: ["truncated"] }, "command.completed": { required: ["commandId", "exitCode", "durationMs"], optional: ["signal"] }, "validation.started": { required: ["validationId", "command"], optional: ["taskId"] }, "validation.completed": { required: ["result"], optional: [] }, "review.completed": { required: ["result"], optional: [] },
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const candidate = record(value, label);
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
  return candidate;
}

function optionalExact(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const candidate = record(value, label);
  for (const key of required) if (!(key in candidate)) throw new Error(`${label} has unexpected or missing fields.`);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) throw new Error(`${label} has unexpected or missing fields.`);
  return candidate;
}

function string(value: unknown, label: string, maximum = 20_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  const result = string(value, label, 128);
  if (!ID.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function iso(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} is invalid.`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const result = string(value, label, 32_768);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute.`);
  return result;
}

function relativePath(value: unknown, label: string): string {
  const result = string(value, label, 4_096).replaceAll("\\", "/");
  const clean = path.posix.normalize(result);
  if (path.posix.isAbsolute(clean) || /^[A-Za-z]:\//.test(clean) || clean === ".." || clean.startsWith("../") || clean === ".git" || clean.startsWith(".git/")) {
    throw new Error(`${label} is invalid.`);
  }
  return clean;
}

function validateRunOptions(value: unknown): void {
  const candidate = optionalExact(value, ["mode", "approvalPolicy"], ["maxAgents", "maxRetries", "providerId", "model"], "run options");
  if (!MODES.has(String(candidate.mode))) throw new Error("run mode is invalid.");
  if (!APPROVAL_POLICIES.has(String(candidate.approvalPolicy))) throw new Error("approval policy is invalid.");
  for (const key of ["maxAgents", "maxRetries"] as const) {
    if (candidate[key] !== undefined && (!Number.isSafeInteger(candidate[key]) || Number(candidate[key]) < 0 || Number(candidate[key]) > 64)) {
      throw new Error(`${key} is invalid.`);
    }
  }
  if (candidate.providerId !== undefined && !PROVIDER_ID.test(string(candidate.providerId, "provider id", 96))) throw new Error("provider id is invalid.");
  if (candidate.model !== undefined) string(candidate.model, "model", 256);
}

function validateThread(value: unknown): asserts value is ThreadRecordV1 {
  const candidate = exact(value, ["schemaVersion", "id", "title", "createdAt", "updatedAt", "archived", "messages", "runs"], "thread");
  if (candidate.schemaVersion !== 1) throw new Error("thread schema version is invalid.");
  id(candidate.id, "thread id");
  string(candidate.title, "thread title", 200);
  iso(candidate.createdAt, "thread createdAt");
  iso(candidate.updatedAt, "thread updatedAt");
  boolean(candidate.archived, "thread archived state");
  if (!Array.isArray(candidate.messages)) throw new Error("thread messages are invalid.");
  for (const message of candidate.messages) {
    const item = exact(message, ["id", "role", "content", "createdAt"], "thread message");
    id(item.id, "message id");
    if (!["user", "assistant", "system"].includes(String(item.role))) throw new Error("thread message role is invalid.");
    string(item.content, "thread message content", 20_000);
    iso(item.createdAt, "message createdAt");
  }
  if (!Array.isArray(candidate.runs)) throw new Error("thread runs are invalid.");
  for (const run of candidate.runs) {
    const item = exact(run, ["userMessageId", "codingSessionId", "status", "createdAt", "updatedAt"], "thread run");
    id(item.userMessageId, "run message id");
    id(item.codingSessionId, "coding session id");
    if (!RUN_STATUSES.has(String(item.status))) throw new Error("thread run status is invalid.");
    iso(item.createdAt, "run createdAt");
    iso(item.updatedAt, "run updatedAt");
  }
}

function validateStart(value: unknown): void {
  const input = exact(value, ["repositoryRoot", "threadId", "currentUserMessageId", "options"], "run start input");
  absolutePath(input.repositoryRoot, "repository root"); id(input.threadId, "thread id"); id(input.currentUserMessageId, "message id"); validateRunOptions(input.options);
}

function validateResume(value: unknown): void {
  const input = exact(value, ["repositoryRoot", "threadId", "codingSessionId", "options"], "run resume input");
  absolutePath(input.repositoryRoot, "repository root"); id(input.threadId, "thread id"); id(input.codingSessionId, "coding session id"); validateRunOptions(input.options);
}

function validateRunReference(value: unknown): void {
  const input = exact(value, ["repositoryRoot", "threadId", "codingSessionId"], "run reference");
  absolutePath(input.repositoryRoot, "repository root"); id(input.threadId, "thread id"); id(input.codingSessionId, "coding session id");
}

function validateCredentialReference(value: unknown): void {
  const input = exact(value, ["providerId", "kind"], "credential reference");
  if (!PROVIDER_ID.test(string(input.providerId, "provider id", 96))) throw new Error("provider id is invalid.");
  if (!CREDENTIAL_KINDS.has(String(input.kind))) throw new Error("credential kind is invalid.");
}

function validateCredentialWrite(value: unknown): void {
  const input = exact(value, ["providerId", "kind", "secret"], "credential input");
  validateCredentialReference({ providerId: input.providerId, kind: input.kind });
  string(input.secret, "credential secret", 100_000);
}

function validateProviderConfiguration(value: unknown): void {
  const input = optionalExact(value, ["id", "name", "kind", "authType", "approved"], ["baseUrl", "defaultModel"], "provider configuration");
  if (!PROVIDER_ID.test(string(input.id, "provider id", 96))) throw new Error("provider id is invalid.");
  string(input.name, "provider name", 200);
  if (!PROVIDER_KINDS.has(String(input.kind))) throw new Error("provider kind is invalid.");
  if (!AUTH_TYPES.has(String(input.authType))) throw new Error("provider auth type is invalid.");
  boolean(input.approved, "provider approval");
  if (input.baseUrl !== undefined) {
    const url = new URL(string(input.baseUrl, "provider base URL", 2_048));
    if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("provider base URL is invalid.");
  }
  if (input.defaultModel !== undefined) string(input.defaultModel, "default model", 256);
}

function validateDiff(value: unknown): void {
  const input = optionalExact(value, ["repositoryRoot", "codingSessionId"], ["paths", "staged"], "diff request");
  absolutePath(input.repositoryRoot, "repository root"); id(input.codingSessionId, "coding session id");
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.length > 1_000) throw new Error("diff paths are invalid.");
    input.paths.forEach((entry, index) => relativePath(entry, `diff path ${index}`));
  }
  if (input.staged !== undefined) boolean(input.staged, "staged flag");
}

function validateGitProposal(value: unknown, action: string): void {
  const base = ["action", "repositoryRoot", "codingSessionId"];
  const extras = action === "commit" ? ["message", "paths"] : action === "push" ? ["remote"] : action === "pull-request" ? ["remote", "base", "title", "body", "draft"] : [];
  const input = exact(value, [...base, ...extras], `${action} proposal`);
  if (input.action !== action) throw new Error("Git proposal action is invalid.");
  absolutePath(input.repositoryRoot, "repository root"); id(input.codingSessionId, "coding session id");
  if (action === "commit") {
    string(input.message, "commit message", 4_096);
    if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 1_000) throw new Error("commit paths are invalid.");
    input.paths.forEach((entry, index) => relativePath(entry, `commit path ${index}`));
  } else if (action === "push") string(input.remote, "remote", 200);
  else if (action === "pull-request") {
    string(input.remote, "remote", 200); string(input.base, "base branch", 200); string(input.title, "pull request title", 500); string(input.body, "pull request body", 50_000); boolean(input.draft, "draft flag");
  }
}

function validateGitConfirmation(value: unknown, action: string): void {
  const input = exact(value, ["confirmationToken", "proposal"], `${action} confirmation`);
  id(input.confirmationToken, "confirmation token");
  validateGitProposal(input.proposal, action);
}

export function validateDesktopCommand(value: unknown): DesktopCommand {
  const root = record(value, "desktop command");
  const type = string(root.type, "desktop command type", 80);
  if (!DESKTOP_COMMAND_TYPE_SET.has(type)) throw new Error(`Unsupported desktop command type: ${type}.`);
  const requestId = id(root.requestId, "request id");
  const noPayload = new Set(["repository.list", "thread.list", "provider.list", "credential.list"]);
  if (noPayload.has(type)) exact(root, ["requestId", "type"], "desktop command");
  else switch (type) {
    case "repository.open": exact(root, ["requestId", "type", "repositoryRoot"], "desktop command"); absolutePath(root.repositoryRoot, "repository root"); break;
    case "thread.create": { exact(root, ["requestId", "type", "input"], "desktop command"); const input = optionalExact(root.input, ["title"], ["id"], "thread create input"); string(input.title, "thread title", 200); if (input.id !== undefined) id(input.id, "thread id"); break; }
    case "thread.load": case "thread.archive": exact(root, ["requestId", "type", "threadId"], "desktop command"); id(root.threadId, "thread id"); break;
    case "thread.message.append": {
      exact(root, ["requestId", "type", "input"], "desktop command");
      const input = exact(root.input, ["threadId", "message"], "append message input");
      id(input.threadId, "thread id");
      const message = exact(input.message, ["id", "role", "content", "createdAt"], "thread message");
      id(message.id, "message id");
      if (!new Set(["user", "assistant", "system"]).has(string(message.role, "message role", 20))) throw new Error("message role is invalid.");
      string(message.content, "message content", 20_000);
      iso(message.createdAt, "message createdAt");
      break;
    }
    case "run.start": exact(root, ["requestId", "type", "input"], "desktop command"); validateStart(root.input); break;
    case "run.resume": exact(root, ["requestId", "type", "input"], "desktop command"); validateResume(root.input); break;
    case "run.pause": case "run.cancel": case "run.report": exact(root, ["requestId", "type", "input"], "desktop command"); validateRunReference(root.input); break;
    case "provider.metadata": case "credential.metadata": exact(root, ["requestId", "type", "providerId"], "desktop command"); if (!PROVIDER_ID.test(string(root.providerId, "provider id", 96))) throw new Error("provider id is invalid."); break;
    case "provider.configure": exact(root, ["requestId", "type", "input"], "desktop command"); validateProviderConfiguration(root.input); break;
    case "credential.set": case "credential.replace": exact(root, ["requestId", "type", "input"], "desktop command"); validateCredentialWrite(root.input); break;
    case "credential.remove": case "credential.test": exact(root, ["requestId", "type", "input"], "desktop command"); validateCredentialReference(root.input); break;
    case "git.inspect": exact(root, ["requestId", "type", "repositoryRoot"], "desktop command"); absolutePath(root.repositoryRoot, "repository root"); break;
    case "changes.diff": exact(root, ["requestId", "type", "input"], "desktop command"); validateDiff(root.input); break;
    case "git.commit.preview": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitProposal(root.input, "commit"); break;
    case "git.push.preview": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitProposal(root.input, "push"); break;
    case "git.pull-request.preview": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitProposal(root.input, "pull-request"); break;
    case "git.discard.preview": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitProposal(root.input, "discard"); break;
    case "git.commit.confirm": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitConfirmation(root.input, "commit"); break;
    case "git.push.confirm": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitConfirmation(root.input, "push"); break;
    case "git.pull-request.confirm": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitConfirmation(root.input, "pull-request"); break;
    case "git.discard.confirm": exact(root, ["requestId", "type", "input"], "desktop command"); validateGitConfirmation(root.input, "discard"); break;
    case "external.open-terminal": exact(root, ["requestId", "type", "repositoryRoot"], "desktop command"); absolutePath(root.repositoryRoot, "repository root"); break;
    case "external.open-editor": { exact(root, ["requestId", "type", "input"], "desktop command"); const input = optionalExact(root.input, ["repositoryRoot"], ["path", "line", "column"], "editor request"); absolutePath(input.repositoryRoot, "repository root"); if (input.path !== undefined) relativePath(input.path, "editor path"); for (const key of ["line", "column"] as const) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1 || Number(input[key]) > 10_000_000)) throw new Error(`${key} is invalid.`); break; }
    case "external.open-explorer": { exact(root, ["requestId", "type", "input"], "desktop command"); const input = optionalExact(root.input, ["repositoryRoot"], ["path"], "explorer request"); absolutePath(input.repositoryRoot, "repository root"); if (input.path !== undefined) relativePath(input.path, "explorer path"); break; }
    default: throw new Error(`Unsupported desktop command type: ${type}.`);
  }
  return { ...root, requestId, type } as DesktopCommand;
}

const EVENT_KEYS: Record<DesktopEvent["type"], readonly string[]> = {
  "desktop.ready": ["type", "timestamp", "repositoryRoot"], "repository.listed": ["type", "timestamp", "repositories"], "thread.changed": ["type", "timestamp", "thread"], "thread.listed": ["type", "timestamp", "threads"],
  "run.changed": ["type", "timestamp", "run"], "run.pause-requested": ["type", "timestamp", "codingSessionId"], "run.reported": ["type", "timestamp", "codingSessionId", "report"], "runtime.event": ["type", "timestamp", "event"], "worker.starting": ["type", "timestamp", "codingSessionId"],
  "worker.started": ["type", "timestamp", "codingSessionId", "processId"], "worker.stopped": ["type", "timestamp", "codingSessionId", "exitCode", "signal", "expected"],
  "worker.failed": ["type", "timestamp", "codingSessionId", "message", "recoverable"], "provider.listed": ["type", "timestamp", "providers"],
  "provider.changed": ["type", "timestamp", "provider"], "credential.listed": ["type", "timestamp", "credentials"], "credential.changed": ["type", "timestamp", "credential"],
  "credential.tested": ["type", "timestamp", "result"], "git.changed": ["type", "timestamp", "status"], "git.previewed": ["type", "timestamp", "preview"],
  "git.action-completed": ["type", "timestamp", "action", "head", "summary", "url"],
  "changes.diffed": ["type", "timestamp", "diff"], "request.completed": ["type", "timestamp", "requestId"], "request.failed": ["type", "timestamp", "requestId", "message", "recoverable"],
};

export function validateDesktopEvent(value: unknown): DesktopEvent {
  const candidate = record(value, "desktop event");
  const type = string(candidate.type, "desktop event type", 80) as DesktopEvent["type"];
  const eventKeys = EVENT_KEYS[type];
  if (!eventKeys) throw new Error("Unsupported desktop event type.");
  const allowed = [...eventKeys, "requestId", "repositoryRoot"];
  const optional = new Set(["codingSessionId", "signal", "head", "summary", "url", "requestId", "repositoryRoot"]);
  const required = allowed.filter((key) => !optional.has(key));
  optionalExact(candidate, required, allowed.filter((key) => optional.has(key)), "desktop event");
  iso(candidate.timestamp, "desktop event timestamp");
  if (candidate.requestId !== undefined) id(candidate.requestId, "request id");
  if (candidate.repositoryRoot !== undefined) absolutePath(candidate.repositoryRoot, "event repository root");
  switch (type) {
    case "desktop.ready": absolutePath(candidate.repositoryRoot, "repository root"); break;
    case "repository.listed": if (!Array.isArray(candidate.repositories) || candidate.repositories.length > 100) throw new Error("Recent repository list is invalid."); candidate.repositories.forEach(validateRecentRepository); break;
    case "thread.changed": validateThread(candidate.thread); break;
    case "thread.listed": if (!Array.isArray(candidate.threads) || candidate.threads.length > 10_000) throw new Error("Desktop thread list is invalid."); candidate.threads.forEach(validateThread); break;
    case "run.changed": validateEventRun(candidate.run); break;
    case "run.pause-requested": id(candidate.codingSessionId, "coding session id"); break;
    case "run.reported": id(candidate.codingSessionId, "coding session id"); if (candidate.report !== null) validateFinalReport(candidate.report); break;
    case "runtime.event": validateRuntimeEvent(candidate.event); break;
    case "worker.starting": id(candidate.codingSessionId, "coding session id"); break;
    case "worker.started": id(candidate.codingSessionId, "coding session id"); if (!Number.isSafeInteger(candidate.processId) || Number(candidate.processId) < 1) throw new Error("Worker process id is invalid."); break;
    case "worker.stopped": id(candidate.codingSessionId, "coding session id"); if (candidate.exitCode !== null && (!Number.isSafeInteger(candidate.exitCode) || Math.abs(Number(candidate.exitCode)) > 65535)) throw new Error("Worker exit code is invalid."); if (candidate.signal !== undefined) boundaryString(candidate.signal, "worker signal", 64); boolean(candidate.expected, "worker expected flag"); break;
    case "worker.failed": if (candidate.codingSessionId !== undefined) id(candidate.codingSessionId, "coding session id"); boundaryString(candidate.message, "worker failure", 2_000); boolean(candidate.recoverable, "worker recoverable flag"); break;
    case "provider.listed": if (!Array.isArray(candidate.providers) || candidate.providers.length > 1_000) throw new Error("Provider list is invalid."); candidate.providers.forEach(validateEventProvider); break;
    case "provider.changed": validateEventProvider(candidate.provider); break;
    case "credential.listed": if (!Array.isArray(candidate.credentials) || candidate.credentials.length > 1_000) throw new Error("Credential list is invalid."); candidate.credentials.forEach(validateEventCredential); break;
    case "credential.changed": validateEventCredential(candidate.credential); break;
    case "credential.tested": { const result = exact(candidate.result, ["providerId", "ok", "message"], "credential test result"); providerId(result.providerId); boolean(result.ok, "credential test result"); boundaryString(result.message, "credential test message", 500); break; }
    case "git.changed": validateGitStatus(candidate.status); break;
    case "git.previewed": validateGitPreview(candidate.preview); break;
    case "git.action-completed": if (!["commit", "push", "pull-request", "discard"].includes(String(candidate.action))) throw new Error("Git action result is invalid."); if (candidate.head !== undefined && candidate.head !== null) boundaryString(candidate.head, "Git head", 128); if (candidate.summary !== undefined) boundaryString(candidate.summary, "Git summary", 2_000); if (candidate.url !== undefined) { const url = new URL(boundaryString(candidate.url, "pull request URL", 2_048)); if (url.protocol !== "https:") throw new Error("Pull request URL is invalid."); } break;
    case "changes.diffed": { const diff = exact(candidate.diff, ["repositoryRoot", "codingSessionId", "patch", "truncated", "recordedFiles", "reviewedFiles", "commitEligibility"], "desktop diff"); absolutePath(diff.repositoryRoot, "repository root"); id(diff.codingSessionId, "coding session id"); boundaryText(diff.patch, "diff patch", 1024 * 1024); boolean(diff.truncated, "diff truncated flag"); for (const key of ["recordedFiles", "reviewedFiles"] as const) { if (!Array.isArray(diff[key]) || diff[key].length > 10_000) throw new Error(`Desktop diff ${key} is invalid.`); diff[key].forEach((file) => relativePath(file, `desktop diff ${key} path`)); } if (!["eligible", "session-not-completed", "validation-required", "review-required", "no-recorded-files"].includes(String(diff.commitEligibility))) throw new Error("Desktop diff commit eligibility is invalid."); break; }
    case "request.completed": break;
    case "request.failed": boundaryString(candidate.message, "request failure", 2_000); boolean(candidate.recoverable, "request recoverable flag"); break;
  }
  return candidate as unknown as DesktopEvent;
}

function validateRecentRepository(value: unknown): void {
  const repository = exact(value, ["path", "lastOpenedAt"], "recent repository");
  absolutePath(repository.path, "recent repository path");
  iso(repository.lastOpenedAt, "recent repository timestamp");
}

function validateFinalReport(value: unknown): void {
  const report = exact(value, ["result", "subagents", "filesChanged", "validation", "review", "outstanding", "completedAt"], "coding final report");
  boundaryText(report.result, "report result", 100_000);
  iso(report.completedAt, "report completedAt");
  const counts = exact(report.subagents, ["total", "active", "working", "waiting", "blocked", "done", "completed", "failed", "cancelled", "skipped"], "report subagent counts");
  for (const [key, count] of Object.entries(counts)) if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 1_000_000) throw new Error(`Report subagent ${key} is invalid.`);
  for (const key of ["filesChanged", "review", "outstanding"] as const) {
    const entries = report[key];
    if (!Array.isArray(entries) || entries.length > 10_000 || entries.some((entry) => typeof entry !== "string" || entry.length > 32_768 || containsKnownSecret(entry))) throw new Error(`Report ${key} is invalid.`);
  }
  if (!Array.isArray(report.validation) || report.validation.length > 10_000) throw new Error("Report validation is invalid.");
  for (const item of report.validation) {
    const result = exact(item, ["label", "status"], "report validation item");
    boundaryString(result.label, "report validation label", 2_000);
    if (!["pending", "running", "passed", "failed", "cancelled"].includes(String(result.status))) throw new Error("Report validation status is invalid.");
  }
}

function boundaryString(value: unknown, label: string, maximum: number): string {
  const result = string(value, label, maximum);
  if (containsKnownSecret(result)) throw new Error(`${label} contains secret-shaped data.`);
  return result;
}

function boundaryText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new Error(`${label} is invalid.`);
  if (containsKnownSecret(value)) throw new Error(`${label} contains secret-shaped data.`);
  return value;
}

function providerId(value: unknown): string { const result = string(value, "provider id", 96); if (!PROVIDER_ID.test(result)) throw new Error("provider id is invalid."); return result; }

function validateEventRun(value: unknown): void {
  const run = exact(value, ["userMessageId", "codingSessionId", "status", "createdAt", "updatedAt"], "desktop run");
  id(run.userMessageId, "message id"); id(run.codingSessionId, "coding session id"); if (!RUN_STATUSES.has(String(run.status))) throw new Error("run status is invalid."); iso(run.createdAt, "run createdAt"); iso(run.updatedAt, "run updatedAt");
}

function validateEventProvider(value: unknown): void {
  const provider = optionalExact(value, ["id", "name", "kind", "authType", "approved", "configured"], ["baseUrl", "defaultModel"], "provider metadata");
  providerId(provider.id); boundaryString(provider.name, "provider name", 200); if (!PROVIDER_KINDS.has(String(provider.kind))) throw new Error("provider kind is invalid."); if (!AUTH_TYPES.has(String(provider.authType))) throw new Error("provider auth type is invalid."); boolean(provider.approved, "provider approval"); boolean(provider.configured, "provider configured flag");
  if (provider.baseUrl !== undefined) { const url = new URL(boundaryString(provider.baseUrl, "provider URL", 2_048)); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("provider URL is invalid."); }
  if (provider.defaultModel !== undefined) boundaryString(provider.defaultModel, "provider model", 256);
}

function validateEventCredential(value: unknown): void {
  const credential = optionalExact(value, ["providerId", "kind", "configured"], ["updatedAt", "displayHint"], "credential metadata");
  providerId(credential.providerId); if (!CREDENTIAL_KINDS.has(String(credential.kind))) throw new Error("credential kind is invalid."); boolean(credential.configured, "credential configured flag"); if (credential.updatedAt !== undefined) iso(credential.updatedAt, "credential timestamp"); if (credential.displayHint !== undefined) boundaryString(credential.displayHint, "credential display hint", 32);
}

function validateRuntimeEvent(value: unknown): void {
  const runtime = exact(value, ["schemaVersion", "id", "sequence", "sessionId", "timestamp", "type", "payload"], "runtime event");
  if (runtime.schemaVersion !== 1) throw new Error("Runtime event schema is invalid."); id(runtime.id, "runtime event id"); if (!Number.isSafeInteger(runtime.sequence) || Number(runtime.sequence) < 1 || Number(runtime.sequence) > Number.MAX_SAFE_INTEGER) throw new Error("Runtime event sequence is invalid."); id(runtime.sessionId, "runtime session id"); iso(runtime.timestamp, "runtime timestamp"); const eventType = boundaryString(runtime.type, "runtime event type", 80); if (!RUNTIME_EVENT_TYPES.has(eventType)) throw new Error("Runtime event type is invalid."); const fields = RUNTIME_PAYLOAD_FIELDS[eventType]; const payload = optionalExact(runtime.payload, fields.required, fields.optional, "runtime event payload"); validateRuntimePayloadFields(payload); validateBoundedJson(payload, 0, { nodes: 0 });
  if (Buffer.byteLength(JSON.stringify(runtime.payload), "utf8") > 1024 * 1024) throw new Error("Runtime event payload is too large.");
}

function validateRuntimePayloadFields(payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (key === "task") validateSubagentTask(value);
    else if (/(?:taskId|subagentId|commandId|validationId)$/.test(key) && typeof value === "string") id(value, key);
    else if (["attempt", "delayMs", "durationMs", "percent"].includes(key) && (!Number.isFinite(value) || Number(value) < 0 || Number(value) > 86_400_000)) throw new Error(`Runtime ${key} is invalid.`);
    else if (key === "exitCode" && value !== null && (!Number.isSafeInteger(value) || Math.abs(Number(value)) > 65535)) throw new Error("Runtime exit code is invalid.");
    else if (["truncated"].includes(key) && typeof value !== "boolean") throw new Error(`Runtime ${key} is invalid.`);
    else if (["taskIds", "staleTaskIds", "commands"].includes(key)) { if (!Array.isArray(value) || value.length > 2_000 || value.some((item) => typeof item !== "string")) throw new Error(`Runtime ${key} is invalid.`); }
    else if ((key === "status" || key === "previousStatus") && !SUBAGENT_STATUSES.has(String(value))) throw new Error(`Runtime ${key} is invalid.`);
    else if (["objective", "reason", "summary", "error", "message", "tool", "path", "operation", "command", "cwd", "stream", "signal", "mode", "approvalPolicy"].includes(key) && value !== undefined && typeof value !== "string") throw new Error(`Runtime ${key} is invalid.`);
  }
}

const SUBAGENT_ROLES = new Set(["planner", "scout", "builder", "validator", "reviewer", "fixer"]);
const SUBAGENT_STATUSES = new Set(["created", "queued", "waiting_for_dependencies", "starting", "working", "blocked", "retrying", "validating", "completed", "failed", "cancelled", "skipped"]);

function validateSubagentTask(value: unknown): void {
  const task = optionalExact(value,
    ["id", "sessionId", "role", "title", "objective", "status", "providerId", "dependencies", "fileScope", "expectedOutput", "completionCriteria", "validationCommands", "depth", "attempt", "maxAttempts", "createdAt"],
    ["parentTaskId", "model", "queuedAt", "startedAt", "completedAt", "summary", "error", "tokenUsage"], "subagent task");
  id(task.id, "subagent task id"); id(task.sessionId, "subagent session id"); if (task.parentTaskId !== undefined) id(task.parentTaskId, "parent task id");
  if (!SUBAGENT_ROLES.has(String(task.role))) throw new Error("Subagent role is invalid."); if (!SUBAGENT_STATUSES.has(String(task.status))) throw new Error("Subagent status is invalid."); providerId(task.providerId);
  for (const key of ["title", "objective", "expectedOutput", "model", "summary", "error"] as const) if (task[key] !== undefined) boundaryString(task[key], `subagent ${key}`, key === "objective" ? 20_000 : 4_000);
  for (const key of ["dependencies", "fileScope", "completionCriteria", "validationCommands"] as const) { const entries = task[key]; if (!Array.isArray(entries) || entries.length > 2_000 || entries.some((entry) => typeof entry !== "string" || entry.length > 4_000 || containsKnownSecret(entry))) throw new Error(`Subagent ${key} is invalid.`); }
  for (const key of ["depth", "attempt", "maxAttempts"] as const) if (!Number.isSafeInteger(task[key]) || Number(task[key]) < 0 || Number(task[key]) > 10_000) throw new Error(`Subagent ${key} is invalid.`);
  for (const key of ["createdAt", "queuedAt", "startedAt", "completedAt"] as const) if (task[key] !== undefined) iso(task[key], `subagent ${key}`);
  if (task.tokenUsage !== undefined) {
    const usage = optionalExact(task.tokenUsage, [], ["input", "output", "total"], "subagent token usage");
    for (const [key, amount] of Object.entries(usage)) if (!Number.isSafeInteger(amount) || Number(amount) < 0 || Number(amount) > 1_000_000_000_000) throw new Error(`Subagent token usage ${key} is invalid.`);
  }
}

function validateBoundedJson(value: unknown, depth: number, state: { nodes: number }): void {
  state.nodes += 1; if (state.nodes > 10_000 || depth > 12) throw new Error("Runtime event payload is too complex.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Runtime event payload number is invalid."); return; }
  if (typeof value === "string") { boundaryText(value, "runtime event value", 20_000); return; }
  if (Array.isArray(value)) { if (value.length > 2_000) throw new Error("Runtime event array is too large."); value.forEach((item) => validateBoundedJson(item, depth + 1, state)); return; }
  const object = record(value, "runtime event payload"); if (Object.keys(object).length > 1_000) throw new Error("Runtime event object is too large.");
  for (const [key, item] of Object.entries(object)) { boundaryString(key, "runtime event key", 200); if (isCredentialFieldName(key)) throw new Error("Runtime event payload has a sensitive field."); validateBoundedJson(item, depth + 1, state); }
}

function validateGitStatus(value: unknown): void {
  const status = exact(value, ["repositoryRoot", "branch", "head", "dirty", "changedFiles", "ahead", "behind"], "Git status"); absolutePath(status.repositoryRoot, "repository root"); if (status.branch !== null) boundaryString(status.branch, "Git branch", 256); if (status.head !== null) boundaryString(status.head, "Git head", 128); boolean(status.dirty, "Git dirty flag"); if (!Array.isArray(status.changedFiles) || status.changedFiles.length > 10_000) throw new Error("Git changed files are invalid."); status.changedFiles.forEach((item) => relativePath(item, "Git changed file")); for (const key of ["ahead", "behind"] as const) if (!Number.isSafeInteger(status[key]) || Number(status[key]) < 0 || Number(status[key]) > 1_000_000) throw new Error(`Git ${key} count is invalid.`);
}

function validateGitPreview(value: unknown): void {
  const preview = exact(value, ["confirmationToken", "proposal", "observedHead", "summary", "createdAt", "expiresAt", "oneUse"], "Git preview"); id(preview.confirmationToken, "confirmation token"); const proposal = record(preview.proposal, "Git proposal"); validateGitProposal(proposal, String(proposal.action)); if (preview.observedHead !== null) boundaryString(preview.observedHead, "Git observed head", 128); boundaryString(preview.summary, "Git preview summary", 2_000); iso(preview.createdAt, "Git preview createdAt"); iso(preview.expiresAt, "Git preview expiresAt"); if (preview.oneUse !== true) throw new Error("Git preview one-use flag is invalid.");
}
