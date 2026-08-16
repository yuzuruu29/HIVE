import { z } from "zod";

export const HIVE_ROUTER_ID = "hive-0.1" as const;
export const HIVE_ROUTER_NAME = "HIVE 0.1" as const;

export const textContentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(200_000),
});

export const imageContentPartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string().url().max(2_000_000),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string().max(200_000),
    z.array(z.discriminatedUnion("type", [textContentPartSchema, imageContentPartSchema])).max(40),
  ]),
  name: z.string().min(1).max(64).optional(),
  tool_call_id: z.string().max(256).optional(),
});

const functionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(64),
    description: z.string().max(4_000).optional(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1).max(256).default(HIVE_ROUTER_ID),
  messages: z.array(chatMessageSchema).min(1).max(256),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(131_072).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
  tools: z.array(functionToolSchema).max(64).optional(),
  tool_choice: z.union([z.literal("none"), z.literal("auto"), z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  })]).optional(),
  user: z.string().max(256).optional(),
  hive: z.object({
    provider: z.string().max(64).optional(),
    model: z.string().max(256).optional(),
    allow_fallback: z.boolean().default(true),
    policy: z.literal("free-first-balanced").default("free-first-balanced"),
    display_content: z.string().max(200_000).optional(),
    parent_message_id: z.string().uuid().nullable().optional(),
    regenerate_of: z.string().uuid().optional(),
    attachment_ids: z.array(z.string().uuid()).max(5).optional(),
    citations: z.array(z.object({
      title: z.string().trim().min(1).max(500),
      url: z.string().url().max(2_048).refine((value) => {
        try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
      }, "Citation URL must use HTTP or HTTPS"),
      retrieved_at: z.string().datetime(),
    })).max(20).optional(),
    execution_summary: z.object({
      started_at: z.string().datetime().optional(),
      search_active: z.boolean().optional(),
      citation_count: z.number().int().min(0).max(100).optional(),
      prepared_file_count: z.number().int().min(0).max(40).optional(),
    }).optional(),
  }).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const providerKindSchema = z.enum([
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
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const providerConnectionInputSchema = z.object({
  kind: providerKindSchema,
  name: z.string().min(1).max(80),
  base_url: z.string().url().optional(),
  api_key: z.string().min(8).max(8_192),
  default_model: z.string().min(1).max(256),
  capabilities: z.object({
    vision: z.boolean().default(false),
    tools: z.boolean().default(false),
    context_window: z.number().int().positive().default(32_768),
  }).default({ vision: false, tools: false, context_window: 32_768 }),
});
export type ProviderConnectionInput = z.infer<typeof providerConnectionInputSchema>;

export interface RouteCandidate {
  id: string;
  provider: ProviderKind;
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  managed: boolean;
  free: boolean;
  healthy: boolean;
  latencyMs: number;
  quality: number;
  contextWindow: number;
  vision: boolean;
  tools: boolean;
  pinned?: boolean;
}

export interface RouteAttempt {
  provider: string;
  model: string;
  status: "selected" | "failed" | "skipped";
  statusCode?: number;
  reason?: string;
  latencyMs: number;
}

export interface RouteReceipt {
  requestId: string;
  router: typeof HIVE_ROUTER_ID;
  policy: "free-first-balanced";
  provider: string;
  model: string;
  managed: boolean;
  costClass: "free" | "paid" | "byok";
  fallbackCount: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  priceSnapshotId?: string;
  reservedCredits?: number;
  estimatedProviderCostMicrousd?: number;
  providerCostMicrousd?: number;
  debitedCredits?: number;
  attempts: RouteAttempt[];
  executionSummary?: {
    status: "completed" | "cancelled" | "failed";
    startedAt: string;
    completedAt: string;
    durationMs: number;
    searchActive?: boolean;
    citationCount?: number;
    preparedFileCount?: number;
    errorCode?: string;
  };
}

export const buildPhaseNames = [
  "queen",
  "scout",
  "planner",
  "builder",
  "validator",
  "reviewer",
  "synthesizer",
] as const;
export type BuildPhaseName = (typeof buildPhaseNames)[number];

export const buildRequestSchema = z.object({
  objective: z.string().min(10).max(20_000),
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    content: z.string().max(2_000_000),
    language: z.string().max(64).optional(),
  })).max(50).refine(
    (files) => files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) <= 20 * 1024 * 1024,
    "Build context must not exceed 20MB",
  ),
});
export type BuildRequest = z.infer<typeof buildRequestSchema>;

export interface BuildPhase {
  name: BuildPhaseName;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  summary?: string;
  receipt?: RouteReceipt;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Array<{ field?: string; code: string; message: string }>;
    request_id?: string;
  };
}

export function apiError(code: string, message: string, requestId?: string): ApiErrorBody {
  return { error: { code, message, ...(requestId ? { request_id: requestId } : {}) } };
}

export interface HiveModelSelection {
  provider?: string;
  model?: string;
  allowFallback: boolean;
}

export interface HiveModelCatalogEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  provider: string;
  model: string;
  displayName: string;
  costClass: "free" | "paid" | "byok";
  managed: boolean;
  free: boolean;
  vision: boolean;
  tools: boolean;
  cooldownUntil?: string;
}

export interface FreeProviderCatalogEntry {
  kind: ProviderKind;
  displayName: string;
  baseUrl?: string;
  defaultModel: string;
  freeMode: "free-model" | "free-account-tier" | "monthly-credit" | "custom";
  quotaNote: string;
  documentationUrl: string;
  catalogUrl?: string;
  privacyNote?: string;
  capabilities: {
    vision: boolean;
    tools: boolean;
    contextWindow: number;
  };
  freeModels: string[];
  runtimeConfigured: boolean;
}

// Billing contracts
export interface PlanVersion {
  id: string;
  name: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  monthlyManagedCredits: number;
  dailyJobLimit: number;
  councilRunLimit: number;
  maxWorkspaces: number;
}

export const PLAN_VERSIONS: Record<string, PlanVersion> = {
  community: {
    id: "community",
    name: "Community",
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    monthlyManagedCredits: 0,
    dailyJobLimit: 30,
    councilRunLimit: 2,
    maxWorkspaces: 1,
  },
  builder: {
    id: "builder",
    name: "Builder",
    monthlyPriceCents: 1500,
    annualPriceCents: 15000,
    monthlyManagedCredits: 600,
    dailyJobLimit: 100,
    councilRunLimit: 20,
    maxWorkspaces: 1,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceCents: 3900,
    annualPriceCents: 39000,
    monthlyManagedCredits: 1600,
    dailyJobLimit: 300,
    councilRunLimit: 75,
    maxWorkspaces: 1,
  },
} as const;

export const TOPUP_SKUS = {
  boost: { credits: 1000, amountCents: 1000 },
  power: { credits: 3000, amountCents: 3000 },
} as const;

export interface SubscriptionStatus {
  planId: string | null;
  status: "active" | "past_due" | "cancelled" | "expired" | "none";
  paidThrough: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  managedCreditsBalance: number;
  promotionalBalance: number;
  purchasedBalance: number;
  totalBalance: number;
}

export interface CreditBalance {
  promotional: number;
  subscription: number;
  purchased: number;
  total: number;
}

export interface PriceEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedProviderCostMicrousd: number;
  estimatedCredits: number;
  priceSnapshotId: string;
}
