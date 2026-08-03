import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isCredentialFieldName, redactKnownSecrets } from "../security/secrets.js";
import { RUNTIME_EVENT_TYPES } from "./events.js";
import {
  CODING_SESSION_SCHEMA_VERSION,
  SUBAGENT_ROLES,
  SUBAGENT_STATUSES,
  type CodingSessionRecord,
  type SubagentTask,
} from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SESSION_FILE = "session.json";
const ACTIVE_SESSION_FILE = "active-session.txt";
const CODE_MODES = new Set(["auto", "plan", "review"]);
const APPROVAL_POLICIES = new Set(["safe", "changes", "always"]);
const SESSION_STATUSES = new Set([
  "created",
  "planning",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
const SUBAGENT_ROLE_SET = new Set<string>(SUBAGENT_ROLES);
const SUBAGENT_STATUS_SET = new Set<string>(SUBAGENT_STATUSES);
const RUNTIME_EVENT_TYPE_SET = new Set<string>(RUNTIME_EVENT_TYPES);

export interface SessionStoreOptions {
  clock?: () => string;
}

export class SessionCorruptionError extends Error {
  public constructor(
    public readonly sessionId: string,
    message: string,
  ) {
    super(`Corrupt coding session ${sessionId}: ${message}`);
    this.name = "SessionCorruptionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function redactSensitiveString(value: string): string {
  return redactKnownSecrets(value);
}

function sanitizeForPersistence(value: unknown, key?: string): unknown {
  if (key && isCredentialFieldName(key)) {
    return value === undefined ? undefined : "[REDACTED]";
  }
  if (typeof value === "string") return redactSensitiveString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForPersistence(entry));
  }
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const result = sanitizeForPersistence(childValue, childKey);
      if (result !== undefined) sanitized[childKey] = result;
    }
    return sanitized;
  }
  return value;
}

function containsUnredactedSecret(value: unknown, key?: string): boolean {
  if (key && isCredentialFieldName(key)) {
    return value !== undefined && value !== "[REDACTED]";
  }
  if (typeof value === "string") {
    if (redactSensitiveString(value) !== value) return true;
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsUnredactedSecret(entry));
  }
  if (isRecord(value)) {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsUnredactedSecret(childValue, childKey),
    );
  }
  return false;
}

function assertTaskShape(task: unknown, sessionId: string): asserts task is SubagentTask {
  if (!isRecord(task)) throw new Error("task is not an object");
  if (!isNonEmptyString(task.id) || !SESSION_ID_PATTERN.test(task.id)) {
    throw new Error("task has an invalid id");
  }
  if (task.sessionId !== sessionId) throw new Error(`task ${task.id} belongs to another session`);
  if (!SUBAGENT_ROLE_SET.has(String(task.role))) throw new Error(`task ${task.id} has an invalid role`);
  if (!SUBAGENT_STATUS_SET.has(String(task.status))) throw new Error(`task ${task.id} has an invalid status`);
  for (const field of [
    "title",
    "objective",
    "providerId",
    "expectedOutput",
    "createdAt",
  ]) {
    if (!isNonEmptyString(task[field])) throw new Error(`task ${task.id} has an invalid ${field}`);
  }
  for (const field of [
    "dependencies",
    "fileScope",
    "completionCriteria",
    "validationCommands",
  ]) {
    if (!isStringArray(task[field])) throw new Error(`task ${task.id} has an invalid ${field}`);
  }
  if (!Number.isSafeInteger(task.depth) || Number(task.depth) < 0) {
    throw new Error(`task ${task.id} has an invalid depth`);
  }
  if (!Number.isSafeInteger(task.attempt) || Number(task.attempt) < 0) {
    throw new Error(`task ${task.id} has an invalid attempt`);
  }
  if (!Number.isSafeInteger(task.maxAttempts) || Number(task.maxAttempts) < 1) {
    throw new Error(`task ${task.id} has an invalid maxAttempts`);
  }
}

function assertSessionShape(value: unknown, expectedId?: string): asserts value is CodingSessionRecord {
  if (!isRecord(value)) throw new Error("snapshot is not an object");
  if (value.schemaVersion !== CODING_SESSION_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${String(value.schemaVersion)}`);
  }
  if (!isNonEmptyString(value.id) || !SESSION_ID_PATTERN.test(value.id)) {
    throw new Error("invalid session id");
  }
  if (expectedId && value.id !== expectedId) throw new Error("snapshot id does not match its directory");
  if (!isNonEmptyString(value.objective)) throw new Error("objective is required");
  if (!CODE_MODES.has(String(value.mode))) throw new Error("invalid mode");
  if (!APPROVAL_POLICIES.has(String(value.approvalPolicy))) throw new Error("invalid approval policy");
  if (!SESSION_STATUSES.has(String(value.status))) throw new Error("invalid session status");
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) {
    throw new Error("createdAt and updatedAt are required");
  }
  if (!isRecord(value.repository)) throw new Error("repository snapshot is required");
  if (!isNonEmptyString(value.repository.root) || !isNonEmptyString(value.repository.capturedAt)) {
    throw new Error("repository root and capturedAt are required");
  }
  if (typeof value.repository.dirty !== "boolean" || !isStringArray(value.repository.changedFiles)) {
    throw new Error("repository dirty state is invalid");
  }
  for (const field of [
    "tasks",
    "events",
    "providerBindings",
    "validationResults",
    "reviewResults",
    "files",
  ]) {
    if (!Array.isArray(value[field])) throw new Error(`${field} must be an array`);
  }

  // Optional arrays for new verification fields
  for (const field of ["failures", "integrations"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new Error(`${field} must be an array when present`);
    }
  }

  // Optional verdict field
  if (value.verdict !== undefined) {
    const validVerdicts = new Set(["ACCEPTED", "REPAIRABLE", "REJECTED", "BLOCKED"]);
    if (!validVerdicts.has(String(value.verdict))) {
      throw new Error(`Invalid verdict: ${String(value.verdict)}`);
    }
  }

  const tasks = value.tasks as unknown[];
  const events = value.events as unknown[];
  const taskIds = new Set<string>();
  for (const task of tasks) {
    assertTaskShape(task, value.id);
    if (taskIds.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    taskIds.add(task.id);
  }

  let previousSequence = 0;
  for (const event of events) {
    if (!isRecord(event)) throw new Error("event is not an object");
    if (event.schemaVersion !== CODING_SESSION_SCHEMA_VERSION) throw new Error("event schema is invalid");
    if (event.sessionId !== value.id) throw new Error("event belongs to another session");
    if (!isNonEmptyString(event.id) || !isNonEmptyString(event.type) || !isNonEmptyString(event.timestamp)) {
      throw new Error("event identity is invalid");
    }
    if (!RUNTIME_EVENT_TYPE_SET.has(event.type)) {
      throw new Error(`event type ${event.type} is invalid`);
    }
    if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) <= previousSequence) {
      throw new Error("event sequences are not strictly increasing");
    }
    if (!isRecord(event.payload)) throw new Error("event payload is invalid");
    previousSequence = Number(event.sequence);
  }

  if (containsUnredactedSecret(value)) throw new Error("snapshot contains an unredacted secret");
}

export function validateCodingSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid session id: use 1-96 letters, numbers, dot, underscore, or dash characters.");
  }
}

export class CodingSessionStore {
  readonly #baseDirectory: string;
  readonly #clock: () => string;

  public constructor(repositoryRoot: string, options: SessionStoreOptions = {}) {
    this.#baseDirectory = path.resolve(repositoryRoot, ".hivemind", "sessions");
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  public get baseDirectory(): string {
    return this.#baseDirectory;
  }

  public getSessionDirectory(sessionId: string): string {
    validateCodingSessionId(sessionId);
    return path.join(this.#baseDirectory, sessionId);
  }

  public async save(record: CodingSessionRecord): Promise<CodingSessionRecord> {
    validateCodingSessionId(record.id);
    const sanitized = sanitizeForPersistence(record) as CodingSessionRecord;
    sanitized.updatedAt = this.#clock();
    assertSessionShape(sanitized, record.id);

    const directory = this.getSessionDirectory(record.id);
    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, SESSION_FILE);
    const temporary = path.join(directory, `.${SESSION_FILE}.${process.pid}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    return sanitized;
  }

  public async load(sessionId: string): Promise<CodingSessionRecord | null> {
    validateCodingSessionId(sessionId);
    const file = path.join(this.getSessionDirectory(sessionId), SESSION_FILE);
    let serialized: string;
    try {
      serialized = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(serialized);
      assertSessionShape(parsed, sessionId);
      return parsed;
    } catch (error) {
      throw new SessionCorruptionError(
        sessionId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async list(): Promise<CodingSessionRecord[]> {
    await fs.mkdir(this.#baseDirectory, { recursive: true });
    const entries = await fs.readdir(this.#baseDirectory, { withFileTypes: true });
    const records: CodingSessionRecord[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
      const record = await this.load(entry.name);
      if (record) records.push(record);
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async setActive(sessionId: string): Promise<void> {
    validateCodingSessionId(sessionId);
    if (!(await this.load(sessionId))) throw new Error(`Coding session ${sessionId} does not exist.`);
    await fs.mkdir(this.#baseDirectory, { recursive: true });
    const destination = path.join(this.#baseDirectory, ACTIVE_SESSION_FILE);
    const temporary = path.join(this.#baseDirectory, `.${ACTIVE_SESSION_FILE}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${sessionId}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async getActive(): Promise<CodingSessionRecord | null> {
    let sessionId: string;
    try {
      sessionId = (await fs.readFile(path.join(this.#baseDirectory, ACTIVE_SESSION_FILE), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    validateCodingSessionId(sessionId);
    const record = await this.load(sessionId);
    if (!record) throw new SessionCorruptionError(sessionId, "active-session pointer targets a missing snapshot");
    return record;
  }

  public async clearActive(): Promise<void> {
    await fs.rm(path.join(this.#baseDirectory, ACTIVE_SESSION_FILE), { force: true });
  }

  public async getAgent(sessionId: string, subagentId: string): Promise<SubagentTask | null> {
    validateCodingSessionId(sessionId);
    validateCodingSessionId(subagentId);
    const record = await this.load(sessionId);
    if (!record) return null;
    return record.tasks.find((task) => task.id === subagentId) ?? null;
  }
}
