import { z } from "zod";

const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const optionalPositiveNumber = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().positive().optional(),
);

const DEVELOPMENT_INTERNAL_SECRET = "development-internal-service-secret";
const DEVELOPMENT_API_KEY_PEPPER = "development-api-key-pepper-change-me";
const DEVELOPMENT_KEK = Buffer.alloc(32, 1).toString("base64");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  HIVE_DEPLOYMENT_MODE: z.enum(["self_hosted", "hosted"]).default("self_hosted"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: optionalUrl,
  DATABASE_MIGRATION_URL: optionalUrl,
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  DATABASE_CONNECTION_MODE: z.enum(["direct", "session-pooler", "transaction-pooler"]).optional(),
  DATABASE_APPLICATION_NAME: z.string().default("hive_cloud"),
  DATABASE_SSL_MODE: z.string().optional(),
  REDIS_URL: optionalUrl,
  INTERNAL_SERVICE_SECRET: z.string().min(32).default(DEVELOPMENT_INTERNAL_SECRET),
  HIVE_API_KEY_PEPPER: z.string().min(32).default(DEVELOPMENT_API_KEY_PEPPER),
  HIVE_ENCRYPTION_KEK_BASE64: z.string().refine((value) => Buffer.from(value, "base64").length === 32, "Encryption KEK must decode to exactly 32 bytes.").default(DEVELOPMENT_KEK),
  HIVE_BETA_BYPASS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  HIVE_MOCK_PROVIDER: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  HIVE_LOCAL_PROVIDER_BRIDGE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  TRUSTED_PROXY_CIDRS: z.string().default("127.0.0.1,::1"),
  GROQ_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENCODE_API_KEY: z.string().optional(),
  NOUS_API_KEY: z.string().optional(),
  NOUS_PORTAL_TOKEN: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  SAMBANOVA_API_KEY: z.string().optional(),
  HUGGINGFACE_API_KEY: z.string().optional(),
  HF_TOKEN: z.string().optional(),
  GITHUB_MODELS_TOKEN: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().min(8).optional(),
  ANTHROPIC_API_KEY: z.string().min(8).optional(),
  OPENAI_MANAGED_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  ANTHROPIC_MANAGED_MODEL: z.string().min(1).default("claude-haiku-4-20250514"),
  MANAGED_PRICE_SNAPSHOTS_JSON: z.string().min(2).optional(),
  PRICE_STALE_MINUTES: z.coerce.number().int().positive().default(1_440),
  PLATFORM_SPEND_CAP_USD: optionalPositiveNumber,
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(8).optional(),
  PAYPAL_CLIENT_SECRET: z.string().min(8).optional(),
  PAYPAL_WEBHOOK_ID: z.string().min(3).optional(),
  PAYPAL_PLAN_BUILDER_MONTHLY: z.string().min(3).optional(),
  PAYPAL_PLAN_BUILDER_ANNUAL: z.string().min(3).optional(),
  PAYPAL_PLAN_PRO_MONTHLY: z.string().min(3).optional(),
  PAYPAL_PLAN_PRO_ANNUAL: z.string().min(3).optional(),
  TAVILY_API_KEY: z.string().optional(),
  AUTH_RESEND_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("HIVE <access@example.com>"),
  R2_ENDPOINT: optionalUrl,
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("hive-cloud"),
  R2_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  OWNER_EMAILS: z.string().default(""),
  SENTRY_DSN: optionalUrl,
  LIMIT_REQUESTS_5H: z.coerce.number().int().min(0).default(500),
  LIMIT_REQUESTS_WEEKLY: z.coerce.number().int().min(0).default(5000),
  LIMIT_TOKENS_INPUT_5H: z.coerce.number().int().min(0).default(1_000_000),
  LIMIT_TOKENS_OUTPUT_5H: z.coerce.number().int().min(0).default(500_000),
}).superRefine((value, context) => {
  if (value.NODE_ENV !== "production") return;
  const required = ["DATABASE_URL", "REDIS_URL", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  for (const key of required) if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production.` });
  if (value.INTERNAL_SERVICE_SECRET === DEVELOPMENT_INTERNAL_SECRET) context.addIssue({ code: "custom", path: ["INTERNAL_SERVICE_SECRET"], message: "Replace the development internal service secret." });
  if (value.HIVE_API_KEY_PEPPER === DEVELOPMENT_API_KEY_PEPPER) context.addIssue({ code: "custom", path: ["HIVE_API_KEY_PEPPER"], message: "Replace the development API-key pepper." });
  if (value.HIVE_ENCRYPTION_KEK_BASE64 === DEVELOPMENT_KEK) context.addIssue({ code: "custom", path: ["HIVE_ENCRYPTION_KEK_BASE64"], message: "Replace the development encryption KEK." });
  if (value.HIVE_BETA_BYPASS) context.addIssue({ code: "custom", path: ["HIVE_BETA_BYPASS"], message: "Beta bypass must be disabled in production." });
  if (value.HIVE_MOCK_PROVIDER) context.addIssue({ code: "custom", path: ["HIVE_MOCK_PROVIDER"], message: "The local mock provider must be disabled in production." });
  if (value.HIVE_LOCAL_PROVIDER_BRIDGE) context.addIssue({ code: "custom", path: ["HIVE_LOCAL_PROVIDER_BRIDGE"], message: "The local credential bridge must be disabled in production." });
  if (!value.TRUSTED_PROXY_CIDRS.trim()) context.addIssue({ code: "custom", path: ["TRUSTED_PROXY_CIDRS"], message: "Production must declare its trusted reverse-proxy CIDRs." });
  if (value.HIVE_DEPLOYMENT_MODE === "hosted") {
    const hostedRequired = [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "PAYPAL_PLAN_BUILDER_MONTHLY",
      "PAYPAL_PLAN_BUILDER_ANNUAL",
      "PAYPAL_PLAN_PRO_MONTHLY",
      "PAYPAL_PLAN_PRO_ANNUAL",
      "MANAGED_PRICE_SNAPSHOTS_JSON",
      "PLATFORM_SPEND_CAP_USD",
    ] as const;
    for (const key of hostedRequired) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in hosted production.` });
    }
    if (!value.OPENAI_API_KEY && !value.ANTHROPIC_API_KEY) {
      context.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "Hosted production requires at least one managed provider key." });
    }
  }
});

export type ApiEnv = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return envSchema.parse(source);
}
