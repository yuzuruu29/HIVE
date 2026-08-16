import { afterEach, describe, expect, it } from "vitest";
import { createInternalAuthHeaders } from "@hive-cloud/security";
import { HiveRouter } from "@hive-cloud/router";
import { createApp } from "./app.js";
import type { ApiEnv } from "./env.js";
import { classifyProviderHealth, CloudStore } from "./store.js";

describe("provider health classification", () => {
  it.each([
    [200, true, "healthy"],
    [204, true, "healthy"],
    [401, false, "auth_failed"],
    [403, false, "auth_failed"],
    [404, false, "healthy"],
    [405, false, "healthy"],
    [429, false, "degraded"],
    [500, false, "degraded"],
  ] as const)("classifies HTTP %i as %s", (status, ok, expected) => {
    expect(classifyProviderHealth({ status, ok })).toBe(expected);
  });

  it("classifies a network failure as degraded", () => {
    expect(classifyProviderHealth(null)).toBe("degraded");
  });
});

describe("message citation ownership", () => {
  it("returns citations only with their message and tenant", async () => {
    const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
    const conversation = await store.createConversation(subject);
    const retrievedAt = "2026-07-18T08:00:00.000Z";
    const assistant = await store.appendMessage(subject, conversation.id, {
      role: "assistant", content: "Answer", status: "complete",
      citations: [{ title: "Example", url: "https://example.com/source", retrievedAt }],
    });
    const listed = await store.listMessages(subject, conversation.id);
    expect(listed.items).toEqual([expect.objectContaining({ id: assistant.id, citations: [{ title: "Example", url: "https://example.com/source", retrievedAt }] })]);
    const otherSubject = { ...subject, tenantId: "33333333-3333-4333-8333-333333333333" };
    expect((await store.listMessages(otherSubject, conversation.id)).items).toEqual([]);
  });
});

const secret = "test-internal-service-secret-value";
const env: ApiEnv = {
  NODE_ENV: "test",
  APP_ENV: "development",
  HIVE_DEPLOYMENT_MODE: "self_hosted",
  API_PORT: 4000,
  INTERNAL_SERVICE_SECRET: secret,
  HIVE_API_KEY_PEPPER: "test-api-key-pepper-at-least-32-characters",
  HIVE_ENCRYPTION_KEK_BASE64: Buffer.alloc(32, 2).toString("base64"),
  HIVE_BETA_BYPASS: true,
  HIVE_MOCK_PROVIDER: false,
  HIVE_LOCAL_PROVIDER_BRIDGE: false,
  OPENAI_MANAGED_MODEL: "gpt-4.1-mini",
  ANTHROPIC_MANAGED_MODEL: "claude-haiku-4-20250514",
  PRICE_STALE_MINUTES: 1_440,
  PAYPAL_ENV: "sandbox",
  WEB_ORIGIN: "http://localhost:3000",
  TRUSTED_PROXY_CIDRS: "127.0.0.1,::1",
  DATABASE_POOL_SIZE: 10,
  DATABASE_CONNECTION_TIMEOUT_MS: 5000,
  DATABASE_IDLE_TIMEOUT_MS: 30000,
  DATABASE_CONNECTION_MODE: undefined,
  DATABASE_APPLICATION_NAME: "hive_cloud",
  REDIS_URL: undefined,
  R2_BUCKET: "hive-cloud",
  R2_FORCE_PATH_STYLE: false,
  EMAIL_FROM: "HIVE <access@example.com>",
  OWNER_EMAILS: "owner@example.com",
  LIMIT_REQUESTS_5H: 500,
  LIMIT_REQUESTS_WEEKLY: 5000,
  LIMIT_TOKENS_INPUT_5H: 1_000_000,
  LIMIT_TOKENS_OUTPUT_5H: 500_000,
};

const subject = { userId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222", role: "owner" as const, email: "owner@example.com" };
let apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => { await Promise.all(apps.map((app) => app.close())); apps = []; });

async function appWithStore() {
  const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
  const app = await createApp({ env, store });
  apps.push(app);
  return app;
}

async function appWithRouter() {
  const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
  await store.addProvider(subject, {
    kind: "groq",
    name: "Test provider",
    api_key: "test-provider-key",
    default_model: "hive-0.1",
    capabilities: { vision: false, tools: true, context_window: 32_768 },
  });
  const router = new HiveRouter({
    fetch: async () => Response.json({
      id: "chatcmpl-test",
      choices: [{ message: { role: "assistant", content: "Response from Assistant" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }),
    requestId: () => crypto.randomUUID(),
  });
  const app = await createApp({ env, store, router });
  apps.push(app);
  return app;
}

function auth(path: string, method = "GET") {
  return createInternalAuthHeaders(subject, secret, method, path,  Date.now());
}

describe("API health and boundaries", () => {
  it("loads and updates user settings in the in-memory store", async () => {
    const app = await appWithStore();
    const initial = await app.inject({ method: "GET", url: "/api/settings", headers: auth("/api/settings") });
    expect(initial.json().data).toEqual({ systemPrompt: null, defaultModel: null, temperature: null });
    const updated = await app.inject({ method: "PATCH", url: "/api/settings", headers: auth("/api/settings", "PATCH"), payload: { systemPrompt: "Be concise", defaultModel: "hive-0.1", temperature: 0.4 } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toEqual({ systemPrompt: "Be concise", defaultModel: "hive-0.1", temperature: 0.4 });
  });

  it("exposes liveness without authentication", async () => {
    const app = await appWithStore();
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(401);
  });

  it("publishes the supported free-provider catalog without exposing credentials", async () => {
    const app = await appWithStore();
    const response = await app.inject({ method: "GET", url: "/api/provider-catalog", headers: auth("/api/provider-catalog") });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.data.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining([
      "groq", "nvidia", "openrouter", "opencode", "nous", "cerebras", "sambanova", "huggingface", "github", "mistral", "custom",
    ]));
    expect(payload.data.every((entry: Record<string, unknown>) => !Object.keys(entry).some((key) => /api[_-]?key|portal[_-]?token/i.test(key)))).toBe(true);
  });

  it("creates a reveal-once API key and uses it for model discovery", async () => {
    const app = await appWithStore();
    const created = await app.inject({ method: "POST", url: "/api/api-keys", headers: auth("/api/api-keys", "POST"), payload: { name: "SDK", scopes: ["models:read"] } });
    expect(created.statusCode).toBe(201);
    const raw = created.json().data.raw as string;
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${raw}` } });
    expect(models.statusCode).toBe(200);
    expect(models.json().data[0].id).toBe("hive-0.1");
    const listed = await app.inject({ method: "GET", url: "/api/api-keys", headers: auth("/api/api-keys") });
    expect(JSON.stringify(listed.json())).not.toContain(raw);
  });

  it("audits API-key creation and revocation without recording the secret", async () => {
    const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
    const app = await createApp({ env, store });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/api-keys", headers: auth("/api/api-keys", "POST"), payload: { name: "Audit key", scopes: ["models:read"] } });
    const id = created.json().data.id as string;
    const raw = created.json().data.raw as string;
    const revoked = await app.inject({ method: "DELETE", url: `/api/api-keys/${id}`, headers: auth(`/api/api-keys/${id}`, "DELETE") });
    expect(revoked.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${raw}` } })).statusCode).toBe(401);
    expect(store.auditEventCount()).toBe(2);
  });

  it("returns no_route without leaking configuration when no provider is connected", async () => {
    const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
    const app = await createApp({ env, store });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: auth("/api/chat/completions", "POST"),
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "Hello" }] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("no_route");
    expect(store.routeRequestCount()).toBe(1);
  });

  it("records a successful BYOK route without debiting managed credits", async () => {
    const store = new CloudStore({ kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
    await store.addProvider(subject, {
      kind: "groq",
      name: "Test provider",
      api_key: "test-provider-key",
      default_model: "test-model",
      capabilities: { vision: false, tools: true, context_window: 32_768 },
    });
    const router = new HiveRouter({
      fetch: async () => Response.json({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "Routed." } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
      requestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const app = await createApp({ env, store, router });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: { ...auth("/api/chat/completions", "POST"), "idempotency-key": "route-test-1" },
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "Hello" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().hive.requestId).toBe("33333333-3333-4333-8333-333333333333");
    expect(store.routeRequestCount()).toBe(1);
    expect(await store.credits(subject)).toBe(0);
  });

  it("keeps conversation data isolated between signed tenant subjects", async () => {
    const app = await appWithStore();
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: auth("/api/conversations", "POST"),
      payload: { mode: "chat", title: "Tenant A private conversation" },
    });
    expect(created.statusCode).toBe(201);

    const otherSubject = { ...subject, tenantId: "44444444-4444-4444-8444-444444444444" };
    const otherHeaders = createInternalAuthHeaders(otherSubject, secret, "GET", "/api/conversations", Date.now());
    const otherConversations = await app.inject({ method: "GET", url: "/api/conversations", headers: otherHeaders });
    expect(otherConversations.statusCode).toBe(200);
    expect(otherConversations.json().data.items).toEqual([]);
  });

  it("persists only the user-visible message when routed context contains files or search snippets", async () => {
    const app = await appWithStore();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: auth("/api/chat/completions", "POST"),
      payload: {
        model: "hive-0.1",
        messages: [{ role: "user", content: "Visible question\n<uploaded_file>private context</uploaded_file>" }],
        hive: { display_content: "Visible question" },
      },
    });
    expect(response.statusCode).toBe(503);
    const convs = await app.inject({ method: "GET", url: "/api/conversations", headers: auth("/api/conversations") });
    const conversationId = convs.json().data.items[0].id;
    const msgs = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/messages`, headers: auth(`/api/conversations/${conversationId}/messages`) });
    expect(JSON.stringify(msgs.json())).toContain("Visible question");
    expect(JSON.stringify(msgs.json())).not.toContain("private context");
  });

  it("persists and deduplicates cancellation that arrives before the chat request", async () => {
    const app = await appWithStore();
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: auth("/api/conversations", "POST"),
      payload: { mode: "chat", title: "Cancellation test" },
    });
    const conversationId = created.json().data.id as string;
    const cancelPath = `/api/conversations/${conversationId}/cancel`;
    const idempotencyKey = "55555555-5555-4555-8555-555555555555";
    const cancelled = await app.inject({
      method: "POST",
      url: cancelPath,
      headers: auth(cancelPath, "POST"),
      payload: {
        idempotency_key: idempotencyKey,
        display_content: "Visible cancelled prompt",
        started_at: "2026-07-16T10:00:00.000Z",
        search_active: false,
        citation_count: 0,
        prepared_file_count: 0,
      },
    });
    expect(cancelled.statusCode).toBe(202);

    const delayedChat = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: { ...auth("/api/chat/completions", "POST"), "x-hive-conversation-id": conversationId, "idempotency-key": idempotencyKey },
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "Untrusted hidden context" }], hive: { display_content: "Visible cancelled prompt" } },
    });
    expect(delayedChat.statusCode).toBe(409);
    expect(delayedChat.json().error.code).toBe("request_cancelled");

    const msgsRes = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/messages`, headers: auth(`/api/conversations/${conversationId}/messages`) });
    const messages = msgsRes.json().data.items;
    expect(messages).toHaveLength(2);
    const userMsg = messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg?.content).toBe("Visible cancelled prompt");
    const assistantMsg = messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistantMsg?.status).toBe("cancelled");
    expect(assistantMsg?.routeReceipt.executionSummary.status).toBe("cancelled");
    expect(JSON.stringify(messages)).not.toContain("Untrusted hidden context");
  });

  it("rejects loopback custom providers with actionable safe guidance", async () => {
    const app = await appWithStore();
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: auth("/api/providers", "POST"),
      payload: {
        kind: "custom",
        name: "Unsafe local endpoint",
        base_url: "http://127.0.0.1:11434/v1",
        api_key: "not-a-real-key",
        default_model: "model-id",
        capabilities: { vision: false, tools: false, context_window: 32768 },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("unsafe_provider_url");
  });

  it("does not let an untrusted client evade rate limits with spoofed forwarding headers", async () => {
    const app = await appWithStore();
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/waitlist",
        remoteAddress: "198.51.100.20",
        headers: { "x-forwarded-for": `8.8.8.${index + 1}` },
        payload: { email: `proxy-test-${index}@example.com`, use_case: "proxy boundary test" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("paginates conversations and fetches messages separately", async () => {
    const app = await appWithStore();
    
    // Create a conversation with some messages
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: auth("/api/conversations", "POST"),
      payload: { mode: "chat", title: "Pagination test" },
    });
    const conversationId = created.json().data.id as string;
    
    await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: { ...auth("/api/chat/completions", "POST"), "x-hive-conversation-id": conversationId },
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "M1" }] },
    });
    
    // Get single conversation without messages
    const conv = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}`, headers: auth(`/api/conversations/${conversationId}`) });
    expect(conv.statusCode).toBe(200);
    expect(conv.json().data.messages).toBeUndefined();
    
    // Get single conversation with messages (legacy)
    const convLegacy = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}?include=messages`, headers: auth(`/api/conversations/${conversationId}?include=messages`) });
    expect(convLegacy.statusCode).toBe(200);
    expect(convLegacy.json().data.messages.length).toBeGreaterThan(0);
    
    // Paginate messages
    const msgs = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/messages?limit=1`, headers: auth(`/api/conversations/${conversationId}/messages?limit=1`) });
    expect(msgs.statusCode).toBe(200);
    expect(msgs.json().data.items.length).toBe(1);
    expect(msgs.json().data.nextCursor).toBeDefined();
    
    // Paginate conversations
    const convs = await app.inject({ method: "GET", url: `/api/conversations?limit=1`, headers: auth(`/api/conversations?limit=1`) });
    expect(convs.statusCode).toBe(200);
    expect(convs.json().data.items.length).toBe(1);
    expect(convs.json().data.items[0].messages).toBeUndefined();
  });

  describe("pagination cursor API error mapping", () => {
    it("maps a malformed conversation cursor to HTTP 422 invalid_cursor", async () => {
      const app = await appWithStore();
      const res = await app.inject({
        method: "GET",
        url: "/api/conversations?cursor=not-a-valid-cursor",
        headers: auth("/api/conversations?cursor=not-a-valid-cursor", "GET"),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("invalid_cursor");
    });

    it("maps a malformed message cursor to HTTP 422 invalid_cursor", async () => {
      const app = await appWithStore();
      const created = await app.inject({
        method: "POST",
        url: "/api/conversations",
        headers: auth("/api/conversations", "POST"),
        payload: { mode: "chat", title: "Cursor err" },
      });
      const conversationId = created.json().data.id as string;
      const msgPath = `/api/conversations/${conversationId}/messages?cursor=not-a-valid-cursor`;
      const res = await app.inject({
        method: "GET",
        url: msgPath,
        headers: auth(msgPath, "GET"),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("invalid_cursor");
    });
  });

  it("branches off the requested parent message for edit-and-resubmit", async () => {
    const app = await appWithRouter();
    
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: auth("/api/chat/completions", "POST"),
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "M1" }] },
    });
    const conversationId = response.headers["x-hive-conversation-id"] as string;
    
    const initialRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(`/api/conversations/${conversationId}/messages`),
    });
    const parentId = initialRes.json().data.items[0].id;

    const editResponse = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: { ...auth("/api/chat/completions", "POST"), "x-hive-conversation-id": conversationId },
      payload: {
        model: "hive-0.1",
        messages: [{ role: "user", content: "M1-Edited" }],
        hive: { parent_message_id: parentId },
      },
    });
    if (editResponse.statusCode !== 200) console.log("ERROR EDIT MSG:", editResponse.json());
    
    const conversationRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(`/api/conversations/${conversationId}/messages`),
    });
    const { data } = conversationRes.json();
    if (conversationRes.statusCode !== 200) console.log("ERROR GET MSG 1:", conversationRes.json());
    
    expect(data.items).toHaveLength(4); // M1, Asst1, M1-Edited, Asst2
  });

  it("regenerates an assistant message without duplicating the user message", async () => {
    const app = await appWithRouter();
    
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: auth("/api/chat/completions", "POST"),
      payload: { model: "hive-0.1", messages: [{ role: "user", content: "M1" }] },
    });
    const conversationId = response.headers["x-hive-conversation-id"] as string;
    
    const initialRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(`/api/conversations/${conversationId}/messages`),
    });
    const initialItems = initialRes.json().data.items;
    const parentMessageId = initialItems.find((m: any) => m.role === "user")?.id;

    const regenRes = await app.inject({
      method: "POST",
      url: "/api/chat/completions",
      headers: { ...auth("/api/chat/completions", "POST"), "x-hive-conversation-id": conversationId },
      payload: {
        model: "hive-0.1",
        messages: [{ role: "user", content: "M1" }],
        hive: { regenerate_of: parentMessageId },
      },
    });
    if (regenRes.statusCode !== 200) console.log("ERROR REGEN MSG:", regenRes.json());

    const conversationRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(`/api/conversations/${conversationId}/messages`),
    });
    const { data } = conversationRes.json();
    if (conversationRes.statusCode !== 200) console.log("ERROR GET MSG 2:", conversationRes.json());
    expect(data.items).toHaveLength(3); // M1, Asst1, Asst2
    const messages = data.items.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    expect(messages[2].revision).toBe(2);
    expect(messages[2].parentMessageId).toBe(messages[0].id);
  });

  describe("share links", () => {
    it("creates a share link for a conversation", async () => {
      const app = await appWithStore();
      const created = await app.inject({ method: "POST", url: "/api/conversations", headers: auth("/api/conversations", "POST"), payload: { mode: "chat", title: "Share test" } });
      const conversationId = created.json().data.id as string;
      const shareRes = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/share`, headers: auth(`/api/conversations/${conversationId}/share`, "POST") });
      expect(shareRes.statusCode).toBe(201);
      expect(shareRes.json().data.token).toMatch(/^hive_share_/);
      expect(shareRes.json().data.url).toMatch(/^\/api\/shared\//);
    });

    it("returns 404 for share on non-existent conversation", async () => {
      const app = await appWithStore();
      const fakeId = "00000000-0000-4000-8000-000000000000";
      const shareRes = await app.inject({ method: "POST", url: `/api/conversations/${fakeId}/share`, headers: auth(`/api/conversations/${fakeId}/share`, "POST") });
      expect(shareRes.statusCode).toBe(404);
    });

    it("revokes a share link", async () => {
      const app = await appWithStore();
      const created = await app.inject({ method: "POST", url: "/api/conversations", headers: auth("/api/conversations", "POST"), payload: { mode: "chat", title: "Revoke test" } });
      const conversationId = created.json().data.id as string;
      await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/share`, headers: auth(`/api/conversations/${conversationId}/share`, "POST") });
      const deleteRes = await app.inject({ method: "DELETE", url: `/api/conversations/${conversationId}/share`, headers: auth(`/api/conversations/${conversationId}/share`, "DELETE") });
      expect(deleteRes.statusCode).toBe(204);
    });

    it("requires auth for share operations", async () => {
      const app = await appWithStore();
      const shareRes = await app.inject({ method: "POST", url: "/api/conversations/00000000-0000-4000-8000-000000000000/share" });
      expect(shareRes.statusCode).toBe(401);
    });
  });

  it("updates conversation titles via the PATCH endpoint", async () => {
    const app = await appWithStore();
    const createRes = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: auth("/api/conversations", "POST"),
      payload: { title: "Original Title" },
    });
    const { data: conversation } = createRes.json();
    
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      headers: auth(`/api/conversations/${conversation.id}`, "PATCH"),
      payload: { title: "Updated Title" },
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/conversations?limit=10",
      headers: auth("/api/conversations?limit=10"),
    });
    const getResJson = getRes.json();
    const updatedConversation = getResJson.data.items.find((c: any) => c.id === conversation.id);
    expect(updatedConversation.title).toBe("Updated Title");
  });

  describe("provider lifecycle", () => {
    it("patches a provider name and default_model", async () => {
      const app = await appWithRouter();
      const list = await app.inject({ method: "GET", url: "/api/providers", headers: auth("/api/providers") });
      const providerId = list.json().data[0].id;
      const patch = await app.inject({
        method: "PATCH",
        url: "/api/providers/" + providerId,
        headers: auth("/api/providers/" + providerId, "PATCH"),
        payload: { name: "Updated provider", default_model: "updated-model" },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().data.name).toBe("Updated provider");
      expect(patch.json().data.default_model).toBe("updated-model");
    });

    it("patches a provider with api_key rotation and re-encrypts", async () => {
      const app = await appWithRouter();
      const list = await app.inject({ method: "GET", url: "/api/providers", headers: auth("/api/providers") });
      const providerId = list.json().data[0].id;
      const patch = await app.inject({
        method: "PATCH",
        url: "/api/providers/" + providerId,
        headers: auth("/api/providers/" + providerId, "PATCH"),
        payload: { api_key: "rotated-new-api-key-longer-than-8" },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().data.has_secret).toBe(true);
    });

    it("patches a provider to disable it", async () => {
      const app = await appWithRouter();
      const list = await app.inject({ method: "GET", url: "/api/providers", headers: auth("/api/providers") });
      const providerId = list.json().data[0].id;
      const patch = await app.inject({
        method: "PATCH",
        url: "/api/providers/" + providerId,
        headers: auth("/api/providers/" + providerId, "PATCH"),
        payload: { disabled: true },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().data.status).toBe("disabled");
    });

    it("deletes a provider and returns 204", async () => {
      const app = await appWithRouter();
      const list = await app.inject({ method: "GET", url: "/api/providers", headers: auth("/api/providers") });
      const providerId = list.json().data[0].id;
      const del = await app.inject({
        method: "DELETE",
        url: "/api/providers/" + providerId,
        headers: auth("/api/providers/" + providerId, "DELETE"),
      });
      expect(del.statusCode).toBe(204);
    });

    it("re-checks provider health via POST /health", async () => {
      const app = await appWithRouter();
      const list = await app.inject({ method: "GET", url: "/api/providers", headers: auth("/api/providers") });
      const providerId = list.json().data[0].id;
      const health = await app.inject({
        method: "POST",
        url: "/api/providers/" + providerId + "/health",
        headers: auth("/api/providers/" + providerId + "/health", "POST"),
      });
      expect(health.statusCode).toBe(200);
      expect(["healthy", "degraded", "auth_failed", "pending"]).toContain(health.json().data.status);
    });
  });

  describe("deployment mode", () => {
    it("self_hosted starts without PayPal config", async () => {
      const app = await createApp({ env });
      expect(app).toBeDefined();
      await app.close();
    });
  });
});
