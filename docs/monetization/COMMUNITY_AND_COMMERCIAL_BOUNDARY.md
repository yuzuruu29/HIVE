# Community and commercial boundary

## Principle

HIVE Community is the complete local, provider-neutral engineering runtime. It requires no HIVE account, payment, license server, remote feature flag, or HIVE-hosted API. The local execution path must not import or call commercial entitlement or billing services.

## Community

Community includes the CLI and TUI; Queen, Scout, Planner, Builder, Validator, Reviewer, and bounded Fixer roles; BYOK, local, and custom OpenAI-compatible providers; DAG scheduling; local parallelism; worktree isolation; file leases; controlled tools; approvals; secret redaction; local sessions and resume; local run reports; Community presets; and unrestricted single-user local repositories, providers, agents, and runs.

## Future hosted plans

- Pro: cloud session synchronization, remote runs, GitHub automation, private cloud presets, notifications, limited hosted execution, and budget alerts.
- Power: higher hosted concurrency, scheduled runs, API access, webhooks, advanced hosted routing/fallback, and extended retention.
- Team: shared workspaces, centralized billing, shared providers/presets/skills, RBAC, approval policies, budgets, audit logs, and usage analytics.
- Enterprise: self-hosted control plane, customer VPC, SSO/SCIM, customer-managed secrets, network policies, compliance exports, air-gapped support, and dedicated support.

These names describe future packaging, not current runtime checks or promises of availability.

## Trust boundary

Local sessions may emit redacted engineering and usage facts. A future hosted API may authenticate a principal, resolve a server-authoritative plan, enforce a commercial entitlement, and append billing events. Client-supplied plan claims and local reports are never authoritative for access or billing.

## Change rule

Any proposal that moves an existing Community capability behind an account, payment, hosted dependency, or commercial entitlement requires an explicit product decision and compatibility review. It is not an ordinary implementation change.
