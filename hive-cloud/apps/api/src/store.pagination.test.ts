import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudStore,
  PaginationCursorError,
  decodeCursor,
  encodeCursor,
} from "./store.js";

const kekBase64 = Buffer.alloc(32, 2).toString("base64");
const tenantA = "22222222-2222-4222-8222-222222222222";
const tenantB = "33333333-3333-4333-8333-333333333333";
const subjectA = { userId: "11111111-1111-4111-8111-111111111111", tenantId: tenantA, role: "owner" as const, email: "a@example.com" };
const subjectB = { userId: "44444444-4444-4444-8444-444444444444", tenantId: tenantB, role: "owner" as const, email: "b@example.com" };

describe("cursor encode/decode", () => {
  it("round-trips a composite cursor", () => {
    const cursor = encodeCursor({ kind: "conversations", tenant: tenantA, t: "2026-07-19T12:00:00.000Z", id: "abc" });
    const decoded = decodeCursor(cursor, "conversations", tenantA);
    expect(decoded).toEqual({ t: "2026-07-19T12:00:00.000Z", id: "abc" });
  });

  it("rejects an empty cursor", () => {
    expect(() => decodeCursor("", "conversations", tenantA)).toThrow(PaginationCursorError);
  });

  it("rejects an over-long cursor", () => {
    expect(() => decodeCursor("x".repeat(1_025), "conversations", tenantA)).toThrow(PaginationCursorError);
  });

  it("rejects invalid base64url", () => {
    expect(() => decodeCursor("!!!not-base64!!!", "conversations", tenantA)).toThrow(PaginationCursorError);
  });

  it("rejects non-JSON payloads", () => {
    const bad = Buffer.from("not-json", "utf8").toString("base64url");
    expect(() => decodeCursor(bad, "conversations", tenantA)).toThrow(PaginationCursorError);
  });

  it("rejects an unsupported cursor version", () => {
    const stale = Buffer.from(JSON.stringify({ v: 99, kind: "conversations", tenant: tenantA, t: "2026-07-19T12:00:00.000Z", id: "abc" }), "utf8").toString("base64url");
    expect(() => decodeCursor(stale, "conversations", tenantA)).toThrow(PaginationCursorError);
  });

  it("rejects a mismatched resource kind", () => {
    const cursor = encodeCursor({ kind: "conversations", tenant: tenantA, t: "2026-07-19T12:00:00.000Z", id: "abc" });
    expect(() => decodeCursor(cursor, "messages", tenantA)).toThrow(PaginationCursorError);
  });

  it("rejects a cross-tenant cursor", () => {
    const cursor = encodeCursor({ kind: "conversations", tenant: tenantA, t: "2026-07-19T12:00:00.000Z", id: "abc" });
    expect(() => decodeCursor(cursor, "conversations", tenantB)).toThrow(PaginationCursorError);
  });

  it("rejects a payload with incomplete fields", () => {
    const incomplete = Buffer.from(JSON.stringify({ v: 1, kind: "conversations", tenant: tenantA, t: "2026-07-19T12:00:00.000Z" }), "utf8").toString("base64url");
    expect(() => decodeCursor(incomplete, "conversations", tenantA)).toThrow(PaginationCursorError);
  });
});

describe("gap-free conversation pagination (in-memory)", () => {
  let store: CloudStore;
  beforeEach(() => {
    store = new CloudStore({ kekBase64 });
  });

  it("walks every conversation without gaps or duplicates across pages", async () => {
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
    const count = 25;
    for (let i = 0; i < count; i++) {
      await store.createConversation(subjectA, "chat", `Conv ${i}`);
    }
    vi.useRealTimers();

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.listConversations(subjectA, { limit: 10, cursor });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(count);
    } while (cursor);

    expect(seen.size).toBe(count);
    expect(pages).toBe(Math.ceil(count / 10));
  });

  it("returns no nextCursor on a final empty page", async () => {
    await store.createConversation(subjectA, "chat", "Only one");
    const page = await store.listConversations(subjectA, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it("isolates conversations by tenant", async () => {
    await store.createConversation(subjectA, "chat", "A convo");
    const page = await store.listConversations(subjectB, { limit: 10 });
    expect(page.items).toHaveLength(0);
  });
});

describe("gap-free message pagination with identical timestamps (in-memory)", () => {
  let store: CloudStore;
  beforeEach(async () => {
    store = new CloudStore({ kekBase64 });
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("walks every message without gaps or duplicates even when timestamps collide", async () => {
    const conversation = await store.createConversation(subjectA, "chat", "Same time convo");
    const count = 23;
    for (let i = 0; i < count; i++) {
      await store.appendMessage(subjectA, conversation.id, { role: "user", content: `Msg ${i}`, status: "complete" });
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.listMessages(subjectA, conversation.id, { limit: 10, cursor });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(seen.size).toBe(count);
    expect(pages).toBe(Math.ceil(count / 10));
  });

  it("rejects a malformed cursor with a PaginationCursorError from listMessages", async () => {
    const conversation = await store.createConversation(subjectA, "chat", "Cursor test");
    await expect(store.listMessages(subjectA, conversation.id, { cursor: "totally-broken" })).rejects.toThrow(PaginationCursorError);
  });

  it("rejects a cross-tenant cursor with a PaginationCursorError from listConversations", async () => {
    const conversation = await store.createConversation(subjectA, "chat", "Cursor tenant test");
    await store.createConversation(subjectB, "chat", "Other tenant convo");
    const cursor = encodeCursor({ kind: "conversations", tenant: tenantA, t: "2026-07-19T12:00:00.000Z", id: conversation.id });
    await expect(store.listConversations(subjectB, { cursor })).rejects.toThrow(PaginationCursorError);
  });
});
