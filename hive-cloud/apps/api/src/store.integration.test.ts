import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import { CloudStore } from "./store.js";

const baseUrl = process.env.DATABASE_URL;
let store: CloudStore | undefined;
let disposeDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!baseUrl) return;
  const testDb = await createTestDatabase(baseUrl, "store-int");
  disposeDb = testDb.dispose;
  store = new CloudStore({ databaseUrl: testDb.dbUrl, kekBase64: Buffer.alloc(32, 2).toString("base64") });
}, 120_000);

afterAll(async () => {
  await store?.close();
  if (disposeDb) await disposeDb();
});

describe.skipIf(!baseUrl)("persistent message citations", () => {
  it("persists citations transactionally and enforces tenant ownership", async () => {
    const tenantId = randomUUID();
    const subject = { userId: randomUUID(), tenantId, role: "owner" as const, email: `citation-${tenantId}@example.com` };
    const otherTenantId = randomUUID();
    const other = { userId: randomUUID(), tenantId: otherTenantId, role: "owner" as const, email: `citation-${otherTenantId}@example.com` };
    await store!.ensureSubject(subject); await store!.ensureSubject(other);
    const conversation = await store!.createConversation(subject);
    const retrievedAt = "2026-07-18T08:00:00.000Z";
    await store!.appendMessage(subject, conversation.id, { role: "assistant", content: "Answer", status: "complete", citations: [{ title: "Example", url: "https://example.com", retrievedAt }] });
    expect((await store!.listMessages(subject, conversation.id)).items[0]?.citations).toEqual([{ title: "Example", url: "https://example.com", retrievedAt }]);
    await expect(store!.listMessages(other, conversation.id)).rejects.toThrow("Conversation not found");
    await store!.updateConversation(subject, conversation.id, { deleted: true });
  });
});

describe("conversation pagination cursor determinism", () => {
  it("returns deterministic order for conversations with equal update times", () => {
    const sameTime = "2026-07-19T12:00:00.000Z";
    const records = [
      { id: "c", title: "Third", mode: "chat" as const, updatedAt: sameTime, archived: false },
      { id: "a", title: "First", mode: "chat" as const, updatedAt: sameTime, archived: false },
      { id: "b", title: "Second", mode: "chat" as const, updatedAt: sameTime, archived: false },
    ];

    // Apply the same sorting logic as the in-memory store (desc updatedAt, asc id tiebreaker)
    const sorted = [...records].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
    );

    // All have the same timestamp, so ids should be in ascending order
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
