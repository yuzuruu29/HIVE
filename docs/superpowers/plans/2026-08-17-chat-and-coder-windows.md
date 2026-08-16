# Chat + Coder Windows — Claude/ChatGPT-parity chat surface for HIVE Desktop

Branch: `feat/chat-cockpit` (after Task 0 lands the engagement work under it).
Goal: turn HIVE Desktop into two top-level surfaces — **Chat** (the primary,
Claude/ChatGPT-parity conversational UI with streaming, personas, receipts,
and Council/hivebot mode) and **Coder** (the existing verified harness
cockpit, unchanged in function, releasable as its own OS window). The chat
surface is frontend-silent today: the CLI chat engine already streams
(`createChatEngine.complete` with `onChunk`), persists sessions
(`ChatSessionStore`), and routes BYOK roles — the desktop bridge simply has no
chat commands yet. This plan adds them end-to-end.

Design read (design-taste-frontend): *developer-desktop chat product UI
(Claude/ChatGPT parity) for technical users, dark retro-terminal violet
language, hand-rolled CSS + motivated micro-motion.* Dials: Chat view
VARIANCE 4 / MOTION 5 / DENSITY 5 (airy conversation, not a cockpit). Coder
view keeps DENSITY 8. The taste skill is written for marketing pages; apply
only its app-relevant rules — motivated motion, no AI-slop, one-accent lock,
reduced-motion gating, ASCII-safe glyphs.

Research note: references were fetched 2026-08-17. 21st.dev, motionsites.ai,
and prompt-kit timed out from this machine and MUST be opened live by the
executing agent while building Tasks 4–7 (failures were transient network, not
nonexistent sites). What to pull from each:
- **21st.dev** — chat/prompt-input component patterns, composer layouts.
- **prompt-kit** (prompt-kit.com/docs) — `prompt-input`, `message`,
  `chat-container` (scroll behavior), `code-block`, `loader`, `reasoning`.
- **Vercel AI Elements** (ai-sdk.dev/docs/ai-sdk-ui/ai-elements) —
  Conversation, Message, PromptInput, Response (streaming markdown), Loader,
  Suggestion, Reasoning, Tool-call cards. Our mirrors are hand-rolled
  (zero-dep rule) but copy interaction contracts, not code.
- **assistant-ui.com** — thread/composer/action-bar (copy, retry, feedback).
- **motionsites.ai** — motion language: streaming caret, message entry,
  ambient background treatments.

## Global Constraints

- Zero new runtime dependencies. The engagement branch already ships a
  hand-rolled markdown renderer (`desktop/renderer/src/markdown.tsx`) — reuse
  it; do not add react-markdown/shadcn/ai-elements packages.
- Brand contract: `hive-brand-kit.json` — Void Black/Deep Violet palette,
  ASCII-safe glyphs only (no emoji, no block-element Unicode without an ASCII
  fallback; the typing caret is a CSS element, not a glyph), retro-terminal
  tone.
- Every animation behind `@media (prefers-reduced-motion: no-preference)` or
  killed by the existing reduce block.
- Accessibility: the chat stream is `role="log" aria-live="polite"`; composer
  labeled; all popovers/dropdowns keyboard-navigable; receipts truthful —
  never fabricate token numbers.
- Protocol discipline: every new command/event shape gets strict validation in
  `src/desktop/electron/contracts.ts` and registration in
  `command-manifest.ts`. All additions are ADDITIVE — existing commands,
  events, and coder behavior must not change shape or semantics.
- BYOK/secret discipline: the chat service resolves providers through
  `ChatEngine`/`ProviderRouter` exactly like the CLI; secrets never cross IPC;
  role slugs accept kebab-case AND camelCase via `normalizeChatRole`
  (`src/chat/roles.ts`).
- Core tests: `.mjs` under `tests/`, run `npx tsc` first, load `../dist/...`.
  Renderer tests: Vitest + jsdom, co-located `*.test.tsx`.
- Streaming chunk events are HIGH-FREQUENCY: worker coalesces chunks into
  batches flushed every ~60 ms (or on 2 KB accumulation) so IPC isn't flooded.
- Windows, git-bash. Platform-neutral code. YAGNI per task.

## Task 0: Land the engagement upgrade as this plan's baseline

The engagement implementation (11 tasks, ~950 insertions) currently sits
uncommitted on `main`. Before anything else:

1. `git switch -c feat/chat-cockpit` (carries the working tree), then commit
   the engagement work as ONE commit: `feat(desktop): engagement upgrade —
   live turn UX, palette, hive view, settings`. Include the plan file
   `docs/superpowers/plans/2026-08-16-desktop-engagement-upgrade.md` in it.
2. Verify green: `npm run lint`, `npm run typecheck:desktop-renderer`,
   `npm run test:desktop-renderer`, `npm test` (must stay 381).
3. All subsequent tasks branch from here. Do NOT include this plan file in the
   engagement commit; commit it separately as `docs: capture chat+coder
   windows plan`.

## Task 1: Bridge protocol — chat commands + streaming events (core)

Files: `src/chat/types.ts` (edit — export desktop-safe DTO types),
`src/desktop/types.ts` (edit), `src/desktop/electron/contracts.ts` (edit),
`src/desktop/electron/command-manifest.ts` (edit),
`tests/desktop-chat-protocol.test.mjs` (new).

1. New DTOs (payload-safe, no classes):
   `DesktopChatSummary { id, title, role, updatedAt, messageCount }`,
   `DesktopChatConversation { id, cwd, role, ground, createdAt, updatedAt, messages: DesktopChatMessage[] }`,
   `DesktopChatMessage { id, role: "user"|"assistant", content, at, receipt? (reuse ChatReceipt) }`.
   `title` derivation: first 80 chars of first user message, service-side.
2. Commands (all `DesktopCommandBase`):
   `chat.list`, `chat.create { input: { role?: string; ground?: boolean } }`,
   `chat.load { conversationId }`, `chat.archive { conversationId }`,
   `chat.route { input?: { role?: string; providerId?: string; model?: string } }`
   (returns resolved route for the trust chip),
   `chat.send { input: { conversationId, content, role?, providerId?, model?, ground? } }`,
   `chat.cancel { conversationId }`.
3. Events (all `DesktopEventBase`):
   `chat.listed { conversations }`, `chat.changed { conversation }`,
   `chat.started { conversationId, turnId }`,
   `chat.chunk { conversationId, turnId, chunk, seq }` (batched text only),
   `chat.completed { conversationId, turnId, message: DesktopChatMessage }`,
   `chat.failed { conversationId, turnId, message, recoverable }`,
   `chat.route.resolved { role, providerId, model, source, degraded }`.
4. `contracts.ts`: strict validators for every new shape — ids against the
   existing chat-id pattern (`CHAT_SESSION_ID_PATTERN`), content ≤ 24_000
   chars, chunk ≤ 2_048 chars, seq non-negative int, enums constrained. Update
   the event-type union checks too — contracts validate BOTH directions.
5. `command-manifest.ts`: register the 8 commands with their risk class
   (all read/write-local, none guarded-git class).
6. Tests: validator acceptance/rejection per command and event (bad id, over-
   length chunk, negative seq, unknown field → each must throw), additive
   parity with existing validators.

## Task 2: Worker chat service (core)

Files: `src/desktop/chat-service.ts` (new),
`src/desktop/electron/worker.ts` (edit — dispatch + wiring),
`src/desktop/index.ts` (edit — export),
`tests/desktop-chat-service.test.mjs` (new).

1. `ChatService` class: constructed with `(projectRootProvider: () => string, emit: (event) => void)`. Internals: one `ChatSessionStore` per cwd
   (cache by path), per-conversation `AbortController`, per-conversation
   engine cache (`createChatEngine(cwd, conversationId)`).
2. `send`: append user message via store, emit `chat.changed` +
   `chat.started` (turnId = `turn-${Date.now().toString(36)}-n`), then
   `engine.complete({ role, prompt: conversation transcript via the same
   turn-window the CLI uses — reuse the CLI's transcript builder if exported,
   else messages.map(...).join — keep parity with chat-cli.ts, signal,
   onChunk })`. `onChunk` pushes into a 60 ms batched emitter; final
   `chat.completed` carries the assistant `DesktopChatMessage` with receipt
   (providerId/model/tokens/latency from `ChatCompletionResult.receipt`).
   Errors → `chat.failed` with `recoverable: true`. Abort → treat as failed
   with message "Cancelled." and recoverable true.
3. `ground: true` in send: build the Scout grounding pack through
   `src/chat/grounding.ts` and prepend per the CLI's grounding behavior.
4. `chat.route`: call `engine.resolveRoute(role ?? conversation.role, override)`
   and emit `chat.route.resolved`.
5. `chat.cancel`: abort the conversation's controller (no partial-complete
   event).
6. `worker.ts`: follow the existing dispatch pattern (switch case → service
   call → emit). ChatService event emission flows through the same
   `onEvent` → renderer channel as run events.
7. Tests (node --test, dist imports): service with injected stub engine —
   send flow emits started → chunks → completed with receipt; chunk batching
   (two chunks within 50 ms arrive as one); cancel aborts; ground prepends
   pack (stub grounding module seam like CLI tests do); failed completion
   emits recoverable. Follow `tests/chat-core.test.mjs` conventions for stub
   shape.

## Task 3: Renderer mode switch (Chat | Coder shell)

Files: `desktop/renderer/src/state.ts` (edit),
`desktop/renderer/src/App.tsx` (edit),
`desktop/renderer/src/components/ModeSwitch.tsx` (new),
`desktop/renderer/src/components/ModeSwitch.test.tsx` (new),
`desktop/renderer/src/prefs.ts` (edit), `styles.css` (edit).

1. State: add `mode: "chat" | "coder"` + `ui.mode` action + chat slice
   (`chat: { conversations, activeId, streaming: Record<convId, { turnId, text } | undefined>, councilByConv: Record<string, CouncilStage[]> }`
   — extend in later tasks). Reducer handles every Task 1 event; chunks append
   `text` only when `turnId` matches the active stream.
2. `App.tsx`: when `mode === "chat"` render `<ChatView>` (Task 4) inside the
   same `.app-shell`/topbar; the current `.cockpit-grid` mounts only in coder
   mode. Zero behavioral edits to the coder path.
3. `ModeSwitch`: topbar segmented control `Chat | Coder` (aria
   `role="tablist"`, `aria-selected`), active cell gets the aria-current
   thread-row treatment. Persistence `prefs.mode`; Task 8's `?view=` query
   param overrides prefs for that window. Shortcuts: `Ctrl+Shift+1` chat,
   `Ctrl+Shift+2` coder — registered next to the existing keydown block;
   palette gains "Switch to Chat/Coder" commands.
4. Tests: switch flips state + writes prefs; reducer chunk-append guards stale
   turnId; coder regressions covered by existing App tests.

## Task 4: Chat view — sessions rail + welcome surface

Files: `desktop/renderer/src/components/chat/ChatView.tsx` (new),
`chat/SessionRail.tsx` (new + test), `chat/Welcome.tsx` (new + test),
`styles.css` (edit).

1. Layout: `.chat-grid = columns minmax(240px, 18vw) 1fr`; rail on the left
   (collapsible via existing `ui.rails` left toggle). Rail list: conversation
   title, d, role chip, updatedAt — reuse `.thread-list` visual language with
   `aria-current`; filter input (substring, case-insensitive); "New chat"
   button on top; archived collapsed in `<details>` like threads.
2. Empty state (no conversation selected): `Welcome` — HIVE wordmark +
   glyphline ASCII bee (reuse EmptyWorkspace art, smaller), six persona cards
   + Auto card (name + one-line description + `[route]` chip showing
   `chat.route.resolved` provider/model when loaded), 3 suggestion prompts
   (same heuristic as `PromptStarters`, repo-segment flavored). Clicking a
   persona card creates a conversation with that role; clicking a suggestion
   creates + sends.
3. Persona card copy comes from `src/chat/roles.ts` descriptions — export a
   desktop-safe description map from there if it isn't one already.
4. Motion: `.anim-in` on cards; card hover uses the engagement-branch button
   glow. ASCII glyphs only on cards.
5. Tests: rail lists + filters + creates; welcome creates conversation with
   chosen role; suggestion click sends (stub bridge).

## Task 5: Streaming conversation surface

Files: `chat/ChatStream.tsx` (new + test), `chat/MessageList.tsx` (new),
`chat/TypingLoader.tsx` (new), `chat/MessageActions.tsx` (new),
`styles.css` (edit). Reuse `Message.tsx` + `markdown.tsx` from the engagement
work for completed messages.

1. `ChatStream`: `role="log" aria-live="polite"`; renders completed messages
   newest-last via `Message`; when `streaming[convId]` exists, renders the
   in-flight assistant text in a `.message-streaming` Message variant —
   markdown rendered live per batched chunk, followed by a CSS caret
   (`.stream-caret`: 0.55em violet bar with `pulse-glow`; element, not glyph).
2. Before the first chunk arrives, show `TypingLoader`: three-dot ASCII
   ellipsis shimmer (`[...] ` + `anim-shimmer` strip) with the resolved route
   line `auto → coding · provider/model`.
3. Auto-scroll: same near-bottom guard as TurnProgress (within 80 px only).
4. `MessageActions` (assistant messages, visible on hover/focus): Copy
   (whole message), Retry (deletes nothing; re-sends the preceding user
   message via `chat.send`), receipt chip render (reuse the Task-4 engagement
   `.receipt-chip`; now guaranteed to have data).
5. Perf: streaming text held in reducer state but the MessageList body is
   memoized (`useMemo` on messages + rAF-batched chunk appends already at the
   worker + reducer level). No per-keystroke re-render of the whole list.
6. Tests: chunk append updates streaming message; completed swaps in receipt;
   actions copy/retry call bridge correctly; loader shows pre-first-chunk.

## Task 6: Composer

Files: `chat/ChatComposer.tsx` (new + test), `chat/RolePicker.tsx`
(new + test), `styles.css` (edit).

1. Auto-growing textarea (1–8 rows, then scroll) anchored bottom-center,
   max-width 78ch, `Enter` sends / `Shift+Enter` newline (prefs
   `composerSendWithEnter` toggle, default true — when false, Ctrl+Enter
   sends). Char counter right-aligned like the coder composer.
2. Left chip cluster: `[role: auto ▾]` (RolePicker popover: auto + 6 personas
   kebab labels, each row shows the resolved route provider/model via
   `chat.route` on mount, aria `role="listbox"`), `[/ground]` toggle
   (grounding state per conversation, default false), `[provider/model ▾]`
   override popover listing `state.providers` (clears to role default when
   re-selected), `[/council]` toggle consumed by Task 7.
3. Right: Send button (primary) — transforms into Stop (`[■]`-free ASCII
   `Stop`) while streaming, dispatching `chat.cancel`.
4. Disabled states mirrored honestly: while `chat.started`-pending or
   streaming, textarea stays editable (queued edits allowed) but Send becomes
   Stop; on `chat.failed`, composer restores the previous content into the
   draft (like coder Conversation does).
5. Tests: role picker selects + fetches route; ground toggle persists per
   conversation; Enter/Ctrl+Enter honor the pref; Stop sends cancel; failure
   restores draft.

## Task 7: Council (hivebot) mode in Chat

Files: `src/chat/hivebot.ts` (edit — additive stage callback),
`tests/hivebot.test.mjs` (edit — assert callback parity),
`src/desktop/types.ts` + `contracts.ts` + `command-manifest.ts` (council
commands/events), `src/desktop/council-service.ts` (new),
`tests/desktop-council-service.test.mjs` (new),
`chat/CouncilTranscript.tsx` (new + test), `styles.css` (edit).

1. Core additivity: `HivebotOptions` gains optional
   `onStage?: (event: { type: "stage-started"|"stage-completed"; agent: string; attempt: number; receipt?: ChatReceipt }) => void`.
   Fire it from `emitStageStart`/`emitReceipt`/stage completion; default
   undefined keeps CLI behavior byte-identical (existing tests prove it).
2. Desktop commands: `council.start { input: { task, preset?: "quick"|"standard"|"deep"|"audit", providerId?, model? } }`,
   `council.cancel { runId }`; events: `council.started { runId, preset }`,
   `council.stage { runId, ... }` (mirrors onStage), `council.completed
   { runId, summary: HivebotRunSummary }`, `council.failed { runId, message }`.
   Council runs are keyed by runId (not conversation) — a council session is
   one-shot per task, rendered inside the active conversation as a special
   message block.
3. `CouncilService`: wraps `runHivebot(task, { cwd: current repo root,
   preset, onStage, signal })`; cancels via its AbortController.
4. Renderer `CouncilTranscript`: progressive stage blocks — header strip
   `──── FORGER · attempt 1 ────` (existing hivebot line format, styled as
   `.council-strip`), stage body markdown, receipt chips per stage; verdict
   state from stage colors; final summary card (stages, total tokens, preset,
   artifact path with an "Open artifacts folder" button via
   `external.open-explorer` on the run's artifact dir when the repo root
   contains it — guard for relative path).
5. Composer wiring: while `[/council]` is on, Send dispatches `council.start`
   with the composer text as task; preset selector appears next to chips;
   Stop dispatches `council.cancel`.
6. Tests: core — onStage fires per stage with receipts, abort works; service —
   start→stage→completed flow with injected `runHivebot` seam (mirror CLI
   tests' `createEngine` injection); renderer — progressive rendering of stage
   events + summary card.

## Task 8: Pop the Coder out into its own OS window

Files: `src/desktop/electron/main.ts` (edit),
`src/desktop/electron/contracts.ts` + `command-manifest.ts` (shell commands),
`desktop/renderer/src/main.tsx` (edit), `desktop/renderer/src/bridge.ts`
(verify), `tests/desktop-electron.test.mjs` (edit/add),
`components/TopBar.tsx` (edit — pop-out button).

1. `main.ts`: window registry `Map<string, BrowserWindow>` keyed `"chat"` /
   `"coder"`; extract current window creation into `createShellWindow(view)`.
   Event fan-out (`onEvent`) broadcasts to every live window's
   `webContents` — events are scoped + validated, so extra delivery is safe.
   New commands: `shell.open-view { view: "chat"|"coder" }` (creates or
   focuses the right window), `shell.close-view { view }` (returns to
   single-window; closing the last window keeps default quit semantics).
2. Renderer `main.tsx`: `?view=coder|chat` query param seeds the initial
   `ui.mode` for that window and suppresses the prefs write on first seed
   (choice still free afterwards via ModeSwitch).
3. Single-instance rule for Coder: only one coder window may exist —
   `shell.open-view { view: "coder" }` focuses the existing one. (The
   repository's one-active-run invariant assumes one control surface.)
4. Topbar: `[⇱]`-free ASCII button "Pop out" (`[^]`) on coder mode sending
   `shell.open-view coder`; when windows.length > 1 show a "Recombine" button
   on the chat window.
5. Tests: main-process window registry (mock BrowserWindow — follow existing
   desktop-electron tests' mocking), open-view idempotence, broadcast fan-out
   reaches both contents, single-coder enforcement.

## Task 9: Final gate + docs

Files: `README.md` (edit), `docs/HIVE_ROADMAP.md` (edit).

1. Gate, in order: `npm run lint` → `npm run typecheck:desktop-renderer` →
   `npm run test:desktop-renderer` → `npm run build:desktop` →
   `npm test` (core must stay ≥381 + new chat/council tests green) →
   `npm run desktop:e2e` if the environment supports it.
2. Golden-path test addition in `App.test.tsx`: chat mode — welcome → send →
   streaming loader → chunks → completed message with receipt; mode switch to
   coder preserves threads.
3. README: new "Chat & Coder" section replacing/extending the desktop cockpit
   bullets; note chat parity features (streaming, personas, receipts, council)
   and the pop-out window. Mark landed items in HIVE_ROADMAP.md.
4. Manual checklist (human):
   - [ ] Real streamed conversation over a configured provider (watch chunks,
   caret, receipt chip with true token counts).
   - [ ] Council run with visible stage progression and artifact folder open.
   - [ ] Pop out Coder; chat keeps receiving events; single coder window
   enforced; recombine works.
   - [ ] OS reduced-motion on: zero animation; screen reader announces stream
   without spam.

## Appendix (deferred — NOT in this plan)

- Chat ↔ Coder cross-linking: send an assistant answer straight into a coder
  thread ("make this real" button → `thread.create` + `run.start`). Powerful,
  but needs a designed handoff (approval policy, thread naming) — its own
  plan.
- Web version of the Chat surface (the deferred terminal-vs-web decision from
  the repo consolidation notes; desktop chat comes first).
- Agentic tool-loop mode toggle inside the chat window (CLI `/agent on`);
  the Coder view is the agentic surface for now.
- Message search across conversations; conversation folders/tags; export.
