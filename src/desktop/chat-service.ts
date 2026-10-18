import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { DesktopEvent } from "./types.js";
import type {
  DesktopChatConversation,
  DesktopChatMessage,
  DesktopChatSummary,
  DesktopChatToolActivity,
  ChatBindingRole,
  ChatMessage,
  ChatReceipt,
  ChatRoleSelection,
  ChatSessionRecord,
} from "../chat/types.js";
import { CHAT_ROLE_META, CHAT_ROLE_SLUGS, classifyTask, normalizeChatRole, type ChatRoleSlug } from "../chat/roles.js";
import { ChatSessionStore, newChatSessionId, CHAT_SESSION_ID_PATTERN } from "../chat/session-store.js";
import { compactHistory } from "../chat/history.js";
import { HISTORY_CHAR_BUDGET } from "../chat/chat-cli.js";
import { buildScoutGrounding } from "../chat/grounding.js";
import { createChatEngine, type ChatEngine, type ChatEngineOptions } from "../chat/engine.js";
import { runChatAgentTurn, type ChatAgentTurnHooks, type ChatAgentTurnInput, type ChatAgentTurnResult } from "../chat/agent-turn.js";

/** First 80 chars of the first user message; derived service-side, never client-side. */
const TITLE_MAX_CHARS = 80;
const ARCHIVED_DIRECTORY = "archived";
const DEFAULT_CHUNK_BATCH_MS = 60;
const DEFAULT_CHUNK_BATCH_CHARS = 2_048;

export interface DesktopChatSendInput {
  conversationId: string;
  content: string;
  role?: string;
  providerId?: string;
  model?: string;
  ground?: boolean;
  agent?: boolean;
  /** Rerun the stored last user turn. Drops the trailing assistant reply instead of appending another user message. */
  regenerate?: boolean;
}

export interface DesktopChatRouteInput {
  role?: string;
  providerId?: string;
  model?: string;
}

export interface DesktopChatServiceOptions {
  /** Injectable engine factory for tests; defaults to createChatEngine. */
  createEngine?: (projectRoot: string, conversationId: string, options?: ChatEngineOptions) => ChatEngine;
  /** Injectable Scout grounding seam; defaults to buildScoutGrounding. */
  buildGrounding?: (cwd: string, taskPrompt: string) => Promise<string | null>;
  /** Injectable agentic-turn runner for tests; defaults to runChatAgentTurn. */
  runAgentTurn?: (input: ChatAgentTurnInput, hooks: ChatAgentTurnHooks) => Promise<ChatAgentTurnResult>;
  clock?: () => string;
  /** Chunk coalescing window; streaming chunks batch to keep IPC calm. */
  chunkBatchMs?: number;
  chunkBatchChars?: number;
}

function slugToBinding(slug: ChatRoleSlug): ChatBindingRole {
  return normalizeChatRole(slug) ?? "coding";
}

function bindingToSlug(binding: string): ChatRoleSlug {
  for (const slug of CHAT_ROLE_SLUGS) {
    if (slugToBinding(slug) === binding) return slug;
  }
  return "coding";
}

function labelToolCall(name: unknown, args: Record<string, unknown>): DesktopChatToolActivity {
  // Contract caps: tool name <= 64 chars, label <= 300 chars (contracts.ts validateChatTool).
  const toolName = (typeof name === "string" ? name : "tool").slice(0, 64);
  const pathArg = typeof args.path === "string" && args.path.trim() ? args.path.slice(0, 280) : undefined;
  const queryArg = typeof args.query === "string" && args.query.trim() ? args.query.slice(0, 280) : undefined;
  let label = toolName;
  if (toolName === "read_file") label = `read ${pathArg ?? "file"}`;
  else if (toolName === "list_files") label = `list ${pathArg ?? "."}`;
  else if (toolName === "search_files") label = queryArg ? `search "${queryArg}"` : "search";
  return { name: toolName, label };
}

/** Mirrors the CLI's renderHistory so desktop turns share the transcript shape. */
function renderHistory(history: ChatMessage[]): string {
  return history
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
}

function conversationTitle(record: ChatSessionRecord): string {
  const firstUser = record.messages.find((message) => message.role === "user");
  if (!firstUser) return "New chat";
  const flat = firstUser.content.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS)}…` : flat || "New chat";
}

function toConversation(record: ChatSessionRecord): DesktopChatConversation {
  return {
    id: record.id,
    cwd: record.cwd,
    role: record.role,
    ground: record.grounded ?? false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messages: record.messages.map((message, index) => toMessage(message, index)),
  };
}

function toMessage(message: ChatMessage, index: number): DesktopChatMessage {
  return { id: `msg-${index}`, role: message.role, content: message.content, at: message.at, ...(message.receipt ? { receipt: message.receipt } : {}) };
}

/**
 * Long-lived chat conversation service for the desktop shell. Lives in the
 * main process (chat is conversational and outlives any coding run), resolves
 * providers through {@link createChatEngine} exactly like the CLI, and emits
 * desktop events through the same onEvent channel as run events.
 */
export class DesktopChatService {
  readonly #projectRootProvider: () => string;
  readonly #emit: (event: DesktopEvent) => void;
  readonly #createEngine: NonNullable<DesktopChatServiceOptions["createEngine"]>;
  readonly #buildGrounding: NonNullable<DesktopChatServiceOptions["buildGrounding"]>;
  readonly #runAgentTurn: NonNullable<DesktopChatServiceOptions["runAgentTurn"]>;
  readonly #clock: () => string;
  readonly #chunkBatchMs: number;
  readonly #chunkBatchChars: number;
  readonly #stores = new Map<string, ChatSessionStore>();
  readonly #engines = new Map<string, ChatEngine>();
  readonly #routeEngines = new Map<string, ChatEngine>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #archiving = new Set<string>();
  readonly #groundPacks = new Map<string, string | null>();
  #turnCounter = 0;

  public constructor(projectRootProvider: () => string, emit: (event: DesktopEvent) => void, options: DesktopChatServiceOptions = {}) {
    this.#projectRootProvider = projectRootProvider;
    this.#emit = emit;
    this.#createEngine = options.createEngine ?? ((projectRoot, conversationId, engineOptions) => createChatEngine(projectRoot, conversationId, engineOptions));
    this.#buildGrounding = options.buildGrounding ?? ((cwd, taskPrompt) => buildScoutGrounding(cwd, taskPrompt));
    this.#runAgentTurn = options.runAgentTurn ?? ((input, hooks) => runChatAgentTurn(input, hooks));
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#chunkBatchMs = options.chunkBatchMs ?? DEFAULT_CHUNK_BATCH_MS;
    this.#chunkBatchChars = options.chunkBatchChars ?? DEFAULT_CHUNK_BATCH_CHARS;
  }

  public async list(): Promise<DesktopChatSummary[]> {
    const store = this.#store();
    const active: DesktopChatSummary[] = [];
    for (const summary of await store.list()) {
      const record = await store.load(summary.id);
      if (!record) continue;
      active.push({ id: record.id, title: conversationTitle(record), role: record.role, updatedAt: record.updatedAt, messageCount: record.messages.length });
    }
    const archived: DesktopChatSummary[] = [];
    for (const record of await this.#listArchived(store)) {
      archived.push({ id: record.id, title: conversationTitle(record), role: record.role, updatedAt: record.updatedAt, messageCount: record.messages.length, archived: true });
    }
    return [...active.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), ...archived.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))];
  }

  public async create(input: { role?: string; ground?: boolean }): Promise<DesktopChatConversation> {
    const root = this.#projectRootProvider();
    const store = this.#store();
    const role: ChatRoleSelection = input.role ? this.#resolveRoleSelection(input.role) : "auto";
    const record: ChatSessionRecord = {
      id: newChatSessionId(),
      createdAt: this.#clock(),
      updatedAt: this.#clock(),
      cwd: root,
      messages: [],
      role,
      ...(input.ground !== undefined ? { grounded: input.ground } : {}),
    };
    return toConversation(await store.save(record));
  }

  public async load(conversationId: string): Promise<DesktopChatConversation> {
    const record = await this.#loadRecord(conversationId);
    return toConversation(record);
  }

  public async archive(conversationId: string): Promise<DesktopChatSummary[]> {
    const store = this.#store();
    if (this.#controllers.has(conversationId)) throw new Error("Cancel the streaming turn before archiving this conversation.");
    if (this.#archiving.has(conversationId)) throw new Error("This conversation is already being archived.");
    const source = store.filePathFor(conversationId);
    const archiveDirectory = path.join(store.baseDirectory, ARCHIVED_DIRECTORY);
    this.#archiving.add(conversationId);
    try {
      await fs.mkdir(archiveDirectory, { recursive: true });
      try {
        await fs.rename(source, path.join(archiveDirectory, path.basename(source)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Chat conversation not found.");
        throw error;
      }
      return await this.list();
    } finally {
      this.#archiving.delete(conversationId);
    }
  }

  /** Resolves the provider route for a role (or `auto`) and emits `chat.route.resolved`. */
  public async route(input: DesktopChatRouteInput = {}): Promise<void> {
    const root = this.#projectRootProvider();
    const requestedRole = input.role ?? "auto";
    const selection = this.#resolveRoleSelection(requestedRole);
    const engine = this.#engineFor(root, "route-probe", this.#routeEngines);
    const route = await engine.resolveRoute(
      selection === "auto" ? slugToBinding(classifyTask("")) : selection,
      input.providerId || input.model ? { providerId: input.providerId, model: input.model } : undefined,
    );
    this.#emit({ type: "chat.route.resolved", timestamp: this.#clock(), role: requestedRole, providerId: route.providerId, model: route.model, source: route.source, degraded: route.degraded });
  }

  public cancel(conversationId: string): void {
    this.#controllers.get(conversationId)?.abort();
  }

  /**
   * Starts a streaming turn: persists the user message, emits `chat.changed` +
   * `chat.started`, then completes asynchronously (chunks → completed/failed).
   * Resolves once the turn is initiated so the router can ack the request.
   */
  public async send(input: DesktopChatSendInput): Promise<void> {
    const root = this.#projectRootProvider();
    const store = this.#store();
    if (this.#controllers.has(input.conversationId)) throw new Error("A chat turn is already streaming in this conversation.");
    if (this.#archiving.has(input.conversationId)) throw new Error("Wait for this conversation to finish archiving before sending a message.");
    const controller = new AbortController();
    this.#controllers.set(input.conversationId, controller);
    try {
      await this.#send(input, root, store, controller);
    } catch (error) {
      if (this.#controllers.get(input.conversationId) === controller) this.#controllers.delete(input.conversationId);
      throw error;
    }
  }

  async #send(input: DesktopChatSendInput, root: string, store: ChatSessionStore, controller: AbortController): Promise<void> {
    const record = await this.#loadRecord(input.conversationId);
    controller.signal.throwIfAborted();

    const history = record.messages.slice();
    let promptContent = input.content;
    if (input.regenerate) {
      while (history.length > 0 && history[history.length - 1]?.role === "assistant") history.pop();
      const lastUser = [...history].reverse().find((message) => message.role === "user");
      if (!lastUser) throw new Error("Nothing to regenerate.");
      promptContent = lastUser.content;
    } else {
      history.push({ role: "user", content: input.content, at: this.#clock() });
    }

    const ground = input.ground ?? record.grounded ?? false;
    const selection: ChatRoleSelection = input.role ? this.#resolveRoleSelection(input.role) : record.role;
    const slug = selection === "auto" ? classifyTask(promptContent) : bindingToSlug(selection);
    const override = input.providerId || input.model ? { providerId: input.providerId, model: input.model } : undefined;

    const persisted: ChatSessionRecord = { ...record, messages: history, role: selection, override, grounded: ground };

    let groundPack = this.#groundPacks.get(record.id) ?? null;
    if (ground && groundPack === null) {
      groundPack = await this.#buildGrounding(root, promptContent);
      this.#groundPacks.set(record.id, groundPack);
    }
    controller.signal.throwIfAborted();
    const grounding = ground && groundPack ? groundPack : undefined;

    const engine = this.#engineFor(root, record.id, this.#engines);
    const systemPrompt = grounding ? `${grounding}\n\n---\n\n${CHAT_ROLE_META[slug].systemPrompt}` : CHAT_ROLE_META[slug].systemPrompt;
    const context = renderHistory(compactHistory(persisted.messages.slice(0, -1), HISTORY_CHAR_BUDGET).kept);
    const prompt = context ? `${context}\n\nUser: ${promptContent}` : promptContent;

    controller.signal.throwIfAborted();
    await store.save(persisted);
    this.#emit({ type: "chat.changed", timestamp: this.#clock(), conversation: toConversation(persisted) });
    const turnId = `turn-${Date.now().toString(36)}-${(this.#turnCounter += 1)}`;
    this.#emit({ type: "chat.started", timestamp: this.#clock(), conversationId: record.id, turnId });

    let buffer = "";
    let bufferedChars = 0;
    let seq = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      if (!buffer) return;
      const chunk = buffer;
      buffer = "";
      bufferedChars = 0;
      this.#emit({ type: "chat.chunk", timestamp: this.#clock(), conversationId: record.id, turnId, chunk, seq: (seq += 1) - 1 });
    };
    const onChunk = (chunk: string): void => {
      buffer += chunk;
      bufferedChars += chunk.length;
      if (bufferedChars >= this.#chunkBatchChars) {
        flush();
        return;
      }
      if (!flushTimer) flushTimer = setTimeout(flush, this.#chunkBatchMs);
    };

    const finalize = async (output: string, receipt: ChatReceipt): Promise<void> => {
      flush();
      const messages = [...persisted.messages, { role: "assistant" as const, content: output, at: this.#clock(), receipt }];
      const completed: ChatSessionRecord = { ...persisted, messages };
      await store.save(completed);
      const message = toMessage(messages[messages.length - 1], messages.length - 1);
      this.#emit({ type: "chat.changed", timestamp: this.#clock(), conversation: toConversation(completed) });
      this.#emit({ type: "chat.completed", timestamp: this.#clock(), conversationId: record.id, turnId, message });
    };
    const fail = async (error: unknown): Promise<void> => {
      flush();
      const message = controller.signal.aborted
        ? "Cancelled."
        : error instanceof Error ? error.message : String(error);
      this.#emit({ type: "chat.failed", timestamp: this.#clock(), conversationId: record.id, turnId, message: message.slice(0, 2_000) || "Chat turn failed.", recoverable: true });
    };
    const cleanup = (): void => {
      if (flushTimer) clearTimeout(flushTimer);
      if (this.#controllers.get(record.id) === controller) this.#controllers.delete(record.id);
    };

    if (controller.signal.aborted) {
      await fail(controller.signal.reason);
      cleanup();
      return;
    }

    if (input.agent) {
      let toolSeq = 0;
      const hooks: ChatAgentTurnHooks = {
        onEvent: (event) => {
          if (event.type !== "subagent.tool_call") return;
          const args = (event.payload.arguments ?? {}) as Record<string, unknown>;
          this.#emit({ type: "chat.tool", timestamp: this.#clock(), conversationId: record.id, turnId, seq: toolSeq, tool: labelToolCall(event.payload.name, args) });
          toolSeq += 1;
        },
      };
      void this.#runAgentTurn(
        { cwd: root, engine, role: slug, message: promptContent, history: persisted.messages.slice(0, -1), override, grounding, signal: controller.signal },
        hooks,
      ).then((result) => finalize(result.output, result.receipt)).catch(fail).finally(cleanup);
      return;
    }

    void engine
      .complete({ role: slugToBinding(slug), prompt, systemPrompt, providerId: input.providerId, model: input.model, signal: controller.signal, onChunk })
      .then((result) => finalize(result.output, result.receipt))
      .catch(fail)
      .finally(cleanup);
  }

  #store(): ChatSessionStore {
    const root = this.#projectRootProvider();
    const key = path.resolve(root).toLowerCase();
    let store = this.#stores.get(key);
    if (!store) {
      store = new ChatSessionStore(root, { clock: this.#clock });
      this.#stores.set(key, store);
    }
    return store;
  }

  #engineFor(root: string, key: string, cache: Map<string, ChatEngine>): ChatEngine {
    let engine = cache.get(key);
    if (!engine) {
      engine = this.#createEngine(root, key);
      cache.set(key, engine);
    }
    return engine;
  }

  async #loadRecord(conversationId: string): Promise<ChatSessionRecord> {
    if (!CHAT_SESSION_ID_PATTERN.test(conversationId)) throw new Error("Chat conversation id is invalid.");
    const record = await this.#store().load(conversationId);
    if (!record) throw new Error("Chat conversation not found.");
    return record;
  }

  async #listArchived(store: ChatSessionStore): Promise<ChatSessionRecord[]> {
    const directory = path.join(store.baseDirectory, ARCHIVED_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ChatSessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!CHAT_SESSION_ID_PATTERN.test(id)) continue;
      try {
        records.push(JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8")) as ChatSessionRecord);
      } catch {
        // A single corrupt archive entry must not abort the listing.
      }
    }
    return records;
  }

  #resolveRoleSelection(input: string): ChatRoleSelection {
    if (input === "auto") return "auto";
    const binding = normalizeChatRole(input);
    if (!binding) throw new Error(`Unknown chat role '${input}'.`);
    return binding;
  }
}
