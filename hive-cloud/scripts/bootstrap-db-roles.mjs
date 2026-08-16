/**
 * Bootstrap least-privilege PostgreSQL roles for the HIVE Cloud application.
 *
 * Usage (superuser):
 *   node --env-file=.env scripts/bootstrap-db-roles.mjs
 *
 * Creates:
 *   1. migration_role  — owns schema objects, used only during controlled migration
 *   2. app_role        — runtime application connection (NOSUPERUSER, NOBYPASSRLS)
 *   3. service_role    — same as app_role, but intended for app.is_service context
 *
 * Requirements:
 *   - DATABASE_URL must point to a PostgreSQL 15+ cluster reachable by the
 *     admin user
 *   - HIVE_DATABASE_NAME — target database (defaults to hive_cloud)
 *   - HIVE_APP_PASSWORD, HIVE_SERVICE_PASSWORD, HIVE_MIGRATION_PASSWORD —
 *     optional; generated as random UUIDs if omitted
 *
 * Outputs:
 *   Prints the generated passwords to stdout (capture for deployment secrets).
 *   Can be rerun; refuses unsafe role names.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const DATABASE_NAME = process.env.HIVE_DATABASE_NAME || "hive_cloud";
const APP_ROLE = "hive_app";
const SERVICE_ROLE = "hive_app_service";
const MIGRATION_ROLE = "hive_migration";

const SAFE_NAME_RE = /^[a-z][a-z0-9_]+$/;

for (const name of [APP_ROLE, SERVICE_ROLE, MIGRATION_ROLE]) {
  if (!SAFE_NAME_RE.test(name)) {
    console.error(`Unsafe role name: ${name}`);
    process.exit(1);
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const appPass = process.env.HIVE_APP_PASSWORD || randomUUID().replace(/-/g, "");
    const svcPass = process.env.HIVE_SERVICE_PASSWORD || randomUUID().replace(/-/g, "");
    const migPass = process.env.HIVE_MIGRATION_PASSWORD || randomUUID().replace(/-/g, "");

    // Create roles idempotently (PostgreSQL 9.5+)
    for (const [role, password] of [
      [MIGRATION_ROLE, migPass],
      [APP_ROLE, appPass],
      [SERVICE_ROLE, svcPass],
    ] as const) {
      await pool.query(
        `CREATE ROLE "${role}" WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
      ).catch((err) => {
        // 42710 = duplicate_object
        if (err.code !== "42710") throw err;
      });
    }

    // Grant CONNECT on the target database
    for (const role of [APP_ROLE, SERVICE_ROLE, MIGRATION_ROLE]) {
      await pool.query(`GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO "${role}"`);
    }

    // Grant schema-level privileges via the migration role (run after migrations)
    console.log(`Role "${APP_ROLE}" password: ${appPass}`);
    console.log(`Role "${SERVICE_ROLE}" password: ${svcPass}`);
    console.log(`Role "${MIGRATION_ROLE}" password: ${migPass}`);
    console.log("\nStore these passwords securely. They will not be shown again.");
    console.log("\nAfter running migrations, connect as migration role and run:");
    console.log(`  psql -d ${DATABASE_NAME} -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \\"${APP_ROLE}\\""`);
    console.log(`  psql -d ${DATABASE_NAME} -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \\"${SERVICE_ROLE}\\""`);
    console.log(`  psql -d ${DATABASE_NAME} -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \\"${APP_ROLE}\\""`);
    console.log(`  psql -d ${DATABASE_NAME} -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \\"${SERVICE_ROLE}\\""`);
    console.log(`  psql -d ${DATABASE_NAME} -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO \\"${APP_ROLE}\\""`);
    console.log(`  psql -d ${DATABASE_NAME} -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO \\"${SERVICE_ROLE}\\""`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
