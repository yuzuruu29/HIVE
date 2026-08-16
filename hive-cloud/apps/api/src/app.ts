import { createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { HeadObjectCommand, PutObjectCommand, S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Queue } from "bullmq";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  apiError,
  buildPhaseNames,
  buildRequestSchema,
  chatCompletionRequestSchema,
  HIVE_ROUTER_ID,
  providerConnectionInputSchema,
  type ChatCompletionRequest,
  type RouteAttempt,
  type RouteCandidate,
  type RouteReceipt,
} from "@hive-cloud/contracts";
import {
  BUILTIN_PROVIDER_URLS,
  FreeModelDirectory,
  HiveRouter,
  PriceRegistry,
  RouterError,
  providerCatalogUrl,
  type PriceSnapshot,
} from "@hive-cloud/router";
import { fetchPublicHttpsEndpoint, validatePublicHttpsEndpoint } from "@hive-cloud/security";
import { authenticateRequest, type AuthContext } from "./auth.js";
import { readEnv, type ApiEnv } from "./env.js";
import { CloudStore, PaginationCursorError, type MessageRecord } from "./store.js";
import { validateProductionDatabaseConfig, diagnoseDatabase, createDatabase, type HiveDatabase } from "@hive-cloud/database";
import { BillingStore } from "./billing/billing-store.js";
import { PayPalClient } from "./billing/paypal.js";
import { WebhookHandler } from "./billing/webhooks.js";
import { createBillingHandlers, handlePayPalWebhook } from "./billing/routes.js";
import { UsageMiddleware } from "./usage-middleware.js";
import { UsageControl } from "./usage-control.js";
import { registerAdminUsageRoutes } from "./admin-usage.js";
const conversationPatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
  pinned: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one change is required.");

const providerPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().min(8).max(8_192).optional(),
  default_model: z.string().min(1).max(256).optional(),
  disabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one change is required.");

const apiKeyInputSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(["models:read", "chat:write"])).min(1).default(["models:read", "chat:write"]),
});

const waitlistSchema = z.object({
  email: z.string().email().max(320),
  use_case: z.string().max(1_000).optional(),
  website: z.string().max(0).optional(),
});

const managedPriceSnapshotsSchema = z.array(z.object({
  id: z.string().uuid(),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(256),
  inputMicrousdPerMillionTokens: z.number().int().nonnegative().safe(),
  outputMicrousdPerMillionTokens: z.number().int().nonnegative().safe(),
  cacheReadMicrousdPerMillionTokens: z.number().int().nonnegative().safe().optional(),
  sourceUrl: z.string().url().refine((value) => value.startsWith("https://"), "Price source must use HTTPS"),
  effectiveFrom: z.string().datetime(),
})).max(100);

const searchSchema = z.object({ query: z.string().min(2).max(500) });
const fileInputSchema = z.object({
  name: z.string().min(1).max(240).regex(/^[^\\/:*?"<>|]+$/),
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"]),
  size_bytes: z.number().int().positive().max(20 * 1024 * 1024),
});
const fileResultSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["owner", "member"]),
  status: z.enum(["approved", "rejected"]),
  object_key: z.string().min(1).max(1_000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  extracted_text: z.string().optional(),
});

export interface CreateAppOptions {
  env?: ApiEnv;
  store?: CloudStore;
  router?: HiveRouter;
  freeModelDirectory?: FreeModelDirectory;
}

function redisConnection(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Back off reconnection attempts so a Redis outage cannot saturate the
    // event loop with a tight reconnect loop (which would block even the
    // liveness endpoint). Returns ms to wait before next retry.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  // Swallow connection errors so a Redis outage degrades gracefully
  // (readiness reports redis:false) instead of emitting unhandled 'error'
  // events that can block or crash the process.
  client.on("error", (err: Error) => {
    if (process.env.NODE_ENV !== "test") {
      console.error(JSON.stringify({ level: "warn", event: "redis.error", error: err.message }));
    }
  });
  return client;
}

function bullConnection(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    // Throttle reconnection so a Redis outage cannot saturate the event
    // loop with a tight reconnect loop (which would make even the liveness
    // endpoint unresponsive).
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: null,
  };
}

function routeHeaders(receipt: RouteReceipt): Record<string, string> {
  return {
    "x-hive-request-id": receipt.requestId,
    "x-hive-provider": receipt.provider,
    "x-hive-model": receipt.model,
    "x-hive-route-policy": receipt.policy,
    "x-hive-fallback-count": String(receipt.fallbackCount),
  };
}

function authError(reply: FastifyReply, requestId: string) {
  return reply.code(401).send(apiError("invalid_api_key", "Authentication is required or the supplied key lacks the required scope.", requestId));
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?")[0] || "/";
}

function auditContext(request: FastifyRequest, env: ApiEnv, metadata: Record<string, unknown> = {}) {
  const userAgent = request.headers["user-agent"]?.toString();
  return {
    requestId: request.id,
    ipHash: createHmac("sha256", env.INTERNAL_SERVICE_SECRET).update(request.ip).digest("hex"),
    metadata: {
      ...metadata,
      ...(userAgent ? { user_agent_hash: createHmac("sha256", env.INTERNAL_SERVICE_SECRET).update(userAgent).digest("hex") } : {}),
    },
  };
}

function isPlatformOwner(auth: AuthContext, env: ApiEnv): boolean {
  if (env.HIVE_BETA_BYPASS) return auth.role === "owner";
  const owners = env.OWNER_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return auth.role === "owner" && owners.includes(auth.email.toLowerCase());
}

function normalizedProviderUrl(kind: string, custom?: string): string {
  if (kind === "custom") {
    if (!custom) throw new Error("A custom provider URL is required.");
    return custom.replace(/\/+$/, "");
  }
  const builtIn = BUILTIN_PROVIDER_URLS[kind as keyof typeof BUILTIN_PROVIDER_URLS];
  if (!builtIn) throw new Error(`Unsupported provider kind: ${kind}`);
  return builtIn;
}

function developmentMockCandidate(env: ApiEnv): RouteCandidate {
  return {
    id: "managed:local-mock",
    provider: "groq",
    providerName: "HIVE local mock",
    model: "hive-local-mock",
    baseUrl: `http://127.0.0.1:${env.API_PORT}/internal/dev/mock/v1`,
    apiKey: "development-mock-provider-key",
    managed: true,
    free: true,
    healthy: true,
    latencyMs: 10,
    quality: 50,
    contextWindow: 32_768,
    vision: false,
    tools: true,
  };
}

function platformManagedCandidates(env: ApiEnv, priceRegistry: PriceRegistry): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  if (env.OPENAI_API_KEY && priceRegistry.getPrice("openai", env.OPENAI_MANAGED_MODEL)) {
    candidates.push({
      id: `managed:openai:${env.OPENAI_MANAGED_MODEL}`,
      provider: "openai",
      providerName: "HIVE Managed OpenAI",
      model: env.OPENAI_MANAGED_MODEL,
      baseUrl: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      managed: true,
      free: false,
      healthy: true,
      latencyMs: 650,
      quality: 92,
      contextWindow: 128_000,
      vision: true,
      tools: true,
    });
  }
  if (env.ANTHROPIC_API_KEY && priceRegistry.getPrice("anthropic", env.ANTHROPIC_MANAGED_MODEL)) {
    candidates.push({
      id: `managed:anthropic:${env.ANTHROPIC_MANAGED_MODEL}`,
      provider: "anthropic",
      providerName: "HIVE Managed Anthropic",
      model: env.ANTHROPIC_MANAGED_MODEL,
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: env.ANTHROPIC_API_KEY,
      managed: true,
      free: false,
      healthy: true,
      latencyMs: 700,
      quality: 94,
      contextWindow: 200_000,
      vision: true,
      tools: true,
    });
  }
  return candidates;
}

function parseSseContent(chunk: string): string {
  let content = "";
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.startsWith("data:") || line.trim() === "data: [DONE]") continue;
    try {
      const payload = JSON.parse(line.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
      content += payload.choices?.[0]?.delta?.content ?? "";
    } catch {
      // Upstream chunks may split a JSON event. The caller keeps a line buffer.
    }
  }
  return content;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => typeof part === "object" && part && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n");
  return "";
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? readEnv();
  const store = options.store ?? new CloudStore({ ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}), kekBase64: env.HIVE_ENCRYPTION_KEK_BASE64 });
  const router = options.router ?? new HiveRouter();
  const freeModelDirectory = options.freeModelDirectory ?? new FreeModelDirectory();
  const activeChatRequests = new Map<string, { abort: AbortController; tenantId: string; conversationId: string }>();
  const pendingChatCancellations = new Map<string, { tenantId: string; conversationId: string; persisted: boolean }>();
  if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0.05, sendDefaultPii: false });
  const redis = env.REDIS_URL ? redisConnection(env.REDIS_URL) : undefined;
  const buildQueue = env.REDIS_URL ? new Queue("hive-builds", { connection: bullConnection(env.REDIS_URL) }) : undefined;
  const fileQueue = env.REDIS_URL ? new Queue("hive-files", { connection: bullConnection(env.REDIS_URL) }) : undefined;
  const titleQueue = env.REDIS_URL ? new Queue("hive-titles", { connection: bullConnection(env.REDIS_URL) }) : undefined;
  const billingStore = new BillingStore({ ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}) });
  let priceSnapshots: PriceSnapshot[] = [];
  if (env.MANAGED_PRICE_SNAPSHOTS_JSON) {
    let rawSnapshots: unknown;
    try {
      rawSnapshots = JSON.parse(env.MANAGED_PRICE_SNAPSHOTS_JSON);
    } catch {
      throw new Error("MANAGED_PRICE_SNAPSHOTS_JSON must be valid JSON");
    }
    priceSnapshots = managedPriceSnapshotsSchema.parse(rawSnapshots).map((snapshot) => ({
      id: snapshot.id,
      provider: snapshot.provider,
      model: snapshot.model,
      inputMicrousdPerMillionTokens: snapshot.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: snapshot.outputMicrousdPerMillionTokens,
      ...(snapshot.cacheReadMicrousdPerMillionTokens !== undefined ? { cacheReadMicrousdPerMillionTokens: snapshot.cacheReadMicrousdPerMillionTokens } : {}),
      sourceUrl: snapshot.sourceUrl,
      effectiveFrom: snapshot.effectiveFrom,
    }));
  }
  const priceRegistry = new PriceRegistry();
  for (const snapshot of priceSnapshots) priceRegistry.loadSnapshot(snapshot);
  await billingStore.syncPriceSnapshots(priceSnapshots);
  const platformCandidates = platformManagedCandidates(env, priceRegistry);
  const platformSpendCapMicrousd = env.PLATFORM_SPEND_CAP_USD !== undefined ? Math.floor(env.PLATFORM_SPEND_CAP_USD * 1_000_000) : undefined;
  const managedBalance = async (subject: AuthContext) => {
    if (!billingStore.persistent) return store.credits(subject);
    await billingStore.grantStarterCredits(subject.tenantId);
    return billingStore.getTotalBalance(subject.tenantId);
  };
  const paypalClient = new PayPalClient({
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    env: env.PAYPAL_ENV,
  });
  const paypalPlanMap = {
    ...(env.PAYPAL_PLAN_BUILDER_MONTHLY ? { [env.PAYPAL_PLAN_BUILDER_MONTHLY]: "builder" } : {}),
    ...(env.PAYPAL_PLAN_BUILDER_ANNUAL ? { [env.PAYPAL_PLAN_BUILDER_ANNUAL]: "builder" } : {}),
    ...(env.PAYPAL_PLAN_PRO_MONTHLY ? { [env.PAYPAL_PLAN_PRO_MONTHLY]: "pro" } : {}),
    ...(env.PAYPAL_PLAN_PRO_ANNUAL ? { [env.PAYPAL_PLAN_PRO_ANNUAL]: "pro" } : {}),
  };
  const webhookHandler = new WebhookHandler(billingStore, paypalClient, paypalPlanMap);
  const billingHandlers = createBillingHandlers(billingStore, paypalClient, {
    webOrigin: env.WEB_ORIGIN,
    enabled: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    planIds: {
      builder_monthly: env.PAYPAL_PLAN_BUILDER_MONTHLY,
      builder_annual: env.PAYPAL_PLAN_BUILDER_ANNUAL,
      pro_monthly: env.PAYPAL_PLAN_PRO_MONTHLY,
      pro_annual: env.PAYPAL_PLAN_PRO_ANNUAL,
    },
  });
  const usageDB = env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : undefined;
  const usagePolicy = UsageControl.policyFromEnv(env as unknown as Record<string, string | undefined>);
  const usageControl = usageDB ? new UsageMiddleware(usageDB.db, usagePolicy) : undefined;
  const app = Fastify({
    trustProxy: env.TRUSTED_PROXY_CIDRS.split(",").map((entry) => entry.trim()).filter(Boolean),
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body",
        "res.headers.set-cookie",
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 22 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  if (env.DATABASE_URL) {
    validateProductionDatabaseConfig(env.DATABASE_URL);
    const diag = diagnoseDatabase(env.DATABASE_URL);
    app.log.info(`database provider: ${diag.provider}\nconnection mode: ${diag.connectionMode}\nTLS: ${diag.tls}\npool size: ${diag.poolSize}`);
  }

  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true, exposedHeaders: Object.keys(routeHeaders({ requestId: "", router: HIVE_ROUTER_ID, policy: "free-first-balanced", provider: "", model: "", managed: false, costClass: "byok", fallbackCount: 0, latencyMs: 0, attempts: [] })) });
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    ...(redis ? { redis } : {}),
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      ...apiError("rate_limited", `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1_000)} seconds.`, request.id),
    }),
  });

  app.addHook("onClose", async () => {
    await buildQueue?.close();
    await fileQueue?.close();
    await titleQueue?.close();
    await redis?.quit();
    await billingStore.close();
    await store.close();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const safeError = error instanceof Error ? error : new Error("Unknown request error");
    const statusCode = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    if (statusCode === 429) {
      return reply.code(429).send(apiError("rate_limited", "Rate limit exceeded. Try again shortly.", request.id));
    }
    if (error instanceof PaginationCursorError) {
      return reply.code(422).send(apiError("invalid_cursor", error.message, request.id));
    }
    if (env.SENTRY_DSN) Sentry.captureException(safeError, { extra: { request_id: request.id, method: request.method, path: requestPath(request) } });
    request.log.error({ err: { name: safeError.name, message: safeError.message }, requestId: request.id }, "request failed");
    if (error instanceof RouterError) return reply.code(error.statusCode).send(apiError(error.code, error.message, request.id));
    if (error instanceof z.ZodError) return reply.code(422).send({
      error: {
        code: "validation_error",
        message: "Request validation failed.",
        request_id: request.id,
        details: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
      },
    });
    return reply.code(500).send(apiError("internal_error", "The request could not be completed.", request.id));
  });

  app.get("/health/live", async () => ({ status: "ok", service: "api" }));
  app.get("/health/ready", async (_request, reply) => {
    const database = await store.ready();
    const redisReady = redis ? redis.status === "ready" || redis.status === "connect" : true;
    return reply.code(database && redisReady ? 200 : 503).send({ status: database && redisReady ? "ok" : "degraded", checks: { database, redis: redisReady } });
  });

  app.post("/api/waitlist", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = waitlistSchema.parse(request.body);
    if (body.website) return reply.code(201).send({ data: { accepted: true } });
    const entry = await store.joinWaitlist(body.email, body.use_case);
    return reply.code(entry.alreadyExisted ? 200 : 201).send({ data: { accepted: true, already_joined: entry.alreadyExisted } });
  });

  if (env.HIVE_MOCK_PROVIDER) app.post("/internal/dev/mock/v1/chat/completions", async (request, reply) => {
    if (request.headers.authorization !== "Bearer development-mock-provider-key") return reply.code(401).send(apiError("invalid_api_key", "Mock provider authentication failed.", request.id));
    const body = chatCompletionRequestSchema.omit({ hive: true }).parse(request.body);
    const lastMessage = body.messages.at(-1);
    const prompt = typeof lastMessage?.content === "string" ? lastMessage.content : "multimodal input";
    const content = `Local provider response: ${prompt.slice(0, 240)}`;
    const usage = { prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)), completion_tokens: Math.max(1, Math.ceil(content.length / 4)) };
    if (!body.stream) return { id: `chatcmpl-${request.id}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage };
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    reply.raw.end(`data: ${JSON.stringify({ id: `chatcmpl-${request.id}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
  });

  app.get("/v1/models", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store, ["models:read"]);
    if (!auth) return authError(reply, request.id);
    await store.ensureSubject(auth);
    const connections = await store.providerCandidates(auth);
    const creditBalance = await managedBalance(auth);
    const runtime = freeModelDirectory.candidatesFromEnv(env as unknown as NodeJS.ProcessEnv);
    const managed = [
      ...runtime.filter((candidate) => !candidate.managed || candidate.free || creditBalance > 0),
      ...(creditBalance > 0 ? platformCandidates : []),
    ];
    return {
      object: "list",
      data: [
        { id: HIVE_ROUTER_ID, object: "model", created: 0, owned_by: "hive" },
        ...[...managed, ...connections].map((candidate) => ({ id: `${candidate.provider}/${candidate.model}`, object: "model", created: 0, owned_by: candidate.provider })),
      ],
    };
  });

  app.get("/api/models", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    await store.ensureSubject(auth);
    const connections = await store.providerCandidates(auth);
    const creditBalance = await managedBalance(auth);
    const quota = await store.getQuotaPolicy(auth);
    let managedLimitExceeded = false;
    if (redis && creditBalance > 0) {
      const currentM = await redis.get(`hive:rl:managed:${auth.tenantId}`);
      if (currentM && parseInt(currentM, 10) >= quota.managedRequestsPerMinute) {
         managedLimitExceeded = true;
      }
    }
    const runtime = freeModelDirectory.candidatesFromEnv(env as unknown as NodeJS.ProcessEnv);
    const managed = [
      ...runtime.filter((candidate) => !candidate.managed || candidate.free || (creditBalance > 0 && !managedLimitExceeded)),
      ...(creditBalance > 0 && !managedLimitExceeded ? platformCandidates : []),
      ...(creditBalance > 0 && !managedLimitExceeded && env.HIVE_MOCK_PROVIDER ? [developmentMockCandidate(env)] : []),
    ];

    const candidates = [...managed, ...connections];
    const data: import("@hive-cloud/contracts").HiveModelCatalogEntry[] = [
      {
        id: HIVE_ROUTER_ID,
        object: "model",
        created: 0,
        owned_by: "hive",
        provider: "hive",
        model: "hive-0.1",
        displayName: "HIVE 0.1 Auto",
        costClass: "free",
        managed: true,
        free: true,
        vision: true,
        tools: true,
      },
      ...candidates.map((candidate) => ({
        id: `${candidate.provider}/${candidate.model}`,
        object: "model" as const,
        created: 0,
        owned_by: candidate.provider,
        provider: candidate.provider,
        model: candidate.model,
        displayName: candidate.providerName ? `${candidate.providerName} ${candidate.model}` : candidate.model,
        costClass: candidate.managed ? (candidate.free ? "free" as const : "paid" as const) : "byok" as const,
        managed: candidate.managed,
        free: candidate.free,
        vision: candidate.vision,
        tools: candidate.tools,
        ...(router.cooldownUntil(candidate.id) ? { cooldownUntil: new Date(router.cooldownUntil(candidate.id)!).toISOString() } : {}),
      })),
    ];
    return { data };
  });

  const handleChat = async (request: FastifyRequest, reply: FastifyReply, internal: boolean) => {
    const auth = await authenticateRequest(request, env, store, ["chat:write"]);
    if (!auth || (internal && !auth.internal)) return authError(reply, request.id);
    await store.ensureSubject(auth);
    
    // --- Phase 3 Rate Limiting ---
    const quota = await store.getQuotaPolicy(auth);
    const concurrentKey = `hive:concurrent:${auth.tenantId}`;
    let concurrentSlotHeld = false;
    const releaseConcurrentSlot = async () => {
      if (!redis || !concurrentSlotHeld) return;
      concurrentSlotHeld = false;
      try {
        await redis.decr(concurrentKey);
      } catch (error) {
        request.log.warn({ err: error, requestId: request.id }, "failed to release concurrent chat slot");
      }
    };
    if (redis) {
      const rpmKey = `hive:rl:chat:${auth.tenantId}`;
      const current = await redis.incr(rpmKey);
      if (current === 1) await redis.expire(rpmKey, 60);
      if (current > quota.requestsPerMinute) {
        return reply.code(429).send(apiError("rate_limited", "Chat rate limit exceeded based on your quota policy.", request.id));
      }
      const currentStreams = await redis.incr(concurrentKey);
      await redis.expire(concurrentKey, 300); // 5 min expiry safety net
      if (currentStreams > quota.concurrentStreams) {
        await redis.decr(concurrentKey);
        return reply.code(429).send(apiError("rate_limited", "Too many concurrent streams. Please wait for other generations to finish.", request.id));
      }
      concurrentSlotHeld = true;
      const releaseOnTerminalResponse = () => { void releaseConcurrentSlot(); };
      reply.raw.once("finish", releaseOnTerminalResponse);
      reply.raw.once("close", releaseOnTerminalResponse);
    }
    
    // settings injection
    const userSettings = await store.getUserSettings(auth);

    let body: ChatCompletionRequest;
    try {
      body = chatCompletionRequestSchema.parse(request.body);
    } catch (parseError) {
      await releaseConcurrentSlot();
      throw parseError;
    }
    const assistantCitations = internal ? body.hive?.citations?.map((citation) => ({
      title: citation.title,
      url: citation.url,
      retrievedAt: citation.retrieved_at,
    })) : undefined;
    
    if (userSettings.systemPrompt) {
      const existingSystemIndex = body.messages.findIndex(m => m.role === "system");
      const existingSystem = existingSystemIndex !== -1 ? body.messages[existingSystemIndex] : undefined;
      if (existingSystem && typeof existingSystem.content === "string") {
         existingSystem.content = `${userSettings.systemPrompt}\n\n${existingSystem.content}`;
      } else if (existingSystemIndex === -1) {
         body.messages.unshift({ role: "system", content: userSettings.systemPrompt });
      }
    }
    if (!body.model && userSettings.defaultModel) {
      body.model = userSettings.defaultModel;
    }
    if (body.temperature === undefined && userSettings.temperature !== null) {
      body.temperature = userSettings.temperature;
    }

    if (body.hive?.attachment_ids?.length) {
      const requestedIds = body.hive.attachment_ids;
      const attachments = await store.getAttachments(auth, requestedIds);
      
      const unapproved = attachments.filter(a => a.status !== "approved");
      if (unapproved.length > 0) {
        await releaseConcurrentSlot();
        return reply.code(422).send(apiError("invalid_attachment", "One or more attachments are still scanning or were rejected.", request.id));
      }
      if (attachments.length !== requestedIds.length) {
        await releaseConcurrentSlot();
        return reply.code(422).send(apiError("invalid_attachment", "One or more attachments could not be found.", request.id));
      }

      const validAttachments = attachments.filter((a) => a.extractedText);
      if (validAttachments.length > 0) {
        const textParts = validAttachments.map((a) => `--- File: ${a.originalName} ---\n${a.extractedText?.slice(0, 120_000)}`);
        body.messages.unshift({
          role: "system",
          content: `The user has provided the following extracted text from attached files for context:\n\n${textParts.join("\n\n")}`,
        });
      }
    }

    const executionInput = body.hive?.execution_summary;
    const requestedStartedAtMs = executionInput?.started_at ? Date.parse(executionInput.started_at) : Number.NaN;
    const executionStartedAtMs = Number.isFinite(requestedStartedAtMs) && requestedStartedAtMs <= Date.now()
      ? requestedStartedAtMs
      : Date.now();
    const completeExecution = (receipt: RouteReceipt, status: "completed" | "cancelled" | "failed", errorCode?: string) => {
      const completedAtMs = Date.now();
      receipt.executionSummary = {
        status,
        startedAt: new Date(executionStartedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - executionStartedAtMs),
        ...(executionInput?.search_active !== undefined ? { searchActive: executionInput.search_active } : {}),
        ...(executionInput?.citation_count !== undefined ? { citationCount: executionInput.citation_count } : {}),
        ...(executionInput?.prepared_file_count !== undefined ? { preparedFileCount: executionInput.prepared_file_count } : {}),
        ...(errorCode ? { errorCode } : {}),
      };
      return receipt;
    };
    const terminalReceipt = (requestId: string, attempts: RouteAttempt[], status: "cancelled" | "failed", errorCode: string): RouteReceipt => {
      const latestAttempt = attempts.at(-1);
      return completeExecution({
        requestId,
        router: HIVE_ROUTER_ID,
        policy: "free-first-balanced",
        provider: latestAttempt?.provider || "unavailable",
        model: latestAttempt?.model || "unavailable",
        managed: false,
        costClass: "byok",
        fallbackCount: Math.max(0, attempts.length - 1),
        latencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
        attempts,
      }, status, errorCode);
    };
    const requiredCapabilities = [
      ...(body.tools?.length ? ["tools"] : []),
      ...(body.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")) ? ["vision"] : []),
      "context",
    ];
    const idempotencyKey = request.headers["idempotency-key"]?.toString();
    const conversationIdHeader = request.headers["x-hive-conversation-id"]?.toString();
    const shouldPersist = request.headers["x-hive-no-persist"]?.toString() !== "true";
    const conversation = internal && shouldPersist
      ? conversationIdHeader || (await store.createConversation(auth, "chat", "New conversation")).id
      : undefined;
    const abort = new AbortController();
    let clearActiveRequest: () => void = () => {
      if (idempotencyKey) activeChatRequests.delete(idempotencyKey);
      void releaseConcurrentSlot();
    };
    
    // Poll redis for cross-replica cancellation
    let cancelPoll: NodeJS.Timeout | undefined;
    if (redis && idempotencyKey) {
      cancelPoll = setInterval(async () => {
        try {
          if (await redis.get(`hive:cancel:${idempotencyKey}`) === "1") abort.abort();
        } catch (error) {
          request.log.warn({ err: error, requestId: request.id }, "failed to poll cancellation state");
        }
      }, 500);
      cancelPoll.unref();
    }
    request.raw.once("close", () => {
       abort.abort();
       if (cancelPoll) clearInterval(cancelPoll);
       clearActiveRequest();
    });
    if (idempotencyKey && conversation) {
      activeChatRequests.set(idempotencyKey, { abort, tenantId: auth.tenantId, conversationId: conversation });
      const pendingCancellation = pendingChatCancellations.get(idempotencyKey);
      if (pendingCancellation?.tenantId === auth.tenantId && pendingCancellation.conversationId === conversation) {
        pendingChatCancellations.delete(idempotencyKey);
        clearActiveRequest();
        if (pendingCancellation.persisted) return reply.code(409).send(apiError("request_cancelled", "The request was cancelled.", request.id));
        abort.abort();
      }
      pendingChatCancellations.delete(idempotencyKey);
    }
    let userMessageRecord: MessageRecord | undefined;
    let assistantParentId: string | null = null;
    let assistantRevision = 1;
    if (conversation) {
      if (body.hive?.regenerate_of) {
        const { parentMessageId, revision } = await store.getBranchingContext(auth, conversation, body.hive.regenerate_of);
        assistantParentId = parentMessageId;
        assistantRevision = revision;
      } else {
        const { parentMessageId, revision } = await store.getBranchingContext(auth, conversation, body.hive?.parent_message_id);
        userMessageRecord = await store.appendMessage(auth, conversation, {
          role: "user",
          parentMessageId,
          revision,
          content: body.hive?.display_content ?? body.messages.at(-1)?.content ?? "",
          status: "complete",
        });
        assistantParentId = userMessageRecord.id;
      }
    }

    const byok = await store.providerCandidates(auth);
    const creditBalance = await managedBalance(auth);
    const runtime = freeModelDirectory.candidatesFromEnv(env as unknown as NodeJS.ProcessEnv);
    const managed = [
      ...runtime.filter((candidate) => !candidate.managed || candidate.free || creditBalance > 0),
      ...(creditBalance > 0 ? platformCandidates : []),
      ...(creditBalance > 0 && env.HIVE_MOCK_PROVIDER ? [developmentMockCandidate(env)] : []),
    ];
    const candidates = [...byok, ...managed];
    if (candidates.length === 0) {
      clearActiveRequest();
      await store.recordRouteRequest(auth, {
        requestId: request.id,
        ...(auth.apiKeyId ? { apiKeyId: auth.apiKeyId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        requiredCapabilities,
        statusCode: 503,
        errorCode: "no_route",
        attempts: [],
      });
      if (conversation) await store.appendMessage(auth, conversation, {
        role: "assistant",
        parentMessageId: assistantParentId,
        revision: assistantRevision,
        content: "",
        status: "failed",
        routeReceipt: terminalReceipt(request.id, [], "failed", "no_route"),
        ...(assistantCitations?.length ? { citations: assistantCitations } : {}),
      });
      return reply.code(503).send(apiError("no_route", "No provider route is available. Connect a provider or ask the beta owner for managed credits.", request.id));
    }

    // --- Usage control: check limits and atomically reserve capacity ---
    let usageDimensions: import("./usage-middleware.js").UsageWindowKey | null = null;
    if (usageControl) {
      usageDimensions = usageControl.dimensions(request, auth, candidates[0]?.provider);
      if (usageDimensions) {
        const allowed = await usageControl.checkAndReserve(request, reply, usageDimensions);
        if (!allowed) { clearActiveRequest(); return; }
      }
    }

    let result: Awaited<ReturnType<HiveRouter["route"]>>;
    try {
      result = await router.route(body, candidates, abort.signal, platformCandidates.length > 0 ? {
        priceRegistry,
        staleMinutes: env.PRICE_STALE_MINUTES,
        reserveCredits: (requestId, amount, priceSnapshotId, estimatedProviderCostMicrousd) => billingStore.reserveCredits(auth.tenantId, requestId, amount, priceSnapshotId, estimatedProviderCostMicrousd, platformSpendCapMicrousd),
        releaseCredits: (requestId) => billingStore.releaseReservation(auth.tenantId, requestId),
      } : undefined);
    } catch (error) {
      if (usageControl && usageDimensions) {
        await usageControl.releaseOnError(request, usageDimensions).catch(() => {});
      }
      if (error instanceof RouterError) {
        await store.recordRouteRequest(auth, {
          requestId: error.requestId ?? request.id,
          ...(auth.apiKeyId ? { apiKeyId: auth.apiKeyId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          requiredCapabilities,
          statusCode: error.statusCode,
          errorCode: error.code,
          attempts: error.attempts,
        });
        if (conversation) {
          const cancelled = abort.signal.aborted || error.attempts.some((attempt) => attempt.reason === "request_cancelled");
          await store.appendMessage(auth, conversation, {
            role: "assistant",
            parentMessageId: assistantParentId,
            revision: assistantRevision,
            content: "",
            status: cancelled ? "cancelled" : "failed",
            routeReceipt: terminalReceipt(error.requestId ?? request.id, error.attempts, cancelled ? "cancelled" : "failed", cancelled ? "request_cancelled" : error.code),
            ...(assistantCitations?.length ? { citations: assistantCitations } : {}),
          });
        }
      } else if (error instanceof Error) {
        clearActiveRequest();
        throw new RouterError("upstream_error", "Upstream connection failed.", 502);
      }
      clearActiveRequest();
      throw error;
    }
    const headers = routeHeaders(result.receipt);
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    reply.header("x-hive-conversation-id", conversation ?? "");

    const settleManagedUsage = async (completionText: string) => {
      if (!result.receipt.managed || result.receipt.costClass !== "paid") return;
      const promptTokens = result.receipt.promptTokens ?? Math.max(1, Math.ceil(JSON.stringify(body.messages).length / 3.2));
      const completionTokens = result.receipt.completionTokens ?? Math.max(1, Math.ceil(completionText.length / 3.2));
      const cost = priceRegistry.settleCost(result.receipt.provider, result.receipt.model, promptTokens, completionTokens);
      const debitedCredits = Math.max(1, cost.debitedCredits);
      const settlement = await billingStore.settleReservation(auth.tenantId, result.receipt.requestId, debitedCredits, cost.providerCostMicrousd);
      if (!settlement.success) throw new Error("Managed credit reservation could not be settled");
      result.receipt.promptTokens = promptTokens;
      result.receipt.completionTokens = completionTokens;
      result.receipt.providerCostMicrousd = cost.providerCostMicrousd;
      result.receipt.debitedCredits = settlement.debitedCredits;
      if (redis) {
         const mRpmKey = `hive:rl:managed:${auth.tenantId}`;
         const currentM = await redis.incr(mRpmKey);
         if (currentM === 1) await redis.expire(mRpmKey, 60);
      }
    };

    const persistRoute = async (statusCode: number, errorCode?: string) => store.recordRouteRequest(auth, {
      requestId: result.receipt.requestId,
      ...(auth.apiKeyId ? { apiKeyId: auth.apiKeyId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      requiredCapabilities,
      statusCode,
      ...(errorCode ? { errorCode } : {}),
      receipt: result.receipt,
      attempts: result.receipt.attempts,
    });

    if (!body.stream) {
      try {
        const payload = await result.upstream.json() as Record<string, unknown> & { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        if (payload.usage?.prompt_tokens !== undefined) result.receipt.promptTokens = payload.usage.prompt_tokens;
        if (payload.usage?.completion_tokens !== undefined) result.receipt.completionTokens = payload.usage.completion_tokens;
        const assistantText = contentText(payload.choices?.[0]?.message?.content ?? "");
        await settleManagedUsage(assistantText);
        completeExecution(result.receipt, "completed");
        const response = { ...payload, model: HIVE_ROUTER_ID, hive: result.receipt };
        if (conversation) {
          await store.appendMessage(auth, conversation, { role: "assistant", parentMessageId: assistantParentId, revision: assistantRevision, content: payload.choices?.[0]?.message?.content ?? "", status: "complete", routeReceipt: result.receipt, ...(assistantCitations?.length ? { citations: assistantCitations } : {}) });
          if (assistantParentId === null && titleQueue) {
            await titleQueue.add("title", { conversationId: conversation, tenantId: auth.tenantId, messageContent: body.messages.at(-1)?.content ?? "" }, { removeOnComplete: 100, removeOnFail: 100 });
          }
        }
        await persistRoute(result.upstream.status);
        clearActiveRequest();
        return reply.code(200).send(response);
      } catch (error) {
        if (result.receipt.managed && result.receipt.costClass === "paid") await billingStore.releaseReservation(auth.tenantId, result.receipt.requestId);
        clearActiveRequest();
        throw error;
      }
    }

    if (!result.upstream.body) {
      if (result.receipt.managed && result.receipt.costClass === "paid") await billingStore.releaseReservation(auth.tenantId, result.receipt.requestId);
      clearActiveRequest();
      completeExecution(result.receipt, "failed", "upstream_error");
      if (conversation) await store.appendMessage(auth, conversation, { role: "assistant", parentMessageId: assistantParentId, revision: assistantRevision, content: "", status: "failed", routeReceipt: result.receipt, ...(assistantCitations?.length ? { citations: assistantCitations } : {}) });
      throw new RouterError("upstream_error", "The selected provider returned no stream body.", 502, result.receipt.attempts);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...headers,
      ...(conversation ? { "x-hive-conversation-id": conversation } : {}),
    });
    const stream = Readable.fromWeb(result.upstream.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
    let eventBuffer = "";
    let assistantContent = "";
    const forwardEvent = (eventBlock: string) => {
      const data = eventBlock.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!data || data === "[DONE]") return;
      assistantContent += parseSseContent(eventBlock);
      try {
        const payload = JSON.parse(data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
        if (payload.usage?.prompt_tokens !== undefined) result.receipt.promptTokens = payload.usage.prompt_tokens;
        if (payload.usage?.completion_tokens !== undefined) result.receipt.completionTokens = payload.usage.completion_tokens;
      } catch {
        // The upstream event remains valid provider output even if it has no JSON usage payload.
      }
      reply.raw.write(`${eventBlock}\n\n`);
    };
    stream.on("data", (chunk: Buffer) => {
      eventBuffer += chunk.toString("utf8");
      const events = eventBuffer.split(/\r?\n\r?\n/);
      eventBuffer = events.pop() || "";
      for (const eventBlock of events) forwardEvent(eventBlock);
    });
    stream.on("end", () => {
      void (async () => {
        if (eventBuffer.trim()) forwardEvent(eventBuffer);
        const cancelled = abort.signal.aborted;
        await settleManagedUsage(assistantContent);
        completeExecution(result.receipt, cancelled ? "cancelled" : "completed", cancelled ? "request_cancelled" : undefined);
        if (conversation) {
          await store.appendMessage(auth, conversation, { role: "assistant", parentMessageId: assistantParentId, revision: assistantRevision, content: assistantContent, status: cancelled ? "cancelled" : "complete", routeReceipt: result.receipt, ...(assistantCitations?.length ? { citations: assistantCitations } : {}) });
          if (assistantParentId === null && titleQueue && !cancelled) {
            await titleQueue.add("title", { conversationId: conversation, tenantId: auth.tenantId, messageContent: typeof body.messages.at(-1)?.content === "string" ? body.messages.at(-1)?.content : "" }, { removeOnComplete: 100, removeOnFail: 100 });
          }
        }
        await persistRoute(result.upstream.status);
        clearActiveRequest();
        reply.raw.write(`event: hive.route_receipt\ndata: ${JSON.stringify(result.receipt)}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
      })().catch(async (error: unknown) => {
        request.log.error({ err: error, requestId: result.receipt.requestId }, "failed to finalize provider stream");
        reply.raw.write(`event: error\ndata: ${JSON.stringify(apiError("internal_error", "The stream completed but usage settlement failed.", result.receipt.requestId))}\n\n`);
      }).finally(() => reply.raw.end());
    });
    stream.on("error", () => {
      const cancelled = abort.signal.aborted;
      completeExecution(result.receipt, cancelled ? "cancelled" : "failed", cancelled ? "request_cancelled" : "upstream_stream_error");
      clearActiveRequest();
      void (async () => {
        await settleManagedUsage(assistantContent);
        await Promise.all([
          persistRoute(502, cancelled ? "request_cancelled" : "upstream_stream_error"),
          ...(conversation ? [store.appendMessage(auth, conversation, { role: "assistant" as const, parentMessageId: assistantParentId, revision: assistantRevision, content: assistantContent, status: cancelled ? "cancelled" as const : "failed" as const, routeReceipt: result.receipt, ...(assistantCitations?.length ? { citations: assistantCitations } : {}) })] : []),
        ]);
      })().catch((error: unknown) => {
        request.log.error({ err: error, requestId: result.receipt.requestId }, "failed to finalize errored provider stream");
      }).finally(() => {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(apiError("upstream_stream_error", "The provider stream ended after output began.", result.receipt.requestId))}\n\n`);
        reply.raw.end();
      });
    });
  };

  app.post("/v1/chat/completions", async (request, reply) => handleChat(request, reply, false));
  app.post("/api/chat/completions", async (request, reply) => handleChat(request, reply, true));

  app.get("/api/conversations", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    await store.ensureSubject(auth);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(1_024).optional(), archived: z.coerce.boolean().optional() }).parse(request.query ?? {});
    return { data: await store.listConversations(auth, query) };
  });
  app.get("/api/search/conversations", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    await store.ensureSubject(auth);
    const quota = await store.getQuotaPolicy(auth);
    if (redis) {
       const today = new Date().toISOString().split("T")[0];
       const searchKey = `hive:search:daily:${auth.tenantId}:${today}`;
       const searches = await redis.incr(searchKey);
       if (searches === 1) await redis.expire(searchKey, 86400);
       if (searches > quota.webSearchesPerDay) {
          return reply.code(429).send(apiError("rate_limited", "Daily search quota exceeded.", request.id));
       }
    }
    const query = z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query ?? {});
    return { data: { items: await store.searchConversations(auth, query.q, query.limit) } };
  });
  app.get("/api/conversations/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ include: z.enum(["messages"]).optional() }).parse(request.query ?? {});
    const conversation = await store.getConversation(auth, id, { includeMessages: query.include === "messages" });
    if (!conversation) return reply.code(404).send(apiError("not_found", "Conversation not found.", request.id));
    return { data: conversation };
  });
  app.get("/api/conversations/:id/messages", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(1_024).optional() }).parse(request.query ?? {});
    try {
      return { data: await store.listMessages(auth, id, query) };
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Conversation not found") return reply.code(404).send(apiError("not_found", "Conversation not found.", request.id));
      throw error;
    }
  });
  
  app.get("/api/conversations/:id/export", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await store.getConversation(auth, id, { includeMessages: true });
    if (!conversation) return reply.code(404).send(apiError("not_found", "Conversation not found.", request.id));

    const lines = [`# ${conversation.title || "Conversation Export"}\n`, `_Exported on ${new Date().toISOString()}_\n`];
    
    for (const msg of conversation.messages ?? []) {
      if (msg.role === "system") continue;
      
      const roleName = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool";
      lines.push(`\n## ${roleName}\n`);
      
      if (msg.attachments && msg.attachments.length > 0) {
        lines.push(`_Attachments: ${msg.attachments.map(a => a.name).join(", ")}_\n`);
      }
      
      if (typeof msg.content === "string") {
        lines.push(`${msg.content}\n`);
      } else {
        lines.push(`${JSON.stringify(msg.content, null, 2)}\n`);
      }
    }

    reply.header("Content-Type", "text/markdown");
    reply.header("Content-Disposition", `attachment; filename="conversation-${id.slice(0, 8)}.md"`);
    return reply.send(lines.join("\n"));
  });

  app.post("/api/conversations", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const body = z.object({ mode: z.enum(["chat", "build"]).default("chat"), title: z.string().min(1).max(120).default("New conversation") }).parse(request.body ?? {});
    return reply.code(201).send({ data: await store.createConversation(auth, body.mode, body.title) });
  });

  app.post("/api/conversations/:id/cancel", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const cancellation = z.object({
      idempotency_key: z.string().uuid(),
      display_content: z.string().min(1).max(200_000),
      started_at: z.string().datetime(),
      search_active: z.boolean().default(false),
      citation_count: z.number().int().min(0).max(100).default(0),
      prepared_file_count: z.number().int().min(0).max(40).default(0),
    }).parse(request.body);
    const idempotencyKey = cancellation.idempotency_key;
    const active = activeChatRequests.get(idempotencyKey);
    if (active?.tenantId === auth.tenantId && active.conversationId === id) {
      active.abort.abort();
    } else {
      const completedAtMs = Date.now();
      const startedAtMs = Math.min(completedAtMs, Date.parse(cancellation.started_at));
      const routeReceipt: RouteReceipt = {
        requestId: idempotencyKey,
        router: HIVE_ROUTER_ID,
        policy: "free-first-balanced",
        provider: "unavailable",
        model: "unavailable",
        managed: false,
        costClass: "byok",
        fallbackCount: 0,
        latencyMs: 0,
        attempts: [],
        executionSummary: {
          status: "cancelled",
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: Math.max(0, completedAtMs - startedAtMs),
          searchActive: cancellation.search_active,
          citationCount: cancellation.citation_count,
          preparedFileCount: cancellation.prepared_file_count,
          errorCode: "request_cancelled",
        },
      };
      await store.appendMessage(auth, id, { role: "user", content: cancellation.display_content, status: "complete" });
      await store.appendMessage(auth, id, { role: "assistant", content: "", status: "cancelled", routeReceipt });
      pendingChatCancellations.set(idempotencyKey, { tenantId: auth.tenantId, conversationId: id, persisted: true });
      const expiry = setTimeout(() => pendingChatCancellations.delete(idempotencyKey), 30_000);
      expiry.unref();
      if (redis) await redis.set(`hive:cancel:${idempotencyKey}`, "1", "EX", 60);
    }
    return reply.code(202).send({ data: { id, status: "cancelling" } });
  });
  app.patch("/api/conversations/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const parsed = conversationPatchSchema.parse(request.body);
    const updated = await store.updateConversation(auth, id, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.archived !== undefined ? { archived: parsed.archived } : {}),
      ...(parsed.deleted !== undefined ? { deleted: parsed.deleted } : {}),
      ...(parsed.pinned !== undefined ? { pinned: parsed.pinned } : {}),
    });
    return updated ? reply.send({ data: { id } }) : reply.code(404).send(apiError("not_found", "Conversation not found.", request.id));
  });

  app.get("/api/providers", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    return { data: await store.listProviders(auth) };
  });
  app.get("/api/provider-catalog", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    return { data: freeModelDirectory.catalog(process.env) };
  });
  app.post("/api/provider-catalog/refresh", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    await freeModelDirectory.refresh();
    return { data: freeModelDirectory.catalog(process.env) };
  });
  app.post("/api/providers", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const input = providerConnectionInputSchema.parse(request.body);
    let baseUrl: string;
    if (input.kind === "custom") {
      try {
        baseUrl = (await validatePublicHttpsEndpoint(input.base_url || "")).toString().replace(/\/$/, "");
      } catch {
        await store.audit(auth, {
          eventType: "provider.connection.rejected",
          targetType: "provider_connection",
          ...auditContext(request, env, { kind: input.kind, reason: "unsafe_provider_url" }),
        });
        return reply.code(422).send(apiError("unsafe_provider_url", "Custom providers must use a public HTTPS endpoint. Local, private, metadata, embedded-credential, and redirect targets are blocked.", request.id));
      }
    } else {
      baseUrl = normalizedProviderUrl(input.kind);
    }
    const healthUrl = providerCatalogUrl(input.kind, baseUrl);
    const health = await (input.kind === "custom" ? fetchPublicHttpsEndpoint(healthUrl, {
      headers: { authorization: `Bearer ${input.api_key}`, accept: "application/json" },
    }, { timeoutMs: 8_000, maxResponseBytes: 1024 * 1024 }) : fetch(healthUrl, {
      headers: { authorization: `Bearer ${input.api_key}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })).catch(() => null);
    await health?.body?.cancel().catch(() => undefined);
    if (!health?.ok && ![404, 405].includes(health?.status ?? 0)) {
      const code = [401, 403].includes(health?.status ?? 0) ? "provider_auth_failed" : "provider_unreachable";
      await store.audit(auth, {
        eventType: "provider.connection.rejected",
        targetType: "provider_connection",
        ...auditContext(request, env, { kind: input.kind, reason: code, upstream_status: health?.status }),
      });
      return reply.code(422).send(apiError(code, "The provider connection test failed. Verify the URL, key, and model.", request.id));
    }
    const created = await store.addProvider(auth, { ...input, base_url: baseUrl }, "healthy");
    await store.audit(auth, {
      eventType: "provider.connection.created",
      targetType: "provider_connection",
      targetId: created.id,
      ...auditContext(request, env, { kind: input.kind }),
    });
    return reply.code(201).header("location", `/api/providers/${created.id}`).send({ data: { ...created, status: "healthy" } });
  });

  app.patch("/api/providers/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const parsed = providerPatchSchema.parse(request.body);
    const updated = await store.updateProvider(auth, id, parsed);
    if (!updated) return reply.code(404).send(apiError("not_found", "Provider not found.", request.id));
    await store.audit(auth, {
      eventType: "provider.connection.updated",
      targetType: "provider_connection",
      targetId: id,
      ...auditContext(request, env, { ...parsed, api_key: parsed.api_key ? "redacted" : undefined }),
    });
    return { data: updated };
  });

  app.delete("/api/providers/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await store.deleteProvider(auth, id);
    if (!deleted) return reply.code(404).send(apiError("not_found", "Provider not found.", request.id));
    await store.audit(auth, {
      eventType: "provider.connection.deleted",
      targetType: "provider_connection",
      targetId: id,
      ...auditContext(request, env),
    });
    return reply.code(204).send();
  });

  app.post("/api/providers/:id/health", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await store.recheckProviderHealth(auth, id);
    if (!result) return reply.code(404).send(apiError("not_found", "Provider not found.", request.id));
    return { data: result };
  });

  app.get("/api/api-keys", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    return { data: await store.listApiKeys(auth) };
  });
  app.post("/api/api-keys", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const input = apiKeyInputSchema.parse(request.body);
    const key = await store.createApiKey(auth, input.name, input.scopes, env.HIVE_API_KEY_PEPPER);
    await store.audit(auth, {
      eventType: "api_key.created",
      targetType: "api_key",
      targetId: key.id,
      ...auditContext(request, env, { scopes: input.scopes }),
    });
    return reply.code(201).header("cache-control", "no-store").send({ data: key });
  });
  app.delete("/api/api-keys/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const revoked = await store.revokeApiKey(auth, id);
    if (!revoked) return reply.code(404).send(apiError("not_found", "API key not found.", request.id));
    await store.audit(auth, {
      eventType: "api_key.revoked",
      targetType: "api_key",
      targetId: id,
      ...auditContext(request, env),
    });
    return reply.code(204).send();
  });

  app.get("/api/usage", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const quota = await store.getQuotaPolicy(auth);
    return { data: { managed_credits: await managedBalance(auth), requests_per_minute: quota.requestsPerMinute, managed_requests_per_minute: quota.managedRequestsPerMinute, concurrent_streams: quota.concurrentStreams, web_searches_per_day: quota.webSearchesPerDay } };
  });

  const settingsInputSchema = z.object({
    systemPrompt: z.string().max(4000).nullable().optional(),
    defaultModel: z.string().max(256).nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
  });

  app.get("/api/settings", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const settings = await store.getUserSettings(auth);
    return { data: { systemPrompt: settings.systemPrompt, defaultModel: settings.defaultModel, temperature: settings.temperature } };
  });

  app.patch("/api/settings", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const input = settingsInputSchema.parse(request.body);
    await store.updateUserSettings(auth, {
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });
    const updated = await store.getUserSettings(auth);
    return { data: { systemPrompt: updated.systemPrompt, defaultModel: updated.defaultModel, temperature: updated.temperature } };
  });

  app.post("/api/search", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (!env.TAVILY_API_KEY) return reply.code(503).send(apiError("search_unavailable", "Web search is not configured for this deployment.", request.id));
    const { query } = searchSchema.parse(request.body);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return reply.code(502).send(apiError("search_upstream_error", "The search provider could not complete the request.", request.id));
    const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const retrievedAt = new Date().toISOString();
    return { data: (payload.results ?? []).slice(0, 5).flatMap((result) => result.url ? [{ title: result.title || new URL(result.url).hostname, url: result.url, snippet: (result.content || "").slice(0, 600), retrieved_at: retrievedAt }] : []) };
  });

  app.post("/api/files/presign", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const input = fileInputSchema.parse(request.body);
    if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return reply.code(503).send(apiError("storage_unavailable", "Attachment storage is not configured.", request.id));
    const fileId = randomUUID();
    const key = `quarantine/${auth.tenantId}/${fileId}/${input.name}`;
    const client = new S3Client({ region: "auto", endpoint: env.R2_ENDPOINT, forcePathStyle: env.R2_FORCE_PATH_STYLE, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
    // Browsers calculate Content-Length themselves and do not allow application
    // code to set it. The completion endpoint verifies the stored object size
    // before it can leave quarantine.
    const command = new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: input.mime_type, Metadata: { tenant: auth.tenantId, file: fileId } });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });
    await store.createAttachment(auth, { id: fileId, objectKey: key, originalName: input.name, mimeType: input.mime_type, sizeBytes: input.size_bytes });
    return reply.code(201).send({ data: {
      id: fileId,
      upload_url: uploadUrl,
      upload_headers: {
        "content-type": input.mime_type,
      },
      object_key: key,
      expires_in: 300,
      status: "quarantined",
    } });
  });

  app.post("/api/files/:id/complete", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (!fileQueue || !env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return reply.code(503).send(apiError("scan_unavailable", "Attachment scanning is not configured.", request.id));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = fileInputSchema.extend({ object_key: z.string().min(1).max(1_000) }).parse(request.body);
    const expectedPrefix = `quarantine/${auth.tenantId}/${id}/`;
    if (!input.object_key.startsWith(expectedPrefix)) return reply.code(403).send(apiError("invalid_request", "The quarantine object does not belong to this tenant.", request.id));
    const client = new S3Client({ region: "auto", endpoint: env.R2_ENDPOINT, forcePathStyle: env.R2_FORCE_PATH_STYLE, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
    const head = await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: input.object_key }));
    if (head.ContentLength !== input.size_bytes || head.Metadata?.tenant !== auth.tenantId || head.Metadata?.file !== id) return reply.code(422).send(apiError("invalid_request", "The uploaded object does not match its quarantine record.", request.id));
    const marked = await store.markAttachment(auth, id, { status: "scanning" });
    if (!marked) return reply.code(404).send(apiError("not_found", "Attachment not found.", request.id));
    const job = await fileQueue.add("scan", { id, subject: auth, objectKey: input.object_key, originalName: input.name, mimeType: input.mime_type, sizeBytes: input.size_bytes }, { attempts: 4, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 200, removeOnFail: 200 });
    return reply.code(202).send({ data: { id, job_id: String(job.id), status: "scanning" } });
  });

  app.get("/api/files/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [attachment] = await store.getAttachments(auth, [id]);
    if (!attachment) return reply.code(404).send(apiError("not_found", "Attachment not found.", request.id));
    return {
      data: {
        id: attachment.id,
        name: attachment.originalName,
        mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
        status: attachment.status,
      },
    };
  });

  app.post("/internal/files/:id/result", async (request, reply) => {
    if (request.headers["x-hive-service-secret"] !== env.INTERNAL_SERVICE_SECRET) return reply.code(401).send(apiError("invalid_api_key", "Service authentication failed.", request.id));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = fileResultSchema.parse(request.body);
    const subject = { userId: body.user_id, tenantId: body.tenant_id, email: body.email, role: body.role } as const;
    const marked = await store.markAttachment(subject, id, { status: body.status, ...(body.object_key ? { objectKey: body.object_key } : {}), ...(body.sha256 ? { sha256: body.sha256 } : {}), ...(body.extracted_text ? { extractedText: body.extracted_text } : {}) });
    return marked ? reply.code(204).send() : reply.code(404).send(apiError("not_found", "Attachment not found.", request.id));
  });

  app.get("/api/files/:id/download", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth) return authError(reply, request.id);
    if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return reply.code(503).send(apiError("storage_unavailable", "Object storage is not configured.", request.id));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    
    const [attachment] = await store.getAttachments(auth, [id]);
    if (!attachment) return reply.code(404).send(apiError("not_found", "Attachment not found.", request.id));
    
    if (attachment.status !== "approved") return reply.code(403).send(apiError("invalid_request", "Attachment is not approved.", request.id));

    const client = new S3Client({ region: "auto", endpoint: env.R2_ENDPOINT, forcePathStyle: env.R2_FORCE_PATH_STYLE, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
    const command = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: attachment.objectKey, ResponseContentDisposition: `attachment; filename="${encodeURIComponent(attachment.originalName)}"` });
    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });
    
    return reply.redirect(downloadUrl);
  });

  app.delete("/api/files/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    
    const deleted = await store.deleteAttachment(auth, id);
    if (!deleted) return reply.code(404).send(apiError("not_found", "Attachment not found.", request.id));
    
    return reply.code(204).send();
  });

  app.post("/api/conversations/:id/share", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const share = await store.shareConversation(auth, id);
    if (!share) return reply.code(404).send(apiError("not_found", "Conversation not found.", request.id));
    return reply.code(201).send({ data: { token: share.token, url: share.url } });
  });

  app.delete("/api/conversations/:id/share", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const revoked = await store.revokeShare(auth, id);
    if (!revoked) return reply.code(404).send(apiError("not_found", "Conversation not found or already revoked.", request.id));
    return reply.code(204).send();
  });

  app.get("/api/shared/:token", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(500) }).parse(request.params);
    const conversation = await store.getSharedConversation(token);
    if (!conversation) return reply.code(404).send(apiError("not_found", "Shared conversation not found or has been revoked.", request.id));
    return { data: conversation };
  });

  app.post("/api/builds", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (!buildQueue) return reply.code(503).send(apiError("build_queue_unavailable", "Build mode requires Redis and the HIVE worker.", request.id));
    const input = buildRequestSchema.parse(request.body);
    const job = await buildQueue.add("council", { ...input, subject: auth }, { removeOnComplete: 100, removeOnFail: 100 });
    return reply.code(202).header("location", `/api/builds/${job.id}`).send({ data: { id: String(job.id), status: "queued", estimated_calls: buildPhaseNames.length } });
  });
  app.get("/api/builds/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (!buildQueue) return reply.code(503).send(apiError("build_queue_unavailable", "Build mode requires Redis and the HIVE worker.", request.id));
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const job = await buildQueue.getJob(id);
    if (!job || job.data.subject?.tenantId !== auth.tenantId) return reply.code(404).send(apiError("not_found", "Build job not found.", request.id));
    return { data: { id, status: await job.getState(), progress: job.progress, result: job.returnvalue, failed_reason: job.failedReason || undefined } };
  });
  app.delete("/api/builds/:id", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (!buildQueue) return reply.code(503).send(apiError("build_queue_unavailable", "Build mode requires Redis and the HIVE worker.", request.id));
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const job = await buildQueue.getJob(id);
    if (!job || job.data.subject?.tenantId !== auth.tenantId) return reply.code(404).send(apiError("not_found", "Build job not found.", request.id));
    await job.updateData({ ...job.data, cancelled: true });
    return reply.code(202).send({ data: { id, status: "cancelling" } });
  });

  app.post("/api/admin/credits", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal || !isPlatformOwner(auth, env)) return reply.code(403).send(apiError("forbidden", "Platform-owner access is required.", request.id));
    const body = z.object({ tenant_id: z.string().uuid(), amount: z.number().int().min(-100_000).max(100_000), reason: z.string().min(3).max(200), idempotency_key: z.string().min(8).max(200) }).parse(request.body);
    await store.adminChangeCredits(body.tenant_id, auth.userId, body.amount, body.reason, `admin:${body.idempotency_key}`);
    await store.audit(auth, {
      eventType: "credit.adjusted",
      targetType: "tenant",
      targetId: body.tenant_id,
      ...auditContext(request, env, { amount: body.amount, reason: body.reason, idempotency_key: body.idempotency_key }),
    });
    return { data: { tenant_id: body.tenant_id, applied: true } };
  });

  app.get("/api/admin/waitlist", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal || !isPlatformOwner(auth, env)) return reply.code(403).send(apiError("forbidden", "Platform-owner access is required.", request.id));
    return { data: await store.listWaitlist() };
  });

  app.post("/api/admin/waitlist/:id/approve", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal || !isPlatformOwner(auth, env)) return reply.code(403).send(apiError("forbidden", "Platform-owner access is required.", request.id));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const invitation = await store.approveWaitlist(id, auth.userId);
    if (!invitation) return reply.code(404).send(apiError("not_found", "Waitlist entry not found.", request.id));
    let delivered = false;
    if (env.AUTH_RESEND_KEY) {
      const inviteUrl = `${env.WEB_ORIGIN.replace(/\/$/, "")}/invite/${encodeURIComponent(invitation.rawToken)}`;
      const sent = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.AUTH_RESEND_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [invitation.email], subject: "Your HIVE Cloud beta invite", html: `<p>Your HIVE Cloud beta access is ready.</p><p><a href="${inviteUrl}">Accept your invite</a></p><p>This link expires in 72 hours.</p>` }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      delivered = Boolean(sent?.ok);
    }
    await store.audit(auth, {
      eventType: "invitation.created",
      targetType: "waitlist_entry",
      targetId: id,
      ...auditContext(request, env, { delivered, expires_at: invitation.expiresAt }),
    });
    return reply.code(201).header("cache-control", "no-store").send({ data: { email: invitation.email, expires_at: invitation.expiresAt, delivered, ...(delivered ? {} : { invite_token: invitation.rawToken }) } });
  });

  // ---- Billing routes ----
  app.get("/api/billing/plans", async (_request, reply) => {
    const result = await billingHandlers.getPlans();
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/billing/status", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    const result = await billingHandlers.getStatus(auth.tenantId);
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/billing/checkouts", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (auth.role !== "owner") return reply.code(403).send(apiError("forbidden", "Only workspace owners can manage billing.", request.id));
    const body = z.object({ planId: z.enum(["builder", "pro"]), interval: z.enum(["monthly", "annual"]) }).parse(request.body);
    const result = await billingHandlers.createCheckout(
      auth.tenantId, auth.userId, auth.email,
      body,
    );
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/billing/paypal/subscriptions/confirm", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (auth.role !== "owner") return reply.code(403).send(apiError("forbidden", "Only workspace owners can manage billing.", request.id));
    const body = z.object({ subscriptionId: z.string().min(3).max(200), checkoutId: z.string().uuid(), state: z.string().uuid() }).parse(request.body);
    const result = await billingHandlers.confirmSubscription(
      auth.tenantId,
      body,
    );
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/billing/subscription/cancel", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (auth.role !== "owner") return reply.code(403).send(apiError("forbidden", "Only workspace owners can manage billing.", request.id));
    const result = await billingHandlers.cancelSubscription(auth.tenantId);
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/billing/paypal/orders", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (auth.role !== "owner") return reply.code(403).send(apiError("forbidden", "Only workspace owners can manage billing.", request.id));
    const body = z.object({ sku: z.enum(["boost", "power"]) }).parse(request.body);
    const result = await billingHandlers.createTopUpOrder(
      auth.tenantId,
      body,
    );
    return reply.code(result.status).send(result.body);
  });

  app.post("/api/billing/paypal/orders/:id/capture", async (request, reply) => {
    const auth = await authenticateRequest(request, env, store);
    if (!auth?.internal) return authError(reply, request.id);
    if (auth.role !== "owner") return reply.code(403).send(apiError("forbidden", "Only workspace owners can manage billing.", request.id));
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const result = await billingHandlers.captureOrder(auth.tenantId, id);
    return reply.code(result.status).send(result.body);
  });

  // Public webhook endpoint (no auth)
  app.post("/api/webhooks/paypal", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const rawBody = JSON.stringify(request.body);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value[0] ?? "";
    }
    if (!env.PAYPAL_WEBHOOK_ID) return reply.code(503).send({ message: "PayPal webhooks are not configured" });
    const result = await handlePayPalWebhook(webhookHandler, rawBody, headers, env.PAYPAL_WEBHOOK_ID);
    return reply.code(result.status).send({ message: result.message });
  });

  registerAdminUsageRoutes(app, { env, store });

  return app;
}
