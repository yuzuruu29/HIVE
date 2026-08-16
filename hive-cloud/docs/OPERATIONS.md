# HIVE Cloud operations

## Local acceptance environment

The local stack uses PostgreSQL, Redis, ClamAV, MinIO, and Mailpit. It does not
enable the beta bypass or contact a paid model provider.

```powershell
Copy-Item .env.example .env
docker compose up -d
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

The development seed prints a single-use invite path for `LOCAL_OWNER_EMAIL`.
Open the path, request the local passwordless sign-in link, and read it at
`http://localhost:8025`. MinIO's console is at `http://localhost:9001`.

Set `HIVE_MOCK_PROVIDER=true` only for local acceptance testing. It exposes a
development-only OpenAI-compatible provider inside the API process, so Chat and
the six-phase Council can be exercised without external credentials. Production
startup rejects this flag and `HIVE_BETA_BYPASS=true`.

Useful local checks:

```powershell
docker compose ps
docker compose exec postgres pg_isready -U hive -d hive_cloud
npm run preflight
npm run smoke:file
curl.exe http://localhost:4000/health/ready
curl.exe http://localhost:4001/health/ready
```

Start Docker Desktop and confirm PostgreSQL is healthy before starting the web
process. An Auth.js `AdapterError` from `getUserByEmail` with `ECONNREFUSED`
means the web process cannot reach PostgreSQL; it is not an invitation or
Mailpit failure. Restore the database with `docker compose up -d postgres`, wait
for `pg_isready`, and retry the sign-in request. The sign-in page intentionally
shows only a generic local-service error and does not expose database details.
Next.js incoming-request logging excludes Auth.js callback paths because email
callback query strings contain one-time credentials.

The file smoke test performs a real signed upload, quarantine scan, approved
object retrieval, and SHA-256 comparison. API readiness covers PostgreSQL and
Redis. Worker readiness additionally covers the build queue, API, object
storage, ClamAV, and file queue.

## Railway topology

Create one Railway project with production and staging environments. Add PostgreSQL and Redis, then create three GitHub-backed services from this repository:

| Service | Config file | Public | Port |
| --- | --- | --- | --- |
| Web | `apps/web/railway.toml` | yes | 3000 |
| API | `apps/api/railway.toml` | yes | 4000 |
| Worker | `apps/worker/railway.toml` | no | 4001 |
| ClamAV | official `clamav/clamav` image pinned to a reviewed digest | no | 3310 |

Set `API_INTERNAL_ORIGIN` on web and worker to the API service's Railway private-network URL. Set `WEB_ORIGIN` on the API to the web public URL. The external SDK base URL is the API public URL plus `/v1`.

## Required production variables

- Shared: `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SERVICE_SECRET`, `SENTRY_DSN`.
- API: `HIVE_API_KEY_PEPPER`, `HIVE_ENCRYPTION_KEK_BASE64`, `WEB_ORIGIN`, `TRUSTED_PROXY_CIDRS`, `OWNER_EMAILS`, provider pool keys, Tavily, R2, and Resend variables.
- Web: `AUTH_SECRET`, OAuth credentials, `AUTH_RESEND_KEY`, `API_INTERNAL_ORIGIN`, `NEXT_PUBLIC_APP_ORIGIN`, and optional analytics variables.
- Worker: `API_INTERNAL_ORIGIN`, `BUILD_CONCURRENCY`, the same R2 variables used by the API, `CLAMAV_HOST`, and `CLAMAV_PORT`.

Generate independent high-entropy values for the internal secret, API-key pepper, auth secret, and 32-byte base64 KEK. Never reuse provider credentials as application secrets.
Production startup rejects development secrets, beta bypass, or missing database, Redis, and R2 configuration. Point `CLAMAV_HOST` at the private ClamAV service and keep port 3310 off the public network.
Set `TRUSTED_PROXY_CIDRS` to the exact Railway proxy ranges that are permitted to supply forwarded client addresses; do not use a blanket trust value.

## Release sequence

1. Run `npm ci`, `npm run preflight`, and image builds in CI.
2. Apply additive migrations with `npm run db:migrate` before new application traffic.
3. Deploy API and worker, verify `/health/ready`, then deploy web.
4. Smoke-test waitlist, sign-in, BYOK connection, HIVE key generation, `/v1/models`, streamed chat, and Build cancellation.
5. Roll back by redeploying the preceding Railway commit. Do not roll back a destructive schema migration; the beta migration policy is additive only.

## Supabase Database Integration & Staging Setup

### Connection Choices
- **Direct Connection**: Connects directly to the PostgreSQL instance (default port `5432`). Recommended for all database migrations (Drizzle commands), backup/restore operations, and persistent backend components when direct IPv6/IPv4 network routes are reliable.
- **Session Pooler**: Pools connections at the session level (Supabase pooler port `5432`). Recommended for persistent services running on IPv4-only host networks (such as Railway services or worker instances).
- **Transaction Pooler**: Pools connections at the transaction level (Supabase pooler port `6543` with transaction routing). Not recommended as a default for HIVE's runtime context unless explicitly verified, as it requires disabling prepared statements and ensures that session-level variables are not utilized outside explicit transactions.

### Database Credentials

To configure Supabase in HIVE Cloud, you must provide the connection URLs in your environment:

1. **Staging / Production Environment**:
   - Navigate to your Supabase Project Settings -> Database.
   - Copy the direct connection string (port `5432`) for schema migrations.
   - Copy the session pooler connection string (pooler port `5432`) for application runtimes.
   - Set `DATABASE_URL` to the runtime connection string (session pooler).
   - Set `DATABASE_MIGRATION_URL` to the direct connection string.
   - (Optional) Set `DATABASE_CONNECTION_MODE` to explicitly force `direct`, `session-pooler`, or `transaction-pooler` (defaults to auto-detecting based on port and hostname).
4. **Apply Migrations**: Run `npm run db:migrate` from a migration-eligible execution environment (e.g. Railway release command or CI pipeline).
5. **Verify Schema & RLS**: Ensure all 16 tenant tables have Row-Level Security enabled and forced (`ALTER TABLE ... ENABLE FORCE ROW LEVEL SECURITY`), and that the default PostgREST roles (`anon` and `authenticated`) have had schema and table permissions revoked:
   ```sql
   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON SCHEMA public FROM anon, authenticated;
   ```
6. **Seed Invitation**: Run `npm run db:seed` to register a staging waitlist and invitation record.
7. **Start Services**: Deploy and start the API, web, and worker processes.
8. **Verify Logs**: Confirm startup diagnostics print:
   ```text
   database provider: supabase
   connection mode: [direct/session-pooler/transaction-pooler]
   TLS: enabled
   pool size: 10
   ```
9. **Configure Backups**: Enable nightly scheduled backups in the Supabase project configuration.
10. **Record Rollback Variables**: Document current deployment commits and connection credentials for quick cutback if required.

## Alerts

Alert on readiness failures, sustained API 5xx, provider 401/403, provider 429 spikes, fallback-rate increases, first-token latency regression, Redis queue depth, failed Build jobs, and managed-credit pool depletion. Logs must never include request bodies, cookies, authorization headers, provider credentials, or conversation text.
