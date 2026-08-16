# HIVE Cloud — Design Review Remediation Plan

> **Revalidated:** 2026-07-18 against `feat/phase-0-chatgpt-parity` at `19e3a01`.
>
> **Plan status:** Ready to execute from Phase 0 after this revision; the implementation itself is not on a green baseline yet. The previous version was not execution-ready: it relied on stale Git state, referenced unavailable workflow skills and an uninstalled test library, included tests that could not exercise the claimed behavior, contradicted the latest product decision for the empty Hive state, understated the scope of theme and citation changes, and did not account for the current API typecheck failure.

## Goal

Close the design-review deviations that are still real, preserve the latest Queen-led product direction, and resolve the remaining user-facing and maintainability issues without changing the public OpenAI-compatible `/v1` behavior.

The database schema does not need another migration for this plan. One internal HIVE extension contract change is explicitly allowed in Phase C so citations can be attached to and restored with the assistant message that produced them. That change must not affect non-persisting `/v1/chat/completions` requests.

## Current architecture and invariants

- Next.js 16 web (`apps/web`) → same-origin proxy → Fastify API → Postgres/Redis/R2.
- React 19, Tailwind v4, the token/class system in `apps/web/src/app/globals.css`, Phosphor icons, GSAP/Three.js, and `motion` remain the implementation stack.
- The flagship visual language remains the calm violet cockpit, Queen-led orchestration, transparent processing disclosure, restrained wave, and one persistent composer.
- No Odysseus code, assets, branding, copy, or exact layouts.
- No repository execution in Cloud.
- BYOK secrets remain encrypted and are never returned.
- `/v1/chat/completions` remains OpenAI-compatible and non-persisting.
- The top-level web request model remains `hive-0.1`; a specific provider/model is expressed through the existing `hive.provider` and `hive.model` extension.

## Revalidation of the original findings

| Finding | Live-code verdict | Disposition |
|---|---|---|
| General settings is off-system and inaccessible | Confirmed | Phase A1 |
| Empty Hive must lose the orchestration preview | Rejected | Preserve it; the later 2026-07-17 decision and current project summary explicitly make orchestration the default and explain its choreography beside the composer |
| Share dialog lacks a complete modal focus lifecycle | Confirmed | Phase A2 |
| Help advertises `Esc` to stop, but the behavior is unwired | Confirmed | Phase A3, with one priority-aware Escape path rather than competing listeners |
| Model picker is dominated by static inline styling | Confirmed | Phase A4 |
| Light theme is applied too low in the DOM | Confirmed | Phase B1; the wave observer must move with it |
| `react-markdown` allows `javascript:` links | Rejected as stated | Installed `react-markdown` v10 applies `defaultUrlTransform`; add regression coverage without replacing it |
| Copy failures are silent and success is not announced | Confirmed | Phase B2 |
| Processing labels/animations are duplicated | Confirmed | Phase C1 |
| Citations are global rather than message-owned | Confirmed, but larger than a UI-only change | Phase C2, including persistence and reload |
| Thinking disclosure ignores reduced motion for timed state changes | Confirmed | Phase B3 |
| Usage omits managed RPM and its loading layout shifts | Confirmed | Phase B4; use the real responsive grid instead of one fixed skeleton height |
| Branch switches are not announced | Confirmed | Phase B5 |
| Temporary edit/patch scripts were committed | Confirmed | Phase 0 |
| Current preflight is green | Rejected | API typecheck fails at `apps/api/src/store.ts:1100` because provider health status is widened to `string`; Phase 0 must restore the baseline before design work |

## Execution rules

1. Re-run the repository inspection commands before editing; line numbers in this document are intentionally not treated as stable.
2. Preserve unrelated work. At revalidation time, `apps/web/next-env.d.ts` was already modified by Next.js and is not part of this plan.
3. Use the existing Vitest patterns: server markup tests where markup alone is sufficient, and `// @vitest-environment jsdom` with `createRoot`/`flushSync` for effects, portals, focus, keyboard, timers, and fetch state. Do not use `@testing-library/react` unless a separate dependency decision explicitly adds it.
4. Write complete behavior tests. A comment describing a future assertion is not a test and cannot satisfy a gate.
5. Use `rtk` for shell commands.
6. Stage exact reviewed paths only. Do not use `git add apps/web`, `git add .`, or `git add -A` while unrelated changes exist.
7. Treat the commit boundaries below as suggestions. Commit or push only when the user has authorized those actions.
8. No subagent workflow is required by this plan. Parallel agent work may be used only when explicitly authorized and when tasks do not share files.

## Standard task loop

For every implementation task:

1. Inspect the live source, importers, tests, and relevant CSS/API contract.
2. Add a failing behavioral regression test.
3. Run the smallest focused test and confirm the expected failure.
4. Implement the narrow change.
5. Re-run the focused test and affected workspace typecheck.
6. Inspect `git diff`, `git diff --check`, and the exact files that would be staged.
7. Perform the task-specific runtime/visual checks.
8. At each phase boundary, run `npm run preflight`; report passed, failed, and skipped totals exactly.

There is no repository `lint` script. Do not invent one or claim lint coverage.

---

## Phase 0 — Establish a clean implementation baseline

### Task 0.1: Remove committed agent scratch artifacts

**Delete, after reconfirming they have no importers or script references:**

- `edit_app_test.js`
- `edit_app_test.mjs`
- `edit_test.js`
- `edit_tests.js`
- `edit_tests.py`
- `scratch/patch_app.ts`
- `scratch/patch_app_settings.ts`

**Acceptance:**

- A repository search finds no consumer of any deleted file.
- No unrelated file is deleted or staged.
- `git diff --check` passes.

### Task 0.2: Restore the API typecheck baseline

**Files:**

- Modify `apps/api/src/store.ts`
- Extend `apps/api/src/app.test.ts` or add a focused store/helper test

**Known failure:** `apps/api/src/store.ts:1100` passes a `string` variable to the typed provider-status column. This was introduced by `19e3a01`; the status values themselves are already bounded to `healthy`, `degraded`, and `auth_failed`, but the local annotation discards that information.

**Implementation:**

- Introduce a narrow provider health result type (`healthy | degraded | auth_failed`) and use it for the local variable and method return value.
- Prefer a small pure response classifier if that makes 200/401/403/404/405/other/network behavior directly testable.
- Preserve the existing semantics: 2xx, 404, and 405 are healthy; 401/403 are auth failures; other responses and network failures are degraded.
- Do not broaden the database enum or cast the value through `unknown` merely to silence TypeScript.

**Acceptance:**

- Focused health-classification/route tests pass.
- `rtk npm run typecheck -w @hive-cloud/api` passes.
- The full preflight proceeds beyond typecheck.

### Task 0.3: Record the repaired baseline

Run and record:

- `rtk git status --short --branch`
- `rtk git diff --stat`
- `rtk git log -3 --oneline`
- `rtk npm run preflight`

Do not begin Phase A until this preflight is green. If another baseline failure appears after Task 0.2, distinguish it from remediation failures and either add a bounded Phase 0 prerequisite or stop for direction. Do not rewrite or stage the existing `next-env.d.ts` change unless it is separately inspected and explicitly brought into scope.

---

## Phase A — Design-pass blockers

### Task A1: Bring General settings onto the cockpit system

**Files:**

- Modify `apps/web/src/components/general-settings-surface.tsx`
- Modify `apps/web/src/app/globals.css` only for narrowly scoped layout classes that do not already exist
- Create `apps/web/src/components/general-settings-surface.test.tsx`

**Implementation:**

- Preserve the existing GET/PATCH endpoints and settings payload.
- Replace `text-input`, `button primary`, `--fg-muted`, unassociated labels, and static inline layout styles with the existing `.workspace-page`, `.page-heading`, `.panel`, `.field`, `.input`, `.textarea`, `.button.button-primary`, `.router-pill`, `.error-banner`, and `.skeleton` vocabulary.
- Add a Phosphor identity icon and router pill in the heading.
- Give every label a stable `htmlFor`/`id` pair and connect descriptive text with `aria-describedby` where useful.
- Use an explicit loading/error/ready state so a failed GET does not leave an unexplained permanent skeleton.
- Handle unknown thrown values safely; do not use `catch (cause: any)`.
- Preserve server-side limits for temperature and system-prompt length in the browser controls.

**Behavior tests:**

- Mock a successful GET, flush effects, and assert the real form fields and on-system classes.
- Assert label/input and description associations.
- Submit changed values and assert the exact PATCH payload and saving state.
- Mock GET and PATCH failures and assert a user-visible `role="alert"` state.
- Assert no `text-input`, `button primary`, or `--fg-muted` remains.

**Manual acceptance:** `/settings/general` at 375/768/1440 in dark and light themes; loading, success, validation, save, and failure states; keyboard-only tab order.

### Task A2: Complete the Share dialog modal lifecycle

**Files:**

- Modify `apps/web/src/components/share-dialog.tsx`
- Create `apps/web/src/components/share-dialog.test.tsx`

**Implementation:**

- Capture the previously focused element before moving focus into the dialog. Do not capture it in a later effect after the dialog has already focused itself.
- Give the dialog one stable effect for initial focus, forward/reverse Tab wrapping, Escape close, cleanup, and focus restoration.
- Avoid re-registering or restoring focus because an unstable `onClose` function identity changed.
- Clear the copied-state timer on replacement and unmount.
- Keep backdrop click, create/revoke behavior, alert semantics, and current visual treatment intact.

**Behavior tests:**

- Initial focus enters the dialog.
- Tab from the last focusable wraps to the first; Shift+Tab from the first wraps to the last.
- Escape calls `onClose` once.
- Unmount restores the trigger that had focus before the dialog opened.
- Copy feedback timers do not update an unmounted component.

**Manual acceptance:** open from the real share trigger, exercise both share states, Tab/Shift+Tab/Escape, and verify focus restoration.

### Task A3: Implement one priority-aware shortcut and Escape path

**Files:**

- Modify `apps/web/src/lib/shortcuts.ts`
- Modify `apps/web/src/lib/shortcuts.test.ts`
- Modify `apps/web/src/components/app-shell.tsx`
- Modify `apps/web/src/components/chat-surface.tsx`
- Modify `apps/web/src/components/share-dialog.tsx` if the shared Escape registration lives there
- Extend the relevant interactive component tests

**Implementation:**

- Extend the shortcut infrastructure with a small Escape-action registry (or equivalent single-owner mechanism) so only the highest-priority active action runs.
- Priority order: share/model modal or shell dialog → chat drawer/inspector/mobile navigation → stop the active stream → no action.
- Do not add independent capture listeners in `AppShell` and `ChatSurface` that can both act on the same keypress.
- Register `/` through `useShortcuts`; suppress plain-key shortcuts while an editable control or any modal is active.
- Keep Meta/Ctrl shortcuts cross-platform and preserve current command/help behavior.
- Make the stop action call the existing `stopRequest`, including the API cancellation request and `AbortController.abort()`.

**Behavior tests:**

- Escape during an in-flight response stops it and transitions the optimistic assistant message to cancelled.
- With share, history, receipt, command, help, or mobile navigation open, the first Escape closes only the topmost surface and does not stop the stream.
- A second Escape stops the still-active stream after the overlay is gone.
- `/` focuses the composer only when focus is not editable and no modal is active.
- One keypress invokes at most one registered Escape action.

**Manual acceptance:** repeat the overlay/stream matrix with keyboard only, including `/` while the share dialog and model picker are open.

### Task A4: Move Model picker static presentation onto scoped classes

**Files:**

- Modify `apps/web/src/components/model-picker.tsx`
- Modify `apps/web/src/app/globals.css`
- Replace or extend `apps/web/src/components/model-picker.test.ts` with jsdom interaction coverage

**Implementation:**

- Move static layout, typography, spacing, borders, backgrounds, colors, and state presentation to `.model-picker-*` classes and `data-*` state attributes.
- Keep only genuinely runtime-calculated placement (`top`/`bottom`/`left`/`right`/`maxHeight`) inline, or expose it through CSS custom properties.
- Replace hardcoded `rgba(...)` and `#fff` values with existing tokens or one documented backdrop token.
- Name the positioning constants for gap, target height, viewport gutter, minimum height, and width.
- Preserve portal behavior, scroll locking, focus restoration, focus trap, listbox semantics, search, and Arrow/Home/End/Enter/Escape behavior.

**Behavior tests:**

- Open the picker in popover, dialog, and sheet modes using mocked `matchMedia`; query the portal output rather than only the closed server-rendered trigger.
- Assert semantic classes/data attributes and absence of hardcoded color values in rendered style attributes.
- Retain keyboard selection, focus trap/restoration, outside click, and unavailable/loading/error regressions.

**Manual acceptance:** composer picker at 375/768/1440 in both themes; placement above and below the trigger; scroll, search, all keyboard commands, and body scroll restoration.

**Decision reconciliation:** Do not remove `orchestration-preview` from `hive-welcome-state.tsx`. The current 2026-07-17 product decision supersedes the earlier assistant-first-only interpretation: the empty Hive state should explain the real Queen choreography beside the primary composer. The existing welcome test already protects this direction; re-review it for hierarchy and responsiveness instead of deleting it.

---

## Phase B — User-facing hardening

### Task B1: Apply theme at the document root without breaking the wave

**Files:**

- Modify `apps/web/src/app/layout.tsx`
- Modify `apps/web/src/components/app-shell.tsx`
- Modify `apps/web/src/components/hive-wave-background.tsx`
- Modify `apps/web/src/app/globals.css`
- Add focused theme bootstrap tests

**Implementation:**

- Run a minimal pre-hydration bootstrap in the root layout that resolves stored preference, then system preference, then dark fallback and sets `document.documentElement.dataset.theme`.
- Keep the bootstrap source centralized as a reviewed constant/helper so storage keys and allowed values do not drift.
- Move light token overrides and light-only selectors from `.app-root[data-theme="light"]` to `html[data-theme="light"]`.
- Make `AppShell` read the bootstrapped document theme for its toggle state and update both `<html>` and `localStorage` when toggled.
- Move the wave’s theme lookup and `MutationObserver` from `.app-root` to `document.documentElement`.
- Provide light/dark `theme-color` metadata so browser chrome does not remain dark in light mode.

**Behavior tests:** stored light, stored dark, invalid storage, no storage with light/dark OS preference, toggle persistence, and wave theme reaction.

**Manual acceptance:** hard reload each theme with cache disabled; no dark edge/scrollbar flash; correct wave palette; correct toggle icon; marketing routes remain correct.

### Task B2: Provide one accessible copy-feedback behavior

**Files:**

- Create a small shared copy hook/helper under `apps/web/src/lib/`
- Modify `apps/web/src/components/code-block.tsx`
- Modify `apps/web/src/components/chat-interface.tsx`
- Modify `apps/web/src/components/share-dialog.tsx`
- Add/extend interactive tests

**Implementation:**

- Use `idle | copied | failed` state, one cleanup-safe reset timer, and a graceful missing/rejected Clipboard API path.
- Announce success or failure through an atomic `aria-live="polite"` region and expose the same state in the visible button label.
- Do not add deprecated `document.execCommand("copy")` as an untested fallback; a clear failure state is preferable.
- Share the behavior instead of maintaining three subtly different implementations.

**Behavior tests:** Clipboard API success, rejection, absence, repeated clicks replacing the timer, and unmount cleanup for code, message, and share-link copy controls.

### Task B3: Respect reduced motion for timed disclosure changes

**Files:**

- Modify `apps/web/src/components/hive-thinking-block.tsx`
- Extend `apps/web/src/components/hive-thinking-block.interactive.test.ts`

**Implementation:**

- Reuse or extract the existing live `prefers-reduced-motion` subscription pattern.
- When reduction is requested, disable both the 1.8-second auto-expand and the 900-ms auto-collapse. Explicit user toggles and immediate failed-state disclosure still work.
- Preserve elapsed-time reporting and CSS reduced-motion rules.

**Behavior tests:** fake timers for normal auto-expand/collapse, no timed disclosure change under reduced motion, preference changes at runtime, and manual toggle behavior.

### Task B4: Render every usage limit with a responsive no-shift skeleton

**Files:**

- Rewrite `apps/web/src/components/usage-surface.tsx` for readability
- Modify `apps/web/src/app/globals.css`
- Create `apps/web/src/components/usage-surface.test.tsx`

**Implementation:**

- Render all five API fields, including `managed_requests_per_minute`.
- Render the loading state with the same five-cell `.usage-strip` structure as the loaded state; do not guess one fixed height that only matches one viewport.
- Update desktop/tablet/mobile grid and border rules for five cells.
- Add loading semantics, an accessible group label, and `role="alert"` on failure.
- Handle unknown failures safely.

**Behavior tests:** exact five labels/values, missing/loading/error states, and structural parity between loading and loaded grids.

**Manual acceptance:** no material layout jump at 375/768/1440; borders and the fifth cell remain correct in both themes.

### Task B5: Announce branch changes and clarify revision indexing

**Files:**

- Modify `apps/web/src/components/branch-navigator.tsx`
- Modify `apps/web/src/components/chat-interface.tsx`
- Add focused interaction tests

**Implementation:**

- Add an atomic polite status announcement: `Version N of M`.
- Replace opaque inline 1-based→0-based arithmetic with named `currentIndex` logic or a small tested helper.
- Preserve disabled boundaries and visible `N / M` text.

**Behavior tests:** previous/next target indexes, disabled first/last buttons, rerender announcement, and no out-of-range callback.

### Task B6: Pin the existing markdown URL safety behavior

**Files:**

- Extend `apps/web/src/components/markdown-message.test.ts`
- Modify `markdown-message.tsx` only if a failing regression proves the installed default is bypassed

**Implementation and tests:**

- Render normal relative, `https:`, and `mailto:` links plus `javascript:` and `data:` payloads, including encoded protocol variants.
- Assert dangerous schemes never reach `href` and external HTTP(S) links retain `target="_blank" rel="noopener noreferrer"`.
- Keep `react-markdown`’s `defaultUrlTransform`; do not replace it with a broader custom allowlist without a product requirement and security review.

---

## Phase C — Cross-cutting correctness and maintainability

### Task C1: Make processing-stage metadata a single source of truth

**Files:**

- Create `apps/web/src/lib/processing-stages.ts`
- Modify `apps/web/src/components/chat-interface.tsx`
- Modify `apps/web/src/components/hive-thinking-block.tsx`
- Delete `apps/web/src/components/chat-processing-state.tsx` only after all importers are removed
- Update relevant tests

**Implementation:**

- Move processing status/animation types, active-status rules, safe error labels, attempt-reason labels, and pure label/animation helpers into the shared module.
- Keep message-specific label composition as a pure helper that receives the message summary/receipt data it needs.
- Render the same `HiveThinkingBlock` path for the initial empty streaming state; do not preserve a second component with divergent labels.
- Eliminate the current type-only circular dependency between `chat-processing-state.tsx` and `chat-interface.tsx`.

**Behavior tests:** table-driven expected labels/animations for every status, safe fallback for unknown error/reason codes, and ChatMessage output for initial streaming, completed, failed, and cancelled states. Do not use source-string tests as the acceptance gate.

### Task C2: Attach and persist citations on the producing assistant message

**Files:**

- Modify `packages/contracts/src/index.ts`
- Modify `apps/api/src/store.ts`
- Modify `apps/api/src/app.ts`
- Modify API/store tests
- Modify `apps/web/src/components/chat-interface.tsx`
- Modify `apps/web/src/components/chat-surface.tsx`
- Modify `apps/web/src/lib/conversations-api.ts` types as needed
- Extend web behavior tests

**Implementation:**

- Define one bounded internal citation shape for persistence (`title`, `url`, `retrievedAt`); snippets may remain transient search prompt context because the existing citation table does not store them.
- Extend only the internal `hive` request extension used by authenticated Cloud conversations. Validate count, lengths, timestamps, and HTTP(S) URLs.
- Persist the completed assistant message and its citations in one tenant-scoped transaction using the existing `citations` table.
- Return citations with `getConversation`/`listMessages` and the in-memory store path.
- Add `citations` to `ChatMessageData`; attach current search results to the optimistic assistant message and render its Sources block inside `ChatMessage`.
- Remove the transcript-global `citations` state/footer.
- Define failed/cancelled behavior explicitly: no source block is rendered unless citations belong to a persisted assistant result.
- Preserve branch/regeneration ownership so citations follow the exact assistant revision.

**Behavior and integration tests:**

- Two research turns keep distinct sources on their respective assistant messages.
- Regenerated branches keep independent source sets.
- Reloading/paginating messages restores the same associations.
- Tenant A cannot read Tenant B citations.
- The in-memory and Postgres store paths return the same shape.
- Non-persisting `/v1/chat/completions` behavior is unchanged.

**Manual acceptance:** perform two cited Research turns, reload, switch branches, and confirm each response retains only its own sources. If live search or database credentials are unavailable, report this check as pending rather than claiming full verification.

---

## Validation gates

### Gate 1 — Clean design re-review

Required before asking for the design verdict to change:

- Phase 0 and all Phase A tasks complete.
- Phase B1–B6 complete; no user-facing medium issue is left behind under an ambiguous “at least” rule.
- Focused tests pass.
- `rtk npm run preflight` completes with exact pass/fail/skip totals recorded.
- `rtk git diff --check` passes.
- Browser sweep at 375/768/1440 in dark and light covers:
  - `/chat` empty, active, streaming, cancelled, drawers, share dialog, model picker, and branch navigation
  - `/build` idle and active
  - `/settings/general`, `/settings/providers`, `/settings/api-keys`, and `/settings/usage`
  - command palette, shortcut help, light-theme hard reload, and reduced motion
- Browser console and failed network requests are inspected.

The orchestration preview is judged against the latest Queen-led decision; its mere presence is not a failure.

### Gate 2 — Full remediation complete

- Phase C1 and C2 complete.
- API/store focused tests pass, including tenant isolation and both store modes.
- `rtk npm run test:auth` passes when database/store changes are included, or its environment-dependent skips/blockers are reported exactly.
- Full preflight and diff hygiene pass again.
- Citation persistence is verified through an actual reload with live local infrastructure, or explicitly reported as pending.

Only after the applicable gate passes may the Second Brain verdict move from `CONDITIONAL FAIL` to `PASS`.

## Suggested commit boundaries

If commits are authorized, use one reviewed commit per task except where tests and implementation must remain atomic. Stage only the exact files named by that task, inspect the cached diff, and never include the pre-existing `next-env.d.ts` change or another task’s work accidentally. Push only when separately authorized.

## Corrected out-of-scope notes

- Provider `context_window: 128000` remains deferred to provider-lifecycle work.
- `route-visual.tsx` remains a marketing-only surface.
- `motion` is actively used by `reveal.tsx` and `route-visual.tsx`; dependency removal is not a task.
- 375/768/1440 are QA viewports, not claims about the exact CSS breakpoint values.
- The top-level `model: "hive-0.1"` in the Cloud chat request is intentional; specific routing already uses `hive.provider`/`hive.model`.

## Final reporting requirements

The implementation report must include:

1. Exact files changed and why.
2. Focused validation commands and results.
3. Repository-wide validation and exact passed/failed/skipped totals.
4. Runtime/visual checks performed at each viewport/theme.
5. Checks not performed and the concrete blocker.
6. Final Git status, staged paths, commit status, and push status.
7. Remaining risks or deliberately deferred work.

Do not report “PASS,” “fixed,” “ready,” or “verified” from static inspection or a green build alone.
