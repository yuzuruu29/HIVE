# Validation Report

The full validation policy is defined in [verification-policy.md](../references/verification-policy.md).

## Layers

1. **Static validation** — Syntax, formatting, linting, type checking
2. **Automated testing** — Unit, integration, contract, regression
3. **Behavioral validation** — Execution on representative prompts
4. **Safety review** — Destructive ops, secrets, scope, approvals
5. **Portability review** — All adapters and installation methods

## Verdict

| Verdict | Meaning |
|---------|---------|
| PASS | All criteria satisfied |
| PASS WITH LIMITATIONS | Core pass, documented limitations |
| FAIL | One or more criteria not satisfied |
| BLOCKED | Infrastructure or access unavailable |

## Requirements

- Report exact commands and outcomes.
- Do not claim tests passed unless actually run.
- Distinguish code failures from environment limitations.
- Return actionable findings for any FAIL verdict.
