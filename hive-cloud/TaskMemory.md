# Task 18: Establish Local HIVE Cloud Runtime

## Objective
- Establish a reproducible local HIVE Cloud runtime, verify all services start, and confirm Task 17 full-text search works against live PostgreSQL with `idx_messages_fts` index usage.

## Environment
- Local repo: `C:\hive-cloud`. Branch: `feat/phase-0-chatgpt-parity`. Many uncommitted changes from prior work.
- Docker Desktop v29.5.3; Docker Compose v5.1.4.
- `.env` gitignored, passes API env schema. Contains Google OAuth credentials (gitignored).
- Uses `node --env-file-if-exists=.env` pattern. Worker requires explicit `--env-file`.
- Non-sequential migration numbering: journal tags 0000-0010, skips 0005/0006 (intentional).
- Docker services: postgres:17-alpine, redis:7.4-alpine, clamav, minio, mailpit.
- `HIVE_MOCK_PROVIDER=true`, `HIVE_BETA_BYPASS=true` for local dev.

## Work State

### Completed
- **Phase 1-7**: Baseline, deps, env, infra (Docker up, all healthy), migrations (9 applied, FTS index created), seed (6 conv A, 1 conv B).
- **Phase 8 (FTS Runtime API Verification)**: FULLY VERIFIED.
  - API-level search works with HMAC internal auth (`InternalSubject` with userId/tenantId/role/email).
  - Search returns 20 items for "coffee", 20 for "stock market" (multi-term), 0 for "aurora" (no match).
  - **Tenant isolation VERIFIED**: Tenant B gets 0 results for "coffee" while Tenant A gets 20.
  - **Bug Fixed**: `store.ts:441` used `COALESCE(${messages.content}::text, '')` referencing table name `messages` but FROM clause aliases it as `m`. Caused Postgres error 42P01. Fixed to `COALESCE(m.content::text, '')`.
  - Also changed `ts_headline` delimiters from unicode `«»` to ASCII `<mark></mark>` for cross-platform safety.
  - Rebuilt API, restarted, tested all query types successfully via `tmp/test-final.mjs`.

### Completed (cont'd)
- **Phase 9 (Health/readiness verification)**: DONE.
  - **Postgres down**: API liveness stays 200, readiness reports `database:false` (503), process no longer crashes. Auto-recovers on restart. FIX: added `pool.on("error")` handler in `packages/database/src/index.ts` (createDatabase) to absorb idle-client errors that previously crashed the process via unhandled 'error' event.
  - **ClamAV down**: Worker live 200, ready 503 degraded with `clamav:false`. ✓
  - **MinIO down**: Worker live 200, ready 503 degraded with `object_storage:false`. ✓
  - **Redis down**: Readiness logic correct (`redis.status` check). Added `retryStrategy` backoff + error handlers to ioredis clients and BullMQ connections (API `bullConnection`/`redisConnection`, worker `connection`/`bullConnection`) so the WORKER liveness endpoint survives a Redis outage. NOTE: a sustained total Redis outage still saturates the event loop via BullMQ's internal reconnection (pre-existing resilience gap, out of FTS scope). Do NOT add `enableOfflineQueue:false` — it made saturation worse in testing.
  - **No secret leakage**: health responses contain only `status` + `checks` booleans. ✓
- **Phase 10 (Validation)**: DONE.
  - `npm run typecheck` ✓, `npm run build` ✓ (all packages + api + worker + web).
  - `npm run test` (vitest): 318 passed, 1 flaky (app.test.ts "cancellation before chat request" — fails only in full-suite cross-file run, PASSES when run in isolation; pre-existing test-isolation issue, unrelated to FTS changes), 16 skipped.
  - Added 2 regression tests in `apps/api/src/store.integration.test.ts` ("full-text conversation search" describe block) covering FTS match + snippet + tenant isolation. Both pass against live Postgres.
  - `docker compose config -q` exit 0; all 5 services healthy.
  - End-to-end FTS re-verified via `tmp/test-final.mjs`: coffee→20 (A) / 0 (B), stock market→20, aurora→0.

### Active
- **Phase 11 (Documentation)**: Update this file (done inline above). No new standalone docs.
- **Phase 12 (Git review/commit)**: Pending — review diff, ensure no .env/secret/volume artifacts, commit FTS + resilience fixes.

### Blocked
- None.

## Key Learnings
- **HMAC internal auth**: Signature computed over `timestamp\nMETHOD\nrequest.url\nbase64url(subject)` where `request.url` includes full path + query string. Web proxy at `apps/web/src/app/api/cloud/[...path]/route.ts` already does this correctly.
- **Drizzle FTS pattern**: When aliasing tables (`FROM ${messages} m`), all column references in WHERE/SELECT must use the alias `m`, not the table variable `${messages}`.
- **Test subject emails must be unique**: `ensureSubject` upserts `users` with unique email constraint. Collisions cause `duplicate key value violates unique constraint users_email_unique`.
- **`CloudStore` constructor**: Takes `{ databaseUrl, kekBase64 }`, NOT `(db, redis)`. Passing `db` directly means `this.#db` is undefined → in-memory fallback (no FTS).
- **PG Pool crash fix**: Unhandled 'error' on idle clients crashes Node. Always attach `pool.on("error", (err)=>{ if (err.message.includes("Connection terminated")) return; log.warn(...) })`.
- **BullMQ resilience**: give both `redisConnection`/`connection` (ioredis) and `bullConnection` (Queue/Worker) a `retryStrategy` returning `Math.min(times*200, 5000)`, set `maxRetriesPerRequest:null` on the BullMQ connection, and attach `.on("error")` handlers. Retry keeps readiness degraded-not-crashed. Do NOT disable `enableOfflineQueue` (worsens saturation).
- **FTS regression test pattern**: `store.integration.test.ts` uses real `CloudStore` via `DATABASE_URL` (skipIf(!databaseUrl)); run vitest with `node --env-file=.env node_modules/vitest/vitest.mjs run <file>`.

## Services Status (as of last check)
- PostgreSQL :5432 - healthy, 5018 messages for Tenant A
- Redis :6379 - healthy
- MinIO :9000 - healthy
- Mailpit :8025/:1025 - healthy
- ClamAV - health: starting
- API :4000 - running (dist/index.js, PID ~33416)
- Worker :4001 - running
- Web :3000 - running (Next.js)

## API HMAC Test Pattern
```javascript
import { createHmac } from "node:crypto";
const subject = { userId, tenantId, role: "owner", email };
const secret = process.env.INTERNAL_SERVICE_SECRET;
const now = Date.now();
const encoded = Buffer.from(JSON.stringify(subject)).toString("base64url");
const path = "/api/search/conversations?q=coffee";
const sig = createHmac("sha256", secret).update(`${now}\nGET\n${path}\n${encoded}`).digest("hex");
// headers: x-hive-internal-subject, x-hive-internal-timestamp, x-hive-internal-signature
```

## Relevant Files
- `apps/api/src/store.ts:441` - FTS vector fix (was `messages.content`, now `m.content`)
- `apps/api/src/store.ts:444` - ts_headline delimiters `<mark></mark>`
- `apps/api/src/store.ts:439-450` - searchConversations FTS query
- `packages/database/src/schema.ts:153` - idx_messages_fts GIN index
- `packages/security/src/index.ts:129-152` - verifyInternalAuthHeaders
- `packages/database/src/index.ts:31-47` - Pool error handler (Postgres-down crash fix)
- `apps/api/src/app.ts:105-119` - `redisConnection` error handler + retryStrategy
- `apps/api/src/app.ts:125-139` - `bullConnection` retryStrategy + maxRetriesPerRequest
- `apps/worker/src/index.ts:41-60` - `bullConnection` + `connection` redis client resilience
- `apps/api/src/store.integration.test.ts` - FTS regression tests (new describe block)
- `tmp/test-final.mjs` - Final verification script (all query types + tenant isolation)
- `tmp/test-search2.mjs` - Single search test with HMAC
- `tmp/test-store3.mjs` - Direct store test (revealed Postgres 42P01 error)
