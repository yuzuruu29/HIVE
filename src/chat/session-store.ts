import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CHAT_BINDING_ROLES } from "../coding/types.js";
import type { ChatSessionRecord } from "./types.js";

/**
 * A chat session id: `chat-<epoch-ms>-<4 hex>`.
 * Regex is intentionally strict so a directory entry can never be confused
 * with an active-session pointer or a stray temp file.
 */
export const CHAT_SESSION_ID_PATTERN = /^chat-\d+-[0-9a-f]{4}$/;

const CHAT_SESSION_DIR = "chat-sessions";
const SESSION_FILE_SUFFIX = ".json";
const ACTIVE_SESSION_FILE = "active.json";
const CHAT_ROLES = new Set<string>(["auto", ...CHAT_BINDING_ROLES]);
const MESSAGE_ROLES = new Set(["user", "assistant"]);

/** Generates a fresh chat session id of the form `chat-<epoch-ms>-<4 hex>`. */
export function newChatSessionId(now: number = Date.now()): string {
  return `chat-${now}-${randomBytes(2).toString("hex")}`;
}

export interface ChatSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  role: string;
}

export class ChatSessionCorruptionError extends Error {
  public constructor(
    public readonly id: string,
    message: string,
  ) {
    super(`Corrupt chat session ${id}: ${message}`);
    this.name = "ChatSessionCorruptionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateChatSessionId(sessionId: string): void {
  if (!CHAT_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid chat session id '${sessionId}' (expected chat-<epoch-ms>-<4hex>).`);
  }
}

function assertSessionShape(value: unknown, expectedId?: string): asserts value is ChatSessionRecord {
  if (!isRecord(value)) throw new Error("session is not an object");
  if (!isNonEmptyString(value.id) || !CHAT_SESSION_ID_PATTERN.test(value.id)) {
    throw new Error("invalid session id");
  }
  if (expectedId && value.id !== expectedId) {
    throw new Error("session id does not match the requested id");
  }
  if (!isNonEmptyString(value.cwd)) throw new Error("cwd is required");
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) {
    throw new Error("createdAt and updatedAt are required");
  }
  if (!CHAT_ROLES.has(String(value.role))) throw new Error("invalid role");
  if (!Array.isArray(value.messages)) throw new Error("messages must be an array");
  for (const message of value.messages) {
    if (!isRecord(message)) throw new Error("message is not an object");
    if (!MESSAGE_ROLES.has(String(message.role))) throw new Error("invalid message role");
    if (typeof message.content !== "string") throw new Error("message content must be a string");
    if (typeof message.at !== "string") throw new Error("message timestamp must be a string");
    if (message.receipt !== undefined) {
      if (!isRecord(message.receipt)) throw new Error("message receipt must be an object");
      if (!isNonEmptyString(message.receipt.providerId) || !isNonEmptyString(message.receipt.model)) {
        throw new Error("receipt providerId and model are required");
      }
    }
  }
}

export interface ChatSessionStoreOptions {
  clock?: () => string;
}

export class ChatSessionStore {
  readonly #baseDirectory: string;
  readonly #clock: () => string;

  public constructor(repositoryRoot: string, options: ChatSessionStoreOptions = {}) {
    this.#baseDirectory = path.resolve(repositoryRoot, ".hivemind", CHAT_SESSION_DIR);
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  public get baseDirectory(): string {
    return this.#baseDirectory;
  }

  public filePathFor(sessionId: string): string {
    validateChatSessionId(sessionId);
    return path.join(this.#baseDirectory, `${sessionId}${SESSION_FILE_SUFFIX}`);
  }

  public async save(record: ChatSessionRecord): Promise<ChatSessionRecord> {
    validateChatSessionId(record.id);
    assertSessionShape(record);
    const snapshot: ChatSessionRecord = { ...record, updatedAt: this.#clock() };
    assertSessionShape(snapshot);

    await fs.mkdir(this.#baseDirectory, { recursive: true });
    const destination = this.filePathFor(record.id);
    const temporary = path.join(
      this.#baseDirectory,
      `.${record.id}.${process.pid}.${randomUUID()}.tmp`,
    );
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
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
    return snapshot;
  }

  public async load(sessionId: string): Promise<ChatSessionRecord | null> {
    const file = this.filePathFor(sessionId);
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
      throw new ChatSessionCorruptionError(
        sessionId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async list(): Promise<ChatSessionSummary[]> {
    await fs.mkdir(this.#baseDirectory, { recursive: true });
    const entries = await fs.readdir(this.#baseDirectory, { withFileTypes: true });
    const summaries: ChatSessionSummary[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(SESSION_FILE_SUFFIX)) continue;
      const id = entry.name.slice(0, -SESSION_FILE_SUFFIX.length);
      if (!CHAT_SESSION_ID_PATTERN.test(id)) continue;
      let record: ChatSessionRecord | null;
      try {
        record = await this.load(id);
      } catch (error) {
        // A single corrupt session must not abort the whole listing.
        if (error instanceof ChatSessionCorruptionError) continue;
        throw error;
      }
      if (!record) continue;
      summaries.push({
        id: record.id,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        role: record.role,
      });
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async setActive(sessionId: string): Promise<void> {
    validateChatSessionId(sessionId);
    if (!(await this.load(sessionId))) {
      throw new Error(`Chat session ${sessionId} does not exist.`);
    }
    await fs.mkdir(this.#baseDirectory, { recursive: true });
    const destination = path.join(this.#baseDirectory, ACTIVE_SESSION_FILE);
    const temporary = path.join(this.#baseDirectory, `.${ACTIVE_SESSION_FILE}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${sessionId}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async getActive(): Promise<ChatSessionRecord | null> {
    let sessionId: string;
    try {
      sessionId = (await fs.readFile(path.join(this.#baseDirectory, ACTIVE_SESSION_FILE), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    validateChatSessionId(sessionId);
    const record = await this.load(sessionId);
    if (!record) throw new ChatSessionCorruptionError(sessionId, "active.json points to a missing session");
    return record;
  }

  public async clearActive(): Promise<void> {
    await fs.rm(path.join(this.#baseDirectory, ACTIVE_SESSION_FILE), { force: true });
  }
}
