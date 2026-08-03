# Entitlement enforcement

Status: design only.

## Decision

The future hosted API is authoritative. Clients send an access token and requested operation, never a trusted plan. The API resolves account, organization membership, plan state, and immutable entitlement identifiers, then authorizes the resource and entitlement. Commercial endpoints default deny on unknown plan, unknown entitlement, stale critical state, or tenant mismatch.

## Evaluation order

1. Authenticate a non-revoked principal and validate audience, issuer, expiry, and session.
2. Resolve the tenant from the resource, not a freely trusted header.
3. Verify active membership and role.
4. Authorize the specific resource/action.
5. Resolve subscription state server-side.
6. Evaluate the immutable entitlement and limits.
7. Emit an audit decision and, when applicable, an idempotent usage event.

## Lifecycle

- Trial: explicit start/end and plan snapshot; no client extension.
- Grace period: only predefined features and duration; record the source state.
- Downgrade: block creation of newly disallowed resources, preserve export/delete access, and apply documented retention.
- Cancellation: retain access through the paid period unless fraud/security requires audited suspension.
- Cached state: short TTL, keyed by tenant and entitlement version; fail closed for privileged writes. Cache invalidation follows subscription and administrative changes.
- Overrides: time-bound, reasoned, actor-attributed, and audited; never change the billing provider record silently.

## Anti-bypass

UI hiding is convenience only. Every commercial API action repeats server authorization. Workers validate signed, short-lived job grants. Local Community code does not import this evaluator, and a modified client cannot obtain hosted access by editing local plan data.
