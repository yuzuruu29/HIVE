# HIVE v0.5.0 Release Notes

**HIVE — Hyper Intelligence for Verified Engineering** has officially launched its V0.5.0 public release!

HIVE is an open-source agentic coding orchestrator built entirely around a verified engineering loop. It prevents rogue agent actions by sandboxing AI planning, building, testing, and reviewing into an isolated worktree, terminating with an explicit human-approval gate before pushing.

## Verification Status
**Status:** Verified (Experimental Open-Source Beta)
*HIVE has passed its core validation suite (298 passing tests) but is currently intended for safe experimental usage. Do not grant it production deployment keys directly.*

## Completed Phases
* Phase 1: Verified Patch Runner Foundation
* Phase 1.5: Durable Storage + Dashboard Surfacing
* Phase 2: Multi-Agent Council Execution
* Phase 2.5: Agentic Patch Guardrails
* Phase 3: GitHub PR Mode (with explicit confirmation UI)
* Phase 3.5: CLI Workflow
* Phase 4A: Web-based Editor Client
* Phase 5: Public GitHub Launch

## Main Features
* **The Council Loop:** Agents are automatically orchestrated into a `Planner → Builder → Validator → Reviewer` pipeline to cross-check work before surfacing it to the user.
* **Worktree Isolation:** All agentic changes happen inside an isolated Git worktree (`.hivemind/`). Your main branch and local IDE are never polluted by mid-task agent mistakes.
* **The Editor Client:** A clean Next.js web dashboard lets you watch real-time agent transcripts, inspect diffs, and toggle an uncontrolled UI checkbox to explicitly authorize remote PR generation.
* **Obsidian-Powered Memory:** HIVE tasks, state, and logs are all stored natively in `.md` format using an Obsidian vault as its primary state and knowledge database.
* **CLI Workflow:** Run preset councils via the `hive run` CLI commands with full PR generation support.

## Safety Guarantees
* **Zero Auto-Push:** Core safety limits mean agents simply *cannot* push code directly.
* **Explicit Approval:** You must click an explicit checkbox to confirm a PR.
* **Secret Redaction:** The orchestrator runs best-effort redaction on raw patches before human inspection.
* **No Credential Persistence:** Secrets and tokens are never written into `.hivemind/` task records.

## Known Limitations
* The `gh repo edit` CLI integration currently requires a pre-existing GitHub remote.
* Secret redaction is regex-based and best-effort; always review patches before pushing.
* Third-party model providers govern their own inference data policies.

## Quickstart
1. Clone the repo and `npm ci`.
2. Run `npm run dev:all`.
3. Open `http://localhost:3000/coder` and spin up your first agentic task!

## Recommended Next Roadmap Items
* Deepening Obsidian native graph integration.
* Expanding local-first model fallback logic.
* Expanding UI smoke tests to cover full E2E dashboard usage.
