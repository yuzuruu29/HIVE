# AGENTS.md

## Cursor Cloud specific instructions

HIVE is a **local-first** Node.js + TypeScript product (CLI/TUI plus a Windows Electron desktop cockpit) that shares one TS core. There are **no backend servers, databases, or queues** to start. Real multi-agent coding/chat runs need an LLM provider, but the Scout context engine and provider configuration work fully offline.

### Environment
- Node `>=22.12.0` (see `engines` in `package.json`) and `git` are required and already present. The package manager is **npm** (`package-lock.json`); there is no pnpm/yarn/workspace tooling.
- The update script runs `npm ci`, so dependencies are refreshed on startup.

### Standard commands (defined in `package.json`)
- Build core: `npm run build` (`tsc`). Watch mode: `npm run dev`.
- Lint: `npm run lint` (`tsc --noEmit`).
- Tests: `npm test` (Node's built-in `node --test`, run serially). Note `pretest` rebuilds first.
- Run the CLI: `node bin/hive.mjs <command>` (e.g. `status`, `mode`, `scout`, `providers`). `npm run hive -- <command>` also works.

### Non-obvious caveats
- **Known pre-existing test failures:** `npm test` reports `pass 377 / fail 4` on Linux. All 4 failures are in `tests/desktop-electron.test.mjs` and are OS-specific: they assert Windows path semantics (e.g. `path.isAbsolute("C:\\work")`, `file:///C:/...` renderer URLs), which resolve differently under POSIX. This exact `377/4` result also occurs on GitHub Actions' `core` (ubuntu) job on `main`, so it is **not** an environment problem — do not "fix" it by editing code. Treat a green environment as reproducing this same result.
- **`hive` with no arguments launches a blocking interactive Ink TUI.** In non-interactive/automated contexts always use an explicit subcommand instead.
- **Desktop cockpit is Windows-targeted.** electron-builder is configured for `win` only, and `desktop:pack`/`desktop:dist`/`desktop:e2e`/`desktop:smoke` expect Windows. Launching Electron on this headless Linux VM would require a virtual display (e.g. `xvfb`); the CLI/TUI is the surface to exercise here. `npm run test:desktop-renderer` (Vitest + jsdom) does run headlessly on Linux.
- **Runtime state is written to gitignored dirs** `.hive/` (mode/provider config) and `.hivemind/` (sessions, hivebot runs, reports). Provider API keys are referenced via env vars (see `.env.example`) and never stored in config.
