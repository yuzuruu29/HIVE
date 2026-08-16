import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimeEnvironmentKeys = [
  "NODE_ENV", "APP_ENV", "WEB_PORT", "API_PORT", "WORKER_PORT",
  "NEXT_PUBLIC_API_ORIGIN", "NEXT_PUBLIC_APP_ORIGIN", "API_INTERNAL_ORIGIN", "WEB_ORIGIN", "TRUSTED_PROXY_CIDRS",
  "INTERNAL_SERVICE_SECRET", "HIVE_API_KEY_PEPPER", "HIVE_ENCRYPTION_KEK_BASE64",
  "DATABASE_URL", "DATABASE_MIGRATION_URL", "DATABASE_POOL_SIZE",
  "DATABASE_CONNECTION_TIMEOUT_MS", "DATABASE_IDLE_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS",
  "DATABASE_CONNECTION_MODE", "DATABASE_APPLICATION_NAME", "DATABASE_SSL_MODE", "REDIS_URL",
  "AUTH_SECRET", "AUTH_URL", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "AUTH_RESEND_KEY", "MAILPIT_API_URL",
  "EMAIL_FROM", "OWNER_EMAILS", "LOCAL_OWNER_EMAIL", "HIVE_BETA_BYPASS", "HIVE_MOCK_PROVIDER", "HIVE_BASE_URL", "HIVE_API_KEY",
  "GROQ_API_KEY", "GROQ_DEFAULT_MODEL", "NVIDIA_API_KEY", "NVIDIA_DEFAULT_MODEL",
  "OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "GEMINI_API_KEY", "GEMINI_DEFAULT_MODEL", "TAVILY_API_KEY",
  "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_FORCE_PATH_STYLE", "CLAMAV_HOST", "CLAMAV_PORT", "BUILD_CONCURRENCY",
  "SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST",
] as const;

describe("environment example parity", () => {
  it("documents every environment key consumed by the web, API, worker, and shared database", () => {
    const documented = new Set(readFileSync(new URL("./.env.example", import.meta.url), "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0]));
    expect(runtimeEnvironmentKeys.filter((key) => !documented.has(key))).toEqual([]);
  });
});
