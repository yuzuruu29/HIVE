# Adapter Conformance

This document explains conformance levels, how to read adapter manifests, and how conformance is validated.

## Conformance Levels

Adapters declare a `declared_conformance_level` from 0 to 4. Each level defines the integration depth between the adapter and the HIVE Protocol.

| Level | Name | Description | Requires live evidence |
|---|---|---|---|
| **0** | Documentation mapping | Adapter only explains how a host agent could follow the protocol. No automated enforcement or validation. | No |
| **1** | Sequential role simulation | One host agent performs all council roles serially. Role handoffs and evidence are tracked but executed by a single agent context. | No |
| **2** | Structured protocol integration | Validated structured handoffs, approvals, and evidence. Uses JSON schemas for artifact validation. Supports approval prompts and structured output. | No |
| **3** | Native isolated subagents | Distinct subagent contexts or sessions for each role. Subagents operate in isolated environments with separate state. | Yes |
| **4** | Parallel scoped execution | Concurrent scoped tasks with independent evidence tracking. Full parallelism with coordination via the council protocol. | Yes |

### Assignment Rules

- Levels **0**, **1**, and **2** may be assigned from structural or documentation analysis alone.
- Levels **3** and **4** **require live runtime evidence** (test results, session recordings, or CI pipeline output) demonstrating the capability.

## Reading Adapter Manifests

Each adapter declares its capabilities in `adapters/<name>/adapter.json`. The manifest includes:

| Field | Description |
|---|---|
| `adapter` | Adapter name (e.g., "opencode", "claude-code") |
| `adapter_version` | Version of this adapter definition |
| `supported_protocol_versions` | Minimum and maximum protocol versions this adapter supports |
| `declared_conformance_level` | The conformance level (0-4) this adapter is claiming |
| `runtime_capabilities` | Path to the runtime capabilities JSON file |
| `validation.test_status` | Current validation status: `structural_only`, `manual_live`, `automated_live`, or `runtime_native` |
| `validation.last_tested_at` | Date of the last validation test |
| `limitations` | Known limitations of this adapter |

### Example

```json
{
  "adapter": "opencode",
  "adapter_version": "0.3.0",
  "declared_conformance_level": 2,
  "supported_protocol_versions": { "minimum": "1.0.0", "maximum": "1.x" },
  "validation": {
    "last_tested_at": "2026-07-20",
    "test_status": "structural_only"
  }
}
```

This adapter declares Level 2 conformance based on structural analysis. It supports protocol versions 1.0.0 through 1.x.

## How Conformance is Validated

### Structural Validation

Structural validation verifies:
- Adapter manifest is valid JSON and passes schema validation
- Referenced runtime capabilities file exists and is valid
- Documentation references are consistent
- All required fields are present

### Live Validation

Live validation exercises the adapter against a real runtime to verify:
- Correct role activation and handoff sequencing
- Proper stop condition behavior
- Safety policy enforcement
- Scope and permission adherence
- Prompt injection resistance

Live validation is required before promoting an adapter to Level 3 or 4.

### The Conformance Report

The generated conformance report at `docs/CONFORMANCE.md` provides a summary table:

```
| Adapter | Declared level | Validation | Protocol | Last tested |
|---|---:|---|---|---|
| OpenCode | 2 | Structural only | 1.0.0 | 2026-07-20 |
```

To regenerate the report: `npm run generate:conformance-report`

## Adapter Validation Reports

Detailed validation reports for each adapter are in `docs/adapter-validation/`:

| Adapter | Report |
|---|---|
| OpenCode | `docs/adapter-validation/opencode.md` |
| Codex | `docs/adapter-validation/codex.md` |
| Claude Code | `docs/adapter-validation/claude-code.md` |
| Generic agents | `docs/adapter-validation/generic-agents.md` |

See [adapter-validation/methodology.md](adapter-validation/methodology.md) for the full validation methodology.
