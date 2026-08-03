# HIVE monetization foundation implementation plan

## Current architecture

HIVE is a single-package TypeScript/Node.js CLI. `src/cli.ts` registers legacy task commands and the newer Queen-led coding workflow. The coding runtime under `src/coding/` persists schema-versioned `CodingSessionRecord` snapshots and structured `RuntimeEvent` history in `.hivemind/sessions/`. Provider adapters expose optional token counts, which the provider router normalizes onto persisted subagent tasks. Validation results, review findings, file changes, command lifecycle events, repository state, and a compact final report already exist.

The package has no runtime billing, authentication, tenancy, or hosted-service dependency. The current MIT license permits broad reuse, modification, distribution, sublicensing, and sale subject to its notice and warranty terms.

## Relevant existing files

- `src/coding/types.ts`: session, event, agent, validation, review, and token-usage contracts.
- `src/coding/session-store.ts`: validated, redacted, atomic session persistence and safe session IDs.
- `src/coding/queen.ts`: deterministic accumulation of engineering evidence.
- `src/coding/output.ts`: current live event and compact final-report rendering.
- `src/cli.ts`: CLI registration and coding-session lookup.
- `src/providers/`: optional provider-reported usage.
- `tests/coding-*.test.mjs`: runtime, persistence, CLI, safety, and resume coverage.

## Proposed changes

- Add dependency-free commercial plan and entitlement identifiers outside the execution path.
- Add a versioned run-report contract and pure projection from persisted coding sessions.
- Add JSON and Markdown renderers and a `hive report` CLI command.
- Add a path-contained, symlink-aware, no-overwrite report writer.
- Export the new public contracts from `src/index.ts`.
- Add focused contract, projection, compatibility, redaction, determinism, and CLI/path tests.
- Add monetization, paid-pilot, and future control-plane documentation only.

## Data flow

Persisted session snapshot and events -> pure report projection -> JSON or Markdown renderer -> terminal or guarded local file writer. Report generation does not mutate the session, call a provider, infer prices, or participate in orchestration.

## Compatibility strategy

Keep coding session schema version 1 unchanged. Treat optional and absent usage, pricing, final-report, timing, and event fields as unavailable. Additive exports and a new CLI command leave existing Community commands and resume behavior unchanged.

## Test strategy

Cover all session outcomes, retries and Fixer work, missing/provider-reported usage, unavailable/estimated cost contracts, older sparse session evidence, secret and terminal-control sanitization, determinism, non-mutation, CLI formats, unsafe identifiers, traversal, symlink/parent containment, and no-overwrite behavior. Rerun build, lint, all tests, and CLI smoke checks.

## Security considerations

Never include raw provider requests or command output. Redact report strings, strip terminal controls, avoid emitting absolute repository roots, validate session identifiers through the session store, constrain output to the repository real path, reject symlink escapes, and create output files exclusively.

## Non-goals

No Stripe, checkout, hosted runtime, cloud sandbox, authentication, organizations, RBAC, managed credits, license checks, remote flags, marketplace, deployment, or repository restructuring.

## Phase gates

1. Phase 0: boundary docs and exhaustive commercial identifiers pass build/tests.
2. Phase 1: deterministic reports, safe CLI exports, compatibility tests, and pilot assets pass build/tests.
3. Phase 2: trust-boundary architecture is documented with no production SaaS code.
4. Final: focused security review and full relevant validation are green.
