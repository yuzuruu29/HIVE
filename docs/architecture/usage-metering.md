# Usage metering and report separation

Status: design only.

## Decision

Future billing metering uses append-only, idempotent server events. HIVE run reports are mutable user-facing engineering evidence and are never the sole invoice source.

## Usage event contract

Each event carries a stable event ID, schema version, account and optional organization ID, session ID, optional agent ID, provider/model where applicable, occurred-at timestamp, quantity, unit, provenance, idempotency key, event kind, and strictly redacted metadata. Kinds may cover agent execution, provider input/output tokens, runtime duration, sandbox duration, storage, artifact retention, repository automation, and concurrent-session occupancy.

Quantities use unit-specific validated integers or decimal strings; money uses ISO currency plus decimal strings. Floating-point values are not accepted for billing-grade money. Provider events retain the provider request/usage ID when available. Estimated usage is never silently promoted to measured usage.

## Ingestion

- Authenticate the emitting service; never accept authoritative browser/client quantities.
- Validate tenant/resource ownership and schema.
- Deduplicate on tenant plus idempotency key.
- Append accepted events; corrections are new compensating events.
- Redact/allowlist metadata and reject secrets or raw prompts.
- Reconcile provider records, job records, aggregates, and invoices.

## Reports versus ledger

Run reports optimize for engineering explanation and can be regenerated from session data. The billing ledger optimizes for immutable commercial accounting and is written by trusted hosted services. A report may display reconciled cost later, but report edits, deletion, or local fabrication cannot alter ledger facts.

## Unknowns and failures

Unavailable provider usage remains unavailable. Ingestion retries use stable idempotency keys. Quarantined invalid events alert operators and do not become zero. Late events follow a documented invoice-adjustment policy.
