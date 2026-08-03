# Commercial control-plane boundary

Status: design only; no hosted component is implemented.

## Decision

Keep the Community CLI/runtime as a standalone producer of redacted session facts. A future hosted control plane owns identity, organizations, entitlements, commercial APIs, immutable metering, billing integration, audit, notifications, and cloud execution. Local execution must remain functional when every hosted component is unavailable.

## Candidate components

Names are illustrative and do not authorize repository restructuring: `apps/web`, `apps/api`, and `apps/worker`; packages for auth, entitlements, metering, organizations, billing, audit, notifications, and cloud runtime.

## Trust zones

1. Local runtime: user-controlled machine, repository, providers, and reports; untrusted for plan or invoice claims.
2. Hosted API: authenticated, tenant-aware authorization and entitlement boundary; default deny.
3. Workers/cloud runtime: short-lived scoped jobs; no ambient organization credentials.
4. Accounting: append-only usage ledger and billing reconciliation; isolated from mutable run reports.
5. External systems: identity, GitHub, providers, and payment processor; webhook signatures and idempotency required.

## Data flow

An authenticated client requests a hosted feature. The API resolves membership and plan server-side, checks an immutable entitlement, creates an authorized job, and emits audit and usage events. Workers receive only scoped references. Results are redacted before tenant storage. Billing reads the accounting ledger, never a client-provided report.

## Failure behavior

Hosted commercial endpoints fail closed when identity, tenant, or entitlement state is unknown. Already authorized bounded jobs use explicit expiry/grace rules. Billing failure does not disable Community execution. Local reports remain available offline.

## Deferred decisions

Cloud provider, database, queue, deployment model, repository split, retention defaults, and the first hosted paid feature require pilot evidence and separate ADRs.
