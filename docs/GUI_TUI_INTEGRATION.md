# Shared Desktop and terminal sessions

Last updated: 2026-10-24 +08:00 by Codex; implementation started 2026-10-18.

This guide describes HIVE's shared Desktop and terminal implementation, introduced
on `codex/gui-tui-integration` from main `75a08e252f86c9c48681f2d941c714d05a22cc2a`.
The supplied GUI/TUI starter is a design and behavior reference; its Demo results
are not production verification. Git and the pull request track publication status.
Implementation and the source/native Windows checks below are complete. Installer
acceptance and other platform limits are stated separately.

## Launch from source

Use Node.js 22.17 or newer and Git. Install dependencies with `npm ci` in a fresh
clone; an existing checkout with installed dependencies does not need another copy.
From the source checkout:

```powershell
Set-Location 'C:\path\to\HIVE'
npm run build
node .\bin\hive.mjs --cwd 'C:\path\to\your-repository'
```

The no-argument `hive` command opens the native interactive terminal when installed.
For Desktop, build the Electron shell, worker and renderer, then launch it:

```powershell
npm run build:desktop
npm run desktop:start
```

Choose **Attach project** in Desktop to attach the same repository. Both clients
must run as the same OS user and use the same shared catalog. Provider setup is
still required: use Desktop Settings or the existing
[CLI provider setup](CLI_BYOK_LOCAL.md). Shared provider/model IDs reference each
client's available provider configuration; sharing history does not copy API keys
or make a Desktop-only credential available to the CLI.

## Architecture and ownership

| Boundary | Source | Responsibility |
|---|---|---|
| Shared contract | `src/projects/types.ts` | Projects, workspaces, sessions, messages, runs, approvals and evidence |
| Durable service | `src/projects/service.ts`, `store.ts`, `run-control.ts` | Validated actions, request deduplication, atomic storage, ownership, cancellation and recovery |
| Existing-engine adapter | `src/projects/runtime-adapter.ts` | Chat streaming, read-only Council deliberation and Queen Code/Plan/Review execution; extension and permission integration |
| Electron transport | `src/desktop/electron/router.ts`, `project-worker.ts`, `project-worker-host.ts` | Validated IPC; one utility process per Desktop run; scoped credential delivery and persistence acknowledgments |
| GUI | `desktop/renderer/src/projects/` | Project navigation, one conversation/composer, activity, approvals and changes/checks |
| Native TUI | `src/tui/app.ts`, `project-client.ts`, `transcript-view.ts` | Terminal input/lifecycle and a projection of the same shared service |
| Legacy import | `src/projects/history.ts`, `migration.ts` | Explicit read-only preview, source digests, backups and repeat-safe import |

There is no new HTTP daemon or unauthenticated shell endpoint. Each process uses
the shared application service and catalog; cooperative filesystem locking
serializes mutations across processes. Desktop keeps the sandboxed renderer behind
the restricted preload/IPC boundary. Its worker waits for durable event
acknowledgments before completion can overtake history.

The default catalog is `~/.hive/interface-v1/catalog.json`, where `~` is the current
user's home directory. `HIVE_PROJECT_CATALOG` can select an absolute catalog path;
set the same value for both clients when intentionally using another catalog.
Isolated Desktop test/smoke profiles use their own catalog unless explicitly
configured otherwise. The saved schema has:

- Public fields: `schemaVersion: 1`, monotonic `revision`, `projects`, `sessions`
  and `warnings`.
- Projects with stable IDs, display names, repository identity, workspace records
  and `lastSessionId` as an entry hint.
- Sessions with a workspace ID, title, archive state, saved settings, messages,
  runs, import source references and optional fork provenance.
- Runs with accepted settings/effective policy, request and engine IDs, lifecycle,
  user-facing activity, approval records, actual patches/checks and review state.
- Private storage ledgers for request fingerprints/results, owning process/instance
  and cancellation requests, and migration backup locations. These ledgers are
  excluded from client snapshots.

Git repository identity is saved beside shared Git metadata at
`<git-common-dir>/hive-interface-v1/project.json`. Linked worktrees share a project
ID but retain distinct workspace IDs, paths and branches. Renaming a display name
does not change identity. After moving a repository, reattach its new location so
the catalog can refresh the saved path; preserve its Git metadata. A non-Git
folder keeps its identity under `.hivemind/hive-interface-v1/project.json`; coding
workflows still require Git. Identity is revalidated before execution.

The store refuses malformed, linked or oversized catalog files and preserves them
for inspection. Its current maximum is 32 MiB. It uses synced temporary writes and
atomic replacement, and recovers a lock only when its owner is demonstrably gone.
Do not manually remove a live or uncertain lock to force another run.

## Client state and run behavior

Shared snapshots never dictate another open client's selection. Selection, drafts
per session, search, disclosure/panel state and scroll positions belong to each
client. Desktop remembers its selected session locally; draft text and scroll
positions currently live in memory. They survive session switching and shared-data
refreshes within that client, but not a full page/app/terminal restart.
Drafts are cleared after an accepted send only if the user has not edited them
since submission. Failed sends retain text. Desktop retries an unacknowledged
unchanged send with its original request ID.

The service rejects a second active run in a session or another active HIVE run
owning the same workspace. Archive, settings changes and conversation forks cannot
hide or replace an active run. Repeating an action with its original request ID
returns its saved result; reusing that ID for different content is rejected.
Published snapshots follow durable writes. Coding activity deduplicates by engine
session ID and sequence; full snapshot revisions prevent older refreshes replacing
newer client state.

Runs progress through `queued`, `running`, `awaiting_approval` and `stopping`, then
`completed`, `cancelled`, `failed` or `interrupted`. Stop requests reach the owning
engine and remain **stopping** until acknowledgment or verified process exit.
An exited owner leaves an interrupted attempt, never an inferred completion.
Shutdown failure keeps ownership and reports the unresolved runtime.
If saving a terminal result fails, the owning client retains the original outcome
in memory and retries through normal polling. The workspace remains owned until
the result is durably saved; shutdown also retries and stays open if saving still
fails. A storage error never replaces the actual engine result. Forced process
termination while storage is unavailable can still lose this in-memory outcome.

A continuation creates a new linked attempt, retaining earlier output and partial
changes. The coding runtime loads saved provenance and verifies its workspace/
checkpoint before resume or continuation. Missing or changed history fails visibly.
Cancellation and conversation forking do not roll back files. `/fork` copies
conversation/settings into a new session; it does not clone a previous managed
coding worktree. Existing standalone coding/worktree commands remain separate.

## Providers, permissions and evidence

The workflow (**Code**, **Plan**, **Chat**, **Council**, or explicit read-only **Review**) is
separate from **Guarded**, **Standard** and **Autonomous** permission preferences.
The backend returns the effective `safe` or `changes` policy. Guarded Code starts
with `safe` and asks before applying its planned worktree changes; Plan and Review
remain read-only. Standard/Autonomous Code use `changes`; Autonomous can approve
eligible internal actions automatically, while external and always-ask actions
still require the backend's concrete approval. Existing tool restrictions remain
authoritative. Council always uses `safe`: it produces proposals and a HIVE Review
through the bundled council roles without applying patches or running tools.
It carries bounded recent conversation context while keeping the current request
as the report Goal. Images and extension capabilities are rejected before a
Council message is accepted. The composer keeps existing image drafts intact and
blocks submission until images are removed or the workflow is changed.

Cancelled Council runs retain their partial review, a bounded last-completed
handoff and the full report location in shared history. Cancellation declines
pending approvals but still waits for event persistence acknowledgements; failed
writes remain failures. Legacy Council completion events validate the bounded
review and optional Sentinel verdict before crossing the desktop bridge.

An approval names the tool, arguments, reason, verified execution workspace,
external-access flag and expiry. It applies to that action only. A decision in one
client resolves the same record in the other; stale, expired or already resolved
decisions cannot execute it again. Desktop credentials remain in the encrypted
vault and cross only the selected worker boundary. No credential is part of the
shared session contract. Existing CLI environment/keyring mechanisms remain in
use. See [extension compatibility](CLI_EXTENSIONS.md) and
[protocol limits](CLI_PROTOCOLS.md) for MCP, skills, hooks, plugins and LSP support.

Desktop OpenAI-compatible model discovery requires HTTPS or loopback HTTP
(`localhost`, `127/8`, or `::1`). Base URLs cannot embed credentials, query strings
or fragments. Discovery does not follow redirects; configure the final API base
URL directly. Local loopback HTTP endpoints remain supported.
Provider metadata is validated before it is saved, so rejected settings cannot
break later provider lists. Desktop worker adapters preserve incremental streaming
with credential redaction and cancellation. Native Anthropic and Google discovery
follows pagination with one eight-second deadline, repeated-cursor detection and
a 100-page bound; successful pages survive a later request failure. Google live
catalogs include only models advertising `generateContent` support.

Activity consists of structured role summaries, not private reasoning. Chat calls
the configured live provider; coding calls the existing Queen runtime and tools.
Selected extension capabilities requiring tools need Code/Plan/Review; Chat reports
that restriction rather than silently dropping them. Image inputs use existing
provider image validation.

Changes/checks are recorded evidence: patch state, path, workspace, base revision,
diff and binary/truncation flags; command, workspace, timestamps, output and exit
code. A check is **passed** only with successful execution evidence. Empty evidence
means no checks or changes were recorded. Saved diffs describe the recorded
attempt, and are not an assertion that later workspace edits are unchanged.
Temporary files created and deleted within a run produce no patch. Validation
results retain their command execution ID; older records use normalized command
text, task/workspace and timing to avoid counting one execution twice. The final
report takes precedence over intermediate prose for the saved assistant answer
and subsequent conversation context.
Guarded Git actions perform their own current-state verification and confirmation.
**Mark reviewed** only records inspection of a completed run; it grants no tool
permission and does not commit, merge, push or deploy.

Workspace previews check canonical containment for reads and directory listings,
including parent junctions. Protected paths such as `.git` and `.env` are checked
without case sensitivity in the filesystem and IPC boundaries. A repository
selected through its own junction remains usable.

## Import existing history and roll back

Imports are explicit; opening the new interface does not rewrite existing
`.hivemind` history. In Desktop choose **Import legacy history**. Inspect the counts,
conversation titles and warnings, then choose **Back up and import**. In the TUI:

```text
/import preview
/import confirm <digest-from-the-preview>
```

The importer reads existing CLI conversations, Code threads and active/archived
chats in the attached workspace. It keeps original session IDs, verifies source
digests again at confirmation, refuses identity collisions, and rejects imports
while the project has active runs. Changed sources require a fresh preview.
Reimporting the same digest is a no-op.

Before insertion, raw source records and a `migration-journal.json` are saved under
`<catalog-directory>/migration-backups/import-<uuid>/`. Original stores are retained.
Unknown provider/extension metadata remains in those originals and byte-preserving
backups. Imported conversations carry source path/digest references; linked coding
records retain source references, not fabricated shared runs or newly verified
patch/check results.

For rollback, stop active clients/runs and reopen the previous HIVE revision against
its original stores. **Legacy history & tools** also exposes retained Desktop
history in the current app, with new conversation/run creation disabled there.
New shared-only sessions are not written back into legacy stores; export anything
you need before reverting clients. Keep the catalog, original records, migration
journal and backups. There is no destructive automatic rollback or merge-back.

## Terminal controls

| Command/control | Result |
|---|---|
| `/help` | Current shared-session command list |
| `/projects`, `/projects attach <path>`, `/projects select <id>` | Navigate or attach project folders |
| `/sessions [search text\|archived\|select <id>]` | Find/select current or archived shared history |
| `/new [title]`, `/rename <title>`, `/archive`, `/restore [id]` | Manage sessions |
| `/model <provider> <model>`, `/mode code\|plan\|chat` | Change configured model or workflow |
| `/permissions guarded\|standard\|autonomous` | Change permission preference separately |
| `/activity`, Ctrl+O, `/diff` | Expand activity or recorded changes/checks |
| `/review`, `/review run [request]` | Mark a completed run reviewed, or run a read-only model review |
| `/fork [title]`, `/copy [all]`, `/export [path]` | Fork conversation, copy output, or export history |
| `/context`, `/compact` | Show bounded-history preview; manual compaction is unavailable and changes no saved messages |
| `/stop`, Ctrl+C while running | Request cancellation |
| `/quit`, Ctrl+C while idle | Exit and restore terminal state |
| Shift+Tab; arrows/Enter/Escape; PgUp/PgDn | Cycle workflow; operate menus; scroll transcript |
| Ctrl+J; bracketed paste | Insert a newline; paste text without executing its embedded newlines |

Provider, extension and explicitly guarded local commands retain their existing
handlers. `/mode guarded|standard|autonomous` remains a compatibility alias for
safety settings; prefer `/permissions`. The compact header and continuous transcript
replace a permanent dashboard; concept 1's 17×6 hive-only ASCII appears only in
the spacious empty state. Terminal output uses the existing escape/control sanitizer.

## Verification and remaining gates

Evidence below is for this integration worktree on Windows, completed across
2026-10-18–19 +08:00;
overlapping focused runs are not added together. Local evidence is retained under
`C:\HIVE\test-results\gui-tui-integration-20261018`.

| Layer | Recorded state |
|---|---|
| Full core | 1224/1224 passed (`core-final.log`); the initial startup-cancellation failure was repaired and rechecked |
| Post-native affected regressions | 113/113 passed (`affected-final.log`); overlaps the full core run |
| Full renderer | 194/194 passed across 30 files after the scoped model-display repair (`renderer-verified.log`); legacy chat behavior retained |
| Build/types | Core, Desktop shell/worker/renderer builds and type checks passed (`desktop-build-final.log`, `renderer-build-verified.log`) |
| Native Electron E2E | 3/3 passed on the final run (`native-e2e-final.log`) |
| Native cross-client lifecycle | 6 checks passed using actual ConPTY/Electron with a deterministic lifecycle fixture; covered local focus/drafts, remote cancellation, linked attempts/deduplication, reviewed-history restart and the visual evidence matrix (`native-shared-desktop-evidence.json`) |
| Final terminal smoke | Navigation/draft roundtrip passed; obsolete loading card absent; terminal/raw state and signal handlers restored (`native-final-smoke-evidence.json`) |
| Native visual checks | 6 captures of actual live-run evidence passed in dark/Paper at 1440px, 720px, 200% zoom and 390 CSS px, including the real proof diff; no overflow or renderer errors (`native-live-visual-evidence.json`) |
| Actual live provider | Gemini Chat and restricted Code succeeded; Code made 13 real provider requests, edited only `proof.cjs` in an isolated managed worktree, and recorded `node --test verify.test.cjs` exit 0 plus real diff/check evidence |
| npm package/install/CLI | Real pack, isolated global-prefix install and CLI shims passed; 430 tarball files checked (`npm-package-final.log`). Worktree checks reused ancestor dependencies without a duplicate install |
| Release configuration/PE icon/ASAR | 13/13 passed, including manual PE icon/metadata and flushed-ASAR packaging checks (`package-icon-release-checks.log`) |
| Standard packaged/portable diagnostics | Actual packaged executable safeStorage/production-worker smoke and portable-wrapper smoke passed (`packaged-smoke-final.log`, `portable-smoke-final.log`); these use deterministic diagnostics |
| Final manual release assembler | Fixed staging to embed HIVE PE resources before prepackaged assembly; actual NSIS/portable builds, packaged safeStorage/utility-process smoke and portable-wrapper smoke passed. All 405 compiled ASAR files match final dist; all 7 icon sizes, HIVE version metadata and `asInvoker` manifest passed audit (`manual-package-resource-evidence.json`, `manual-package-verified.log`, `manual-smoke-roots.json`) |
| NSIS install/uninstall | Not run: installation would overwrite the pre-existing `%LOCALAPPDATA%\hive-updater\installer.exe`. Its hash remained unchanged; no registry/shortcut mutation or installer cleanup was performed (`installer-portable-postflight.json`) |
| Original checkout preservation | Original main HEAD, index tree, status and all 41 captured file hashes matched (`preservation-final.json`) |

The live proof establishes that scoped adapter/provider/tool path; it does not
establish every provider, model or task quality. The supplied starter's 29 automated,
23 Linux PTY and 12 browser scenarios remain starter-only evidence.
No CI run, commit, push, merge or published release is claimed for this new scope.

Automatic approval review rejected the manifest-scoped verification cleanup with
"blocked by policy" before execution. Build/package outputs, staging, test cache,
the extracted starter copy and one temporary rendering helper remain; exact paths
are in `cleanup-final.json` under the evidence directory. No alternate deletion was
attempted. The local verification handoff retained the `codex/gui-tui-integration`
source worktree; its current publication status is tracked by Git.
Evidence, source assets, protected profiles, migration backups and unmerged product
fixture worktrees are retained. The verification worker removed its three helper
scripts and five temporary controller files before this cleanup rejection.

Reproduction commands are defined in `package.json`:

```powershell
npm run lint
npm test
npm run test:desktop-renderer
npm run build:desktop
npm run desktop:e2e
npm run test:desktop-release
npm run test:package
```

Use isolated fixture/profile/catalog paths for acceptance, installed browser
channels, and an external-to-repository temporary directory for Git-sensitive
tests. Follow the machine's `AGENTS_MAINTENANCE.md` for manifests, ownership and
cleanup. Packaging instructions are in [the Windows release guide](WINDOWS_DESKTOP_RELEASE.md);
prior installers are not proof of this new revision.

Remaining boundaries include NSIS install/uninstall acceptance, native macOS/Linux
terminal checks, broad assistive technology/clipboard/IME checks and measured
large-history performance. The catalog is local single-user storage with full
snapshots, not cloud sync or a multi-user service. Saved history remains complete;
runtime context uses the existing recent-message history budget of 48,000
characters. The newest message is retained even if oversized; this is a context
selection budget, not a hard token cap or a user-invoked compact operation.
