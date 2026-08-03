import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactKnownSecrets } from "../security/secrets.js";
import {
  DESKTOP_THREAD_SCHEMA_VERSION,
  MAX_THREAD_MESSAGE_CHARS,
  type CreateThreadInput,
  type ThreadMessage,
  type ThreadRecordV1,
  type ThreadRunRef,
  type ThreadStore,
} from "./types.js";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const THREAD_FILE = "thread.json";
const MAX_THREAD_TITLE_CHARS = 200;
const MESSAGE_ROLES = new Set(["user", "assistant", "system"]);
const RUN_STATUSES = new Set(["created", "planning", "running", "paused", "completed", "failed", "cancelled"]);

export interface JsonThreadStoreOptions {
  clock?: () => string;
  idFactory?: () => string;
}

export class ThreadCorruptionError extends Error {
  public constructor(
    public readonly threadId: string,
    message: string,
  ) {
    super(`Corrupt desktop thread ${threadId}: ${message}`);
    this.name = "ThreadCorruptionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function redactSensitiveString(value: string): string {
  return redactKnownSecrets(value);
}

function assertMessageShape(value: unknown): asserts value is ThreadMessage {
  if (!isRecord(value)) throw new Error("message is not an object");
  assertExactKeys(value, ["id", "role", "content", "createdAt"], "message");
  validateDesktopId(value.id, "message");
  if (!MESSAGE_ROLES.has(String(value.role))) throw new Error(`message ${String(value.id)} has an invalid role`);
  if (typeof value.content !== "string") throw new Error(`message ${String(value.id)} content must be a string`);
  if (value.content.length > MAX_THREAD_MESSAGE_CHARS) {
    throw new Error(`message ${String(value.id)} must not exceed 20,000 characters`);
  }
  if (!isTimestamp(value.createdAt)) throw new Error(`message ${String(value.id)} has an invalid createdAt`);
}

function assertRunShape(value: unknown): asserts value is ThreadRunRef {
  if (!isRecord(value)) throw new Error("run reference is not an object");
  assertExactKeys(
    value,
    ["userMessageId", "codingSessionId", "status", "createdAt", "updatedAt"],
    "run reference",
  );
  validateDesktopId(value.userMessageId, "message");
  validateDesktopId(value.codingSessionId, "coding session");
  if (!RUN_STATUSES.has(String(value.status))) throw new Error("run reference has an invalid status");
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new Error("run reference has invalid timestamps");
  }
}

function assertThreadRecordShape(
  value: unknown,
  expectedId: string | undefined,
  requireRedacted: boolean,
): asserts value is ThreadRecordV1 {
  if (!isRecord(value)) throw new Error("thread snapshot is not an object");
  assertExactKeys(
    value,
    ["schemaVersion", "id", "title", "createdAt", "updatedAt", "archived", "messages", "runs"],
    "thread snapshot",
  );
  if (value.schemaVersion !== DESKTOP_THREAD_SCHEMA_VERSION) {
    throw new Error(`unsupported thread schema version ${String(value.schemaVersion)}`);
  }
  validateDesktopId(value.id, "thread");
  if (expectedId !== undefined && value.id !== expectedId) {
    throw new Error("thread snapshot id does not match its directory");
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > MAX_THREAD_TITLE_CHARS) {
    throw new Error("thread title must contain 1-200 characters");
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new Error("thread timestamps are invalid");
  }
  if (typeof value.archived !== "boolean") throw new Error("thread archived must be a boolean");
  if (!Array.isArray(value.messages)) throw new Error("thread messages must be an array");
  if (!Array.isArray(value.runs)) throw new Error("thread runs must be an array");

  const messages = value.messages as unknown[];
  const messageIds = new Set<string>();
  const userMessageIds = new Set<string>();
  for (const message of messages) {
    assertMessageShape(message);
    if (messageIds.has(message.id)) throw new Error(`duplicate message id ${message.id}`);
    messageIds.add(message.id);
    if (message.role === "user") userMessageIds.add(message.id);
    if (requireRedacted && redactSensitiveString(message.content) !== message.content) {
      throw new Error(`message ${message.id} contains an unredacted secret`);
    }
  }

  const runs = value.runs as unknown[];
  const runKeys = new Set<string>();
  for (const run of runs) {
    assertRunShape(run);
    if (!userMessageIds.has(run.userMessageId)) {
      throw new Error(`run reference targets missing user message ${run.userMessageId}`);
    }
    const key = `${run.userMessageId}\u0000${run.codingSessionId}`;
    if (runKeys.has(key)) throw new Error("duplicate run reference");
    runKeys.add(key);
  }
  if (requireRedacted && redactSensitiveString(value.title) !== value.title) {
    throw new Error("thread title contains an unredacted secret");
  }
}

export function assertThreadRecordV1(value: unknown, expectedId?: string): asserts value is ThreadRecordV1 {
  assertThreadRecordShape(value, expectedId, true);
}

function assertCreateThreadInput(value: unknown): asserts value is CreateThreadInput {
  if (!isRecord(value)) throw new Error("create thread input is not an object");
  const expectedKeys = value.id === undefined ? ["title"] : ["id", "title"];
  assertExactKeys(value, expectedKeys, "create thread input");
  if (value.id !== undefined) validateDesktopId(value.id);
  if (typeof value.title !== "string") throw new Error("thread title must be a string");
}

function sanitizeThread(thread: ThreadRecordV1): ThreadRecordV1 {
  return {
    schemaVersion: DESKTOP_THREAD_SCHEMA_VERSION,
    id: thread.id,
    title: redactSensitiveString(thread.title),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archived: thread.archived,
    messages: thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: redactSensitiveString(message.content),
      createdAt: message.createdAt,
    })),
    runs: thread.runs.map((run) => ({ ...run })),
  };
}

const threadMutationQueues = new Map<string, Promise<void>>();

async function serializeThreadMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = threadMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  threadMutationQueues.set(key, current);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (threadMutationQueues.get(key) === current) threadMutationQueues.delete(key);
  }
}

export function validateDesktopId(id: unknown, kind = "thread"): asserts id is string {
  if (typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${kind} id: use 1-96 letters, numbers, dot, underscore, or dash characters.`);
  }
}

export class JsonThreadStore implements ThreadStore {
  readonly #repositoryRoot: string;
  readonly #baseDirectory: string;
  readonly #clock: () => string;
  readonly #idFactory: () => string;

  public constructor(repositoryRoot: string, options: JsonThreadStoreOptions = {}) {
    this.#repositoryRoot = path.resolve(repositoryRoot);
    this.#baseDirectory = path.join(this.#repositoryRoot, ".hivemind", "threads");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? (() => `thread-${randomUUID()}`);
  }

  public get baseDirectory(): string {
    return this.#baseDirectory;
  }

  public getThreadDirectory(threadId: string): string {
    validateDesktopId(threadId);
    return path.join(this.#baseDirectory, threadId);
  }

  public async create(input: CreateThreadInput): Promise<ThreadRecordV1> {
    assertCreateThreadInput(input);
    const id = input.id ?? this.#idFactory();
    validateDesktopId(id);
    const timestamp = this.#clock();
    const record: ThreadRecordV1 = {
      schemaVersion: DESKTOP_THREAD_SCHEMA_VERSION,
      id,
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      messages: [],
      runs: [],
    };
    assertThreadRecordShape(record, id, false);
    assertThreadRecordV1(sanitizeThread(record), id);

    const repositoryRealPath = await this.#prepareBaseDirectory();
    const directory = this.getThreadDirectory(id);
    await this.#assertContained(directory, repositoryRealPath);
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Desktop thread ${id} already exists.`);
      }
      throw error;
    }

    try {
      await this.#assertContained(directory, repositoryRealPath);
      return await this.#write(record, repositoryRealPath);
    } catch (error) {
      await fs.rmdir(directory).catch(() => undefined);
      throw error;
    }
  }

  public async save(thread: ThreadRecordV1): Promise<ThreadRecordV1> {
    assertThreadRecordShape(thread, undefined, false);
    const sanitized = sanitizeThread({ ...thread, updatedAt: this.#clock() });
    assertThreadRecordV1(sanitized, thread.id);
    const existing = await this.load(thread.id);
    if (!existing) throw new Error(`Desktop thread ${thread.id} does not exist.`);
    const repositoryRealPath = await this.#repositoryRealPath();
    return this.#write(sanitized, repositoryRealPath);
  }

  public async appendMessage(threadId: string, message: ThreadMessage): Promise<ThreadRecordV1> {
    return this.mutate(threadId, (thread) => {
      if (thread.archived) throw new Error(`Desktop thread ${threadId} is archived.`);
      if (thread.messages.some((candidate) => candidate.id === message.id)) throw new Error(`Thread message ${message.id} already exists.`);
      thread.messages.push({ ...message });
    });
  }

  public async mutate(threadId: string, update: (thread: ThreadRecordV1) => ThreadRecordV1 | void): Promise<ThreadRecordV1> {
    validateDesktopId(threadId);
    const key = path.join(this.getThreadDirectory(threadId), THREAD_FILE);
    return serializeThreadMutation(key, async () => {
      const current = await this.load(threadId);
      if (!current) throw new Error(`Desktop thread ${threadId} does not exist.`);
      const originalIdentity = { id: current.id, title: current.title, createdAt: current.createdAt };
      const draft = structuredClone(current);
      const proposed = update(draft) ?? draft;
      if (proposed.id !== originalIdentity.id || proposed.title !== originalIdentity.title || proposed.createdAt !== originalIdentity.createdAt) {
        throw new Error("Thread mutation cannot replace immutable thread identity fields.");
      }
      const sanitized = sanitizeThread({ ...proposed, updatedAt: this.#clock() });
      assertThreadRecordV1(sanitized, threadId);
      return this.#write(sanitized, await this.#repositoryRealPath());
    });
  }

  public async load(threadId: string): Promise<ThreadRecordV1 | null> {
    validateDesktopId(threadId);
    const destination = path.join(this.getThreadDirectory(threadId), THREAD_FILE);
    const repositoryRealPath = await this.#repositoryRealPath();
    await this.#assertContained(destination, repositoryRealPath);
    let serialized: string;
    try {
      serialized = await fs.readFile(destination, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      assertThreadRecordV1(parsed, threadId);
      return parsed;
    } catch (error) {
      throw new ThreadCorruptionError(threadId, error instanceof Error ? error.message : String(error));
    }
  }

  public async list(): Promise<ThreadRecordV1[]> {
    const repositoryRealPath = await this.#prepareBaseDirectory();
    const entries = await fs.readdir(this.#baseDirectory, { withFileTypes: true });
    const records: ThreadRecordV1[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!SAFE_ID_PATTERN.test(entry.name)) continue;
      const candidate = path.join(this.#baseDirectory, entry.name);
      await this.#assertContained(candidate, repositoryRealPath);
      const candidateStat = await fs.stat(candidate);
      if (!candidateStat.isDirectory()) continue;
      const record = await this.load(entry.name);
      if (record) records.push(record);
    }
    return records.sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
  }

  public async archive(threadId: string): Promise<ThreadRecordV1> {
    return this.mutate(threadId, (record) => { record.archived = true; });
  }

  async #repositoryRealPath(): Promise<string> {
    return fs.realpath(this.#repositoryRoot);
  }

  async #assertContained(target: string, repositoryRealPath: string): Promise<void> {
    const resolvedTarget = path.resolve(target);
    if (!isContainedPath(this.#repositoryRoot, resolvedTarget)) {
      throw new Error("Thread path escapes the repository root.");
    }

    let existing = resolvedTarget;
    while (true) {
      try {
        const existingRealPath = await fs.realpath(existing);
        if (!isContainedPath(repositoryRealPath, existingRealPath)) {
          throw new Error("Thread path escapes the repository root.");
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (existing === this.#repositoryRoot) {
        throw new Error("Repository root does not exist.");
      }
      const parent = path.dirname(existing);
      if (parent === existing || !isContainedPath(this.#repositoryRoot, parent)) {
        throw new Error("Thread path escapes the repository root.");
      }
      existing = parent;
    }
  }

  async #prepareBaseDirectory(): Promise<string> {
    const repositoryRealPath = await this.#repositoryRealPath();
    await this.#assertContained(this.#baseDirectory, repositoryRealPath);
    await fs.mkdir(this.#baseDirectory, { recursive: true });
    await this.#assertContained(this.#baseDirectory, repositoryRealPath);
    return repositoryRealPath;
  }

  async #write(thread: ThreadRecordV1, repositoryRealPath: string): Promise<ThreadRecordV1> {
    const sanitized = sanitizeThread(thread);
    assertThreadRecordV1(sanitized, thread.id);
    const directory = this.getThreadDirectory(thread.id);
    const destination = path.join(directory, THREAD_FILE);
    await this.#assertContained(directory, repositoryRealPath);
    await this.#assertContained(destination, repositoryRealPath);
    const temporary = path.join(directory, `.${THREAD_FILE}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await this.#assertContained(temporary, repositoryRealPath);
      await handle.writeFile(`${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#assertContained(directory, repositoryRealPath);
      await this.#assertContained(destination, repositoryRealPath);
      await fs.rename(temporary, destination);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    return sanitized;
  }
}
