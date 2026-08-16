import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, ilike, isNull, sql, inArray, or } from "drizzle-orm";
import type { ProviderConnectionInput, RouteAttempt, RouteCandidate, RouteReceipt } from "@hive-cloud/contracts";
import { BUILTIN_PROVIDER_URLS, isFreeProviderModel, providerCatalogUrl } from "@hive-cloud/router";
import {
  apiKeys,
  attachments,
  auditEvents,
  citations,
  conversationShares,
  conversations,
  createDatabase,
  creditLedger,
  invitations,
  memberships,
  messages,
  messageAttachments,
  providerConnections,
  quotaPolicies,
  routeAttempts,
  routerRequests,
  tenants,
  users,
  userSettings,
  waitlistEntries,
  withServiceRole,
  withTenant,
  type HiveDatabase,
} from "@hive-cloud/database";
import {
  decryptProviderSecret,
  digestHiveApiKey,
  encryptProviderSecret,
  generateHiveApiKey,
  type EncryptedSecretEnvelope,
  type InternalSubject,
} from "@hive-cloud/security";

export type ProviderHealthStatus = "healthy" | "degraded" | "auth_failed";

export function classifyProviderHealth(response: Pick<Response, "ok" | "status"> | null): ProviderHealthStatus {
  if (response?.ok || (response && [404, 405].includes(response.status))) return "healthy";
  if (response && [401, 403].includes(response.status)) return "auth_failed";
  return "degraded";
}

export interface ConversationRecord {
  id: string;
  title: string;
  mode: "chat" | "build";
  updatedAt: string;
  archived: boolean;
  messages?: MessageRecord[];
}

export interface MessageRecord {
  id: string;
  parentMessageId?: string | null;
  revision?: number;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  status: "pending" | "streaming" | "complete" | "failed" | "cancelled";
  routeReceipt?: RouteReceipt;
  createdAt: string;
  attachments?: { id: string; name: string; status: string; mimeType?: string; sizeBytes?: number }[];
  citations?: { title: string; url: string; retrievedAt: string }[];
}

export interface SearchResult {
  id: string;
  title: string;
  mode: "chat" | "build";
  updatedAt: string;
  archived: boolean;
  pinnedAt?: string | null;
  snippet?: string;
  matchedMessageId?: string;
}

interface SearchMatch {
  conversationId: string;
  matchedMessageId: string;
  snippet: string;
  [key: string]: unknown;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => typeof part === "object" && part && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n");
  return "";
}

function snippetAround(text: string, query: string, window: number = 80): string {
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return text.slice(0, window * 2);
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + query.length + window);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const matched = text.slice(idx, idx + query.length);
  return `${prefix}${text.slice(start, idx)}«${matched}»${text.slice(idx + query.length, end)}${suffix}`;
}

export const CURSOR_VERSION = 1 as const;

/**
 * Thrown when a pagination cursor fails validation. Mapped to HTTP 422 by the
 * API error handler. Carries no cursor payload details so internals stay opaque.
 */
export class PaginationCursorError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor(message: string) {
    super(message);
    this.name = "PaginationCursorError";
  }
}

interface CursorPayload {
  v: number;
  kind: "conversations" | "messages";
  tenant: string;
  t: string;
  id: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** Encode a deterministic (timestamp, id) composite cursor bound to a tenant. */
export function encodeCursor(params: { kind: "conversations" | "messages"; tenant: string; t: string; id: string }): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, kind: params.kind, tenant: params.tenant, t: params.t, id: params.id };
  return base64UrlEncode(JSON.stringify(payload));
}

/**
 * Decode and validate a cursor. Throws {@link PaginationCursorError} for any
 * malformed, tampered, version-mismatched, cross-tenant, or kind-mismatched
 * cursor. Never exposes the raw payload on error.
 */
export function decodeCursor(input: string, kind: "conversations" | "messages", tenant: string): { t: string; id: string } {
  if (typeof input !== "string" || input.length === 0 || input.length > 1_024) {
    throw new PaginationCursorError("Cursor is malformed.");
  }
  let raw: string;
  try {
    raw = base64UrlDecode(input);
  } catch {
    throw new PaginationCursorError("Cursor encoding is invalid.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new PaginationCursorError("Cursor payload is not valid JSON.");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new PaginationCursorError("Cursor payload has an unsupported shape.");
  }
  const p = payload as Partial<CursorPayload>;
  if (typeof p.v !== "number" || p.v !== CURSOR_VERSION) {
    throw new PaginationCursorError("Cursor version is unsupported.");
  }
  if (p.kind !== kind) {
    throw new PaginationCursorError("Cursor kind does not match this resource.");
  }
  if (typeof p.tenant !== "string" || p.tenant !== tenant) {
    throw new PaginationCursorError("Cursor is not valid for this tenant.");
  }
  if (typeof p.t !== "string" || typeof p.id !== "string" || p.t.length === 0 || p.id.length === 0) {
    throw new PaginationCursorError("Cursor fields are incomplete.");
  }
  return { t: p.t, id: p.id };
}

interface ProviderRecord {
  id: string;
  input: Omit<ProviderConnectionInput, "api_key">;
  envelope: EncryptedSecretEnvelope;
  status: "pending" | "healthy" | "degraded" | "disabled" | "auth_failed";
  createdAt: string;
}

interface KeyRecord {
  id: string;
  name: string;
  prefix: string;
  digest: string;
  scopes: string[];
  subject: InternalSubject;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface AttachmentRecord {
  id: string;
  tenantId: string;
  userId: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: "quarantined" | "scanning" | "approved" | "rejected" | "deleted";
  sha256?: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface CloudStoreOptions {
  databaseUrl?: string;
  kekBase64: string;
}

export interface RouteRequestRecord {
  requestId: string;
  apiKeyId?: string;
  idempotencyKey?: string;
  requiredCapabilities: string[];
  statusCode?: number;
  errorCode?: string;
  receipt?: RouteReceipt;
  attempts: RouteAttempt[];
}

export interface AuditEventInput {
  eventType: string;
  targetType: string;
  targetId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string;
}

export class CloudStore {
  readonly #db?: HiveDatabase;
  readonly #pool?: ReturnType<typeof createDatabase>["pool"];
  readonly #kekBase64: string;
  readonly #conversations = new Map<string, ConversationRecord[]>();
  readonly #providers = new Map<string, ProviderRecord[]>();
  readonly #keys = new Map<string, KeyRecord>();
  readonly #shares: Array<{ tokenDigest: string; rawToken: string; conversationId: string; tenantId: string; revokedAt?: Date }> = [];
  readonly #attachments = new Map<string, AttachmentRecord>();
  readonly #credits = new Map<string, number>();
  readonly #userSettings = new Map<string, { systemPrompt: string | null; defaultModel: string | null; temperature: number | null }>();
  readonly #waitlist = new Map<string, { id: string; email: string; useCase?: string; approved: boolean; createdAt: string }>();
  readonly #routeRequests: RouteRequestRecord[] = [];
  readonly #auditEvents: Array<AuditEventInput & { tenantId?: string; actorUserId?: string }> = [];

  public constructor(options: CloudStoreOptions) {
    this.#kekBase64 = options.kekBase64;
    if (options.databaseUrl) {
      const database = createDatabase(options.databaseUrl);
      this.#db = database.db;
      this.#pool = database.pool;
    }
  }

  public get persistent(): boolean { return Boolean(this.#db); }

  public async close(): Promise<void> { await this.#pool?.end(); }

  public async ready(): Promise<boolean> {
    if (!this.#pool) return true;
    try { await this.#pool.query("select 1"); return true; } catch { return false; }
  }

  public async recordRouteRequest(subject: InternalSubject, record: RouteRequestRecord): Promise<void> {
    if (!this.#db) {
      if (!this.#routeRequests.some((entry) => entry.requestId === record.requestId || (record.idempotencyKey && entry.idempotencyKey === record.idempotencyKey))) {
        this.#routeRequests.push(structuredClone(record));
      }
      return;
    }
    await withTenant(this.#db, subject.tenantId, async (tx) => {
      const receipt = record.receipt;
      const inserted = await tx.insert(routerRequests).values({
        id: record.requestId,
        tenantId: subject.tenantId,
        ...(record.apiKeyId ? { apiKeyId: record.apiKeyId } : {}),
        ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
        routerModel: receipt?.router ?? "hive-0.1",
        routerPolicy: receipt?.policy ?? "free-first-balanced",
        requiredCapabilities: record.requiredCapabilities,
        ...(receipt ? {
          selectedProvider: receipt.provider as RouteCandidate["provider"],
          selectedModel: receipt.model,
          managed: receipt.managed,
          costClass: receipt.costClass,
          fallbackCount: receipt.fallbackCount,
          latencyMs: receipt.latencyMs,
          ...(receipt.promptTokens !== undefined ? { promptTokens: receipt.promptTokens } : {}),
          ...(receipt.completionTokens !== undefined ? { completionTokens: receipt.completionTokens } : {}),
        } : {}),
        ...(record.statusCode !== undefined ? { statusCode: record.statusCode } : {}),
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        completedAt: new Date(),
      }).onConflictDoNothing().returning({ id: routerRequests.id });
      if (!inserted[0] || record.attempts.length === 0) return;
      await tx.insert(routeAttempts).values(record.attempts.map((attempt) => ({
        tenantId: subject.tenantId,
        requestId: record.requestId,
        provider: attempt.provider as RouteCandidate["provider"],
        model: attempt.model,
        status: attempt.status,
        ...(attempt.statusCode !== undefined ? { statusCode: attempt.statusCode } : {}),
        ...(attempt.reason ? { reason: attempt.reason } : {}),
        latencyMs: attempt.latencyMs,
      })));
    });
  }

  public async audit(subject: InternalSubject | undefined, event: AuditEventInput): Promise<void> {
    if (!this.#db) {
      this.#auditEvents.push({ ...structuredClone(event), ...(subject ? { tenantId: subject.tenantId, actorUserId: subject.userId } : {}) });
      return;
    }
    await withServiceRole(this.#db, (tx) => tx.insert(auditEvents).values({
      ...(subject ? { tenantId: subject.tenantId, actorUserId: subject.userId } : {}),
      eventType: event.eventType,
      targetType: event.targetType,
      ...(event.targetId ? { targetId: event.targetId } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
      metadata: event.metadata ?? {},
      ...(event.ipHash ? { ipHash: event.ipHash } : {}),
    }));
  }

  public routeRequestCount(): number { return this.#routeRequests.length; }
  public auditEventCount(): number { return this.#auditEvents.length; }

  public async ensureSubject(subject: InternalSubject): Promise<void> {
    if (!this.#db) return;
    await withServiceRole(this.#db, async (tx) => {
      await tx.insert(users).values({ id: subject.userId, email: subject.email }).onConflictDoUpdate({ target: users.id, set: { email: subject.email, updatedAt: new Date() } });
      await tx.insert(tenants).values({ id: subject.tenantId, name: `${subject.email.split("@")[0] || "HIVE"}'s workspace`, slug: `personal-${subject.tenantId}` }).onConflictDoNothing();
      await tx.insert(memberships).values({ tenantId: subject.tenantId, userId: subject.userId, role: subject.role }).onConflictDoNothing();
    });
  }

  public async listConversations(subject: InternalSubject, params?: { limit?: number | undefined; cursor?: string | undefined; archived?: boolean | undefined }): Promise<{ items: Omit<ConversationRecord, "messages">[]; nextCursor?: string | undefined }> {
    const limit = params?.limit ?? 50;
    const cursor = params?.cursor
      ? decodeCursor(params.cursor, "conversations", subject.tenantId)
      : undefined;
    if (!this.#db) {
      let list = this.#conversations.get(subject.tenantId) ?? [];
      list = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      if (params?.archived) {
        list = list.filter((item) => item.archived);
      } else {
        list = list.filter((item) => !item.archived);
      }
      if (cursor) {
        list = list.filter((item) => item.updatedAt < cursor.t || (item.updatedAt === cursor.t && item.id < cursor.id));
      }
      const slice = list.slice(0, limit);
      const hasMore = list.length > limit;
      const items = slice.map(({ messages: _messages, ...rest }) => rest);
      return { items, ...(hasMore ? { nextCursor: encodeCursor({ kind: "conversations", tenant: subject.tenantId, t: slice.at(-1)!.updatedAt, id: slice.at(-1)!.id }) } : {}) };
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const base = and(eq(conversations.tenantId, subject.tenantId), isNull(conversations.deletedAt));
      const archivedCond = params?.archived ? sql`${conversations.archivedAt} IS NOT NULL` : isNull(conversations.archivedAt);
      const condition = cursor
        ? and(base, archivedCond, sql`(${conversations.updatedAt}, ${conversations.id}) < (${new Date(cursor.t)}::timestamptz, ${cursor.id})`)
        : and(base, archivedCond);
      const rows = await tx.select().from(conversations).where(condition).orderBy(sql`${conversations.pinnedAt} DESC NULLS LAST`, desc(conversations.updatedAt), desc(conversations.id)).limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        id: row.id,
        title: row.title,
        mode: row.mode,
        updatedAt: row.updatedAt.toISOString(),
        archived: Boolean(row.archivedAt),
        pinnedAt: row.pinnedAt?.toISOString() ?? null,
      }));
      return { items, ...(hasMore ? { nextCursor: encodeCursor({ kind: "conversations", tenant: subject.tenantId, t: items.at(-1)!.updatedAt, id: items.at(-1)!.id }) } : {}) };
    });
  }

  public async searchConversations(subject: InternalSubject, query: string, limit: number = 20): Promise<SearchResult[]> {
    if (!this.#db) {
      let list = this.#conversations.get(subject.tenantId) ?? [];
      const lowerQuery = query.toLowerCase();
      const matchedConvIds = new Set<string>();
      const snippetMap = new Map<string, { snippet: string; messageId: string }>();
      for (const conv of list) {
        const titleMatch = conv.title.toLowerCase().includes(lowerQuery);
        if (titleMatch) matchedConvIds.add(conv.id);
        for (const m of (conv.messages || [])) {
          const text = contentText(m.content).toLowerCase();
          if (text.includes(lowerQuery)) {
            matchedConvIds.add(conv.id);
            if (!snippetMap.has(conv.id)) {
              snippetMap.set(conv.id, {
                snippet: snippetAround(contentText(m.content), query),
                messageId: m.id,
              });
            }
          }
        }
      }
      list = list.filter((item) => matchedConvIds.has(item.id));
      list = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const slice = list.slice(0, limit);
      return slice.map(({ messages: _messages, ...rest }) => {
        const info = snippetMap.get(rest.id);
        return {
          id: rest.id,
          title: rest.title,
          mode: rest.mode,
          updatedAt: rest.updatedAt,
          archived: rest.archived,
          ...(info ? { snippet: info.snippet, matchedMessageId: info.messageId } : {}),
        };
      });
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const ftsQuery = sql`plainto_tsquery('english', ${query})`;
      const ftsVector = sql`to_tsvector('english', COALESCE(m.content::text, ''))`;
      const matchedMessages = await tx.execute<SearchMatch>(sql`
        SELECT m.conversation_id AS "conversationId", m.id AS "matchedMessageId",
          ts_headline('english', m.content::text, ${ftsQuery},
            'MaxWords=35, MinWords=15, StartSel=<mark>, StopSel=</mark>') AS "snippet"
        FROM ${messages} m
        WHERE m.tenant_id = ${subject.tenantId}
          AND ${ftsVector} @@ ${ftsQuery}
        LIMIT 200
      `);
      const msgMap = new Map<string, { snippet: string; matchedMessageId: string }>();
      for (const row of matchedMessages.rows) {
        if (!msgMap.has(row.conversationId)) {
          msgMap.set(row.conversationId, { snippet: row.snippet, matchedMessageId: row.matchedMessageId });
        }
      }
      const titleMatches = await tx.select({ id: conversations.id }).from(conversations)
        .where(and(eq(conversations.tenantId, subject.tenantId), isNull(conversations.deletedAt), ilike(conversations.title, `%${query}%`)));
      for (const row of titleMatches) {
        if (!msgMap.has(row.id)) msgMap.set(row.id, { snippet: undefined as unknown as string, matchedMessageId: undefined as unknown as string });
      }
      if (msgMap.size === 0) return [];
      const convIds = [...msgMap.keys()];
      const rows = await tx.select().from(conversations)
        .where(and(eq(conversations.tenantId, subject.tenantId), isNull(conversations.deletedAt), inArray(conversations.id, convIds)))
        .orderBy(desc(conversations.updatedAt)).limit(limit);
      return rows.map((row) => {
        const info = msgMap.get(row.id);
        return {
          id: row.id,
          title: row.title,
          mode: row.mode,
          updatedAt: row.updatedAt.toISOString(),
          archived: Boolean(row.archivedAt),
          ...(info?.matchedMessageId ? { snippet: info.snippet, matchedMessageId: info.matchedMessageId } : {}),
        };
      });
    });
  }

  public async getConversation(subject: InternalSubject, id: string, options?: { includeMessages?: boolean }): Promise<ConversationRecord | null> {
    if (!this.#db) {
      const record = (this.#conversations.get(subject.tenantId) ?? []).find((item) => item.id === id);
      if (!record) return null;
      if (!options?.includeMessages) {
        const { messages: _messages, ...rest } = record;
        return rest as ConversationRecord;
      }
      return record;
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const [row] = await tx.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.tenantId, subject.tenantId), isNull(conversations.deletedAt))).limit(1);
      if (!row) return null;
      let messageRows: any[] = [];
      let messageAttachmentsData: any[] = [];
      let messageCitationsData: any[] = [];
      if (options?.includeMessages) {
        messageRows = await tx.select().from(messages).where(eq(messages.conversationId, row.id)).orderBy(messages.createdAt);
        if (messageRows.length > 0) {
          messageAttachmentsData = await tx.select({
            messageId: messageAttachments.messageId,
            id: attachments.id,
            originalName: attachments.originalName,
            status: attachments.status,
            mimeType: attachments.mimeType,
            sizeBytes: attachments.sizeBytes,
          }).from(messageAttachments)
            .innerJoin(attachments, eq(messageAttachments.attachmentId, attachments.id))
            .where(inArray(messageAttachments.messageId, messageRows.map((m) => m.id)));
          messageCitationsData = await tx.select().from(citations).where(and(
            eq(citations.tenantId, subject.tenantId),
            inArray(citations.messageId, messageRows.map((m) => m.id)),
          ));
        }
      }
      return {
        id: row.id,
        title: row.title,
        mode: row.mode,
        updatedAt: row.updatedAt.toISOString(),
        archived: Boolean(row.archivedAt),
        ...(options?.includeMessages ? {
          messages: messageRows.map((message) => {
            const atts = messageAttachmentsData.filter((a) => a.messageId === message.id);
            const sources = messageCitationsData.filter((citation) => citation.messageId === message.id);
            return {
              id: message.id,
              parentMessageId: message.parentMessageId,
              revision: message.revision,
              role: message.role,
              content: message.content,
              status: message.status,
              ...(message.routeReceipt ? { routeReceipt: message.routeReceipt as RouteReceipt } : {}),
              createdAt: message.createdAt.toISOString(),
              ...(atts.length > 0 ? {
                attachments: atts.map((a) => ({ id: a.id, name: a.originalName, status: a.status, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
              } : {}),
              ...(sources.length > 0 ? { citations: sources.map((citation) => ({ title: citation.title, url: citation.url, retrievedAt: citation.retrievedAt.toISOString() })) } : {}),
            };
          })
        } : {})
      };
    });
  }

  public async listMessages(subject: InternalSubject, conversationId: string, params?: { limit?: number | undefined; cursor?: string | undefined }): Promise<{ items: MessageRecord[]; nextCursor?: string | undefined }> {
    const limit = params?.limit ?? 50;
    const cursor = params?.cursor
      ? decodeCursor(params.cursor, "messages", subject.tenantId)
      : undefined;
    if (!this.#db) {
      const conversation = (this.#conversations.get(subject.tenantId) ?? []).find((item) => item.id === conversationId);
      if (!conversation || !conversation.messages) return { items: [] };
      let list = conversation.messages.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      if (cursor) {
        list = list.filter((item) => item.createdAt < cursor.t || (item.createdAt === cursor.t && item.id < cursor.id));
      }
      const slice = list.slice(0, limit);
      const hasMore = list.length > limit;
      const items = slice;
      return { items, ...(hasMore ? { nextCursor: encodeCursor({ kind: "messages", tenant: subject.tenantId, t: items.at(-1)!.createdAt, id: items.at(-1)!.id }) } : {}) };
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const [conv] = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, subject.tenantId))).limit(1);
      if (!conv) throw new Error("Conversation not found");

      const condition = cursor
        ? and(eq(messages.conversationId, conversationId), sql`(${messages.createdAt}, ${messages.id}) < (${new Date(cursor.t)}::timestamptz, ${cursor.id})`)
        : eq(messages.conversationId, conversationId);
      
      const rows = await tx.select().from(messages).where(condition).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit + 1);
      const hasMore = rows.length > limit;
      const resultRows = rows.slice(0, limit);
      
      let messageAttachmentsData: any[] = [];
      let messageCitationsData: any[] = [];
      if (resultRows.length > 0) {
        messageAttachmentsData = await tx.select({
          messageId: messageAttachments.messageId,
          id: attachments.id,
          originalName: attachments.originalName,
          status: attachments.status,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
        }).from(messageAttachments)
          .innerJoin(attachments, eq(messageAttachments.attachmentId, attachments.id))
          .where(inArray(messageAttachments.messageId, resultRows.map((m) => m.id)));
        messageCitationsData = await tx.select().from(citations).where(and(
          eq(citations.tenantId, subject.tenantId),
          inArray(citations.messageId, resultRows.map((m) => m.id)),
        ));
      }

      const items = resultRows.map((message) => {
        const atts = messageAttachmentsData.filter((a) => a.messageId === message.id);
        const sources = messageCitationsData.filter((citation) => citation.messageId === message.id);
        return {
          id: message.id,
          parentMessageId: message.parentMessageId,
          revision: message.revision,
          role: message.role,
          content: message.content,
          status: message.status,
          ...(message.routeReceipt ? { routeReceipt: message.routeReceipt as RouteReceipt } : {}),
          createdAt: message.createdAt.toISOString(),
          ...(atts.length > 0 ? {
            attachments: atts.map((a) => ({ id: a.id, name: a.originalName, status: a.status, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
          } : {}),
          ...(sources.length > 0 ? { citations: sources.map((citation) => ({ title: citation.title, url: citation.url, retrievedAt: citation.retrievedAt.toISOString() })) } : {}),
        };
      });
      return { items, ...(hasMore ? { nextCursor: encodeCursor({ kind: "messages", tenant: subject.tenantId, t: items.at(-1)!.createdAt, id: items.at(-1)!.id }) } : {}) };
    });
  }

  public async createConversation(subject: InternalSubject, mode: "chat" | "build" = "chat", title = "New conversation"): Promise<ConversationRecord> {
    const record: ConversationRecord = { id: randomUUID(), title, mode, updatedAt: new Date().toISOString(), archived: false, messages: [] };
    if (!this.#db) {
      const list = this.#conversations.get(subject.tenantId) ?? [];
      this.#conversations.set(subject.tenantId, [record, ...list]);
      return record;
    }
    await this.ensureSubject(subject);
    await withTenant(this.#db, subject.tenantId, (tx) => tx.insert(conversations).values({ id: record.id, tenantId: subject.tenantId, userId: subject.userId, mode, title }));
    return record;
  }

  public async updateConversation(subject: InternalSubject, id: string, patch: { title?: string; archived?: boolean; deleted?: boolean; pinned?: boolean }): Promise<boolean> {
    if (!this.#db) {
      const record = (this.#conversations.get(subject.tenantId) ?? []).find((item) => item.id === id);
      if (!record) return false;
      if (patch.title) record.title = patch.title;
      if (patch.archived !== undefined) record.archived = patch.archived;
      if (patch.deleted) this.#conversations.set(subject.tenantId, (this.#conversations.get(subject.tenantId) ?? []).filter((item) => item.id !== id));
      record.updatedAt = new Date().toISOString();
      return true;
    }
    const now = new Date();
    const result = await withTenant(this.#db, subject.tenantId, (tx) => tx.update(conversations).set({
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.archived !== undefined ? { archivedAt: patch.archived ? now : null } : {}),
      ...(patch.deleted ? { deletedAt: now, purgeAfter: new Date(now.getTime() + 30 * 86_400_000) } : {}),
      ...(patch.pinned !== undefined ? { pinnedAt: patch.pinned ? now : null } : {}),
      updatedAt: now,
    }).where(and(eq(conversations.id, id), eq(conversations.tenantId, subject.tenantId))).returning({ id: conversations.id }));
    return result.length === 1;
  }

  public async getBranchingContext(subject: InternalSubject, conversationId: string, requestedParentId?: string | null): Promise<{ parentMessageId: string | null; revision: number }> {
    if (!this.#db) {
      const conversation = (this.#conversations.get(subject.tenantId) ?? []).find((item) => item.id === conversationId);
      if (!conversation || !conversation.messages) throw new Error("Conversation not found");
      let parentMessageId = requestedParentId !== undefined ? requestedParentId : null;
      if (requestedParentId === undefined && conversation.messages.length > 0) {
        parentMessageId = conversation.messages[conversation.messages.length - 1]!.id;
      }
      let revision = 1;
      if (parentMessageId) {
        const children = conversation.messages.filter((m) => m.parentMessageId === parentMessageId);
        revision = children.length + 1;
      } else {
        const rootMessages = conversation.messages.filter((m) => !m.parentMessageId);
        revision = rootMessages.length + 1;
      }
      return { parentMessageId, revision };
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      let parentMessageId = requestedParentId !== undefined ? requestedParentId : null;
      if (requestedParentId === undefined) {
        const [latest] = await tx.select({ id: messages.id }).from(messages)
          .where(and(eq(messages.conversationId, conversationId), eq(messages.tenantId, subject.tenantId)))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        if (latest) parentMessageId = latest.id;
      } else if (parentMessageId) {
        const [exists] = await tx.select({ id: messages.id }).from(messages)
          .where(and(eq(messages.id, parentMessageId), eq(messages.tenantId, subject.tenantId)))
          .limit(1);
        if (!exists) throw new Error("Parent message not found");
      }
      const condition = parentMessageId 
        ? and(eq(messages.conversationId, conversationId), eq(messages.parentMessageId, parentMessageId))
        : and(eq(messages.conversationId, conversationId), isNull(messages.parentMessageId));
      const [result] = await tx.select({ count: count() }).from(messages)
        .where(and(condition, eq(messages.tenantId, subject.tenantId)));
      return { parentMessageId, revision: (result?.count ?? 0) + 1 };
    });
  }

  public async appendMessage(subject: InternalSubject, conversationId: string, input: Omit<MessageRecord, "id" | "createdAt">): Promise<MessageRecord> {
    const record: MessageRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    if (!this.#db) {
      const conversation = (this.#conversations.get(subject.tenantId) ?? []).find((item) => item.id === conversationId);
      if (!conversation || !conversation.messages) throw new Error("Conversation not found");
      conversation.messages.push(record);
      conversation.updatedAt = record.createdAt;
      return record;
    }
    await withTenant(this.#db, subject.tenantId, async (tx) => {
      await tx.insert(messages).values({
        id: record.id,
        tenantId: subject.tenantId,
        conversationId,
        parentMessageId: record.parentMessageId,
        revision: record.revision,
        role: record.role,
        status: record.status,
        content: record.content,
        ...(record.routeReceipt ? { routeReceipt: record.routeReceipt } : {}),
      });
      if (record.citations?.length) await tx.insert(citations).values(record.citations.map((citation) => ({
        tenantId: subject.tenantId,
        messageId: record.id,
        title: citation.title,
        url: citation.url,
        retrievedAt: new Date(citation.retrievedAt),
      })));
      await tx.update(conversations).set({ updatedAt: new Date() }).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, subject.tenantId)));
    });
    return record;
  }

  public async createAttachment(subject: InternalSubject, input: Omit<AttachmentRecord, "tenantId" | "userId" | "status">): Promise<AttachmentRecord> {
    const record: AttachmentRecord = { ...input, tenantId: subject.tenantId, userId: subject.userId, status: "quarantined" };
    if (!this.#db) {
      this.#attachments.set(record.id, record);
      return record;
    }
    await withTenant(this.#db, subject.tenantId, (tx) => tx.insert(attachments).values({
      id: record.id,
      tenantId: subject.tenantId,
      userId: subject.userId,
      objectKey: record.objectKey,
      originalName: record.originalName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      status: record.status,
    }));
    return record;
  }

  public async markAttachment(subject: InternalSubject, id: string, patch: { status: AttachmentRecord["status"]; objectKey?: string; sha256?: string; extractedText?: string }): Promise<boolean> {
    if (!this.#db) {
      const record = this.#attachments.get(id);
      if (!record || record.tenantId !== subject.tenantId) return false;
      record.status = patch.status;
      if (patch.objectKey) record.objectKey = patch.objectKey;
      if (patch.sha256) record.sha256 = patch.sha256;
      if (patch.extractedText) (record as any).extractedText = patch.extractedText;
      return true;
    }
    const result = await withTenant(this.#db, subject.tenantId, (tx) => tx.update(attachments).set({
      status: patch.status,
      ...(patch.objectKey ? { objectKey: patch.objectKey } : {}),
      ...(patch.sha256 ? { sha256: patch.sha256 } : {}),
      ...(patch.extractedText ? { extractedText: patch.extractedText } : {}),
      updatedAt: new Date(),
    }).where(and(eq(attachments.id, id), eq(attachments.tenantId, subject.tenantId))).returning({ id: attachments.id }));
    return result.length === 1;
  }

  public async getAttachments(subject: InternalSubject, ids: string[]): Promise<(AttachmentRecord & { extractedText?: string })[]> {
    if (ids.length === 0) return [];
    if (!this.#db) {
      return ids.map((id) => this.#attachments.get(id)).filter((a): a is AttachmentRecord => a !== undefined && a.tenantId === subject.tenantId);
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const rows = await tx.select().from(attachments).where(and(inArray(attachments.id, ids), eq(attachments.tenantId, subject.tenantId), isNull(attachments.deletedAt)));
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        userId: row.userId,
        objectKey: row.objectKey,
        originalName: row.originalName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        status: row.status,
        ...(row.sha256 ? { sha256: row.sha256 } : {}),
        ...(row.extractedText ? { extractedText: row.extractedText } : {}),
      }));
    });
  }

  public async deleteAttachment(subject: InternalSubject, id: string): Promise<boolean> {
    if (!this.#db) {
      const record = this.#attachments.get(id);
      if (!record || record.tenantId !== subject.tenantId) return false;
      this.#attachments.delete(id);
      return true;
    }
    const result = await withTenant(this.#db, subject.tenantId, (tx) => tx.update(attachments).set({
      deletedAt: new Date(),
      status: "deleted",
      updatedAt: new Date(),
    }).where(and(eq(attachments.id, id), eq(attachments.tenantId, subject.tenantId))).returning({ id: attachments.id }));
    return result.length === 1;
  }

  public async listProviders(subject: InternalSubject): Promise<Array<Record<string, unknown>>> {
    if (!this.#db) return (this.#providers.get(subject.tenantId) ?? []).map((provider) => ({ id: provider.id, ...provider.input, status: provider.status, created_at: provider.createdAt, has_secret: true }));
    return withTenant(this.#db, subject.tenantId, async (tx) => (await tx.select({
      id: providerConnections.id,
      kind: providerConnections.kind,
      name: providerConnections.name,
      base_url: providerConnections.baseUrl,
      default_model: providerConnections.defaultModel,
      capabilities: providerConnections.capabilities,
      status: providerConnections.status,
      created_at: providerConnections.createdAt,
    }).from(providerConnections).where(eq(providerConnections.tenantId, subject.tenantId))).map((provider) => ({ ...provider, has_secret: true })));
  }

  public async addProvider(subject: InternalSubject, input: ProviderConnectionInput, status: ProviderRecord["status"] = "healthy"): Promise<{ id: string }> {
    const id = randomUUID();
    const { api_key: secret, ...safeInput } = input;
    const envelope = encryptProviderSecret(secret, this.#kekBase64, subject.tenantId, id);
    if (!this.#db) {
      const list = this.#providers.get(subject.tenantId) ?? [];
      list.push({ id, input: safeInput, envelope, status, createdAt: new Date().toISOString() });
      this.#providers.set(subject.tenantId, list);
      return { id };
    }
    await withTenant(this.#db, subject.tenantId, (tx) => tx.insert(providerConnections).values({
      id,
      tenantId: subject.tenantId,
      kind: input.kind,
      name: input.name,
      baseUrl: input.base_url || BUILTIN_PROVIDER_URLS[input.kind === "custom" ? "openrouter" : input.kind],
      defaultModel: input.default_model,
      capabilities: input.capabilities,
      secretEnvelope: envelope,
      status,
      lastHealthAt: new Date(),
    }));
    return { id };
  }

  public async providerCandidates(subject: InternalSubject): Promise<RouteCandidate[]> {
    if (!this.#db) return (this.#providers.get(subject.tenantId) ?? []).filter((item) => item.status === "healthy").map((item) => this.#candidateFromRecord(subject.tenantId, item));
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const rows = await tx.select().from(providerConnections).where(and(eq(providerConnections.tenantId, subject.tenantId), eq(providerConnections.status, "healthy"), isNull(providerConnections.disabledAt)));
      return rows.map((row) => {
        const capabilities = row.capabilities as ProviderConnectionInput["capabilities"];
        return {
          id: row.id,
          provider: row.kind,
          providerName: row.name,
          model: row.defaultModel,
          baseUrl: row.baseUrl,
          apiKey: decryptProviderSecret(row.secretEnvelope as EncryptedSecretEnvelope, this.#kekBase64, subject.tenantId, row.id),
          managed: false,
          free: isFreeProviderModel(row.kind, row.defaultModel),
          healthy: true,
          latencyMs: 350,
          quality: 80,
          contextWindow: capabilities.context_window,
          vision: capabilities.vision,
          tools: capabilities.tools,
        } satisfies RouteCandidate;
      });
    });
  }

  #candidateFromRecord(tenantId: string, provider: ProviderRecord): RouteCandidate {
    return {
      id: provider.id,
      provider: provider.input.kind,
      providerName: provider.input.name,
      model: provider.input.default_model,
      baseUrl: provider.input.base_url || BUILTIN_PROVIDER_URLS[provider.input.kind === "custom" ? "openrouter" : provider.input.kind],
      apiKey: decryptProviderSecret(provider.envelope, this.#kekBase64, tenantId, provider.id),
      managed: false,
      free: isFreeProviderModel(provider.input.kind, provider.input.default_model),
      healthy: provider.status === "healthy",
      latencyMs: 350,
      quality: 80,
      contextWindow: provider.input.capabilities.context_window,
      vision: provider.input.capabilities.vision,
      tools: provider.input.capabilities.tools,
    };
  }

  public async createApiKey(subject: InternalSubject, name: string, scopes: string[], pepper: string): Promise<ApiKeySummary & { raw: string }> {
    const generated = generateHiveApiKey(pepper);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    if (!this.#db) {
      this.#keys.set(generated.digest, { id, name, prefix: generated.prefix, digest: generated.digest, scopes, subject, createdAt });
    } else {
      await withTenant(this.#db, subject.tenantId, (tx) => tx.insert(apiKeys).values({ id, tenantId: subject.tenantId, createdByUserId: subject.userId, name, prefix: generated.prefix, digest: generated.digest, scopes }));
    }
    return { id, name, prefix: generated.prefix, scopes, createdAt, raw: generated.raw };
  }

  public async listApiKeys(subject: InternalSubject): Promise<ApiKeySummary[]> {
    if (!this.#db) return [...this.#keys.values()].filter((key) => key.subject.tenantId === subject.tenantId).map(({ digest: _digest, subject: _subject, ...key }) => key);
    return withTenant(this.#db, subject.tenantId, async (tx) => (await tx.select().from(apiKeys).where(eq(apiKeys.tenantId, subject.tenantId)).orderBy(desc(apiKeys.createdAt))).map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes as string[],
      createdAt: key.createdAt.toISOString(),
      ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt.toISOString() } : {}),
      ...(key.revokedAt ? { revokedAt: key.revokedAt.toISOString() } : {}),
    })));
  }

  public async revokeApiKey(subject: InternalSubject, id: string): Promise<boolean> {
    if (!this.#db) {
      const record = [...this.#keys.values()].find((key) => key.id === id && key.subject.tenantId === subject.tenantId);
      if (!record) return false;
      record.revokedAt = new Date().toISOString();
      return true;
    }
    const result = await withTenant(this.#db, subject.tenantId, (tx) => tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, subject.tenantId), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id }));
    return result.length === 1;
  }

  public async authenticateApiKey(raw: string, pepper: string): Promise<{ id: string; scopes: string[]; subject: InternalSubject } | null> {
    const digest = digestHiveApiKey(raw, pepper);
    if (!this.#db) {
      const key = this.#keys.get(digest);
      if (!key || key.revokedAt) return null;
      key.lastUsedAt = new Date().toISOString();
      return { id: key.id, scopes: key.scopes, subject: key.subject };
    }
    return withServiceRole(this.#db, async (tx) => {
      const [key] = await tx.select({ key: apiKeys, user: users, membership: memberships }).from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.createdByUserId))
        .innerJoin(memberships, and(eq(memberships.tenantId, apiKeys.tenantId), eq(memberships.userId, apiKeys.createdByUserId)))
        .where(and(eq(apiKeys.digest, digest), isNull(apiKeys.revokedAt))).limit(1);
      if (!key || key.user.suspendedAt || (key.key.expiresAt && key.key.expiresAt < new Date())) return null;
      await tx.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.key.id));
      return {
        id: key.key.id,
        scopes: key.key.scopes as string[],
        subject: { userId: key.user.id, tenantId: key.key.tenantId, email: key.user.email, role: key.membership.role },
      };
    });
  }

  public async getQuotaPolicy(subject: InternalSubject) {
    if (!this.#db) {
      return {
        requestsPerMinute: 60,
        managedRequestsPerMinute: 20,
        concurrentStreams: 5,
        webSearchesPerDay: 100,
      };
    }
    const [row] = await withTenant(this.#db, subject.tenantId, (tx) =>
      tx.select().from(quotaPolicies).where(eq(quotaPolicies.tenantId, subject.tenantId)).limit(1)
    );
    if (!row) {
      return {
        requestsPerMinute: 60,
        managedRequestsPerMinute: 20,
        concurrentStreams: 5,
        webSearchesPerDay: 100,
      };
    }
    return {
      requestsPerMinute: row.requestsPerMinute,
      managedRequestsPerMinute: row.managedRequestsPerMinute,
      concurrentStreams: row.concurrentStreams,
      webSearchesPerDay: row.webSearchesPerDay,
    };
  }

  public async getUserSettings(subject: InternalSubject) {
    if (!this.#db) {
      return this.#userSettings.get(`${subject.tenantId}:${subject.userId}`) ?? { systemPrompt: null, defaultModel: null, temperature: null };
    }
    const [row] = await withTenant(this.#db, subject.tenantId, (tx) =>
      tx.select().from(userSettings).where(eq(userSettings.userId, subject.userId)).limit(1)
    );
    return row || { systemPrompt: null, defaultModel: null, temperature: null };
  }

  public async updateUserSettings(subject: InternalSubject, settings: { systemPrompt?: string | null; defaultModel?: string | null; temperature?: number | null }) {
    if (!this.#db) {
      const key = `${subject.tenantId}:${subject.userId}`;
      const current = this.#userSettings.get(key) ?? { systemPrompt: null, defaultModel: null, temperature: null };
      this.#userSettings.set(key, { ...current, ...settings });
      return;
    }
    const now = new Date();
    await withTenant(this.#db, subject.tenantId, (tx) =>
      tx.insert(userSettings).values({
        userId: subject.userId,
        systemPrompt: settings.systemPrompt !== undefined ? settings.systemPrompt : null,
        defaultModel: settings.defaultModel !== undefined ? settings.defaultModel : null,
        temperature: settings.temperature !== undefined ? (settings.temperature === null ? null : settings.temperature) : null,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [userSettings.userId],
        set: {
          ...(settings.systemPrompt !== undefined ? { systemPrompt: settings.systemPrompt } : {}),
          ...(settings.defaultModel !== undefined ? { defaultModel: settings.defaultModel } : {}),
          ...(settings.temperature !== undefined ? { temperature: settings.temperature === null ? null : settings.temperature } : {}),
          updatedAt: now,
        }
      })
    );
  }

  public async credits(subject: InternalSubject): Promise<number> {
    if (!this.#db) return this.#credits.get(subject.tenantId) ?? 0;
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const [row] = await tx.select({ balance: sql<string>`coalesce(sum(${creditLedger.amount}), 0)` }).from(creditLedger).where(eq(creditLedger.tenantId, subject.tenantId));
      return Number(row?.balance ?? 0);
    });
  }

  public async changeCredits(subject: InternalSubject, amount: number, reason: string, idempotencyKey: string, requestId?: string, metadata?: Record<string, unknown>): Promise<number> {
    if (!this.#db) {
      const current = this.#credits.get(subject.tenantId) ?? 0;
      this.#credits.set(subject.tenantId, current + amount);
      return current + amount;
    }
    await withTenant(this.#db, subject.tenantId, (tx) => tx.insert(creditLedger).values({
      tenantId: subject.tenantId,
      amount,
      reason,
      idempotencyKey,
      ...(requestId ? { requestId } : {}),
      ...(metadata ? { metadata } : {}),
      grantedByUserId: amount > 0 ? subject.userId : null,
    }).onConflictDoNothing());
    return this.credits(subject);
  }

  public async joinWaitlist(email: string, useCase?: string): Promise<{ id: string; alreadyExisted: boolean }> {
    const normalized = email.trim().toLowerCase();
    if (!this.#db) {
      const existing = this.#waitlist.get(normalized);
      if (existing) return { id: existing.id, alreadyExisted: true };
      const entry = { id: randomUUID(), email: normalized, ...(useCase ? { useCase } : {}), approved: false, createdAt: new Date().toISOString() };
      this.#waitlist.set(normalized, entry);
      return { id: entry.id, alreadyExisted: false };
    }
    return withServiceRole(this.#db, async (tx) => {
      const inserted = await tx.insert(waitlistEntries).values({ email: normalized, ...(useCase ? { useCase } : {}) }).onConflictDoNothing().returning({ id: waitlistEntries.id });
      if (inserted[0]) return { id: inserted[0].id, alreadyExisted: false };
      const [existing] = await tx.select({ id: waitlistEntries.id }).from(waitlistEntries).where(eq(waitlistEntries.email, normalized)).limit(1);
      if (!existing) throw new Error("Unable to create waitlist entry.");
      return { id: existing.id, alreadyExisted: true };
    });
  }

  public async listWaitlist(): Promise<Array<{ id: string; email: string; useCase?: string; approved: boolean; createdAt: string }>> {
    if (!this.#db) return [...this.#waitlist.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return withServiceRole(this.#db, async (tx) => (await tx.select().from(waitlistEntries).orderBy(desc(waitlistEntries.createdAt)).limit(250)).map((entry) => ({
      id: entry.id,
      email: entry.email,
      ...(entry.useCase ? { useCase: entry.useCase } : {}),
      approved: Boolean(entry.approvedAt),
      createdAt: entry.createdAt.toISOString(),
    })));
  }

  public async approveWaitlist(id: string, actorUserId: string): Promise<{ email: string; rawToken: string; expiresAt: string } | null> {
    const rawToken = randomBytes(32).toString("base64url");
    const tokenDigest = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1_000);
    if (!this.#db) {
      const entry = [...this.#waitlist.values()].find((item) => item.id === id);
      if (!entry) return null;
      entry.approved = true;
      return { email: entry.email, rawToken, expiresAt: expiresAt.toISOString() };
    }
    return withServiceRole(this.#db, async (tx) => {
      const [entry] = await tx.update(waitlistEntries).set({ approvedAt: new Date() }).where(eq(waitlistEntries.id, id)).returning({ email: waitlistEntries.email });
      if (!entry) return null;
      await tx.update(invitations).set({ status: "revoked" }).where(and(eq(invitations.email, entry.email), eq(invitations.status, "pending")));
      await tx.insert(invitations).values({ email: entry.email, tokenDigest, status: "pending", expiresAt, createdByUserId: actorUserId });
      return { email: entry.email, rawToken, expiresAt: expiresAt.toISOString() };
    });
  }

  public async shareConversation(subject: InternalSubject, conversationId: string): Promise<{ token: string; url: string } | null> {
    const conversation = await this.getConversation(subject, conversationId);
    if (!conversation) return null;
    const rawToken = `hive_share_${randomBytes(32).toString("base64url")}`;
    const tokenDigest = createHash("sha256").update(rawToken).digest("hex");
    if (!this.#db) {
      this.#shares.push({ tokenDigest, rawToken, conversationId, tenantId: subject.tenantId });
      return { token: rawToken, url: `/api/shared/${rawToken}` };
    }
    await withTenant(this.#db, subject.tenantId, async (tx) => {
      await tx.insert(conversationShares).values({
        tenantId: subject.tenantId,
        conversationId,
        tokenDigest,
      });
    });
    return { token: rawToken, url: `/api/shared/${rawToken}` };
  }

  public async revokeShare(subject: InternalSubject, conversationId: string): Promise<boolean> {
    if (!this.#db) {
      const share = this.#shares.find((s) => s.conversationId === conversationId && s.tenantId === subject.tenantId && !s.revokedAt);
      if (!share) return false;
      share.revokedAt = new Date();
      return true;
    }
    const result = await withTenant(this.#db, subject.tenantId, (tx) =>
      tx.update(conversationShares).set({ revokedAt: new Date() })
        .where(and(eq(conversationShares.conversationId, conversationId), eq(conversationShares.tenantId, subject.tenantId), isNull(conversationShares.revokedAt)))
        .returning({ id: conversationShares.id }));
    return result.length > 0;
  }

  public async getSharedConversation(token: string): Promise<{ title: string; messages: Array<{ role: string; content: unknown; createdAt: string }> } | null> {
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    if (!this.#db) {
      const share = this.#shares.find((s) => s.tokenDigest === tokenDigest && !s.revokedAt);
      if (!share) return null;
      const list = this.#conversations.get(share.tenantId) ?? [];
      const conversation = list.find((c) => c.id === share.conversationId);
      if (!conversation || !conversation.messages) return null;
      return {
        title: conversation.title,
        messages: conversation.messages.map((msg) => ({ role: msg.role, content: msg.content, createdAt: msg.createdAt })),
      };
    }
    return withServiceRole(this.#db, async (tx) => {
      const [share] = await tx.select().from(conversationShares)
        .where(and(eq(conversationShares.tokenDigest, tokenDigest), isNull(conversationShares.revokedAt)))
        .limit(1);
      if (!share) return null;
      const [conv] = await tx.select({ id: conversations.id, title: conversations.title }).from(conversations)
        .where(and(eq(conversations.id, share.conversationId), isNull(conversations.deletedAt)))
        .limit(1);
      if (!conv) return null;
      const rows = await tx.select({ role: messages.role, content: messages.content, createdAt: messages.createdAt }).from(messages)
        .where(eq(messages.conversationId, conv.id))
        .orderBy(messages.createdAt);
      return {
        title: conv.title,
        messages: rows.map((row) => ({
          role: row.role,
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    });
  }

  public async updateProvider(
    subject: InternalSubject,
    id: string,
    patch: {
      name?: string | undefined;
      base_url?: string | undefined;
      api_key?: string | undefined;
      default_model?: string | undefined;
      disabled?: boolean | undefined;
    },
  ): Promise<{
    id: string;
    kind: string;
    name: string;
    base_url: string;
    default_model: string;
    capabilities: unknown;
    status: string;
    created_at: string;
    has_secret: boolean;
    disabled?: string | null;
  } | null> {
    if (!this.#db) {
      const list = this.#providers.get(subject.tenantId) ?? [];
      const record = list.find((item) => item.id === id);
      if (!record) return null;
      if (patch.name !== undefined) record.input.name = patch.name;
      if (patch.base_url !== undefined) record.input.base_url = patch.base_url;
      if (patch.api_key !== undefined) {
        record.envelope = encryptProviderSecret(patch.api_key, this.#kekBase64, subject.tenantId, id);
      }
      if (patch.default_model !== undefined) record.input.default_model = patch.default_model;
      if (patch.disabled !== undefined) {
        if (patch.disabled) {
          record.status = "disabled";
        } else if (record.status === "disabled") {
          record.status = "pending";
        }
      }
      return {
        id: record.id,
        kind: record.input.kind,
        name: record.input.name,
        base_url: record.input.base_url || "",
        default_model: record.input.default_model,
        capabilities: record.input.capabilities,
        status: record.status,
        created_at: record.createdAt,
        has_secret: true,
      };
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const [existing] = await tx.select().from(providerConnections)
        .where(and(eq(providerConnections.id, id), eq(providerConnections.tenantId, subject.tenantId)))
        .limit(1);
      if (!existing) return null;

      const now = new Date();
      const updates: Record<string, unknown> = { updatedAt: now };
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.base_url !== undefined) updates.baseUrl = patch.base_url;
      if (patch.api_key !== undefined) {
        updates.secretEnvelope = encryptProviderSecret(patch.api_key, this.#kekBase64, subject.tenantId, id);
        updates.secretVersion = sql`${providerConnections.secretVersion} + 1`;
      }
      if (patch.default_model !== undefined) updates.defaultModel = patch.default_model;
      if (patch.disabled !== undefined) {
        updates.disabledAt = patch.disabled ? now : null;
        if (patch.disabled) {
          updates.status = "disabled";
        }
      }

      const [updated] = await tx.update(providerConnections).set(updates)
        .where(and(eq(providerConnections.id, id), eq(providerConnections.tenantId, subject.tenantId)))
        .returning({
          id: providerConnections.id,
          kind: providerConnections.kind,
          name: providerConnections.name,
          base_url: providerConnections.baseUrl,
          default_model: providerConnections.defaultModel,
          capabilities: providerConnections.capabilities,
          status: providerConnections.status,
          created_at: providerConnections.createdAt,
          disabledAt: providerConnections.disabledAt,
        });
      if (!updated) return null;
      return {
        ...updated,
        created_at: updated.created_at.toISOString(),
        has_secret: true,
        disabled: updated.disabledAt?.toISOString() ?? null,
      };
    });
  }

  public async deleteProvider(subject: InternalSubject, id: string): Promise<boolean> {
    if (!this.#db) {
      const list = this.#providers.get(subject.tenantId) ?? [];
      const idx = list.findIndex((item) => item.id === id);
      if (idx < 0) return false;
      list.splice(idx, 1);
      return true;
    }
    const result = await withTenant(this.#db, subject.tenantId, (tx) =>
      tx.delete(providerConnections)
        .where(and(eq(providerConnections.id, id), eq(providerConnections.tenantId, subject.tenantId)))
        .returning({ id: providerConnections.id }));
    return result.length === 1;
  }

  public async recheckProviderHealth(subject: InternalSubject, id: string): Promise<{ status: ProviderHealthStatus } | null> {
    if (!this.#db) {
      const list = this.#providers.get(subject.tenantId) ?? [];
      const provider = list.find((item) => item.id === id);
      if (!provider) return null;
      provider.status = "healthy";
      return { status: provider.status };
    }
    return withTenant(this.#db, subject.tenantId, async (tx) => {
      const [existing] = await tx.select().from(providerConnections)
        .where(and(eq(providerConnections.id, id), eq(providerConnections.tenantId, subject.tenantId)))
        .limit(1);
      if (!existing) return null;

      const secret = decryptProviderSecret(existing.secretEnvelope as EncryptedSecretEnvelope, this.#kekBase64, subject.tenantId, existing.id);
      const healthUrl = providerCatalogUrl(existing.kind, existing.baseUrl);

      let status: ProviderHealthStatus;
      try {
        const health = await fetch(healthUrl, {
          headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        }).catch(() => null);
        await health?.body?.cancel().catch(() => undefined);
        status = classifyProviderHealth(health);
      } catch {
        status = "degraded";
      }

      await tx.update(providerConnections).set({
        status,
        lastHealthAt: new Date(),
        lastErrorCode: status === "healthy" ? null : status,
        updatedAt: new Date(),
      }).where(eq(providerConnections.id, id));

      return { status };
    });
  }

  public async adminChangeCredits(targetTenantId: string, actorUserId: string, amount: number, reason: string, idempotencyKey: string): Promise<void> {
    if (!this.#db) {
      this.#credits.set(targetTenantId, (this.#credits.get(targetTenantId) ?? 0) + amount);
      return;
    }
    await withServiceRole(this.#db, (tx) => tx.insert(creditLedger).values({ tenantId: targetTenantId, amount, reason, idempotencyKey, grantedByUserId: actorUserId }).onConflictDoNothing());
  }
}
