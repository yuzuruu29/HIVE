# Adapter Validation

This directory contains validation reports for each supported adapter/runtime combination. Each report documents the test type, conformance level, protocol version, and known limitations.

## Directory Structure

```
docs/adapter-validation/
  README.md           — This file: overview and methodology links
  methodology.md      — Validation methodology and evidence classifications
  opencode.md         — OpenCode validation report
  codex.md            — Codex validation report
  claude-code.md      — Claude Code validation report
  generic-agents.md   — Generic agents validation report
```

## Reports

| Adapter | Level | Validation | Last tested |
|---|---|---|---|
| OpenCode | 2 | Structural only | 2026-07-20 |
| Codex | 1 | Structural only | 2026-07-20 |
| Claude Code | 2 | Structural only | 2026-07-20 |
| Generic agents | 0 | Structural only | 2026-07-20 |

## Upgrading to Level 3 or 4

Levels 3 and 4 require live runtime evidence. See [methodology.md](methodology.md) for the evidence requirements and the procedure for promoting an adapter to a higher conformance level.
