# Migrating from v0.2 to v0.3

This document summarizes the changes between HIVE Skill v0.2.1 and v0.3.0 and what they mean for existing users and integrators.

## Overview

v0.3.0 introduces structured JSON artifacts as the primary protocol format while maintaining backward compatibility with Markdown handoffs.

## What Stays the Same

- **Markdown handoffs remain supported.** Existing v0.2.1 workflows continue to work.
- **Existing v0.2.1 templates** are still human-readable references and have not been removed.
- **Status names** remain unchanged: complete, partial, blocked, failed.
- **Role names** remain unchanged: queen, scout, architect, forger, sentinel, scribe.
- **Permission levels** remain unchanged: READ, WRITE, EXECUTE, NETWORK, GIT_MUTATE, DESTRUCTIVE.

## What Is New

### JSON Artifacts

JSON artifacts are now the preferred format for machine validation. The HIVE protocol defines these artifact types:

- Run Contract (`run-contract.schema.json`)
- Task Graph (`task-graph.schema.json`)
- Role Handoff (`role-handoff.schema.json`)
- Evidence Ledger (`evidence-ledger.schema.json`)
- Final Review (`final-review.schema.json`)
- Run Manifest (`run-manifest.schema.json`)

All artifacts have JSON Schema definitions in `schemas/v1/`.

### New Fields

The following fields are new in v0.3.0:

| Field | Applies to | Purpose |
|---|---|---|
| `protocol_version` | All artifacts | Identifies the protocol version used |
| `run_id` | All artifacts | UUID identifying a specific run |
| `task_id` | Role handoffs | Identifies which task a handoff belongs to |
| `evidence_refs` | Findings, Final Review | References to evidence ledger entries |
| `bundle_version` | Run manifest | Version of the `.hive-run` bundle format |

### Adapter Capability Declarations

Adapters now declare their capabilities in `adapters/<name>/adapter.json`:

- `declared_conformance_level` (0-4)
- `supported_protocol_versions`
- `validation` status (including `test_status` and `last_tested_at`)
- `limitations`

See [ADAPTER_CONFORMANCE.md](ADAPTER_CONFORMANCE.md) for details.

### .hive-run Bundles

`.hive-run` bundles are optional but recommended. A bundle is a directory containing:

- `manifest.json` — Run manifest indexing all artifacts
- Individual artifact JSON files
- Optional evidence files

Bundles provide a self-contained record of a completed run for auditing, debugging, or replay.

## Migration Path

1. **Existing v0.2.1 users** can continue using Markdown handoffs without changes.
2. **To adopt JSON artifacts:** Start using the JSON Schema-validated artifact formats. The CLI tool (`tools/hive-validate.js`) can validate your artifacts.
3. **To declare adapter capabilities:** Create or update `adapters/<name>/adapter.json` with your conformance level and capabilities.
4. **To generate `.hive-run` bundles:** Create a bundle directory with a `manifest.json` and the artifact files.

## Schema Location

All v0.3.0 schemas are in `schemas/v1/`:

```
schemas/v1/
  definitions.schema.json
  run-contract.schema.json
  task-graph.schema.json
  role-handoff.schema.json
  evidence-ledger.schema.json
  final-review.schema.json
  run-manifest.schema.json
  runtime-capabilities.schema.json
  adapter-manifest.schema.json
```
