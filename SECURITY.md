# Security Policy

## Supported Versions

Only the current major version of HIVE is actively supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues. 

Instead, report them privately via the GitHub Security Advisory "Report a vulnerability" tab, or email the maintainers directly.

We are particularly interested in reports concerning:
- Prompt injection vulnerabilities that escape the `.hivemind/` worktree sandbox.
- Bypasses of the explicit approve-to-commit UI gates.
- Telemetry or execution patch extraction vulnerabilities.

You should receive a response within 48 hours. If the vulnerability is confirmed, we will coordinate a fix and an embargoed release schedule before public disclosure.
