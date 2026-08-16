# Adapter Validation Methodology

This document defines how adapter validation is performed, classified, and reported across all supported runtimes.

## Evidence Classifications

Validation results are classified by the type of evidence used:

| Classification | Description | Acceptable for levels |
|---|---|---|
| **structural** | Schema validation, manifest correctness, documentation analysis. No runtime execution. | 0, 1, 2 |
| **manual_live** | Human-conducted test on a real runtime with documented steps and observed outcomes. | 0, 1, 2, 3, 4 |
| **automated_live** | CI pipeline or automated test suite exercising the adapter against a real runtime. | 0, 1, 2, 3, 4 |
| **runtime_native** | Built-in runtime self-test or conformance check provided by the runtime itself. | 0, 1, 2, 3, 4 |

## Rules

1. **No API keys** — Validation reports must never contain API keys, tokens, passwords, or other credentials. Secrets must use environment variable references or be excluded entirely.
2. **No raw prompts** — Validation reports may describe prompts used but must not include raw, untruncated prompt text that would inflate the document or expose sensitive context.
3. **Current vs historical** — Reports must clearly distinguish current results (tested against the latest protocol version) from historical results. Each report includes a `Last tested` date.
4. **Live tests required for Level 3 and 4** — Levels 3 and 4 require live runtime evidence (manual_live, automated_live, or runtime_native). Structural analysis alone cannot certify these levels.

## Validation Report Format

Each adapter validation report follows this structure:

```markdown
# <Adapter Name> Validation
- Last tested: YYYY-MM-DD
- Test type: structural | manual_live | automated_live | runtime_native
- Level: <0-4>
- Protocol: <version>
- Limitations: <description>
```

## Promoting an Adapter

To promote an adapter from structural-only validation to a higher level:

1. Run the live test scenarios from `tests/live/scenarios/` on the target runtime.
2. Document the results in the runtime's validation report.
3. Update `test_type` to `manual_live`, `automated_live`, or `runtime_native`.
4. Update `declared_conformance_level` in the adapter manifest (`adapters/<adapter>/adapter.json`).
5. If the new level is 3 or 4, provide evidence links in the validation report.
