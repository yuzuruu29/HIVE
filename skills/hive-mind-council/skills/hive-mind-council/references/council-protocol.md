# Council Protocol

Shared protocol used by every subagent in The Hive Skill. All roles must adhere to these contracts.

## 1. HIVE Run Contract

At the beginning of every run, the Queen must establish a run contract:

```yaml
run:
  goal: string
  deliverables:
    - string
  constraints:
    - string
  exclusions:
    - string
  success_criteria:
    - string
  approval_requirements:
    - string
  execution_mode: quick | standard | deep | audit
  maximum_fix_cycles: 2
  status: planning
```

The council must not treat a vague request as complete until it converts the request into measurable success criteria.

## 2. Structured Handoffs

Every role must return a compact handoff object:

```yaml
handoff:
  role: queen | scout | architect | forger | sentinel | scribe
  status: complete | blocked | failed | needs_approval
  summary: string
  findings:
    - statement: string
      evidence: string
      confidence: high | medium | low
  files_examined:
    - path
  files_changed:
    - path
  commands_run:
    - command: string
      result: passed | failed | partial
  risks:
    - string
  unresolved_questions:
    - string
  recommended_next_action: string
```

Adapters may render this as Markdown when structured output is unavailable. The semantic fields must be preserved.

## 3. Evidence Ledger

The council maintains a shared evidence ledger that records:

- Files examined
- Files modified
- Commands executed
- Test results
- Build results
- Browser or runtime checks
- Assumptions
- Unverified claims
- Approvals requested or received
- Remaining risks

No role may claim that something "works", "passes", "is secure", or "is production-ready" without corresponding evidence.

## 4. Confidence Labels

All important conclusions must use:

| Label | Meaning |
|-------|---------|
| **High confidence** | Directly confirmed by code, tests, command output, or runtime behavior |
| **Medium confidence** | Supported by code inspection but not executed |
| **Low confidence** | Inferred, incomplete, or dependent on missing information |

## 5. Stop Conditions

The Queen ends the run only when one of these states is reached:

| Status | Meaning |
|--------|---------|
| **COMPLETE** | All success criteria are satisfied with evidence |
| **PARTIAL** | Useful work was completed, but one or more criteria could not be verified |
| **BLOCKED** | Progress requires missing credentials, unavailable infrastructure, user approval, or inaccessible files |
| **FAILED** | The council exhausted its bounded repair cycles without producing a safe result |

The skill must never loop indefinitely.

## 6. Scope Enforcement

- No role may modify files outside its assigned scope.
- No role may add dependencies without disclosure.
- No role may discard uncommitted user work.
- No role may treat filenames as proof of behavior.

## 7. Context Budgeting

- Do not send the full repository context to every role.
- Give each role only relevant files, findings, constraints, and prior decisions.
- Summarize completed work before another role begins.
- Prefer file paths and evidence references over repeating large code blocks.
- Reuse findings rather than independently rediscovering them.
