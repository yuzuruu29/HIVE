# HIVE Artifact Format

This document describes the HIVE artifact format used for structured handoffs, evidence tracking, and run documentation. The canonical source for all field definitions is the JSON Schema files in `schemas/v1/`.

## Artifact Types

The HIVE protocol defines the following artifact types:

| Artifact | Schema | Description |
|---|---|---|
| Run Contract | `run-contract.schema.json` | Initial agreement defining a hive execution run |
| Task Graph | `task-graph.schema.json` | Decomposition of the run goal into individual agent tasks |
| Role Handoff | `role-handoff.schema.json` | Output of one agent role before passing control to another |
| Evidence Ledger | `evidence-ledger.schema.json` | Typed collection of evidence entries produced during a run |
| Final Review | `final-review.schema.json` | Concluding summary of a hive execution run |
| Run Manifest | `run-manifest.schema.json` | Indexes the artifacts of a completed run bundle (`.hive-run/`) |
| Protocol Manifest | `protocol-manifest.schema.json` | Protocol-level metadata (protocol.json) |

## Required Fields by Artifact Type

### Run Contract
- `protocol_version` — Protocol version identifier
- `run_id` — Unique run identifier (UUID format)
- `goal` — The primary goal of the run
- `deliverables` — Expected deliverables from the run (min 1)
- `constraints` — Constraints that must be respected
- `exclusions` — Topics or areas explicitly excluded
- `success_criteria` — Criteria defining a successful run (min 1)
- `approval_requirements` — Approval gates that must be satisfied
- `execution_mode` — One of: quick, standard, deep, audit
- `maximum_fix_cycles` — Maximum number of automated fix cycles (min 0)
- `status` — One of: complete, partial, blocked, failed
- `created_at` — ISO 8601 timestamp

### Task Graph
- `protocol_version` — Protocol version identifier
- `run_id` — Unique run identifier
- `tasks` — Array of task objects (min 1)
- `created_at` — ISO 8601 timestamp

Each task requires: `task_id`, `assigned_role`, `objective`, `status`.

### Role Handoff
- `protocol_version` — Protocol version identifier
- `run_id` — Unique run identifier
- `task_id` — Task identifier this handoff belongs to
- `role` — One of: queen, scout, architect, forger, sentinel, scribe
- `status` — One of: complete, blocked, failed, needs_approval
- `summary` — Summary of what was accomplished
- `findings` — Array of findings with statement, evidence_refs, confidence
- `files_examined` — Paths to files examined
- `files_changed` — Paths to files created or modified
- `commands_run` — Commands that were executed
- `risks` — Array of risks with description, severity, affected_files
- `unresolved_questions` — Questions that remain unanswered
- `recommended_next_action` — Recommended next action
- `created_at` — ISO 8601 timestamp

### Evidence Ledger
- `protocol_version` — Protocol version identifier
- `run_id` — Unique run identifier
- `evidence` — Array of evidence entries

Each evidence entry requires: `evidence_id`, `type` (one of: command, file, test, build, inspection, approval, runtime, limitation).

### Final Review
- `protocol_version` — Protocol version identifier
- `run_id` — Unique run identifier
- `run_status` — One of: complete, partial, blocked, failed
- `goal` — The original goal of the run
- `result` — Summary of the final result
- `execution_mode` — One of: quick, standard, deep, audit
- `fix_cycles_used` — Number of fix cycles used (min 0)
- `changes` — Summary of changes made
- `evidence_refs` — References to evidence entries
- `verification` — Verification steps performed
- `limitations` — Known limitations
- `files_affected` — Paths affected
- `sentinel_verdict` — One of: PASS, PASS_WITH_LIMITATIONS, FAIL, BLOCKED
- `completed_at` — ISO 8601 timestamp

### Run Manifest (.hive-run/manifest.json)
- `bundle_version` — Version of the run bundle format
- `protocol_version` — Protocol version used
- `schema_version` — Schema version used
- `run_id` — Unique run identifier
- `created_at` — ISO 8601 timestamp
- `runtime` — Object with name and version
- `adapter` — Adapter identifier
- `execution_mode` — One of: quick, standard, deep, audit
- `artifact_index` — Array of artifact entries (path, optional sha256)
- `integrity_available` — Whether integrity verification is available

## Artifact Relationships

```
Run Contract
  |
  +-- Task Graph (decomposes the goal into tasks)
  |     |
  |     +-- Role Handoff(s) (per task, per role execution)
  |           |
  |           +-- Evidence Ledger (evidence collected during handoff)
  |
  +-- Final Review (summarizes the entire run)
  |
  +-- Run Manifest (indexes all artifacts in a .hive-run bundle)
```

## Enum Values

Refer to `schemas/v1/definitions.schema.json` for the canonical list of enum values:

- **Roles:** queen, scout, architect, forger, sentinel, scribe
- **Execution modes:** quick, standard, deep, audit
- **Run statuses:** complete, partial, blocked, failed
- **Handoff statuses:** complete, blocked, failed, needs_approval
- **Confidence:** high, medium, low
- **Permission levels:** READ, WRITE, EXECUTE, NETWORK, GIT_MUTATE, DESTRUCTIVE
- **Sentinel verdicts:** PASS, PASS_WITH_LIMITATIONS, FAIL, BLOCKED
- **Risk severity:** low, medium, high
- **Evidence types:** command, file, test, build, inspection, approval, runtime, limitation
- **Validation types:** static, automated, behavioral, safety, portability
- **File actions:** created, modified, deleted, examined

## Format Versioning

The artifact format version is declared in `protocol.json` as `artifact_format_version`. All artifacts within a run share the same `protocol_version`.

See [PROTOCOL_VERSIONING.md](PROTOCOL_VERSIONING.md) for the change process.
