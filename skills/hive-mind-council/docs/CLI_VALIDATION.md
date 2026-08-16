# CLI Validation

The Hive Skill provides CLI tools for validating artifacts, schemas, and bundles. This document covers the available commands, exit codes, and usage examples.

## Commands

### Validate a single artifact

```
node tools/hive-validate.js <path-to-artifact.json>
```

Validates a single artifact file against its JSON Schema. The tool automatically detects the artifact type based on the file content.

**Exit codes:**
- `0` — Artifact is valid
- `1` — Validation failed (schema mismatch, missing required fields, or invalid values)

**Example:**
```bash
node tools/hive-validate.js run-contract.json
node tools/hive-validate.js role-handoff.json
node tools/hive-validate.js evidence-ledger.json
```

### Validate all schemas

```
npm run validate:schemas
```

Runs schema validation tests for all artifact types.

**Exit codes:**
- `0` — All schemas pass
- `1` — One or more schemas failed validation

### Run all tests

```
npm test
```

Runs the full test suite including:
- Schema validation tests
- Semantic rule tests
- Conformance tests
- Mutation tests
- Bundle tests
- Link validation regression tests

**Exit codes:**
- `0` — All tests pass
- `1` — One or more tests failed

### Generate conformance report

```
npm run generate:conformance-report
```

Reads all adapter manifests and generates `docs/CONFORMANCE.md`.

**Exit codes:**
- `0` — Report generated successfully
- `1` — Failed to read adapters or generate report

### Validate JSON files

```
npm run validate:json
```

Validates that `package.json`, `skill.json`, and `plugin.json` are valid JSON.

### Validate links

```
npm run validate:links
```

Checks internal links across documentation files for correctness.

## Bundle Validation

A `.hive-run` bundle is a directory containing artifacts from a completed run. To validate a bundle:

1. Ensure the bundle contains a `manifest.json` file conforming to the run-manifest schema.
2. Validate each artifact file individually using `tools/hive-validate.js`.
3. Verify that the `run_id` in the manifest matches the `run_id` in each artifact.

## Semantic Rules Overview

The semantic rules (`tools/semantic-rules.js`) enforce higher-level constraints beyond schema validation:

- Finding confidence levels must be consistent with evidence
- Run status transitions must follow the defined state machine
- Task graph dependencies must not contain cycles
- Sentinel verdict must be present before a run can be marked complete
- Evidence references must point to valid entries

## Artifact Types and Detection

The validator detects artifact type by examining the JSON structure:

| Artifact type | Key detection field |
|---|---|
| Run Contract | `run_id`, `goal`, `execution_mode` |
| Task Graph | `tasks` array with `assigned_role` |
| Role Handoff | `role`, `findings` |
| Evidence Ledger | `evidence` array |
| Final Review | `run_status`, `sentinel_verdict` |
| Run Manifest | `bundle_version`, `artifact_index` |
