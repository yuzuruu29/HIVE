import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  real,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const membershipRole = pgEnum("membership_role", ["owner", "member"]);
export const conversationMode = pgEnum("conversation_mode", ["chat", "build"]);
export const messageRole = pgEnum("message_role", ["system", "user", "assistant", "tool"]);
export const messageStatus = pgEnum("message_status", ["pending", "streaming", "complete", "failed", "cancelled"]);
export const providerKind = pgEnum("provider_kind", [
  "groq",
  "nvidia",
  "openrouter",
  "gemini",
  "opencode",
  "nous",
  "cerebras",
  "sambanova",
  "huggingface",
  "github",
  "mistral",
  "openai",
  "anthropic",
  "custom",
]);
export const providerStatus = pgEnum("provider_status", ["pending", "healthy", "degraded", "disabled", "auth_failed"]);
export const buildStatus = pgEnum("build_status", ["queued", "running", "complete", "failed", "cancelled"]);
export const buildPhaseName = pgEnum("build_phase_name", ["queen", "scout", "planner", "builder", "validator", "reviewer"]);
export const invitationStatus = pgEnum("invitation_status", ["pending", "accepted", "revoked", "expired"]);
export const attachmentStatus = pgEnum("attachment_status", ["quarantined", "scanning", "approved", "rejected", "deleted"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const accounts = pgTable("accounts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] }), index("accounts_user_idx").on(table.userId)]);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}, (table) => [index("sessions_user_idx").on(table.userId)]);

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.identifier, table.token] })]);

export const waitlistEntries = pgTable("waitlist_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  useCase: text("use_case"),
  referral: text("referral"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt,
}, (table) => [uniqueIndex("waitlist_email_unique").on(table.email), index("waitlist_created_idx").on(table.createdAt)]);

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  tokenDigest: text("token_digest").notNull(),
  status: invitationStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt,
}, (table) => [uniqueIndex("invitations_token_unique").on(table.tokenDigest), index("invitations_email_status_idx").on(table.email, table.status)]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex("tenants_slug_unique").on(table.slug)]);

export const memberships = pgTable("memberships", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: membershipRole("role").notNull().default("member"),
  createdAt,
}, (table) => [primaryKey({ columns: [table.tenantId, table.userId] }), index("memberships_user_idx").on(table.userId)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mode: conversationMode("mode").notNull().default("chat"),
  title: text("title").notNull().default("New conversation"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [index("conversations_tenant_updated_idx").on(table.tenantId, table.updatedAt)]);

export const conversationShares = pgTable("conversation_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  tokenDigest: text("token_digest").notNull().unique(), // sha256 hex of raw share token
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  parentMessageId: uuid("parent_message_id"),
  revision: integer("revision").notNull().default(1),
  role: messageRole("role").notNull(),
  status: messageStatus("status").notNull().default("complete"),
  content: jsonb("content").notNull(),
  routeReceipt: jsonb("route_receipt"),
  createdAt,
  updatedAt,
}, (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt), index("messages_tenant_idx").on(table.tenantId), index("idx_messages_fts").using("gin", sql`to_tsvector('english', COALESCE(${table.content}::text, ''))`)]);

export const messageAttachments = pgTable("message_attachments", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
}, (t) => [primaryKey({ columns: [t.messageId, t.attachmentId] })]);

export const citations = pgTable("citations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  url: text("url").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
}, (table) => [index("citations_message_idx").on(table.messageId)]);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  status: attachmentStatus("status").notNull().default("quarantined"),
  extractedText: text("extracted_text"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex("attachments_object_key_unique").on(table.objectKey), index("attachments_tenant_status_idx").on(table.tenantId, table.status)]);

export const providerConnections = pgTable("provider_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: providerKind("kind").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  defaultModel: text("default_model").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  secretEnvelope: jsonb("secret_envelope").notNull(),
  secretVersion: integer("secret_version").notNull().default(1),
  status: providerStatus("status").notNull().default("pending"),
  lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [index("provider_connections_tenant_idx").on(table.tenantId), uniqueIndex("provider_connections_tenant_name_unique").on(table.tenantId, table.name)]);

export const providerModels = pgTable("provider_models", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  providerConnectionId: uuid("provider_connection_id").references(() => providerConnections.id, { onDelete: "cascade" }),
  provider: providerKind("provider").notNull(),
  modelId: text("model_id").notNull(),
  displayName: text("display_name").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  costClass: text("cost_class").notNull(),
  catalogUpdatedAt: timestamp("catalog_updated_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("provider_models_unique").on(table.provider, table.modelId, table.providerConnectionId), index("provider_models_tenant_idx").on(table.tenantId)]);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  digest: text("digest").notNull(),
  scopes: jsonb("scopes").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt,
}, (table) => [uniqueIndex("api_keys_digest_unique").on(table.digest), index("api_keys_tenant_idx").on(table.tenantId)]);

export const routerRequests = pgTable("router_requests", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key"),
  routerModel: text("router_model").notNull().default("hive-0.1"),
  routerPolicy: text("router_policy").notNull().default("free-first-balanced"),
  requiredCapabilities: jsonb("required_capabilities").notNull().default([]),
  selectedProvider: providerKind("selected_provider"),
  selectedModel: text("selected_model"),
  managed: boolean("managed").notNull().default(false),
  costClass: text("cost_class"),
  fallbackCount: integer("fallback_count").notNull().default(0),
  statusCode: integer("status_code"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  latencyMs: integer("latency_ms"),
  errorCode: text("error_code"),
  priceSnapshotId: uuid("price_snapshot_id"),
  promptCacheHitTokens: integer("prompt_cache_hit_tokens"),
  promptCacheWriteTokens: integer("prompt_cache_write_tokens"),
  providerCostMicrousd: integer("provider_cost_microusd"),
  reservedCredits: integer("reserved_credits"),
  debitedCredits: integer("debited_credits"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
}, (table) => [uniqueIndex("router_requests_idempotency_unique").on(table.tenantId, table.idempotencyKey), index("router_requests_tenant_created_idx").on(table.tenantId, table.createdAt)]);

export const routeAttempts = pgTable("route_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull().references(() => routerRequests.id, { onDelete: "cascade" }),
  provider: providerKind("provider").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  statusCode: integer("status_code"),
  reason: text("reason"),
  latencyMs: integer("latency_ms").notNull(),
  createdAt,
}, (table) => [index("route_attempts_request_idx").on(table.requestId)]);

export const creditLedger = pgTable("credit_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").references(() => routerRequests.id, { onDelete: "set null" }),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key").notNull(),
  balanceClass: text("balance_class").notNull().default("subscription"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  paymentEventId: text("payment_event_id"),
  metadata: jsonb("metadata"),
  createdAt,
}, (table) => [uniqueIndex("credit_ledger_idempotency_unique").on(table.tenantId, table.idempotencyKey), index("credit_ledger_tenant_created_idx").on(table.tenantId, table.createdAt)]);

export const quotaPolicies = pgTable("quota_policies", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  requestsPerMinute: integer("requests_per_minute").notNull().default(60),
  managedRequestsPerMinute: integer("managed_requests_per_minute").notNull().default(10),
  concurrentStreams: integer("concurrent_streams").notNull().default(4),
  webSearchesPerDay: integer("web_searches_per_day").notNull().default(20),
  updatedAt,
});

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  systemPrompt: text("system_prompt"),
  defaultModel: text("default_model"),
  temperature: real("temperature"),
  createdAt,
  updatedAt,
});

export const buildJobs = pgTable("build_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  objective: text("objective").notNull(),
  sourceManifest: jsonb("source_manifest").notNull(),
  status: buildStatus("status").notNull().default("queued"),
  estimatedCalls: integer("estimated_calls").notNull().default(6),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [index("build_jobs_tenant_created_idx").on(table.tenantId, table.createdAt)]);

export const buildPhases = pgTable("build_phases", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  buildJobId: uuid("build_job_id").notNull().references(() => buildJobs.id, { onDelete: "cascade" }),
  name: buildPhaseName("name").notNull(),
  status: buildStatus("status").notNull().default("queued"),
  summary: text("summary"),
  routeReceipt: jsonb("route_receipt"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
}, (table) => [uniqueIndex("build_phases_job_name_unique").on(table.buildJobId, table.name), index("build_phases_tenant_idx").on(table.tenantId)]);

export const buildArtifacts = pgTable("build_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  buildJobId: uuid("build_job_id").notNull().references(() => buildJobs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  executionStatus: text("execution_status").notNull().default("not_run"),
  createdAt,
}, (table) => [index("build_artifacts_job_idx").on(table.buildJobId)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").notNull().default({}),
  ipHash: text("ip_hash"),
  createdAt,
}, (table) => [index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt), index("audit_events_type_idx").on(table.eventType)]);

export const modelPriceSnapshots = pgTable("model_price_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  // Physical column names are retained for migration compatibility; values are
  // integer micro-USD prices per one million tokens, never per-token rates.
  inputMicrousdPerMillionTokens: integer("input_microusd_per_token").notNull(),
  outputMicrousdPerMillionTokens: integer("output_microusd_per_token").notNull(),
  cacheReadMicrousdPerMillionTokens: integer("cache_read_microusd_per_token"),
  sourceUrl: text("source_url").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  createdAt,
}, (table) => [
  uniqueIndex("price_snapshots_provider_model_effective_idx").on(table.provider, table.model, table.effectiveFrom),
]);

export const creditReservations = pgTable("credit_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  priceSnapshotId: text("price_snapshot_id"),
  reservedCredits: integer("reserved_credits").notNull(),
  settledCredits: integer("settled_credits").notNull().default(0),
  providerCostMicrousd: integer("provider_cost_microusd"),
  status: text("status").notNull().default("reserved"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("credit_reservations_tenant_request_unique").on(table.tenantId, table.requestId),
]);

export const billingAccounts = pgTable("billing_accounts", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  paypalPayerId: text("paypal_payer_id"),
  createdAt,
  updatedAt,
});

export const billingCheckouts = pgTable("billing_checkouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  interval: text("interval").notNull(),
  paypalPlanId: text("paypal_plan_id").notNull(),
  nonceDigest: text("nonce_digest").notNull(),
  externalSubscriptionId: text("external_subscription_id"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  index("billing_checkouts_tenant_created_idx").on(table.tenantId, table.createdAt),
  uniqueIndex("billing_checkouts_external_subscription_unique").on(table.externalSubscriptionId),
]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("paypal"),
  externalSubscriptionId: text("external_subscription_id").notNull(),
  planVersion: text("plan_version").notNull(),
  status: text("status").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  paidThrough: timestamp("paid_through", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("subscriptions_external_id_unique").on(table.externalSubscriptionId),
  index("subscriptions_tenant_idx").on(table.tenantId),
]);

export const billingEvents = pgTable("billing_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  externalEventId: text("external_event_id").notNull(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  payload: jsonb("payload").notNull().default({}),
  processingStatus: text("processing_status").notNull().default("received"),
  attemptCount: integer("attempt_count").notNull().default(0),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt,
}, (table) => [
  uniqueIndex("billing_events_external_event_id_unique").on(table.externalEventId),
]);

export const paymentOrders = pgTable("payment_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  externalOrderId: text("external_order_id").notNull(),
  externalCaptureId: text("external_capture_id"),
  customId: text("custom_id").notNull(),
  sku: text("sku").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("created"),
  creditsGranted: integer("credits_granted").default(0),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("payment_orders_external_order_unique").on(table.externalOrderId),
]);

export const entitlements = pgTable("entitlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  planVersion: integer("plan_version").notNull().default(1),
  limitsJson: jsonb("limits_json").notNull().default({}),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  createdAt,
}, (table) => [
  index("entitlements_tenant_effective_idx").on(table.tenantId, table.effectiveFrom),
]);

export const analyticsEvents = pgTable("analytics_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  eventName: text("event_name").notNull(),
  properties: jsonb("properties").notNull().default({}),
  sessionId: text("session_id"),
  createdAt,
}, (table) => [
  index("analytics_events_name_created_idx").on(table.eventName, table.createdAt),
  index("analytics_events_tenant_idx").on(table.tenantId),
]);
export const usageWindows = pgTable("usage_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  windowKey: text("window_key").notNull(),
  metric: text("metric").notNull(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  windowEnd: bigint("window_end", { mode: "number" }).notNull(),
  count: bigint("count", { mode: "number" }).notNull().default(0),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("idx_usage_windows_lookup").on(table.windowKey, table.metric, table.windowStart),
  index("idx_usage_windows_cleanup").on(table.windowEnd),
]);

export const usageOverrides = pgTable("usage_overrides", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  maxOverride: integer("max_override"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("idx_usage_overrides_lookup").on(table.tenantId, table.metric),
]);
