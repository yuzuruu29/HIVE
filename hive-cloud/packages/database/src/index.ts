import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";

export type HiveDatabase = ReturnType<typeof createDatabase>["db"];

function databaseSsl(databaseUrl: string, sslMode?: string): false | { rejectUnauthorized: boolean } {
  const url = new URL(databaseUrl);
  const mode = sslMode || url.searchParams.get("sslmode") || undefined;
  if (mode === "disable") return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "postgres" || url.hostname.endsWith(".railway.internal")) {
    if (!mode) return false;
  }
  if (mode === "no-verify") {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

export function createDatabase(databaseUrl: string) {
  const poolSize = Number(process.env.DATABASE_POOL_SIZE || 10);
  const connectionTimeout = Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5000);
  const idleTimeout = Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000);
  const statementTimeout = process.env.DATABASE_STATEMENT_TIMEOUT_MS ? Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS) : undefined;
  const application_name = process.env.DATABASE_APPLICATION_NAME || "hive_cloud";
  const sslMode = process.env.DATABASE_SSL_MODE || undefined;

  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolSize,
    connectionTimeoutMillis: connectionTimeout,
    idleTimeoutMillis: idleTimeout,
    ...(statementTimeout !== undefined ? { statement_timeout: statementTimeout } : {}),
    application_name,
    ssl: databaseSsl(databaseUrl, sslMode),
  });
  // Absorb idle-client errors (e.g. admin-terminated connections) so they do
  // not surface as unhandled 'error' events that crash the process. Active
  // queries still reject; the pool reconnects on the next request.
  pool.on("error", (err: Error) => {
    if (process.env.NODE_ENV !== "test") {
      console.error(JSON.stringify({ level: "warn", event: "db.pool.error", error: err.message }));
    }
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function checkDatabase(databaseUrl: string): Promise<boolean> {
  const { pool } = createDatabase(databaseUrl);
  try {
    await pool.query("select 1");
    return true;
  } finally {
    await pool.end();
  }
}

export async function withTenant<T>(
  db: HiveDatabase,
  tenantId: string,
  operation: (tx: Parameters<Parameters<HiveDatabase["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return operation(tx);
  });
}

export async function withServiceRole<T>(
  db: HiveDatabase,
  operation: (tx: Parameters<Parameters<HiveDatabase["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_service', 'true', true)`);
    return operation(tx);
  });
}

export function diagnoseDatabase(databaseUrl: string): {
  provider: "supabase" | "local" | "other";
  connectionMode: "direct" | "session-pooler" | "transaction-pooler" | "unknown";
  tls: "enabled" | "disabled";
  poolSize: number;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    return {
      provider: "other",
      connectionMode: "unknown",
      tls: "disabled",
      poolSize: Number(process.env.DATABASE_POOL_SIZE || 10),
    };
  }

  const host = parsedUrl.hostname.toLowerCase();
  const port = parsedUrl.port;

  let provider: "supabase" | "local" | "other" = "other";
  if (host.includes(".supabase.co") || host.includes(".supabase.net") || host.includes("supabase")) {
    provider = "supabase";
  } else if (host === "localhost" || host === "127.0.0.1" || host === "postgres" || host.endsWith(".local") || host.endsWith(".internal")) {
    provider = "local";
  }

  let connectionMode: "direct" | "session-pooler" | "transaction-pooler" | "unknown" = "unknown";
  const configuredMode = process.env.DATABASE_CONNECTION_MODE;
  if (configuredMode === "direct" || configuredMode === "session-pooler" || configuredMode === "transaction-pooler") {
    connectionMode = configuredMode;
  } else {
    if (port === "5432") {
      if (host.includes("pooler.supabase.com")) {
        connectionMode = "session-pooler";
      } else {
        connectionMode = "direct";
      }
    } else if (port === "6543") {
      connectionMode = "transaction-pooler";
    }
  }

  const sslMode = process.env.DATABASE_SSL_MODE || parsedUrl.searchParams.get("sslmode") || undefined;
  const hasSsl = databaseSsl(databaseUrl, sslMode) !== false;
  const tls = hasSsl ? "enabled" : "disabled";

  return {
    provider,
    connectionMode,
    tls,
    poolSize: Number(process.env.DATABASE_POOL_SIZE || 10),
  };
}

export function validateProductionDatabaseConfig(databaseUrl: string, isMigration = false) {
  const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production" || process.env.APP_ENV === "staging";
  if (!isProduction) return;

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Production database configuration error: Invalid database URL format.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`Production database configuration error: Invalid protocol "${url.protocol}". Must use postgres: or postgresql:.`);
  }

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "postgres") {
    throw new Error(`Production database configuration error: Database URL cannot point to local host "${host}" in production.`);
  }

  const sslMode = process.env.DATABASE_SSL_MODE || url.searchParams.get("sslmode");
  if (sslMode === "disable") {
    throw new Error("Production database configuration error: sslmode=disable is forbidden for production remote connections.");
  }

  const password = url.password;
  if (!password || password === "hive" || password === "password" || password === "placeholder" || password.includes("change-me")) {
    throw new Error("Production database configuration error: Invalid database credentials (placeholder password detected).");
  }

  const poolSizeStr = process.env.DATABASE_POOL_SIZE;
  if (poolSizeStr) {
    const size = Number(poolSizeStr);
    if (isNaN(size) || size <= 0 || size > 100) {
      throw new Error(`Production database configuration error: Invalid pool size "${poolSizeStr}". Must be an integer between 1 and 100.`);
    }
  }

  if (isMigration && !process.env.DATABASE_MIGRATION_URL) {
    throw new Error("Production database configuration error: DATABASE_MIGRATION_URL is required for migrations in production.");
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value && (value.includes("service_role") || key.includes("SERVICE_ROLE"))) {
      throw new Error(`Security violation: service-role keys exposed in public browser variable "${key}".`);
    }
  }
}

export async function auditDatabasePermissions(databaseUrl: string): Promise<void> {
  const { pool } = createDatabase(databaseUrl);
  try {
    const result = await pool.query<{ rolname: string; tablename: string; has_privilege: boolean }>(`
      SELECT 
        r.rolname, 
        t.tablename, 
        has_table_privilege(r.rolname, quote_ident(t.schemaname) || '.' || quote_ident(t.tablename), 'select,insert,update,delete') as has_privilege
      FROM 
        pg_roles r 
        CROSS JOIN pg_tables t 
      WHERE 
        r.rolname IN ('anon', 'authenticated') 
        AND t.schemaname = 'public'
    `);
    
    const violations = result.rows.filter(row => row.has_privilege);
    if (violations.length > 0) {
      const details = violations.map(v => `${v.rolname} has access to ${v.tablename}`).join(", ");
      throw new Error(`Database permission audit failed: Public API roles have table privileges. Details: ${details}`);
    }
  } finally {
    await pool.end();
  }
}

