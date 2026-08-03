# Billing boundary

Status: design only; no payment SDK, checkout, webhook, or credential is included.

## Decision

A future billing package adapts a payment provider behind a hosted service interface. The Community runtime has no billing dependency. Subscription records are commercial state, not authorization by themselves; the hosted entitlement service converts reconciled server state into access decisions.

## Integration surfaces

- Checkout: server creates price/tenant-bound sessions; the client cannot choose arbitrary price metadata.
- Portal: short-lived server-created links after tenant-admin authorization.
- Webhooks: verify signature on raw body, enforce timestamp tolerance, persist provider event ID, process idempotently, and tolerate reordering.
- Trials/founding plans: immutable internal plan IDs mapped to provider price versions.
- Seat and usage charges: reconcile active memberships and trusted ledger aggregates at defined cutoffs.
- Failed payments/grace: explicit state machine and expiry; no indefinite cached access.
- Cancellation/downgrade: period-end and immediate paths are distinct, audited, and reversible where provider semantics allow.
- Reconciliation: scheduled comparison of provider subscriptions/invoices, internal subscription state, entitlements, and ledger totals.

## State and idempotency

Persist provider customer, subscription, price, invoice, and event identifiers with tenant uniqueness constraints. Every mutating provider request uses a stable idempotency key derived from an internal operation. Webhook handlers append receipt and transition records; duplicate or stale events do not repeat side effects.

## Security and cost integrity

Only server-held credentials call billing APIs. Never trust client plan, seat count, discount, or usage. Administrative adjustments require actor, reason, before/after state, and reconciliation. Decimal currency is stored as minor-unit integers or validated decimal strings according to provider rules—never binary floating point.

## Deferred

Payment provider, prices, taxes, invoicing entity, currencies, refund policy, dunning schedule, founding-plan terms, and usage-rating model require owner, finance, and legal approval.
