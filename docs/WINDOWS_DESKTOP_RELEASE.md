# HIVE Windows desktop release

HIVE Desktop v1 targets Windows 10/11 x64. The npm CLI/TUI remains the package entry at `bin/hive.mjs`; the desktop is an additional Electron entry and does not wrap the CLI.

## Data and security boundaries

- App preferences, recent repositories, provider metadata, and Windows `safeStorage` encrypted credentials live in the Electron user-data folder under `%APPDATA%\HIVE`.
- Threads, coding sessions, reports, and isolated worktrees remain inside each repository's `.hivemind` directory.
- Credentials never enter the renderer, threads, events, reports, or Playwright artifacts. OpenAI and Anthropic require an explicit credential plus approval. Local Ollama requires explicit approval but no stored secret.
- Push and pull-request actions require separate previews and one-use confirmations. They are never automatic.
- There is no updater in v1. Download and install a newer release manually after verifying `SHA256SUMS.txt`.

## First reply in the desktop app

1. Use **Open folder** or the sidebar's **Browse** action to select your project.
   Chat history is repository-scoped and loads only after the folder is opened.
2. Open **Settings → Providers**. Configure an API provider with an encrypted
   credential, or explicitly approve a keyless local provider whose server you
   have already started. Existing credentials can be replaced through Configure.
3. Choose a model in the chat composer, then send a message. A draft can be typed
   before setup is complete and is retained while opening the folder and settings.

Normal HiveBot chat uses the desktop provider metadata and encrypted vault; it
neither requires matching CLI provider files nor borrows credentials from another
CLI account. Replacing or removing a key affects subsequent requests without a
restart. Failed saves stay in the setup dialog for correction or retry.

**Configured** means approved configuration with the required stored credential,
not proof of connectivity, model entitlement, or successful inference. Model
catalogs may include provider defaults or fallback entries. Actual account access
is established by a successful request; network/model errors remain visible.

## Local operator checklist

1. Install Node.js 22.17 or later on Windows x64 and run `npm ci`.
2. Run `npm run lint`, `npm test`, `npm run test:desktop`, and `npm run desktop:e2e`.
3. Run `npm run desktop:dist` with fresh staging/output directories. This creates per-user NSIS and no-install portable executables, then writes `dist-binaries/SHA256SUMS.txt`.
4. Run `npm run desktop:smoke` to test the unpacked app's production utility process and Windows credential encryption.
5. Compare local checksums with `Get-FileHash dist-binaries\HIVE-*.exe -Algorithm SHA256`.
6. Smoke the portable executable manually on a clean Windows account before publishing.

`WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` are optional CI secrets. When present, electron-builder signs through its normal CSC integration. Without them, local/CI artifacts remain buildable but are unsigned internal-evaluation builds; Windows SmartScreen warnings are expected and the artifacts should not be represented as production-trusted binaries.

The manual/tag release workflow uploads both `.exe` files and checksums as a workflow artifact. It never publishes through electron-builder and cannot enable automatic updates.

## Isolated packaging and smoke checks

`scripts/package-desktop.mjs` refuses existing staging, unpacked, or output directories. It never removes an earlier release to make room for a new one. After compiling, choose fresh leaf paths whose parent directories already exist:

```powershell
node scripts/package-desktop.mjs --source-root <compiled-source-root> --staging-dir <new-staging-path> --unpacked-dir <new-unpacked-path> --output-dir <new-artifact-path> --manifest <existing-scratch-parent>\cleanup-manifest.txt
```

The compiled source root must contain `package.json`, `dist`, `dist-desktop/renderer`, the release council assets/notices, and `build/desktop/icon.ico`. Installed Electron and electron-builder are resolved from this repository, so the isolated source does not need a duplicate `node_modules`. `--source-root` defaults to the current directory; other defaults remain `build/staging-app` and `dist-binaries/win-unpacked`. For a custom artifact directory, set `HIVE_RELEASE_DIR` before running `npm run desktop:checksum`.

For the smoke script, set `HIVE_DESKTOP_PACKAGED_EXE` to the unpacked `HIVE.exe`, `HIVE_PACKAGED_SMOKE_ROOT` to a fresh scratch child, and `HIVE_CLEANUP_MANIFEST` to the task manifest. `HIVE_PACKAGED_SMOKE_USER_DATA` optionally selects a new child of that root. The harness isolates the child's temporary/user-data paths, configures a dummy encrypted credential through Settings, and sends its model-catalog request only to a loopback fixture. It then runs the exact internal diagnostic and checks the UI and persisted report. This deterministic check does not establish live model inference or NSIS install/uninstall acceptance.

The smoke profile and fixture repository are retained and listed in the manifest because Chromium creates databases and the credential check creates an encrypted envelope. Apply `AGENTS_MAINTENANCE.md` before any cleanup; normal `%APPDATA%\HIVE` data is never used by this diagnostic.

To test the actual portable wrapper, set `HIVE_DESKTOP_PORTABLE_EXE` to its generated executable, `HIVE_PORTABLE_SMOKE_ROOT` to another fresh scratch child, and `HIVE_CLEANUP_MANIFEST` to the task manifest, then run `node tests/e2e/portable-smoke.mjs`. It launches the wrapper normally, attaches through a loopback debugging endpoint, checks the packaged renderer and production worker, and requires exit code 0 plus removal of the wrapper's extraction directory. This is separate from NSIS install/uninstall verification.

The packager waits for the ASAR write stream to close before starting electron-builder. The pinned ASAR API resolves before that stream is finished; starting a synchronous packaging process earlier can embed an empty archive even though the unpacked app appears complete afterward.
