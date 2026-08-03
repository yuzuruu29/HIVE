# Future commercial entitlement matrix

All identifiers below are stable contract names. Community runtime capabilities are intentionally absent because they are not commercial gates. “Hosted API” means a future server boundary; none is implemented in this release.

| Identifier | Feature | Community | Pro | Power | Team | Enterprise | Enforcement | Meter | Security implications | Status |
|---|---|---:|---:|---:|---:|---:|---|---|---|---|
| `cloud_sessions` | Cloud session sync | No | Yes | Yes | Yes | Yes | Hosted API | Stored session/time | Tenant isolation, redaction | Designed only |
| `remote_runs` | Remote execution | No | Limited | Yes | Yes | Yes | Hosted API and cloud runtime | Run/runtime duration | Sandbox and credential isolation | Designed only |
| `github_automation` | GitHub automation | No | Yes | Yes | Yes | Yes | Hosted integration API | Automation action | Scoped tokens, repository authorization | Designed only |
| `scheduled_runs` | Scheduled remote runs | No | No | Yes | Yes | Yes | Hosted scheduler API | Scheduled run | Replay and credential controls | Designed only |
| `private_presets` | Private hosted presets | No | Yes | Yes | Yes | Yes | Hosted preset API | Storage/retention | Tenant isolation, prompt secrets | Designed only |
| `api_access` | Commercial API access | No | No | Yes | Yes | Yes | Hosted API gateway | Request | Authentication, rate limits | Designed only |
| `webhooks` | Outbound webhooks | No | No | Yes | Yes | Yes | Hosted webhook service | Delivery | Signing, SSRF prevention, secret rotation | Designed only |
| `team_workspaces` | Shared workspaces | No | No | No | Yes | Yes | Hosted workspace API | Seat/storage | Cross-tenant isolation, RBAC | Designed only |
| `shared_provider_registry` | Shared provider configuration | No | No | No | Yes | Yes | Hosted provider API | Provider/secret reference | Secret ownership and least privilege | Designed only |
| `approval_policies` | Central approval policies | No | No | No | Yes | Yes | Hosted policy API | Policy evaluation | Default deny, auditability | Designed only |
| `audit_logs` | Organization audit log | No | No | No | Yes | Yes | Hosted audit API | Retained event | Integrity, redaction, retention | Designed only |
| `managed_models` | HIVE-managed model access | No | Optional | Optional | Optional | Optional | Hosted model gateway | Provider units | Spend controls, abuse, cost integrity | Designed only |
| `self_hosted_control_plane` | Customer control plane | No | No | No | No | Yes | Enterprise distribution/control plane | Deployment/seat | Upgrade, signing, customer isolation | Designed only |

Unknown plans or entitlement identifiers must fail closed at future hosted boundaries. They must not affect Community commands.
