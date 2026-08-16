import { z } from "zod";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { HiveDatabase } from "@hive-cloud/database";
import { apiError } from "@hive-cloud/contracts";
import { authenticateRequest } from "./auth.js";
import { UsageControl } from "./usage-control.js";
import type { ApiEnv } from "./env.js";
import type { CloudStore } from "./store.js";

interface AdminUsageOptions {
  env: ApiEnv;
  store: CloudStore;
}

interface AdminAuthContext {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

const overrideSchema = z.object({
  metric: z.enum(["requests_5h", "requests_weekly"]),
  max_override: z.number().int().min(0).nullable(),
});

async function requireAdmin(
  request: { id: string; headers: Record<string, string | string[] | undefined> },
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  env: ApiEnv,
  store: CloudStore,
): Promise<AdminAuthContext | undefined> {
  const auth = await authenticateRequest(request as Parameters<typeof authenticateRequest>[0], env, store);
  if (!auth) {
    reply.code(401).send(apiError("invalid_api_key", "Authentication is required.", request.id));
    return undefined;
  }
  if (!auth.internal) {
    reply.code(403).send(apiError("forbidden", "Admin access is required.", request.id));
    return undefined;
  }
  return { userId: auth.userId, tenantId: auth.tenantId, role: auth.role, email: auth.email };
}

export function registerAdminUsageRoutes(
  app: FastifyInstance,
  options: AdminUsageOptions,
): void {
  const { env, store } = options;

  const pool = env.DATABASE_URL ? new Pool({ connectionString: env.DATABASE_URL, max: 5 }) : undefined;
  const db: HiveDatabase | undefined = pool ? drizzle(pool) : undefined;
  const uc = db ? new UsageControl(db, UsageControl.policyFromEnv(env as unknown as Record<string, string | undefined>)) : undefined;

  app.addHook("onClose", async () => {
    if (pool) await pool.end();
  });

  app.get("/api/admin/usage", async (request, reply) => {
    const auth = await requireAdmin(request, reply, env, store);
    if (!auth) return;
    if (!uc) return reply.code(503).send(apiError("service_unavailable", "Usage tracking is not configured.", request.id));

    const dims = { tenantId: auth.tenantId };
    const checks = await uc.check(dims);

    const windows = checks.map((c) => ({
      metric: c.metric,
      label: c.label,
      used: c.used,
      limit: c.limit,
      remaining: c.remaining,
      resetsAt: c.resetsAt,
    }));

    return { data: { tenantId: auth.tenantId, windows } };
  });

  app.get("/api/admin/usage/overrides", async (request, reply) => {
    const auth = await requireAdmin(request, reply, env, store);
    if (!auth) return;
    if (!db) return reply.code(503).send(apiError("service_unavailable", "Usage tracking is not configured.", request.id));

    const rows = await db.execute(sql`
      SELECT metric, max_override, created_at, updated_at
      FROM usage_overrides
      WHERE tenant_id = ${auth.tenantId}
      ORDER BY metric
    `);

    return {
      data: rows.rows.map((r: Record<string, unknown>) => ({
        tenantId: auth.tenantId,
        metric: r.metric,
        maxOverride: r.max_override,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.put("/api/admin/usage/overrides", async (request, reply) => {
    const auth = await requireAdmin(request, reply, env, store);
    if (!auth) return;
    if (!db) return reply.code(503).send(apiError("service_unavailable", "Usage tracking is not configured.", request.id));

    const body = overrideSchema.parse(request.body);

    await db.execute(sql`
      INSERT INTO usage_overrides (tenant_id, metric, max_override)
      VALUES (${auth.tenantId}, ${body.metric}, ${body.max_override})
      ON CONFLICT (tenant_id, metric)
      DO UPDATE SET max_override = ${body.max_override}, updated_at = now()
    `);

    return {
      data: { tenantId: auth.tenantId, metric: body.metric, maxOverride: body.max_override },
    };
  });

  app.delete("/api/admin/usage/overrides/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply, env, store);
    if (!auth) return;
    if (!db) return reply.code(503).send(apiError("service_unavailable", "Usage tracking is not configured.", request.id));

    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    const result = await db.execute(sql`
      DELETE FROM usage_overrides
      WHERE tenant_id = ${auth.tenantId} AND metric = ${id}
    `);

    if ((result.rowCount ?? 0) === 0) {
      return reply.code(404).send(apiError("not_found", "Override not found.", request.id));
    }

    return reply.code(204).send();
  });
}
