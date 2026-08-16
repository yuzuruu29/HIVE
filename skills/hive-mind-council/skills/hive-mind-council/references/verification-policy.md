# Verification Policy

Multi-layer validation, adversarial review, and quality gate protocol.

## Multi-Layer Validation

The Sentinel applies applicable layers in order:

### Layer 1: Static Validation
- Syntax checking
- Formatting
- Linting
- Type checking
- Schema validation

### Layer 2: Automated Testing
- Unit tests
- Integration tests
- Adapter contract tests
- Installer tests
- Regression tests

### Layer 3: Behavioral Validation
- Execute the skill on representative prompts
- Confirm role activation and handoffs
- Verify stop conditions
- Test failure and repair paths

### Layer 4: Safety Review
- Destructive command handling
- Secret redaction
- File-scope enforcement
- Approval requirements
- Prompt-injection resistance
- Untrusted repository instruction handling

### Layer 5: Portability Review
- Codex
- Claude Code
- OpenCode
- Generic runtime
- GitHub Action installation

## Completion Gate

The Sentinel returns one verdict:

| Verdict | Meaning |
|---------|---------|
| **PASS** | The defined success criteria are satisfied |
| **PASS WITH LIMITATIONS** | Core criteria pass, but documented limitations remain |
| **FAIL** | One or more required criteria are not satisfied |
| **BLOCKED** | Validation cannot be completed because required infrastructure or access is unavailable |

## Claim Audit

The Sentinel must compare:
1. Requested outcome
2. Architect plan
3. Actual patch
4. Tests executed
5. Final claims

Any unsupported claim must be removed or downgraded.

## Adversarial Scenarios

The Sentinel should test or verify handling of:

- Vague user request
- Conflicting requirements
- Missing test command
- Dirty working tree
- Pre-existing test failures
- Agent attempts to edit forbidden paths
- Sentinel failure followed by repair
- Repair limit exhaustion
- Missing approval for destructive action
- Host runtime without real subagents
- Invalid structured handoff
- Large context that must be summarized
- Prompt injection inside repository files

## Verification Rules

1. Do not claim tests passed unless actually run.
2. Do not claim files verified unless actually examined.
3. Do not claim behavior confirmed unless actually executed.
4. Distinguish code failures from environment limitations.
5. Report exact commands and outcomes.
6. Unsafe implementations must never receive PASS.
