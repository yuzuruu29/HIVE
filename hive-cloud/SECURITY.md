# Security Policy

## Reporting a Vulnerability

Do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/yuzuruu29/hive-cloud/security/advisories/new) with:

- A description of the vulnerability
- Reproduction steps
- Affected versions
- Any known mitigations

The maintainer will acknowledge reports as capacity allows. Response-time guarantees are not offered during the hackathon beta.

## Supported Versions

| Version | Supported |
|---|---|
| Latest main branch | Supported |
| Older releases | Not supported |

## Security Design

- Platform provider keys remain server-only and are never exposed to browsers
- Tenant BYOK keys are encrypted at rest with AES-256-GCM
- PayPal webhooks are signature-verified before processing
- Credit operations are atomic and idempotent in hosted mode
- Prompts and secrets are excluded from intended operational log payloads

Security claims describe the implementation boundary, not a third-party certification.

## Dependency Audit Status

As of 2026-07-19, `npm audit --audit-level=moderate` reports six moderate transitive findings with no safe stable upgrade:

- Next.js 16.2.10 bundles PostCSS 8.4.31 (`GHSA-qx2v-qp2m-jg93`). HIVE processes repository-owned CSS during its trusted build; it does not accept user-authored CSS or invoke PostCSS in a hosted request path.
- Drizzle Kit 0.31.10 includes an older esbuild through its deprecated development loader (`GHSA-67mh-4wv8-2f99`). Drizzle Kit is a development/migration tool, and HIVE does not expose an esbuild development server.

Next.js 16.2.10 and Drizzle Kit 0.31.10 are the latest stable releases available at this review. npm's proposed forced remediation would install breaking older versions, so the project keeps the stable dependency graph and must re-check these advisories when either upstream publishes a compatible fix.
