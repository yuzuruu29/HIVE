# HIVE Windows Desktop Companion Design

Date: 2026-07-14  
Status: Approved  
Initial platform: Windows 10/11 x64

## Product decision

HIVE will add a Windows x64 Electron companion around the existing repository-local coding runtime. The desktop app is a companion, not a second orchestration engine: existing coding sessions, provider routing, safety policy, persistence, reports, and runtime events remain the source of truth. The desktop layer supplies durable conversational threads, a safe process boundary, repository navigation, encrypted desktop credentials, and an explicit Git review flow.

The first release is optimized for one local user. It permits one active coding run per canonical real repository path while allowing independent repositories to run concurrently. It does not add cloud accounts, team sync, remote execution, billing, background agents after the app exits, or a general-purpose terminal.

## Window and three-pane interaction model

The main window has three persistent panes:

1. The left navigation pane shows the selected repository, recent repositories, active threads, archived threads, and the command to create a thread. Selecting a repository never silently starts a run.
2. The center conversation pane shows the durable thread timeline, a composer, run controls for the current turn, and concise assistant results. User, assistant, and system messages are thread content. Raw tool output is not thread content.
3. The right activity pane shows the coding-session state for the selected turn: plan and agent activity, validation/review outcomes, changed files, diff/status inspection, and guarded Git actions. Closing or resizing this pane does not affect the running session.

The renderer may optimistically show a submitted message, but the main process confirms persisted state before the message is treated as durable. Errors remain associated with the request and can be retried without duplicating a successful write.

## Threads, turns, and coding sessions

A desktop thread is a durable human-readable conversation stored as `ThreadRecordV1`. It has one safe filesystem ID, a title, creation/update timestamps, an archive flag, complete messages, and references to coding runs. Archiving is reversible at the data level; v1 exposes no permanent-delete operation.

A turn begins with one required user message. A conversational response that does not run code may add an assistant message without a run. A coding turn creates or resumes an existing HIVE coding session and adds a `ThreadRunRef` that links the initiating user message to that coding session ID and its current status. The coding session remains authoritative for tasks, events, tool calls, command output, validation, review, files, and final reports. The thread stores only the run reference and human-facing messages; it does not copy raw session/tool output into the conversation.

The model objective is deterministic. The current user message is required, must be non-empty, and cannot exceed 20,000 characters. Context starts with that message, then includes prior messages newest-first under a total 20,000-character budget. When the budget is exceeded, older messages are dropped first. Context is constructed locally from persisted messages: there is no provider-generated summary, hidden summarization call, or tool-output injection.

The renderer never supplies an objective to `run.start`. It supplies only the selected repository root, thread ID, current user-message ID, and bounded coding options. The run manager reloads that persisted thread and calls `buildThreadObjective`, preventing renderer text from diverging from durable thread history. Start scans all persisted repository threads for nonterminal runs, reserves the canonical repository before launching the runtime, and returns after the run reference is durable; execution and event persistence continue in the background. Resume and cancellation identify repository, thread, and coding-session ID, and only paused runs can resume. Cancellation reconstructs persisted state after restart, waits up to five seconds for cooperative abort, optionally force-terminates the runtime, and prevents late completion from replacing the durable cancelled state.

## Process architecture and trust boundaries

Electron uses four explicit boundaries:

- The main process owns windows, repository selection, AppData paths, encrypted credentials, utility-process lifecycle, and the allowlisted IPC command router.
- A context-isolated preload exposes a narrow typed API. `nodeIntegration` is disabled in the renderer, remote content is not loaded, navigation and new-window creation are denied by default, and arbitrary filesystem or process APIs are never bridged.
- The renderer owns presentation and ephemeral UI state only. It cannot read credentials, launch commands, or write repository files directly.
- An Electron utility process hosts the existing HIVE coding runtime. Long-running coding sessions never execute in the renderer or block the main event loop. The main process starts it with structured inputs, forwards normalized runtime events, supports cancellation, and treats unexpected exit as a failed or resumable run rather than a completed one.

IPC uses the public `DesktopCommand` request union and `DesktopEvent` union. Every request carries a request ID; errors return redacted, user-displayable messages. IPC payloads are validated at the main-process boundary. Repository and thread paths are resolved from an already selected repository root rather than accepted as arbitrary renderer-supplied write destinations.

The command union covers repository/thread/run work, provider and credential metadata, change diffs, guarded Git previews and confirmations, and bounded external open-in-editor/terminal/explorer actions. Runtime forwarding uses the canonical coding `RuntimeEvent` unchanged inside a desktop event, while separate worker starting/started/stopped/failed events describe the utility-process lifecycle.

## Hybrid persistence model

Repository-portable work belongs to the repository:

- Desktop threads: `<repo>/.hivemind/threads/<thread-id>/thread.json`
- Existing coding sessions and reports: the current `.hivemind` session/report locations
- No credential values, window state, or machine-specific recent-repository data

Machine-local state belongs under Electron `app.getPath("userData")` in the user's AppData directory:

- Recent repository locations and last-opened repository
- Window bounds and non-sensitive UI preferences
- Encrypted provider credential envelopes and credential metadata
- Desktop logs after secret redaction

Thread JSON is schema-versioned and validated on load and save. IDs permit only 1–96 ASCII letters, numbers, dots, underscores, or dashes and cannot traverse directories. Before every read or write, the store resolves the repository root and every existing target ancestor and rejects junction, symlink, or reparse-point paths whose real location escapes that root. Creation reserves the thread directory with one exclusive `mkdir`, so concurrent callers for one ID have exactly one winner without a check-then-write race. Writes use an exclusive temporary file, flush, and atomic rename. A missing thread cannot be created through `save`; a malformed, unsupported, mismatched, or unredacted existing snapshot raises a corruption error and is never overwritten. Listing does not silently discard a corrupt or redirected safe-ID thread. Full valid thread content persists; v1 has archive but no permanent delete.

## Credentials

Desktop-entered credentials never enter repository JSON, thread messages, logs, command arguments, environment snapshots, IPC events, or renderer persistence. The main process encrypts credential values with Electron `safeStorage` and stores only exact-shape encrypted envelopes in AppData; unknown fields, including accidental plaintext fields, make an envelope corrupt and are never silently retained or rewritten. Provider ID, credential kind, update time, and a non-secret display hint may remain as metadata.

The renderer can list non-secret provider/credential metadata, configure non-secret provider settings, and set, replace, remove, or test a credential through dedicated commands. Secret input exists only on the set/replace write-command payloads. There is no renderer `credential.resolve` command, no plaintext read response, and no secret-bearing desktop event or test result. The internal `CredentialResolver` gives the utility runtime a credential only for the selected provider and only in memory for the active operation. All persisted thread/session text passes through runner-compatible redaction plus known provider-token patterns before disk write. If `safeStorage` reports encryption unavailable, v1 refuses to persist a new plaintext credential and explains that limitation; it does not add a plaintext fallback.

## Guarded Git flow

Git inspection is read-only by default. The activity pane may show repository status, branch, HEAD, changed paths, and diffs. HIVE does not automatically stage, commit, push, switch branches, discard changes, force-push, or open a pull request.

Mutations are explicit and sequenced:

1. Refresh status and diff.
2. Show the exact paths and proposed action.
3. Ask for a deliberate user confirmation.
4. Bind the confirmation to the action and observed HEAD.
5. Recheck HEAD and worktree assumptions immediately before mutation.
6. Run the bounded action and refresh status.

The preview request contains the complete proposal, including repository root and coding-session ID, reviewed paths and message for a commit, the fixed `origin` remote for a push, pull-request base/title/body/draft, or an explicit discard action. Worktree path and `hive-coder/<coding-session-id>` branch are always derived internally. Preview inspects the derived worktree HEAD; the returned token expires after five minutes, is one-use, and is bound to that exact canonical proposal and HEAD. Confirmation resubmits both the token and unchanged proposal; changing any detail, action, or HEAD invalidates it.

A commit loads the persisted coding session, requires terminal success, at least one latest validation result with every latest result passed, a passed latest review, and an exact unique match with the recorded repository-relative paths before scoped staging. Push and pull-request creation operate only on the derived HIVE branch; neither is triggered by commit, and pull-request creation never pushes implicitly. Before preview and confirmation, pull-request creation verifies that the remote branch exists at the same HEAD as the local derived branch. Discard removes only the derived HIVE worktree/branch and verifies that both the worktree `.git` marker and branch reference are gone. Destructive resets, cleans, checkout-based discards, force pushes, credential-bearing remote URLs, and arbitrary Git argument strings are outside the service contract. Existing dirty work belongs to the user and must not be swept into a desktop action without selection and confirmation.

## Failure and recovery behavior

- A missing thread returns `null`; a corrupt thread raises a typed corruption error with no rewrite.
- A utility-process crash marks the affected run failed or paused according to the persisted coding-session state. Relaunch uses the existing session resume path rather than inventing a new thread history.
- Cancellation is cooperative first and bounded; the UI reports whether the utility process acknowledged it.
- Renderer reload reconstructs threads from repository JSON and run state from existing coding sessions.
- All displayed errors and stored logs are redacted. Secret-bearing raw provider errors are not forwarded.
- Schema v1 readers reject unknown schema versions. A future migration must be explicit, tested, and preserve the original until success.

## Testing and release assumptions

Core contracts, context selection, persistence, redaction, corruption handling, and guarded Git policy are TypeScript modules tested with Node's test runner. Tests import built `dist` modules, so compilation precedes direct test execution. Filesystem tests use temporary repositories and verify Windows-safe paths and atomic-write cleanup.

Electron work adds main/preload IPC contract tests, utility-process lifecycle tests, renderer component tests, and Windows smoke tests for launch, repository selection, thread recovery, cancellation, encrypted credential round trips, and guarded commit/push confirmations. CI must build and test on Windows x64 before release. Cross-platform unit success alone is not release evidence.

The first distributable targets Windows x64. Code signing, installer format, update channel, crash reporting, and publication credentials are release decisions that must be configured before a public build; they are not silently invented in the core task. Until signing is configured, artifacts are internal evaluation builds and must be labeled accordingly. macOS/Linux packaging, auto-update, protocol handlers, shell integration, and Store distribution are out of v1 scope.

## Public core boundary

`src/desktop` owns the stable desktop-facing contracts and pure/repository-local implementation:

- `ThreadRecordV1`, `ThreadMessage`, and `ThreadRunRef`
- `DesktopCommand` and `DesktopEvent`
- `CredentialResolver`, `ThreadStore`, `DesktopRunManager`, and `GuardedGitService`
- `JsonThreadStore`
- `DefaultDesktopRunManager`, `DesktopCredentialVault`, `JsonCredentialEnvelopeStore`, and `DefaultGuardedGitService`
- deterministic current-turn context and `buildThreadObjective`

Electron-specific imports do not enter this core. That keeps persistence and context behavior testable without launching Electron and lets the future main process depend on the core rather than reimplement it.
