# Protocol Versioning

This document maps each protocol concept to its canonical source of truth. When a definition changes, the canonical source is updated first; derived documents follow.

## Canonical Sources

| Concept | Canonical source | Format | Notes |
|---|---|---|---|
| Field names and enum values | JSON Schemas (`schemas/v1/*.schema.json`) | JSON Schema | All artifact field names, types, enum values, and structural rules are defined in the schema files. The definitions schema (`definitions.schema.json`) contains shared type definitions. |
| Protocol compatibility | `protocol.json` | JSON | Declares `protocol_version`, `artifact_format_version`, `schema_version`, supported execution modes, and supported run statuses. This is the root authority for which protocol version the skill implements. |
| Role responsibilities | `skills/hive-mind-council/references/role-contracts.md` | Markdown | Defines input/output contracts, evidence requirements, failure handling, and bounded autonomy for each of the six council roles (Queen, Scout, Architect, Forger, Sentinel, Scribe). |
| Safety behavior | `skills/hive-mind-council/references/safety-policy.md` | Markdown | Defines permission levels, approval requirements, untrusted input policy, file scope enforcement, secret handling, and user work protection rules. |
| Preset behavior | `skills/hive-mind-council/references/orchestration-presets.md` | Markdown | Defines the four execution presets (Quick, Standard, Deep, Audit) with role selection, fix cycle limits, and selection rules. |
| Runtime adaptation | `skills/hive-mind-council/references/runtime-capabilities.md` | Markdown | Documents capability negotiation rules, conformance level definitions (0-4), and per-level capability requirements. Runtime-specific capability declarations are in `runtime/*.json`. |
| Adapter capabilities | `adapters/*/adapter.json` | JSON | Each adapter declares its `declared_conformance_level`, `supported_protocol_versions`, runtime capabilities reference, validation status, and known limitations. |
| Public positioning | `README.md` and `WHAT_THIS_IS.md` | Markdown | High-level project description, scope boundaries, and what the skill is and is not. These are the entry points for new users. |

## Version Mapping

| Artifact | Version field | Current value |
|---|---|---|
| Protocol manifest | `protocol_version` | `1.0.0` |
| JSON Schemas | `$id` / `$version` | `1.0.0` |
| Artifact format | `artifact_format_version` | `1.0.0` |
| Skill (in skill.json) | `version` | `0.3.0` |

## Change Process

1. Schema changes are the authoritative change — update the JSON Schema first.
2. Update `protocol.json` version fields when the protocol or artifact format changes.
3. Update reference documents (`role-contracts.md`, `safety-policy.md`, etc.) to reflect schema changes.
4. Update adapter manifests (`adapters/*/adapter.json`) when protocol compatibility changes.
5. Update `README.md` and `WHAT_THIS_IS.md` for user-facing changes.
6. Document breaking changes in `CHANGELOG.md` with migration instructions.
