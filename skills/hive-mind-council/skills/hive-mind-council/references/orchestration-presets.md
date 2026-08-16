# Orchestration Presets

Predefined council configurations for different task types. The Queen selects the appropriate preset based on task classification.

## Quick

For minor, low-risk work such as documentation typos, simple formatting fixes, or trivial one-file changes.

```yaml
execution_mode: quick
roles:
  - queen
  - forger
  - sentinel
maximum_fix_cycles: 1
require_risk_analysis: false
require_adversarial_validation: false
```

**When to use:** Typo fixes, formatting, trivial changes with no behavioral impact.
**When not to use:** Any change that affects runtime behavior, tests, or external interfaces.

---

## Standard

Default for most development tasks: bug fixes, small features, test improvements.

```yaml
execution_mode: standard
roles:
  - queen
  - scout
  - architect
  - forger
  - sentinel
  - scribe
maximum_fix_cycles: 2
require_risk_analysis: false
require_adversarial_validation: false
```

**When to use:** Bug fixes, small-to-medium features, refactors with clear scope, documentation updates, test additions.
**When not to use:** Security-sensitive work, cross-package changes, architecture decisions.

---

## Deep

For architecture, difficult bugs, security-sensitive work, or cross-package changes.

```yaml
execution_mode: deep
roles:
  - queen
  - scout
  - architect
  - forger
  - sentinel
  - scribe
maximum_fix_cycles: 2
require_risk_analysis: true
require_adversarial_validation: true
```

**When to use:** Security audits, performance optimization, cross-package refactors, authentication/authorization changes, data migration, API redesign.
**When not to use:** Trivial or well-understood changes where Deep mode adds ceremony without value.

---

## Audit

Read-only inspection mode. No source edits are permitted.

```yaml
execution_mode: audit
roles:
  - queen
  - scout
  - architect
  - sentinel
  - scribe
allow_source_edits: false
maximum_fix_cycles: 0
require_risk_analysis: true
require_adversarial_validation: false
```

**When to use:** Code review, security audit, performance assessment, architecture evaluation, pre-deployment review.
**When not to use:** Any task requiring implementation.

---

## Preset Selection Rules

1. The Queen may downgrade roles (e.g., skip Scribe for very small changes).
2. The Queen must not remove Sentinel from any implementation task.
3. The Queen may upgrade to a stricter preset when risks are identified mid-run.
4. The Queen should not use Deep mode for trivial changes.
5. Audit mode is the only mode that sets `allow_source_edits: false`.
