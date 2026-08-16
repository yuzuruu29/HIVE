# Release Validation

This document defines the manual smoke-test procedure for validating a release
of The Hive Skill against a real runtime (OpenCode, Claude Code, or Codex).

These tests are not automated in CI because they require a live runtime
environment with tool access and host-agent execution.

## Prerequisites

- A compatible host runtime (OpenCode, Claude Code, or Codex) installed and
  authenticated
- Node.js 18+
- The skill installed via `npx skills add`
- Clean working tree (no uncommitted changes that would interfere)

## Smoke Tests

### 1. Isolated installation

Verify the skill can be installed into a clean directory without affecting
other projects.

### 2. Quick typo fix

Invoke the skill to fix a deliberate typo in a documentation file. Verify
the council completes with `COMPLETE` status and only the intended file
changed.

### 3. Standard bug fix

Invoke the skill to fix a deliberate bug in a test fixture. Verify the
council completes, tests pass, and the fix is minimal.

### 4. Deep security review

Invoke the skill with a security-sensitive scenario. Verify that the
Sentinel role performs adversarial validation and that the Queen produces
a risk-assessed verdict.

### 5. Audit read-only behavior

Invoke the skill in audit mode. Verify no files are modified.

### 6. Structured role handoffs

Verify that each role handoff includes status, findings, evidence, and
recommended next action in the format defined by the handoff schema.

### 7. Dirty working-tree protection

Invoke the skill with uncommitted changes present. Verify the skill does
not discard uncommitted work.

### 8. GitHub Action installation

Verify the GitHub Action installs the skill correctly in a CI workflow.

## Report Format

Each smoke test should produce a report in this format:

```yaml
smoke_test:
  runtime: <runtime name>
  runtime_version: <version>
  skill_version: <version>
  environment: <OS, Node version>
  scenario: <test name>
  command_or_prompt: <exact command or prompt used>
  files_before: <list of files>
  files_after: <list of files>
  git_diff: <summary of changes>
  verdict: <pass | fail | pass_with_limitations>
  limitations: <known limitations>
```

## Important

- These tests require a real runtime with tool access.
- Results depend on the runtime's capabilities.
- Do not add live runtime invocation to automated CI.
