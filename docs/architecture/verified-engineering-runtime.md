# HIVE Verified Engineering Runtime

> HIVE coordinates specialized coding agents and proves whether their combined work is safe to accept.

## Product Positioning

Other coding agents help produce patches. HIVE determines whether those patches deserve to be accepted.

HIVE is not another generic multi-agent coding CLI. Multi-agent execution, subagents, BYOK, custom providers, worktrees, reviewers, planning, terminal interfaces, and parallelism are no longer sufficient differentiators.

The product gap HIVE owns is: **HIVE is an enforceable acceptance layer for autonomous software engineering.**

## Architecture

### Core Modules

| Module | Purpose |
|--------|---------|
| `src/coding/contracts.ts` | Task contract schema, acceptance gates, gate satisfaction |
| `src/coding/evidence.ts` | Evidence ledger, evidence records, validity tracking |
| `src/coding/verdicts.ts` | Failure taxonomy, deterministic verdict computation |
| `src/coding/queen.ts` | Orchestrator — wires contracts, evidence, and verdicts |
| `src/coding/scheduler.ts` | DAG-based task scheduling with scope enforcement |
| `src/coding/report.ts` | Deterministic JSON and Markdown report generation |
| `src/coding/session-store.ts` | Session persistence with secret redaction |
| `src/coding/repository.ts` | Repository inspection, drift detection |
| `src/security/secrets.ts` | Secret redaction and credential field detection |

### Task Contracts

A `HiveTaskContract` defines what the system must prove before a run can be accepted:

- **Acceptance gates** — stable-ID requirements that must be satisfied
- **Evidence requirements** — what evidence must be collected
- **Allowed/forbidden paths** — scope enforcement
- **Risk level** — low/medium/high/critical
- **Approval policy** — user approval, independent provider requirements
- **Budget** — max model calls, commands, minutes, repair attempts

Contracts are adaptive: gates are only created for validation commands that are actually configured.

### Evidence Model

Every piece of evidence that contributes to a verdict is recorded in the `EvidenceLedger`:

- **Statuses**: `OBSERVED`, `EXECUTED`, `PASSED`, `FAILED`, `SKIPPED`, `UNAVAILABLE`, `AGENT_CLAIMED`
- **Key rule**: `AGENT_CLAIMED` evidence **never** satisfies mandatory gates
- **Invalidation**: evidence tied to a repository SHA is invalidated when the repository changes
- **Provenance**: each record tracks source role, task, gate, timestamp, and repository SHA

### Verdicts

Every run ends with one of four deterministic verdicts:

| Verdict | Condition |
|---------|-----------|
| `ACCEPTED` | All required gates passed, evidence is current, reviewer approved |
| `REPAIRABLE` | Defects are actionable, repair budget remains, no critical safety violation |
| `REJECTED` | Scope violation, architecture failure, budget exhausted, or user rejected |
| `BLOCKED` | Infrastructure unavailable, credentials missing, or cancelled |

### Failure Taxonomy

19 classified failure types with deterministic default actions:

| Failure Class | Default Action |
|---------------|----------------|
| `BUILD_FAILURE` | Invoke Fixer |
| `TYPECHECK_FAILURE` | Invoke Fixer |
| `TEST_FAILURE` | Invoke Fixer |
| `SCOPE_VIOLATION` | Reject patch |
| `PROTECTED_PATH_VIOLATION` | Reject patch |
| `INTEGRATION_CONFLICT` | Re-plan affected nodes |
| `MISSING_EVIDENCE` | Mark blocked |
| `SECURITY_FINDING` | Reject patch |
| `PROVIDER_FAILURE` | Route provider fallback |
| `BUDGET_EXCEEDED` | Terminate run |

### Role Separation

| Role | Can Modify Files | Can Approve | Receives |
|------|-----------------|-------------|----------|
| Scout | No | No | Repository context |
| Planner | No | No | Objective, scout context |
| Builder | Yes (scoped) | No | Task contract, dependencies |
| Validator | No | No | Actual diff, repository state |
| Reviewer | No | No | Integrated diff, evidence ledger |
| Fixer | Yes (scoped) | No | Classified failures, bounded scope |
| Queen | No | Yes | All state, produces verdict |

### Integrated Validation

Individual Builder success is insufficient. The final verdict requires:

1. Builder completes work in isolated worktree
2. Scope and diff are checked
3. Patches are applied in dependency order
4. Final required checks run against the combined repository
5. All acceptance evidence is tied to the integrated repository SHA
6. Reviewer evaluates the integrated state
7. Any later repository mutation invalidates affected evidence

## CLI Commands

```bash
# Primary workflow
hive code "<objective>"           # Run verified engineering session
hive status                       # Show active session status with verdict
hive resume <session-id>          # Resume with repository state reconciliation
hive report <session-id>          # Generate deterministic report
hive report <session-id> --json   # JSON format
hive report <session-id> --markdown  # Markdown format
hive approve <session-id>         # Approve a paused session
hive reject <session-id>          # Reject a session
hive discard <session-id>         # Discard a session
```

### Canonical Lifecycle

```
Repository inspection
→ Scout context
→ Task contract
→ Typed DAG
→ Plan validation
→ Provider assignment
→ Isolated Builder execution
→ Patch scope verification
→ Controlled integration
→ Integrated validation
→ Independent review
→ Bounded repair
→ Approval
→ Final verdict
→ Run report
```

## Report Format

Reports distinguish claims from observations and include:

- Final verdict with reasons
- Initial and final repository SHAs
- Acceptance gate matrix
- Evidence ledger with validity status
- Failure and retry history
- Integration history
- Cost and token information (with provenance)
- Unavailable information (honestly represented)

## Session Resume

Before continuing a saved session, HIVE reconciles persisted state with the real repository:

- Current branch and HEAD vs. original base commit
- Working-tree modifications and staged files
- Existing worktrees
- File hashes for relevant paths
- Previously captured evidence SHAs

Nodes are classified as: reusable, stale, invalidated, missing, conflicted, or completed.

## Known Limitations

- Provider and infrastructure cost estimation requires external pricing data
- Safety counters are not yet persisted in the event schema
- Raw command output is intentionally excluded from reports for security
- Desktop and TUI surfaces consume canonical events but do not yet display the full evidence ledger
