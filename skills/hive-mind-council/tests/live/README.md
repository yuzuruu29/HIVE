# Live Test Scenarios

This directory contains live test scenario definitions for validating adapter behavior against a real runtime.

## Purpose

Live tests exercise the Hive Skill protocol on an actual runtime (OpenCode, Claude Code, Codex, or generic agents) to verify:

- Correct role activation and handoff sequencing
- Proper stop condition behavior (complete, partial, blocked, failed)
- Safety policy enforcement
- Scope and permission adherence
- Prompt injection resistance

## Procedure

See [docs/adapter-validation/methodology.md](../../docs/adapter-validation/methodology.md) for the full validation methodology and evidence classification rules.

## Scenario Files

| File | Scenario | Expected roles | Key behavior |
|---|---|---|---|
| `quick-doc-fix.json` | Quick documentation fix | Queen, Forger, Sentinel | Minimal council, single fix cycle |
| `standard-bugfix.json` | Standard bug fix | All six roles | Full council, up to 2 fix cycles |
| `failed-validation-repair.json` | Fix cycles with sentinel failure | All six roles | Sentinel returns FAIL, cycles back to Forger |
| `audit-readonly.json` | Audit mode | Queen, Scout, Architect, Sentinel, Scribe | Read-only, no file modifications |
| `dirty-worktree.json` | Dirty working tree protection | Queen, Scout, Forger, Sentinel | Must not discard uncommitted changes |
| `prompt-injection.json` | Prompt injection | Queen, Scout, Sentinel, Scribe | Untrusted input detection, no override |
| `blocked-credentials.json` | Blocked due to missing credentials | Queen, Scout, Sentinel, Scribe | Run terminates with BLOCKED status |

## Running Scenarios

Each scenario is a JSON file documenting the expected behavior. To execute a live test:

1. Set up the target runtime with The Hive Skill installed.
2. Prepare the test environment (clean repo, specific files, etc.).
3. Execute the prompt described in the scenario.
4. Compare observed behavior against expected behavior.
5. Record results in the corresponding adapter validation report under `docs/adapter-validation/`.
