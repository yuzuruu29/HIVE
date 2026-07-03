# Contributing to HIVE

Thank you for contributing! HIVE relies on its community to build new agent presets, improve safety guardrails, and harden the core orchestrator.

## Quickstart

1. Clone the repository and install dependencies:
   ```bash
   npm ci
   ```
2. Build the workspace:
   ```bash
   npm run build
   ```
3. Run the tests:
   ```bash
   npm test
   ```

## Development Guidelines

- **Branch Naming**: Use `feat/`, `fix/`, `docs/`, or `chore/` prefixes.
- **Safety First**: Do not weaken existing safety tests or validation logic. If you change how `.hivemind/` isolation works, you must provide new tests proving that worktrees remain isolated.
- **No Broad Staging**: Commit only the files you intend to modify (`git add -p` is your friend). Avoid broad `git add .` to prevent accidental credential leakage.
- **No Secrets**: Never commit actual API keys or credentials. Use the `.env.example` file and mock keys in tests (e.g., `sk-leak-guard-*`).

## Pull Requests
- Ensure `npm run lint`, `npm run build`, and `npm test` are completely green locally before opening a PR.
- Keep PRs focused on a single feature or bug fix.
- Follow the explicit confirmation paths for any UI changes related to the Editor Client's commit/push capabilities.
