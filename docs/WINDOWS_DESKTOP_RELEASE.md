# HIVE Windows desktop release

HIVE Desktop v1 targets Windows 10/11 x64. The npm CLI/TUI remains the package entry at `bin/hive.mjs`; the desktop is an additional Electron entry and does not wrap the CLI.

## Data and security boundaries

- App preferences, recent repositories, provider metadata, and Windows `safeStorage` encrypted credentials live in the Electron user-data folder under `%APPDATA%\HIVE`.
- Threads, coding sessions, reports, and isolated worktrees remain inside each repository's `.hivemind` directory.
- Credentials never enter the renderer, threads, events, reports, or Playwright artifacts. OpenAI and Anthropic require an explicit credential plus approval. Local Ollama requires explicit approval but no stored secret.
- Push and pull-request actions require separate previews and one-use confirmations. They are never automatic.
- There is no updater in v1. Download and install a newer release manually after verifying `SHA256SUMS.txt`.

## Local operator checklist

1. Install Node.js 22.12 or later on Windows x64 and run `npm ci`.
2. Run `npm run lint`, `npm test`, `npm run test:desktop`, and `npm run desktop:e2e`.
3. Run `npm run desktop:pack && npm run desktop:smoke` to test the unpacked app.
4. Run `npm run desktop:dist`. This creates per-user NSIS and no-install portable executables, then writes `release/SHA256SUMS.txt`.
5. Compare local checksums with `Get-FileHash release\HIVE-*.exe -Algorithm SHA256`.
6. Smoke the portable executable manually on a clean Windows account before publishing.

`WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` are optional CI secrets. When present, electron-builder signs through its normal CSC integration. Without them, local/CI artifacts remain buildable but are unsigned internal-evaluation builds; Windows SmartScreen warnings are expected and the artifacts should not be represented as production-trusted binaries.

The manual/tag release workflow uploads both `.exe` files and checksums as a workflow artifact. It never publishes through electron-builder and cannot enable automatic updates.
