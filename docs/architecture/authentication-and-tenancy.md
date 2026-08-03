# Authentication and tenancy

Status: design only.

## Model

An individual account may own personal resources and hold memberships in future organizations. Membership binds account, organization, role, status, and timestamps. Repository connections, sessions, artifacts, provider-secret references, audit records, and usage events carry an authoritative tenant ID.

## Authentication

Use standards-based browser sessions and short-lived service tokens. Cookies are secure, HTTP-only, same-site, CSRF-protected, rotated after privilege changes, and revocable. Tokens validate issuer, audience, expiry, signature, and token/session version. Recovery and account linking require recent authentication and notification.

GitHub linking proves control of a GitHub identity but does not itself grant repository or organization access. Prevent account-link confusion by requiring an authenticated HIVE account, state/PKCE, exact callback validation, and explicit confirmation when identities differ.

## Authorization and isolation

Derive tenant from the addressed resource and compare membership on every request. Use default-deny RBAC with resource-specific checks; roles do not substitute for repository authorization. Database queries include tenant constraints, object storage uses tenant-scoped keys and signed URLs, caches include tenant keys, queues carry signed tenant/job grants, and logs avoid cross-tenant payloads.

## Secrets

Provider and repository credentials belong to an account or organization, are encrypted with managed keys, referenced rather than copied into jobs, never returned after creation, and accessed through audited least-privilege grants. Rotation and deletion invalidate grants.

## Deletion and audit

Deletion workflows enumerate primary records, derived artifacts, caches, backups, credentials, and external installations with retention exceptions recorded. Privileged membership, secret, entitlement, repository, export, and deletion actions produce redacted audit events.

## Required tests before implementation ships

Cross-tenant ID guessing, cache-key isolation, signed URL scope, membership removal, token revocation, GitHub relinking, secret ownership, worker grants, export, and deletion propagation.
