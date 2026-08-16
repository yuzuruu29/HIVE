import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import { CloudStore } from "./store.js";

const baseUrl = process.env.DATABASE_URL;
let store: CloudStore | undefined;
let disposeDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!baseUrl) return;
  const testDb = await createTestDatabase(baseUrl, "fts");
  disposeDb = testDb.dispose;
  store = new CloudStore({ databaseUrl: testDb.dbUrl, kekBase64: Buffer.alloc(32, 2).toString("base64") });
}, 120_000);

afterAll(async () => {
  await store?.close();
  if (disposeDb) await disposeDb();
});

describe.skipIf(!baseUrl)("full-text conversation search (PostgreSQL FTS)", () => {
  it("matches messages via to_tsvector and returns a headline snippet", async () => {
    const tenantId = randomUUID();
    const subject = {
      userId: randomUUID(),
      tenantId,
      role: "owner" as const,
      email: `fts-${tenantId}@example.com`,
    };
    await store!.ensureSubject(subject);
    const conversation = await store!.createConversation(subject, "chat", "Quarterly planning sync");
    await store!.appendMessage(subject, conversation.id, {
      role: "user",
      content: "The aurora borealis forecasting model needs more training data before launch.",
      status: "complete",
    });

    const results = await store!.searchConversations(subject, "aurora", 20);
    const match = results.find((result) => result.id === conversation.id);
    expect(match).toBeDefined();
    expect(match?.snippet).toContain("aurora");
    expect(match?.matchedMessageId).toBeTruthy();
    // Headline delimiters must be the ASCII markers the web renderer parses.
    expect(match?.snippet).toContain("<mark>");

    await store!.updateConversation(subject, conversation.id, { deleted: true });
  });

  it("does not match unrelated queries and respects tenant isolation", async () => {
    const tenantId = randomUUID();
    const subject = {
      userId: randomUUID(),
      tenantId,
      role: "owner" as const,
      email: `fts-iso-${tenantId}@example.com`,
    };
    await store!.ensureSubject(subject);
    const conversation = await store!.createConversation(subject, "chat", "Isolated conversation");
    await store!.appendMessage(subject, conversation.id, {
      role: "user",
      content: "zebra migration patterns across the savanna during seasonal change.",
      status: "complete",
    });

    const unrelated = await store!.searchConversations(subject, "aurora");
    expect(unrelated.find((result) => result.id === conversation.id)).toBeUndefined();

    const otherTenant = {
      userId: randomUUID(),
      tenantId: randomUUID(),
      role: "owner" as const,
      email: `fts-other-${tenantId}@example.com`,
    };
    await store!.ensureSubject(otherTenant);
    const crossTenant = await store!.searchConversations(otherTenant, "zebra");
    expect(crossTenant.find((result) => result.id === conversation.id)).toBeUndefined();

    await store!.updateConversation(subject, conversation.id, { deleted: true });
  });
});
