import { randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface TestDatabase {
  /** Admin/superuser connection URL (used for migration and cleanup). */
  dbUrl: string;
  /**
   * Non-superuser tenant role connection URL. The connected role has
   * NOSUPERUSER, NOBYPASSRLS, and all table privileges — RLS handles
   * tenant isolation.
   */
  tenantUrl: string;
  /**
   * Non-superuser service role connection URL. Same privileges as the
   * tenant role, but intended for use with set_config('app.is_service', 'true')
   * to exercise the service-bypass path in RLS policies.
   */
  serviceUrl: string;
  /**
   * Close the admin pool, drop the temporary roles and database.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  dispose: () => Promise<void>;
}

const packageDir = fileURLToPath(new URL(".", import.meta.url));

const SAFE_NAME_RE = /^[a-z][a-z0-9_-]+$/;

/**
 * Create a temporary isolated PostgreSQL database with non-superuser
 * application roles, apply all pending migrations, and return the
 * connection URLs plus a dispose function.
 *
 * Two application roles are created:
 * - A **tenant** role that must respect RLS (no BYPASSRLS).
 * - A **service** role that also must respect RLS, but which the
 *   application uses with `set_config('app.is_service', 'true')` to
 *   exercise the service-bypass path in tenant_isolation policies.
 *
 * Both roles are granted ALL PRIVILEGES on all tables and sequences
 * in the public schema. RLS policies (not PostgreSQL role attributes)
 * enforce tenant and service boundaries.
 *
 * @param baseUrl – Superuser connection URL to a running PostgreSQL
 *   instance. A throwaway child database is created in the same cluster.
 * @param label – Optional short label embedded in database and role
 *   names (defaults to "hct"). Must match ^[a-z][a-z0-9_-]+$.
 */
export async function createTestDatabase(
  baseUrl: string,
  label = "hct",
): Promise<TestDatabase> {
  if (!SAFE_NAME_RE.test(label)) {
    throw new Error(
      `Invalid test-database label "${label}". Must match ${SAFE_NAME_RE.source}`,
    );
  }

  const suffix = randomBytes(4).toString("hex");
  const safeSuffix = `${process.pid}_${suffix}`;
  const dbName = `hive_cloud_test_${label}_${safeSuffix}`.toLowerCase();
  const roleSuffix = `${label}_${safeSuffix}`.toLowerCase();
  const tenantRole = `hive_app_t_${roleSuffix}`;
  const serviceRole = `hive_app_s_${roleSuffix}`;
  const tenantPass = randomUUID().replace(/-/g, "");
  const servicePass = randomUUID().replace(/-/g, "");

  const admin = new Pool({ connectionString: baseUrl });
  let disposed = false;

  try {
    // Drop any stale database or roles from a previous aborted run.
    for (const role of [tenantRole, serviceRole]) {
      await admin.query(`DROP OWNED BY "${role}" CASCADE`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);

    // Create the temporary database.
    await admin.query(`CREATE DATABASE "${dbName}"`);

    // Create the application roles.
    await admin.query(
      `CREATE ROLE "${tenantRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${tenantPass}'`,
    );
    await admin.query(
      `CREATE ROLE "${serviceRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${servicePass}'`,
    );

    // Construct the admin and application connection URLs.
    const parsed = new URL(baseUrl);
    parsed.pathname = `/${dbName}`;
    const dbUrl = parsed.toString();

    // Build role-specific URLs by replacing credentials and database path.
    const baseParsed = new URL(baseUrl);
    const makeRoleUrl = (role: string, pass: string): string => {
      const u = new URL(baseParsed.href);
      u.username = role;
      u.password = pass;
      u.pathname = `/${dbName}`;
      return u.toString();
    };
    const tenantUrl = makeRoleUrl(tenantRole, tenantPass);
    const serviceUrl = makeRoleUrl(serviceRole, servicePass);

    // Apply all pending migrations using the superuser connection.
    execSync("npm run db:migrate", {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "ignore",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });

    // Grant privileges on the temporary database to the application roles.
    await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${tenantRole}"`);
    await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${serviceRole}"`);

    // Switch to the temp database for schema-level grants.
    // We need another pool connected to the temp DB because GRANT ON ALL TABLES
    // in the current database requires being connected to it.
    const tempAdmin = new Pool({ connectionString: dbUrl });
    try {
      await tempAdmin.query(`GRANT USAGE ON SCHEMA public TO "${tenantRole}"`);
      await tempAdmin.query(`GRANT USAGE ON SCHEMA public TO "${serviceRole}"`);
      await tempAdmin.query(
        `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${tenantRole}"`,
      );
      await tempAdmin.query(
        `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${serviceRole}"`,
      );
      await tempAdmin.query(
        `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${tenantRole}"`,
      );
      await tempAdmin.query(
        `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${serviceRole}"`,
      );
      await tempAdmin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO "${tenantRole}"`,
      );
      await tempAdmin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO "${serviceRole}"`,
      );
    } finally {
      await tempAdmin.end();
    }

    const dispose = async () => {
      if (disposed) return;
      disposed = true;

      // Terminate lingering connections so the database can be dropped.
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
      } catch {
        // Best-effort.
      }

      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        // Drop application roles.
        for (const role of [tenantRole, serviceRole]) {
          try {
            await admin.query(`DROP OWNED BY "${role}" CASCADE`);
          } catch {
            // Role may have no owned objects.
          }
          try {
            await admin.query(`DROP ROLE IF EXISTS "${role}"`);
          } catch {
            // Best-effort.
          }
        }
        await admin.end();
      }
    };

    return { dbUrl, tenantUrl, serviceUrl, dispose };
  } catch (error) {
    await admin.end().catch(() => {});
    throw error;
  }
}
