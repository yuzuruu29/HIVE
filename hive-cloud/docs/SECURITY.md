# HIVE Cloud security model

- Browser sessions use Auth.js secure HttpOnly cookies and same-origin BFF requests. The BFF signs a short-lived subject envelope for the private API hop.
- Public API keys contain 256 random bits, use the `hive_live_` prefix, and are stored only as HMAC-SHA-256 digests with a server-held pepper.
- Provider credentials use per-record AES-256-GCM data keys. Each data key is wrapped by a versioned 256-bit KEK and bound to tenant/provider AAD.
- Custom provider URLs require public HTTPS. DNS is resolved for every routed request; private, loopback, link-local, metadata, documentation, and reserved networks are blocked. Redirects are rejected.
- Tenant-owned database tables use both application query guards and PostgreSQL forced row-level security.
- Uploaded objects use tenant-scoped quarantine keys and five-minute signed URLs. Production must not process an object until ClamAV and MIME validation mark it approved.
- Search and uploaded content are untrusted context. Council prompts explicitly delimit data and ignore instructions inside sources.
- HIVE Cloud never executes uploaded repositories. Build artifacts use `execution_status: not_run` unless a future separately approved execution product exists.
- Conversation deletion schedules a 30-day purge. Operational logs and analytics exclude prompts and message contents.

## Dependency review

The release dependency review includes `npm audit`. At implementation time, the current stable Next.js release (`16.2.10`) embeds PostCSS `8.4.31`, which is covered by moderate advisory `GHSA-qx2v-qp2m-jg93`. The root override is pinned to PostCSS `8.5.10`, but Next.js keeps its nested build-time copy. npm only proposes a breaking forced downgrade, so that unsafe automated fix is not applied. Track the next stable Next.js release and upgrade as soon as it carries the patched nested dependency. The application does not accept user-authored CSS or expose PostCSS as a runtime content service. The remaining moderate findings are development-only `drizzle-kit`/`esbuild` tooling and are excluded from production installs.

### sharp <0.35.0 (High, GHSA-f88m-g3jw-g9cj)

Next.js 16.2.10 depends on `sharp@0.34.x` which is affected by four inherited libvips CVE advisories: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, and CVE-2026-35591. The fix is `sharp@0.35.3`, first carried in a Next.js `16.3.0` canary; no stable Next.js release includes it as of July 22, 2026.

- The finding predates PR #2. The PR does not increase the vulnerable surface.
- Directly forcing `sharp@0.35.x` via npm overrides was rejected because the major-version bump could conflict with Next.js expectations.
- HIVE Cloud uses `next/image` only for a single bundled hero asset (`/images/hive-queen-network.webp`). No user uploads, arbitrary remote images, or attacker-controlled URLs reach the Next.js image optimizer.
- A tracked issue will upgrade Next.js or the sharp override when an officially compatible stable release is available.

### Dependency watch

| Dependency | Current | Target | Trigger |
|-----------|---------|--------|---------|
| Next.js | 16.2.10 | Next stable carrying `sharp@0.35.x` | First `16.3.x` or `16.x` stable release with sharp bump |
| PostCSS | 8.5.10 (override) | Remove override | When Next.js ships a patched bundled PostCSS |
| sharp | 0.34.5 (transitive) | 0.35.3+ | Next.js stable release or separate override testing |

Report suspected issues privately to the repository owner. Do not open a public issue containing secrets or user data.
