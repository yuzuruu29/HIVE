import { Socket } from "node:net";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { createDatabase, validateProductionDatabaseConfig, diagnoseDatabase } from "@hive-cloud/database";
import { createCouncilProcessor } from "./council.js";
import { createFileProcessor } from "./files.js";
import { createTitlesProcessor } from "./titles.js";
import { createMaintenanceProcessor } from "./maintenance.js";

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WORKER_PORT: z.coerce.number().int().positive().default(4001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_INTERNAL_ORIGIN: z.string().url().default("http://localhost:4000"),
  INTERNAL_SERVICE_SECRET: z.string().min(32),
  BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  SENTRY_DSN: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  R2_ENDPOINT: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).default("hive-cloud"),
  R2_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CLAMAV_HOST: z.string().min(1).default("localhost"),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
}).superRefine((value, context) => {
  if (value.NODE_ENV !== "production") return;
  for (const key of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const) {
    if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production.` });
  }
});

const env = workerEnvSchema.parse(process.env);

if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0.05, sendDefaultPii: false });

function bullConnection(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: null,
  };
}

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times: number) => Math.min(times * 200, 5000),
});
connection.on("error", (err: Error) => {
  if (env.NODE_ENV !== "test") {
    console.error(JSON.stringify({ level: "warn", event: "redis.error", error: err.message }));
  }
});

validateProductionDatabaseConfig(env.DATABASE_URL);
const diag = diagnoseDatabase(env.DATABASE_URL);
console.log(`database provider: ${diag.provider}\nconnection mode: ${diag.connectionMode}\nTLS: ${diag.tls}\npool size: ${diag.poolSize}`);

const database = createDatabase(env.DATABASE_URL);
const controlQueue = new Queue("hive-builds", { connection: bullConnection(env.REDIS_URL) });
const maintenanceQueue = new Queue("hive-maintenance", { connection: bullConnection(env.REDIS_URL) });
const worker = new Worker("hive-builds", createCouncilProcessor(env.API_INTERNAL_ORIGIN, env.INTERNAL_SERVICE_SECRET, controlQueue), {
  connection: bullConnection(env.REDIS_URL),
  concurrency: env.BUILD_CONCURRENCY,
  limiter: { max: 10, duration: 60_000 },
});
const titlesWorker = new Worker("hive-titles", createTitlesProcessor(env.API_INTERNAL_ORIGIN, env.INTERNAL_SERVICE_SECRET), {
  connection: bullConnection(env.REDIS_URL),
  concurrency: 2,
});
const fileWorker = env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
  ? new Worker("hive-files", createFileProcessor({ endpoint: env.R2_ENDPOINT, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET, forcePathStyle: env.R2_FORCE_PATH_STYLE, clamHost: env.CLAMAV_HOST, clamPort: env.CLAMAV_PORT, apiOrigin: env.API_INTERNAL_ORIGIN, serviceSecret: env.INTERNAL_SERVICE_SECRET }), { connection: bullConnection(env.REDIS_URL), concurrency: 2 })
  : undefined;
const storage = env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
  ? new S3Client({ region: "auto", endpoint: env.R2_ENDPOINT, forcePathStyle: env.R2_FORCE_PATH_STYLE, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } })
  : undefined;

const maintenanceWorker = new Worker("hive-maintenance", createMaintenanceProcessor(database), {
  connection: bullConnection(env.REDIS_URL),
  concurrency: 1,
});

function clamAvReady(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(2_000);
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("PONG")) finish(true);
    });
    socket.once("close", () => finish(false));
    socket.connect(port, host, () => socket.write("zPING\0"));
  });
}

async function readinessChecks() {
  const [databaseReady, redisReady, queueReady, apiReady, storageReady, clamReady] = await Promise.all([
    database.pool.query("select 1").then(() => true).catch(() => false),
    connection.ping().then((reply) => reply === "PONG").catch(() => false),
    controlQueue.getJobCounts("waiting", "active", "failed").then(() => worker.isRunning()).catch(() => false),
    fetch(`${env.API_INTERNAL_ORIGIN.replace(/\/$/, "")}/health/ready`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.ok).catch(() => false),
    storage ? storage.send(new HeadBucketCommand({ Bucket: env.R2_BUCKET })).then(() => true).catch(() => false) : Promise.resolve(true),
    fileWorker ? clamAvReady(env.CLAMAV_HOST, env.CLAMAV_PORT) : Promise.resolve(true),
  ]);
  const fileQueueReady = fileWorker ? fileWorker.isRunning() : true;
  return {
    ready: databaseReady && redisReady && queueReady && apiReady && storageReady && clamReady && fileQueueReady,
    checks: {
      database: databaseReady,
      redis: redisReady,
      build_queue: queueReady,
      api: apiReady,
      object_storage: storageReady,
      clamav: clamReady,
      file_queue: fileQueueReady,
    },
  };
}

worker.on("failed", (job, error) => {
  if (env.SENTRY_DSN) Sentry.captureException(error, { extra: { job_id: job?.id } });
  console.error(JSON.stringify({ level: "error", event: "build.failed", job_id: job?.id, error: error.message }));
});
titlesWorker.on("failed", (job, error) => {
  if (env.SENTRY_DSN) Sentry.captureException(error, { extra: { job_id: job?.id, queue: "hive-titles" } });
  console.error(JSON.stringify({ level: "error", event: "title.failed", job_id: job?.id, error: error.message }));
});
fileWorker?.on("failed", (job, error) => {
  if (env.SENTRY_DSN) Sentry.captureException(error, { extra: { job_id: job?.id, queue: "hive-files" } });
  console.error(JSON.stringify({ level: "error", event: "file.failed", job_id: job?.id, error: error.message }));
});
maintenanceWorker.on("failed", (job, error) => {
  if (env.SENTRY_DSN) Sentry.captureException(error, { extra: { job_id: job?.id, queue: "hive-maintenance" } });
  console.error(JSON.stringify({ level: "error", event: "maintenance.failed", job_id: job?.id, error: error.message }));
});

const health = Fastify({ logger: env.NODE_ENV !== "test" });
health.get("/health/live", async () => ({ status: "ok", service: "worker" }));
health.get("/health/ready", async (_request, reply) => {
  const result = await readinessChecks();
  return reply.code(result.ready ? 200 : 503).send({ status: result.ready ? "ok" : "degraded", checks: result.checks });
});

maintenanceQueue.add("maintenance", {}, { repeat: { pattern: "0 * * * *" } }).catch((error) => console.error("Failed to add maintenance job:", error));

const shutdown = async () => {
  await health.close();
  await worker.close();
  await titlesWorker.close();
  await fileWorker?.close();
  await maintenanceWorker.close();
  await controlQueue.close();
  await maintenanceQueue.close();
  await connection.quit();
  await database.pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await health.listen({ host: "0.0.0.0", port: Number(process.env.PORT || env.WORKER_PORT) });
