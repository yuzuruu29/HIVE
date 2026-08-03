# HIVE pilot delivery checklist

## Before access

- [ ] Signed scope, owners, task set, and acceptance thresholds
- [ ] Repository access uses least privilege
- [ ] Provider keys remain customer-owned and environment-based
- [ ] Data handling, retention, and incident contacts agreed
- [ ] Existing branch protection and CI requirements recorded

## Installation and baseline

- [ ] Record HIVE, Node.js, package-manager, Git, and OS versions
- [ ] Verify repository status and preserve unrelated changes
- [ ] Run existing build/lint/typecheck/tests before configuration
- [ ] Configure providers without persisting raw secrets
- [ ] Verify destructive Git, path scope, approval, and redaction controls
- [ ] Export one failed/partial and one completed run report where feasible

## Workflow trials

- [ ] Agree objective, file scope, validations, and approval points per trial
- [ ] Capture start/end time and human interventions
- [ ] Retain redacted JSON reports and customer-readable summaries
- [ ] Record unknown usage/cost as unavailable
- [ ] Triage failures without weakening repository checks
- [ ] Review diffs and unresolved findings with the customer owner

## Handoff

- [ ] Deliver configuration inventory without secret values
- [ ] Deliver operator runbook, limitations, and recovery steps
- [ ] Review pilot metrics against the baseline
- [ ] Document required remediation and optional improvements separately
- [ ] Confirm local artifacts and retention/deletion actions
- [ ] Obtain acceptance or document exact gaps
