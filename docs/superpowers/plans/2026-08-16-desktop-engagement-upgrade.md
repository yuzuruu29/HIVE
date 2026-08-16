# Desktop Engagement Upgrade — HIVE Desktop renderer

Branch: `feat/desktop-engagement` (baseline commit f6e6a6d). Goal: turn the
functional-but-static desktop companion (`desktop/renderer/`) into an engaging,
alive cockpit — live run feedback, rich messages, a hive-motif inspector,
onboarding, keyboard-first power UX, notifications, and personalization —
without changing the trust model, the bridge protocol, or the retro-terminal
brand.

The renderer today is one 320-line `App.tsx` + 151-line hand-written
`styles.css`. Messages appear only after a run finishes, agent activity is a
flat `[id] status` list, empty states are generic, and none of the brand kit's
motion/identity layer (scanlines, glow, hive-cell geometry) is used. Every
engagement win must come from data the bridge already delivers
(`runtime.event`, `run.changed`, `run.reported`, `changes.diffed`) — Task 3 and
Task 5 need **no protocol changes at all**.

## Global Constraints

- **Zero new runtime dependencies.** React 18 + Vite + Vitest/jsdom only.
  Markdown rendering, syntax coloring, palette, and motion are hand-rolled in
  this repo. (Offline/BYOK ethos; renderer ships in an installer.)
- Brand contract: `hive-brand-kit.json` is source of truth — Void Black
  `#08080B`, Deep/Vivid Violet `#5B21B6/#7C3AED`, scanlines/glow, **ASCII-safe
  glyphs only** (no emoji, no Unicode-only branding), dark retro-terminal tone.
- Every animation/transition MUST be disabled under
  `@media (prefers-reduced-motion: reduce)`. New keyframes go inside
  `@media (prefers-reduced-motion: no-preference)`.
- Accessibility: every new widget is keyboard-reachable with visible
  `:focus-visible`; the existing `.announcer` aria-live region is reused, not
  duplicated; color is never the only status signal (glyph + text stand).
- Keep the existing ARIA patterns (skip link `main-workspace`, tab roles,
  dialog semantics in `Dialog.tsx`). Do not regress them.
- Renderer tests: Vitest + jsdom, `npm run test:desktop-renderer`.
  Typecheck: `npm run typecheck:desktop-renderer`.
  Build: `npm run build:desktop`. Core suite (381 tests, `npm test`) must stay
  green — core files are touched only where a task explicitly says so.
- `App.tsx` today owns everything. Tasks decompose it into
  `desktop/renderer/src/components/*` as they land; each new component ships
  with a co-located test file. Do not leave new JSX inline in `App.tsx`.
- Read `desktop/renderer/src/state.ts` before touching state: new view-only
  actions extend the `DesktopUiAction` union; persisted UI prefs go in
  `localStorage` under key `hive.desktop.ui.v1`, NOT in the bridge.
- Do not change `src/desktop/types.ts` command/event protocol except in the
  one task that explicitly adds optional read-only fields, and there the core
  emitters must default the fields so old events still typecheck.
- Environment: Windows, git-bash. Keep code platform-neutral.
- YAGNI: build exactly what a task specifies. No speculative abstractions.

## Task 1: Design tokens, motion primitives, ambient layer

Files: `desktop/renderer/src/styles.css` (edit),
`desktop/renderer/src/components/` (create empty dir placeholder `.gitkeep`).

1. Extend the `:root` token block with a type scale (`--text-xs..--text-lg`
   matching current .62rem–1rem usage), spacing scale (`--sp-1: .35rem` …
   `--sp-5: 1.2rem` — derive from existing padding values), elevation/shadow
   tokens (`--glow-violet: 0 0 24px rgba(124,58,237,.25)`), and motion tokens
   (`--dur-fast: 120ms; --dur-med: 240ms; --ease-out: cubic-bezier(.2,.8,.3,1)`).
2. Add keyframe utilities inside `@media (prefers-reduced-motion: no-preference)`:
   - `@keyframes fade-slide-in` (opacity 0→1, translateY 6px→0) and class
     `.anim-in { animation: fade-slide-in var(--dur-med) var(--ease-out) both; }`
   - `@keyframes pulse-glow` (box-shadow breathing on violet) and class
     `.anim-running` for the active-run indicator
   - `@keyframes shimmer` (background-position sweep) and `.anim-shimmer` for
     progress placeholders
   - `@keyframes scan-drift` (background-position Y drift) for the topbar
     scanline strip.
3. Ambient layer: add a 4px scanline strip (`repeating-linear-gradient`, low
   opacity, animated by `scan-drift`) inside `.topbar::after`, and a radial
   violet glow behind `.app-shell::before` content. Keep both under
   `opacity: .25` and `pointer-events: none`.
4. Micro-interactions: `button:hover:not(:disabled)` gains
   `box-shadow: 0 0 12px rgba(124,58,237,.35)` and 150ms transition on
   `border-color/background/box-shadow`; `.message` and `.thread-list button`
   get the same transition set.
5. Verification: `npm run typecheck:desktop-renderer` and
   `npm run build:desktop-renderer` pass. No component code changes yet.

## Task 2: App decomposition (pure refactor, zero behavior change)

Files: `desktop/renderer/src/App.tsx` (edit),
`desktop/renderer/src/components/TopBar.tsx` (new),
`.../components/LeftRail.tsx` (new), `.../components/CenterStage.tsx` (new),
`.../components/Inspector.tsx` (new), `.../components/Conversation.tsx` (new),
`.../components/ChangesView.tsx` (new), `.../components/ReportView.tsx` (new),
`.../components/StatusPill.tsx` (new), `.../components/EmptyState.tsx` (new),
`.../components/ThreadList.tsx` (new), `.../components/AgentActivity.tsx` (new),
`.../components/ValidationSummary.tsx` (new),
`.../components/ConfirmationDialog.tsx` (new),
`.../components/ProviderDialog.tsx` (new),
`.../components/inspector-section.tsx` (new),
`desktop/renderer/src/App.test.tsx` (edit if imports change).

1. Move each function component out of `App.tsx` into its own file with
   explicit prop interfaces exported. Keep `App.tsx` as the container: all
   `send`/dispatch orchestration stays there; presentational components stay
   prop-driven and bridge-free (this is what makes them cheaply testable).
2. Shared primitives (`StatusPill`, `EmptyState`, `PanelHeader`,
   `InspectorSection`) live in their own files; other components import them.
3. Keep `formatTime`, `titleCase`, `phaseTone`, `commitBlockedCopy`,
   `providerConfiguration` in a new `desktop/renderer/src/utils.ts` and import
   from there; update `App.test.tsx` imports if it references any moved
   symbol.
4. Acceptance: `npm run test:desktop-renderer` is green with zero logic edits —
   this task is file movement only. Snapshot the rendered tree of `<App>` with
   the existing jsdom test before and after refactor and diff them to prove
   parity (do this manually during development; do not commit snapshot files).

## Task 3: Live turn experience — phase stepper + activity timeline

The single biggest engagement gap: after pressing Send, the UI is silent until
the whole run finishes. The bridge already streams `runtime.event`s; render
them as a story.

Files: `desktop/renderer/src/components/TurnProgress.tsx` (new),
`desktop/renderer/src/components/TurnProgress.test.tsx` (new),
`desktop/renderer/src/components/Conversation.tsx` (edit),
`desktop/renderer/src/components/CenterStage.tsx` (edit),
`desktop/renderer/src/state.ts` (edit — view actions only),
`desktop/renderer/src/styles.css` (edit).

1. `TurnProgress` props: `{ events: RuntimeEvent[]; status: CodingSessionStatus | null; startedAt?: string; pausing: boolean }`.
2. Phase stepper: derive current phase from the latest event whose type starts
   with `session.` (fall back to subagent statuses: any `working` builder →
   "building", validator/reviewer working → "validating"/"reviewing"). Render
   five steps — plan / scout / build / validate / review — as a horizontal
   stepper: completed steps get a filled cell glyph `[x]`, the active step gets
   `[~]` + `.anim-running`, pending steps get `[ ]`. Pure ASCII glyphs, per
   brand contract.
3. Elapsed timer: `useEffect` + `setInterval(1000)` computing from
   `startedAt ?? first event timestamp`; stop ticking at terminal statuses
   (`completed/failed/cancelled` — reuse `terminalStatuses`).
4. Activity timeline: the last 8 runtime events rendered newest-first, one row
   each: trimmed event type, role when `payload.subagentId` present, time as
   `HH:MM:SS`; container is `role="log"` with `aria-live="polite"` capped at 8
   rows (older rows removed from DOM so announcements stay short).
5. Mount: render `TurnProgress` at the top of the Conversation tab whenever
   `currentRun && !terminalStatuses.has(currentRun.status)`; keep it visible in
   the sticky composer area's parent grid row above the message list so the
   composer never overlaps it.
6. Auto-scroll: message list scrolls to bottom on new `run.changed`/messages
   via `useRef` + `scrollIntoView({ block: "end" })`, but ONLY when the list is
   already near the bottom (within 80px) so scrolling users aren't yanked down.
7. Collapse: a `<details open>` wrapper lets the user fold the whole panel;
   fold state per session in component state seeded from
   `localStorage("hive.desktop.ui.v1").turnPanelCollapsed`.
8. Styles: `.turn-progress` panel with `.anim-shimmer` skeleton line under the
   stepper while status is `starting`; `.anim-in` on each timeline row.
9. Tests (`TurnProgress.test.tsx`): renders stepper with correct step active
   for a fake `RuntimeEvent` sequence; shows elapsed seconds; caps timeline at
   8 rows; announces via `role="log"`; hides when run is terminal.
   Add a Conversation-level test that `TurnProgress` mounts for an active run.
10. Perf guard: memoize timeline derivation with `useMemo` on `events`; do not
    re-render the whole message list on every event.

## Task 4: Rich message rendering — markdown-lite + copy + receipts

Files: `desktop/renderer/src/markdown.tsx` (new),
`desktop/renderer/src/markdown.test.tsx` (new),
`desktop/renderer/src/components/Message.tsx` (new),
`desktop/renderer/src/components/Message.test.tsx` (new),
`desktop/renderer/src/components/Conversation.tsx` (edit),
`desktop/renderer/src/styles.css` (edit).

1. `markdown.tsx`: export `renderMarkdown(source: string): ReactNode`. Hand
   rolled, no deps, XSS-safe by construction (build ReactNodes from parsed
   segments, never `dangerouslySetInnerHTML`): fenced code blocks
   (` ```lang `), inline code, `**bold**`, `*italic*`, `-`/`1.` lists,
   `#`..`###` headings, `- [ ]` checkboxes, and bare URLs → safe `<a
   rel="noreferrer" target="_blank">`. Split on double newlines for
   paragraphs. Keep the parser ~150 lines, line-based, deterministic.
2. Code blocks render as `.code-block` with a header row: language label
   (default "text") + Copy button (`navigator.clipboard.writeText`, fallback
   `textarea` execCommand path; show "Copied" for 1.5s via local state).
3. `Message` component: replaces the inline `<li>` markup in Conversation —
   header (`You / HIVE / System` + time), markdown body for assistant/system,
   plain `pre-wrap` for user (user text is not markdown-parsed), and the
   existing retry affordance moved in unchanged.
4. Receipt chip: if a future `ThreadMessage.receipt`-like shape exists on the
   message (guard with optional chaining on an `unknown` cast), render
   `.receipt-chip` showing `role → provider/model · tokens · latency` using the
   CLI receipt formatting as reference (`src/chat/` engine receipt). If
   absent, render nothing — this is forward-compat only, do NOT change bridge
   types to make it appear.
5. Styles: `.code-block` (deep terminal violet background, lavender left
   border, horizontal scroll, mono font), `.code-block header`, `.receipt-chip`
   (small, dashed border, dim text), checkbox list styling.
6. Tests: markdown parser — fence extraction with language, escaping of `<script>`,
   list grouping, checkbox rendering, URL linkification refuses `javascript:`;
   Message — assistant renders markdown, user stays plain, copy button writes
   clipboard (stub `navigator.clipboard` in jsdom).

## Task 5: Inspector → Hive view (agents as living cells)

Files: `desktop/renderer/src/components/HiveView.tsx` (new),
`desktop/renderer/src/components/HiveView.test.tsx` (new),
`desktop/renderer/src/components/Inspector.tsx` (edit),
`desktop/renderer/src/styles.css` (edit).

1. Replace the `AgentActivity` list body with `HiveView`
   (`Inspector.tsx` keeps the section heading "Agents"). Props:
   `{ events: RuntimeEvent[]; report: CodingFinalReport | null }`.
2. Agent cell card per distinct `payload.subagentId` seen in events:
   hexagon-ish cell made purely of CSS borders (clip-path hexagon is allowed;
   fall back if too fiddly — keep it decorative, not the status carrier),
   containing: role label (parse from event payload when present, else
   truncated id), ASCII status glyph + StatusPill, file scope chips (from
   `payload.fileScope` when array), and the last event timestamp.
3. Card backgrounds tint by status: violet border + `.anim-running` glow while
   `working`, green on `completed`, red on `failed`, dim on terminal-skipped —
   text label repeats status for non-color signaling.
4. Run meter above the cards: `progress` element styled violet —
   `value = terminal subagents`, `max = total subagents` (count from events;
   fall back to `report.subagents.total`), plus a line
   `N of M agents settled`.
5. Keep `ValidationSummary` section as-is below Hive view; when a report
   exists, append one summary line `validation X/Y passed`.
6. Tests: cards appear per subagentId in event order; meter computes ratio;
   failed status renders glyph `!!`; empty state preserved when no agents.

## Task 6: Onboarding, checklist, prompt starters

Files: `desktop/renderer/src/components/OnboardingChecklist.tsx` (new),
`desktop/renderer/src/components/OnboardingChecklist.test.tsx` (new),
`desktop/renderer/src/components/PromptStarters.tsx` (new),
`desktop/renderer/src/components/EmptyWorkspace.tsx` (new, extracted),
`desktop/renderer/src/components/Conversation.tsx` (edit),
`desktop/renderer/src/components/LeftRail.tsx` (edit),
`desktop/renderer/src/prefs.ts` (new),
`desktop/renderer/src/styles.css` (edit).

1. `prefs.ts`: `loadPrefs()/savePrefs()` over `localStorage`
   `hive.desktop.ui.v1` with a versioned shape
   `{ v: 1; onboardingDismissed?: string[]; turnPanelCollapsed?: boolean; notifications?: boolean; density?: "comfortable" | "compact"; accent?: "vivid" | "contrast" }`
   and a tiny pub/sub `usePrefs()` hook (setState on save). All later tasks
   read prefs from here.
2. Onboarding checklist renders in CenterStage when `!state.repositoryRoot ||
   threads.length === 0`: five steps with auto-completion detection from
   existing state — Open a repository (done when `repositoryRoot`), Create a
   thread, Send your first task (done when any run exists), Review the diff
   (done when `state.diff` loaded), Confirm a guarded commit (dismiss-only; do
   NOT detect git actions). Each done step shows `[x]`. "Dismiss" persists the
   list id to prefs and hides permanently.
3. Prompt starters: `PromptStarters` renders 3 example task chips inside the
   empty-conversation state ("Fix the failing test in …", "Add dark mode to
   …", "Refactor the auth module to …") derived from the repo path's last
   segment; clicking a chip inserts the text into the composer (prop
   `onInsert(text)`), it does NOT auto-send.
4. `EmptyWorkspace` keeps the ASCII bee but adds: the checklist (task 2) above
   it and a hint line `Ctrl+K for commands` (wired once Task 7 lands — stub the
   hint text now).
5. Tests: checklist steps flip as simulated state changes; dismiss persists
   (assert localStorage write); starter chip click calls `onInsert` with the
   chip text.

## Task 7: Command palette + global shortcuts

Files: `desktop/renderer/src/components/CommandPalette.tsx` (new),
`desktop/renderer/src/components/CommandPalette.test.tsx` (new),
`desktop/renderer/src/components/ShortcutHelp.tsx` (new),
`desktop/renderer/src/components/Conversation.tsx` (edit),
`desktop/renderer/src/App.tsx` (edit — keydown wiring only),
`desktop/renderer/src/styles.css` (edit).

1. `CommandPalette`: props `{ open; onClose(); commands: PaletteCommand[] }`
   where `PaletteCommand { id; label; hint?; run(): void }`. Renders like
   `Dialog` (reuse its backdrop semantics + focus trap pattern): filter input
   at top, list filtered by substring (case-insensitive), ArrowUp/Down moves,
   Enter runs, Escape closes, focus returns to previously focused element.
2. Palette commands assembled in `App.tsx` from live state: Open recent
   repository (one per `state.repositories`, max 6), New thread, Switch to
   Conversation/Changes/Report, Pause/Resume when a run is active, Toggle
   inspector rail (Task 8 supplies this), Open Shortcut help.
3. Global shortcuts on `App.tsx` (single `keydown` listener, ignored while
   `providerDialog || state.preview || palette open`, and ignored when the
   target is an input/textarea except Ctrl+Enter): `Ctrl+K` palette,
   `Ctrl+Enter` submit composer (call the existing submit path), `Ctrl+1/2/3`
   tab switch through `chooseTab`, `?` (Shift+/) opens `ShortcutHelp`,
   `Escape` closes palette/help.
4. `ShortcutHelp`: static dialog listing every shortcut in a two-column
   definition list, styled like `Dialog`.
5. Styles: `.palette` modal (max-height 60vh, item rows with hint right
   aligned, `.active` row highlighted with lavender inset bar like
   `aria-current` thread rows).
6. Tests: palette filters, keyboard navigation wraps at ends, Enter dispatches
   the command, Ctrl+Enter in composer calls onSubmit, Escape closes without
   dispatch, ignored while other dialogs open.

## Task 8: Collapsible rails + diff view upgrade

Files: `desktop/renderer/src/App.tsx` (edit),
`desktop/renderer/src/state.ts` (edit — `ui.rails` view action),
`desktop/renderer/src/components/ChangesView.tsx` (rewrite),
`desktop/renderer/src/components/ChangesView.test.tsx` (new),
`desktop/renderer/src/diff.ts` (edit — expose per-file grouping),
`desktop/renderer/src/styles.css` (edit).

1. Rails: `state.rails = { left: boolean; right: boolean }` default `{true,true}`
   + `ui.rails` action `{ side: "left"|"right" }` toggling;
   `.cockpit-grid` gets conditional classes `.hide-left`/`.hide-right` setting
   `grid-template-columns` to remove the rail. Persist to prefs
   (`hive.desktop.ui.v1` — extend the shape: `rails?: {left:boolean;right:boolean}`).
   Topbar gains two ASCII toggle buttons `[/]` (left) and `[\]` (right).
2. `diff.ts`: add `groupUnifiedDiff(parsed): { path: string; added: number; removed: number; lineSpan: [number, number] }[]`
   — reuse existing `parseUnifiedDiff` output; a file starts at `diff-file`
   lines; counts from line kinds. Keep the existing return type untouched.
3. `ChangesView` rewrite: two-pane — a sticky file rail listing each file with
   `+added −removed` chips, clicking a file scrolls to its first line via
   `scrollIntoView` (line elements already keyed); per-file collapse toggle
   `[+]/[−]` hiding that file's lines; a "wrap lines" toggle switch (class on
   the list switching `white-space: pre ↔ pre-wrap`). Keep the truncated pill
   and read-only framing exactly as-is.
4. Tests: grouping counts on a multi-file patch; rail click scrolls (stub
   `scrollIntoView`); collapse hides lines; wrap toggle flips class.

## Task 9: Presence, badges, notifications

Files: `desktop/renderer/src/components/ThreadList.tsx` (edit),
`desktop/renderer/src/components/TopBar.tsx` (edit),
`desktop/renderer/src/components/Toast.tsx` (new),
`desktop/renderer/src/notifications.ts` (new),
`desktop/renderer/src/notifications.test.tsx` (new),
`desktop/renderer/src/App.tsx` (edit — effect wiring),
`desktop/renderer/src/styles.css` (edit).

1. Thread badges: `ThreadList` rows take an extra `ThreadRunRef | null`
   (latest run) — show `.badge` dot `[~]` running (violet, `.anim-running`),
   `[ok]` completed (green), `[!!]` failed (red). Badge = glyph + class, per
   no-color-only rule.
2. Completion toast: `Toast` stack bottom-right above `.announcer` (new
   container, `role="status"`); on `run.changed` entering a terminal state for
   the ACTIVE thread, App pushes `{ id, tone, text }` to local toast state,
   auto-dismissing after 6s (manual close button too). Toasts are React state
   only, not bridge events.
3. Native notification: `notifications.ts` exports
   `notifyRunCompleted(title, { threadTitle, result })` using the HTML5
   `Notification` API — guard `typeof Notification !== "undefined"`, ask
   permission on first run completion, ONLY fire when `document.hidden`, and
   respect `prefs.notifications !== false`. Clicking the notification focuses
   the window (`window.focus()`).
4. Title-bar: topbar wordmark gains `.anim-running` class while ANY repository
   run is active (`repositoryActiveRun` already computed in App).
5. Tests: badge mapping per run status; toast appears and auto-dismisses
   (fake timers); notification suppressed when `document.hidden` false
   (jsdomstub) and when prefs.notifications false.

## Task 10: Settings dialog — density, accent, notification toggle

Files: `desktop/renderer/src/components/SettingsDialog.tsx` (new),
`desktop/renderer/src/components/SettingsDialog.test.tsx` (new),
`desktop/renderer/src/components/TopBar.tsx` (edit),
`desktop/renderer/src/prefs.ts` (edit — already created Task 6),
`desktop/renderer/src/styles.css` (edit).

1. Topbar gains a ⚙-free ASCII button `[*]` opening `SettingsDialog` (reuse
   `Dialog`). Contents, all persisted through `prefs.ts`:
   - Density radio: Comfortable (default) / Compact — toggles `data-density`
     on `.app-shell`; compact CSS reduces paddings/line-height ~15% via
     `.app-shell[data-density="compact"]` overrides (variables only, no layout
     change).
   - Accent radio: Vivid Violet (default) / High Contrast — `data-accent`
     attribute; contrast preset raises `--violet` → `#9d6bff`,
     `--muted` → `#c9ced8`, focus ring to full opacity (accessibility win,
     stays within violet family per brand).
   - Notifications checkbox bound to `prefs.notifications`.
   - Static note: "Motion follows your OS reduced-motion setting."
2. Attribute hook: a `useEffect` in `App.tsx` syncing
   `document.documentElement.dataset.density/.accent` on prefs change.
3. Tests: dialog opens/closes from topbar; density toggle writes prefs +
   document attribute; defaults render correctly with empty localStorage.

## Task 11: Final verification + docs

Files: `README.md` (edit — screenshots/features section only),
`docs/HIVE_ROADMAP.md` (edit — mark landed items),
`desktop/renderer/src/App.test.tsx` (edit — golden-path coverage).

1. Full gate, in order: `npm run lint` (core typecheck),
   `npm run typecheck:desktop-renderer`, `npm run test:desktop-renderer`,
   `npm run build:desktop`, core `npm test` (must stay 381-green), and if
   available `npm run desktop:e2e`.
2. `App.test.tsx` golden path: open repository (stub bridge) → thread list →
   send message → turn progress mounts → terminal run event → toast appears.
   This test proves the engagement features compose without Electron.
3. README: refresh the desktop feature bullets (live turn progress, hive agent
   view, command palette, notifications) — no screenshots binary in git;
   reference `docs/` as before.
4. Manual verification checklist appended at the bottom of this plan; the
   agent performing the work ticks each box with a commit reference.

### Manual checklist for the human reviewer

- [ ] Start a real run against a demo repo; the phase stepper advances and the
  timeline scrolls live.
- [ ] OS reduced-motion ON: zero animation anywhere; OFF: scanline + glow
  visible but subtle.
- [ ] Ctrl+K, Ctrl+Enter, Ctrl+1/2/3, `?` all work with a screen reader
  announcing the live regions.
- [ ] Notification fires only when the window is unfocused and settings allow.
- [ ] Diff file rail + collapse + wrap work on a 1000-line patch without jank.

## Appendix (future, NOT in this plan — needs controller approval)

These are deliberately excluded; they require the deferred chatbot-UI product
decision or bridge protocol extensions:

- **Quick Chat pane in desktop** (port `src/chat` engine behind new bridge
  commands `chat.start/chat.send/chat.stream`) — depends on the open
  terminal-vs-web UI decision; treat as its own plan.
- **Live token-level streaming of builder output into Conversation** — needs a
  new opt-in bridge event (`run.output-chunk`) plus worker-side plumbing from
  `streamComplete`. Separate change: protocol + worker + renderer.
- **Token/cost aggregation per run** in the report tab — needs
  `CodingFinalReport` to carry per-subagent `TokenUsage` totals (core change).
