# HIVE Cloud — ChatGPT-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each phase is independently shippable; when a phase is scheduled, expand it into its own detailed TDD plan with this same skill before writing production code.

**Goal:** Close the product-surface gap between HIVE Cloud's working chat core and a ChatGPT-quality chat agent experience, without touching the security substrate, HIVE identity, or product boundaries.

**Architecture:** Keep the existing topology — Next.js 16 web (`apps/web`) → same-origin proxy (`/api/cloud/[...path]`) → Fastify API (`apps/api`) → Postgres/Redis/R2, with BullMQ worker (`apps/worker`). All new product features extend the current Drizzle schema, `CloudStore`, and the single chat pipeline (`handleChat`) rather than adding parallel stacks.

**Tech Stack:** TypeScript, Next.js 16 / React 19, Fastify 5, Drizzle ORM + Postgres RLS, BullMQ + Redis, Vitest, existing bespoke CSS design system (`globals.css`).

**Product boundaries (unchanged, from `README.md` + Decisions.md):**
- HIVE Cloud never executes uploaded repositories.
- BYOK credentials are encrypted and never returned after storage.
- `/v1/chat/completions` stays OpenAI-compatible and non-persisting.
- No Odysseus code, assets, branding, copy, or exact layouts.

**Verification baseline for every task:** `npm run typecheck`, `npm test`, `npm run build` (or `npm run preflight` before pushing). Run `npm run test:auth` whenever auth or database code changes. Run `npm run smoke:file` whenever the file pipeline changes. Manual browser checks at 375/768/1440 widths in dark and light themes per project convention.

---

## Phase 0 — Trust basics & UX quick wins (Days 1–2)

Small, isolated, high-trust fixes. No schema changes. Each task is one commit.

### Task 1: Sign-out control in the account popover

**Files:**
- Modify: `apps/web/src/components/app-shell.tsx` (account popover, ~lines 100–120)
- Create: `apps/web/src/app/signout-action.ts`
- Test: `apps/web/src/components/app-shell.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// AppShell must expose a sign-out affordance inside the account popover.
// Render with the popover forced open via a test prop or initial state.
```

Assert the rendered markup contains a form posting to the sign-out server action and a button with accessible name "Sign out".

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run apps/web/src/components/app-shell.test.tsx` → FAIL (no sign-out element).
- [ ] **Step 3: Implement**

`apps/web/src/app/signout-action.ts`:

```ts
"use server";

import { signOut } from "@/auth";

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
```

In `app-shell.tsx` account popover, below the "Provider control" link:

```tsx
<form action={signOutAction}>
  <button type="submit" className="account-menu-item" data-testid="sign-out">
    <SignOut size={16} aria-hidden />
    Sign out
  </button>
</form>
```

Style `.account-menu-item` to match the existing popover link. `SignOut` icon from `@phosphor-icons/react`.

- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Verify** — `npm run typecheck && npm test`.
- [ ] **Step 6: Commit** — `git add apps/web && git commit -m "feat(web): add sign-out control to account popover"`.

### Task 2: Conversation delete confirmation

**Files:**
- Modify: `apps/web/src/components/chat-surface.tsx` (delete handler near line 547)
- Test: `apps/web/src/components/chat-surface.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test** — clicking the trash button once must NOT call the DELETE fetch; clicking the revealed confirm control within 3s must call it.
- [ ] **Step 2: Run → FAIL** (current code deletes on first click).
- [ ] **Step 3: Implement two-step confirm** — replace the immediate `onDelete` call with local state:

```tsx
const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

// In the conversation row:
{pendingDeleteId === conversation.id ? (
  <button
    type="button"
    className="history-action history-action-danger"
    onClick={() => void confirmDelete(conversation.id)}
    onBlur={() => setPendingDeleteId(null)}
    autoFocus
  >
    Confirm?
  </button>
) : (
  <button
    type="button"
    className="history-action"
    aria-label={`Delete ${conversation.title}`}
    onClick={() => setPendingDeleteId(conversation.id)}
  >
    <Trash size={14} aria-hidden />
  </button>
)}
```

`confirmDelete` performs the existing PATCH `{ deleted: true }`, clears `pendingDeleteId`, and — if the deleted conversation is the active one — resets the transcript to the welcome state (current code already handles list refresh).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(web): require confirmation before deleting conversations`.

### Task 3: Markdown code blocks — copy button, language label, safe links

**Files:**
- Modify: `apps/web/src/components/markdown-message.tsx` (currently 9 lines)
- Create: `apps/web/src/components/code-block.tsx`
- Test: `apps/web/src/components/markdown-message.test.tsx`

- [ ] **Step 1: Write the failing test** — rendering `` ```ts\nconst a = 1\n``` `` must produce a `pre` block containing a "Copy" button and a visible `ts` language label; rendering `[x](https://example.com)` must produce `target="_blank" rel="noopener noreferrer"`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

`code-block.tsx`:

```tsx
"use client";

import { Check, Copy } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

export function CodeBlock({
  language,
  children,
}: {
  language: string | null;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = extractText(children);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? "text"}</span>
        <button type="button" className="code-block-copy" onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}
```

`markdown-message.tsx` — add component overrides:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeHighlight]}
  components={{
    pre({ children }) {
      const code = Children.toArray(children)[0] as ReactElement<{
        className?: string;
        children?: ReactNode;
      }>;
      const match = /language-(\w+)/.exec(code?.props?.className ?? "");
      return <CodeBlock language={match?.[1] ?? null}>{children}</CodeBlock>;
    },
    a({ href, children }) {
      const external = href?.startsWith("http");
      return (
        <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {children}
        </a>
      );
    },
  }}
>
  {children}
</ReactMarkdown>
```

Add `.code-block`, `.code-block-header`, `.code-block-lang`, `.code-block-copy` styles to `globals.css` following existing panel/button tokens. Memoize the renderer: `export const MarkdownMessage = memo(function MarkdownMessage(...) ...)`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(web): add copyable code blocks and safe external links to markdown`.

### Task 4: Scroll behavior — stick-to-bottom only when appropriate + jump pill

**Files:**
- Modify: `apps/web/src/components/chat-surface.tsx` (auto-scroll effect at lines 183–185)
- Create: `apps/web/src/lib/scroll-stick.ts`
- Test: `apps/web/src/lib/scroll-stick.test.ts`

- [ ] **Step 1: Write the failing test** — pure function `shouldStickToBottom({ scrollTop, scrollHeight, clientHeight, thresholdPx })` returns true only within threshold; and `ChatSurface` must not call `scrollIntoView` when the user has scrolled up during streaming.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

`scroll-stick.ts`:

```ts
export const STICK_THRESHOLD_PX = 120;

export function shouldStickToBottom(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  thresholdPx?: number;
}): boolean {
  const threshold = args.thresholdPx ?? STICK_THRESHOLD_PX;
  return args.scrollHeight - args.scrollTop - args.clientHeight <= threshold;
}
```

In `chat-surface.tsx`: keep a `stickRef = useRef(true)` updated by the transcript container's `onScroll` (via `shouldStickToBottom`). The streaming effect scrolls only when `stickRef.current` is true, and always scrolls when the local user just sent a message. When new content arrives while `stickRef.current === false`, set `showJumpPill(true)`; the pill ("Jump to latest", absolutely positioned above the composer) scrolls to bottom and hides. Hide on stream completion after a final conditional scroll.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verify at 375/768/1440 manually.**
- [ ] **Step 6: Commit** — `feat(web): respect scroll position during streaming with jump-to-latest pill`.

### Task 5: Draft persistence per conversation

**Files:**
- Modify: `apps/web/src/components/chat-surface.tsx` (input state)
- Create: `apps/web/src/lib/draft-store.ts`
- Test: `apps/web/src/lib/draft-store.test.ts`

- [ ] **Step 1: Write the failing test** — `saveDraft(key, text)` / `loadDraft(key)` round-trip via localStorage; `clearDraft(key)` removes; drafts are namespaced `hive-draft:{conversationId|"new"}`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** a tiny module wrapping localStorage with try/catch (private-mode safe), then wire into `ChatSurface`: load draft when `activeConversationId` changes, save on every `input` change (debounced ~200ms), clear on successful send.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(web): persist composer drafts per conversation`.

### Task 6: Clipboard image paste into composer

**Files:**
- Modify: `apps/web/src/components/chat-interface.tsx` (`PromptComposer`, lines 100–232)
- Test: `apps/web/src/components/chat-interface.test.tsx`

- [ ] **Step 1: Write the failing test** — a paste event carrying a `File` of type `image/png` must call the same `onAddFiles` path as the file picker and respect the existing 5-file/20MB limits.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — on the composer textarea:

```tsx
onPaste={(event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length > 0) {
    event.preventDefault();
    onAddFiles(files);
  }
}}
```

Reuse the existing validation/preparation pipeline (`handleFiles` in chat-surface.tsx) unchanged; surface limit violations through the existing error banner.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(web): paste images directly into the composer`.

### Task 7: Retry on failed/cancelled exchanges

**Files:**
- Modify: `apps/web/src/components/chat-interface.tsx` (`ChatMessage`, lines 360–397) and `chat-surface.tsx` (`onRegenerate` path)
- Test: `apps/web/src/components/chat-surface.test.tsx`

- [ ] **Step 1: Write the failing test** — a failed assistant message renders a "Retry" action; clicking it resubmits the preceding user message content through `submit`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `ChatMessage`, when `message.status === "failed" || "cancelled"`, render a Retry button wired to a new `onRetry(messageId)` prop. In `ChatSurface`, `onRetry` finds the nearest preceding user message and calls `submit(undefined, thatContent)` (same path as regenerate today; Phase 1 replaces this with true revision semantics).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(web): allow retrying failed exchanges`.

**Phase 0 gate:** `npm run preflight` green; manual smoke of all seven behaviors at 375/1440 dark+light.

---

## Phase 1 — Conversation & message core (Week 1)

This is the phase that makes HIVE *feel* like ChatGPT: fast lists, lazy messages, edit/regenerate with branching, pins, real titles. Backend-heavy; TDD with Vitest; one migration.

### Task 8: Migration 0002 — pins, message-tree activation, share table, message–attachment link

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0002_<name>.sql` (via `npm run db:generate`, then hand-append RLS)
- Test: `packages/database` migration replay per project convention (`npm run db:migrate` on a fresh compose stack)

- [ ] **Step 1: Schema edits (failing state = typecheck of new store methods against missing columns).**

```ts
// conversations: add
pinnedAt: timestamp("pinned_at", { withTimezone: true }),

// conversation_shares: new table (tenant-scoped, RLS)
export const conversationShares = pgTable("conversation_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  tokenDigest: text("token_digest").notNull().unique(), // sha256 hex of raw share token
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// message_attachments: new join table (tenant-scoped, RLS)
export const messageAttachments = pgTable("message_attachments", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
}, (t) => [primaryKey({ columns: [t.messageId, t.attachmentId] })]);

// messages: add composite index for path reads
// index("messages_conversation_created_idx").on(messages.conversationId, messages.createdAt)
```

- [ ] **Step 2:** `npm run db:generate` → inspect the generated SQL; append RLS enable/force + `tenant_isolation` policies for `conversation_shares` and `message_attachments`, mirroring the exact policy pattern in `migrations/0000_big_maddog.sql` (GUCs `app.tenant_id` / `app.is_service`).
- [ ] **Step 3:** Apply against a fresh docker-compose Postgres: `npm run db:migrate`; replay verification (drop schema → migrate from 0000 → 0002) must succeed.
- [ ] **Step 4:** `npm run test:auth` (touches DB code) + `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(db): add pins, shares, message attachments, and message path index`.

### Task 9: Paginated conversation APIs (kill the N+1 mega-fetch)

**Files:**
- Modify: `apps/api/src/store.ts` (`CloudStore`), `apps/api/src/app.ts`
- Modify: `packages/contracts/src/index.ts` (response schemas)
- Test: `apps/api/src/store.test.ts` (new; mock pg pool or use test DB per existing patterns)

- [ ] **Step 1: Write failing contract + store tests** for:
  - `listConversations(tenantId, { cursor?, limit, archived? })` → rows `{ id, title, mode, pinnedAt, archivedAt, updatedAt, lastMessagePreview }` ordered `pinned_at DESC NULLS LAST, updated_at DESC`, keyset-paginated by `(updated_at, id)`; **no inlined messages**.
  - `getConversation(tenantId, id)` → single row or null.
  - `listMessages(tenantId, conversationId, { cursor?, limit })` → only the **active path**: for each `parent_message_id` group, the max `revision`; ascending by `created_at`, keyset cursor.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement store methods + routes:**

```
GET /api/conversations?cursor=&limit=20&archived=true|false
    → { data: ConversationSummary[], next_cursor: string | null }
GET /api/conversations/:id
    → { data: ConversationSummary }
GET /api/conversations/:id/messages?cursor=&limit=50
    → { data: Message[], next_cursor: string | null }
```

Keep the old fully-inlined response shape behind `?include=messages` for one release so the current web client keeps working until Task 12 lands; mark deprecated. Enforce tenant isolation via existing `withTenant()` + RLS. Validate with Zod schemas added to `packages/contracts`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(api): paginate conversations and messages with keyset cursors`.

### Task 10: Edit-and-resubmit via the chat pipeline (message tree write path)

**Files:**
- Modify: `packages/contracts/src/index.ts` (`hive` extension block), `apps/api/src/app.ts` (`handleChat`), `apps/api/src/store.ts`
- Test: `apps/api/src/app.test.ts` or integration-style Vitest per existing patterns

- [ ] **Step 1: Write failing tests** — posting to `/api/chat/completions` with `hive.parent_message_id = <userMessageId>` and edited content must persist: (a) a NEW user message row with `parent_message_id` equal to the original's parent and `revision = original.revision + 1`, and (b) the streamed assistant reply as a child of the new revision. The original branch remains in the DB.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — extend the Zod `hive` block:

```ts
hive: z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  allow_fallback: z.boolean().optional(),
  policy: z.literal("free-first-balanced").optional(),
  display_content: z.string().optional(),
  execution_summary: z.string().optional(),
  parent_message_id: z.string().uuid().optional(),   // NEW: branch point for edits
  regenerate_of: z.string().uuid().optional(),        // NEW: Task 11
}).optional()
```

In `handleChat` (apps/api/src/app.ts:324-546), after conversation resolution: when `parent_message_id` is present, load the referenced message, verify it belongs to this conversation/tenant, compute `revision = max(existing siblings' revision) + 1`, and persist the new user message with the original's `parent_message_id`. Route and stream exactly as today. Persist the assistant reply with `parent_message_id = newUserMessage.id`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(api): support edit-and-resubmit as message-tree branches`.

### Task 11: Regenerate as assistant revision

**Files:** same as Task 10.

- [ ] **Step 1: Failing test** — `hive.regenerate_of = <assistantMessageId>` creates a new assistant message sharing the original's `parent_message_id` with `revision + 1`, without writing a new user message.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — same branch as Task 10: resolve the assistant message, take its `parent_message_id` (the user message), rebuild upstream context from the active path up to that user message, stream, persist new assistant revision. Reject when the referenced message is not an assistant message in this conversation (422).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(api): regenerate answers as assistant revisions`.

### Task 12: Automatic conversation titles (worker job)

**Files:**
- Modify: `apps/api/src/app.ts` (enqueue after first completed exchange), `apps/worker/src/index.ts`
- Create: `apps/worker/src/titles.ts`
- Test: `apps/worker/src/titles.test.ts`

- [ ] **Step 1: Failing test** — `generateTitle(prompt, answer)` returns a ≤48-char single-line title; the worker processor only updates conversations whose title is still the default placeholder (never overwrites user renames); job is enqueued exactly once per conversation (idempotency key `title:{conversationId}`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — new BullMQ queue `hive-titles` (concurrency 2). In `handleChat`'s completion path, when the conversation's message count transitions to 2, enqueue `{ conversationId, tenantId }`. Worker calls the API's internal chat endpoint with `x-hive-no-persist: true`, a cheap prompt ("Summarize this conversation in 3–6 words as a title. Reply with the title only."), then `UPDATE conversations SET title = … WHERE id = $1 AND (title = 'New conversation' OR title = substring(original first prompt, 1, 72))` guarded to default titles only. Emit `audit_events` row `conversation.titled`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(worker): auto-generate conversation titles after first exchange`.

### Task 13: Web — sidebar v2 on paginated APIs

**Files:**
- Modify: `apps/web/src/components/chat-surface.tsx` (major state refactor — consider splitting `conversation-list.tsx` out; keep files <800 lines per ECC)
- Create: `apps/web/src/components/conversation-list.tsx`, `apps/web/src/lib/conversations-api.ts`
- Tests: `apps/web/src/components/conversation-list.test.tsx`, `apps/web/src/lib/conversations-api.test.ts`

- [ ] **Step 1: Failing tests** — list renders from the new summary endpoint; "Load more" fetches with `cursor`; pin action PATCHes `{ pinned: true }` and the item moves to a "Pinned" section; "Archived" toggle switches the query and exposes "Unarchive"; selecting a conversation lazy-loads its messages via `/messages` (older pages load on scroll-to-top).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - `conversations-api.ts` — typed fetch wrappers for the three Task 9 endpoints + PATCH `{ title?, archived?, pinned?, deleted? }` (extend the existing PATCH route to accept `pinned`).
  - `conversation-list.tsx` — pinned section above recent, infinite scroll (IntersectionObserver sentinel), archived view toggle, skeletons matching existing patterns.
  - `chat-surface.tsx` — replace the upfront `loadConversations()` mega-fetch with: summary list + `activeMessages` state loaded per selection; keep the post-stream refetch but scope it to the active conversation's first page and the list's first page.
  - API: extend `PATCH /api/conversations/:id` to accept `pinned: boolean` → sets/clears `pinned_at`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verify 375/768/1440 dark+light.**
- [ ] **Step 6: Commit** — `feat(web): paginated sidebar with pins, archive view, and lazy message loading`.

### Task 14: Web — edit in place + branch navigation

**Files:**
- Modify: `apps/web/src/components/chat-interface.tsx` (`ChatMessage`), `chat-surface.tsx`
- Create: `apps/web/src/components/branch-navigator.tsx`
- Test: `apps/web/src/components/branch-navigator.test.tsx`

- [ ] **Step 1: Failing tests** — editing a user message opens an inline textarea with Save/Cancel; Save calls submit with `hive.parent_message_id`; after the new branch completes, a `‹ 1 / 2 ›` control appears on the edited group and switches which revision chain renders; regenerate on an assistant message shows its own revision counter.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - `branch-navigator.tsx` — `< ChevronLeft {current}/{total} ChevronRight >` group control.
  - `chat-surface.tsx` — keep messages as a tree client-side (`Map<parentId, Message[]>`); the rendered transcript = selected path; selectors switch `activeRevision[parentId]`.
  - Edit: inline textarea in `ChatMessage`; Save → `submit(content, { parentMessageId: message.parentMessageId ?? message.id })` per Task 10's contract; the optimistic UI appends the new branch.
  - Regenerate: send `hive.regenerate_of` per Task 11 instead of appending a duplicate pair (replaces Phase 0/Task 7 semantics for the latest message; Retry keeps the regenerate path).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(web): edit messages and navigate answer branches`.

### Task 15: Streaming render performance

**Files:**
- Modify: `apps/web/src/components/chat-surface.tsx` (SSE delta handling, lines ~455–461)
- Test: `apps/web/src/components/chat-surface.test.tsx` (throttle behavior with fake timers)

- [ ] **Step 1: Failing test** — N rapid SSE deltas within one 50ms window produce ≤2 message-state updates.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — accumulate deltas in a ref; flush to React state on a 50ms interval (and on `[DONE]`/error immediately). `MarkdownMessage` is already memoized from Task 3.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `perf(web): throttle streaming markdown re-renders`.

**Phase 1 gate:** `npm run preflight` + `npm run test:auth` green; manual check: 100+ conversations list stays fast; edit/regenerate branches survive reload; titles appear automatically.

---

## Phase 2 — Sharing, search, attachments-in-context (Week 2)

### Task 16: Public share links

- **API** (`apps/api/src/app.ts`, `store.ts`): `POST /api/conversations/:id/share` → creates raw token `hive_share_…` (32 random bytes, base64url), stores sha256 digest in `conversation_shares`, returns the URL once. `DELETE /api/conversations/:id/share` → sets `revoked_at`. Public unauthenticated `GET /api/shared/:token` → 404 on unknown/revoked; returns sanitized snapshot `{ title, messages: [{ role, content, created_at }] }` — strip user/tenant ids, receipts, and attachment object keys. TDD: digest lookup, revocation, tenant mismatch.
- **Web**: share dialog on the conversation row + active chat header (copy-link button, revoke); new public page `apps/web/src/app/shared/[token]/page.tsx` (server component, `noindex,nofollow`, read-only transcript, branded footer "Shared from HIVE Cloud").
- Commit: `feat: public conversation share links`.

### Task 17: Full-text conversation search

- **DB**: generated `tsvector` column on `messages` over `content::text` (or a migration trigger); GIN index; title search via `ILIKE` is acceptable at current scale — decide in the detailed plan with a benchmark.
- **API**: `GET /api/search/conversations?q=&limit=20` → matches with `ts_headline` snippets, tenant-scoped. Rate-limit 30/min/user (reuse Phase 3 limiter early if trivial).
- **Web**: sidebar search swaps client filter for debounced (300ms) server search; result rows show snippet with highlighted match; clicking opens the conversation scrolled to the matched message (`?focus=<messageId>`).
- Commit: `feat: full-text search across conversations`.

### Task 18: Server-side attachments in chat context

- **Contracts**: extend `hive` block with `attachment_ids: z.array(z.string().uuid()).max(5).optional()`.
- **API**: in `handleChat`, when `attachment_ids` present: load approved attachments for this tenant, join `message_attachments` for the persisted user message, inject `extracted_text` (truncated to the existing 120k budget) as `<uploaded_file>` parts, and approved images as base64 `image_url` parts (mirroring today's client-side inlining so router vision detection still fires). Reject quarantined/scanning/rejected ids with 422.
- **Web**: composer uploads switch from client-side inlining to the presign→complete→approved flow (`POST /api/files/presign`, `/api/files/:id/complete`), polls attachment status, and sends `hive.attachment_ids`. Keep client-side PDF text extraction as a fallback only when the worker extractor is unavailable — record this as a decision in the phase plan.
- Commits: `feat(api): inject approved attachments into chat context` + `feat(web): route composer uploads through the scanned file pipeline`.

### Task 19: Worker — text extraction + purge jobs

- `apps/worker/src/extract.ts`: on scan-approval, populate `attachments.extracted_text` for pdf/txt/md/csv/json/code (pdfjs-dist in Node; cap 120 pages like the client); leave images null. TDD with fixture files.
- `apps/worker/src/maintenance.ts` + repeatable BullMQ jobs (hourly): (a) hard-delete conversations where `purge_after < now()` plus their messages/shares/joins and R2 objects; (b) delete quarantine objects older than 24h with no completed upload; (c) mark expired invitations. TDD each sweeper with fake timers/fixtures.
- Commit: `feat(worker): attachment text extraction and scheduled purge jobs`. Verify with `npm run smoke:file`.

### Task 20: Attachment previews + download

- **API**: `GET /api/files/:id/download` → tenant-checked presigned GET (5 min) from the `approved/` prefix only; `DELETE /api/files/:id` (removes row + object; blocked while referenced by `message_attachments` → 409).
- **Web**: image thumbnails in chips (via download URL), click → lightbox dialog (focus-trapped per existing drawer patterns); PDF chips show page count when available.
- Commit: `feat: attachment previews and secure downloads`.

### Task 21: Transcript export

- Client-side export from loaded messages: Markdown download (`{title}.md` with timestamps and model/provider footnotes from receipts) and JSON download. Button in the route-inspector/header menu. Pure generator module `apps/web/src/lib/export-transcript.ts` with unit tests.
- Commit: `feat(web): export conversations as markdown or JSON`.

**Phase 2 gate:** preflight + `smoke:file` green; share page renders logged-out; search finds message bodies; an uploaded PDF answers questions about its content.

---

## Phase 3 — Realtime robustness, real quotas, personalization (Week 3)

### Task 22: Multi-replica cancellation + Redis rate limiting

- Move `activeChatRequests` cancel flags (apps/api/src/app.ts:167-168) to Redis: `SET hive:cancel:{idempotencyKey} 1 EX 60`; the chat handler checks before routing and between stream chunks (keep the in-memory map as a fast path).
- Switch `@fastify/rate-limit` to the ioredis store; add a per-subject chat limiter (`hive:rl:chat:{tenantId}`, 60 rpm default from `quota_policies`).
- TDD: cancel works when POSTed to a different app instance (test via two `createApp()` instances sharing one Redis); limiter counts across instances.
- Commit: `fix(api): make cancellation and rate limits replica-safe`.

### Task 23: Enforce quota_policies for real

- Read `quota_policies` per tenant (fallback defaults 60 rpm / 10 managed rpm / 4 streams / 20 searches-day).
- Enforce: managed-rpm on managed candidates only; concurrent streams via Redis `INCR`/`DECR` with TTL safety net; searches/day via Redis daily counter on `/api/search`.
- `/api/usage` returns the tenant's actual policy + live counters instead of hardcoded numbers.
- TDD each limit with frozen time; 429 bodies match the existing error shape.
- Commit: `feat(api): enforce per-tenant quota policies`.

### Task 24: Token-based credit accounting

- Replace the flat 1-credit debit with `ceil((prompt_tokens + completion_tokens) / 1000) * classMultiplier` (`free=0`, standard managed=1, premium managed=4 — exact multipliers decided in the phase plan and stored on the candidate config, not hardcoded mid-pipeline).
- Ledger rows record `tokens_in`, `tokens_out`, `multiplier` in `metadata`. Idempotency unchanged (unique debit key).
- TDD: usage-less upstream responses fall back to 1 credit; cancelled streams debit 0.
- Commit: `feat(api): price managed inference by tokens`.

### Task 25: User settings & custom instructions ✅

- [x] Migration 0003: `user_settings (user_id PK, system_prompt text, default_model jsonb, temperature numeric, updated_at)` + RLS (user-scoped via tenant of personal workspace — confirm pattern in phase plan).
- [x] API: `GET/PATCH /api/settings` (Zod-validated; system prompt ≤4000 chars, temperature 0–2).
- [x] Chat pipeline: when the request has no system message and the user has one stored, prepend it server-side; apply default temperature when unset in the request.
- [x] Web: new `/settings/general` page (system prompt textarea, default model select fed by `/api/models`, temperature slider); rail/settings nav entry.
- [x] Commits: `feat(db+api): per-user settings and custom instructions` + `feat(web): general settings page`.

### Task 26: Command palette actions + keyboard shortcuts

- Palette (`app-shell.tsx`): add actions — New chat, Toggle theme, Switch model…, Search chats…, Go to usage — with the existing fuzzy filter; keep navigation links.
- Shortcuts: `Ctrl/⌘+Shift+O` new chat, `Esc` stops an active stream (when transcript focused), `/` focus (existing). Central `apps/web/src/lib/shortcuts.ts` with a help dialog (`?`).
- TDD: action registry unit tests; palette rendering tests.
- Commit: `feat(web): actionable command palette and keyboard shortcuts`.

### Task 27 (stretch): Stream resume

- Buffer SSE frames in Redis per idempotency key (`RPUSH hive:stream:{key}`, EX 120) while piping to the client; on reconnect with `x-hive-resume: {key}` + `Last-Event-ID`, replay buffered frames then continue live. Client auto-resumes once on network drop before marking failed.
- Only attempt after Tasks 22–23; flag as stretch.
- Commit: `feat(api): resumable chat streams`.

**Phase 3 gate:** preflight green; two API replicas behind a local proxy still cancel/limit correctly; usage page shows real numbers; custom instructions affect answers.

---

## Phase 4 — Platform hardening (Week 4+, schedule independently)

Each of these is its own expanded plan when picked up:

28. **Provider lifecycle** — `PATCH/DELETE /api/providers/:id` (rename, rotate key, change default model, disable via `disabled_at`); `POST /api/providers/:id/health` re-check; worker cron refreshing `healthy`, `latency_ms`, and the `provider_models` catalog; router consumes live health/latency instead of static flags.
29. **Usage history & dashboard** — `GET /api/usage/history?days=30` (per-day requests/tokens/credits, per-provider split from `router_requests`); `usage-surface.tsx` charts using dependency-free CSS bars.
30. **Build Council persistence** — write `build_jobs`/`build_phases`/`build_artifacts` from the worker (fix the DB enum to include `synthesizer`); `GET /api/builds` history list; web build-history view replacing BullMQ-returnvalue-only results.
31. **Account lifecycle** — `DELETE /api/account` (anonymize user row, purge tenant data, revoke keys/sessions, audit) and `GET /api/account/export` (JSON dump of conversations/messages/settings); run `test:auth`.
32. **Message feedback** — `message_feedback` table + `POST /api/messages/:id/feedback` (`up|down`, optional comment); thumbs UI on assistant messages; feedback visible in admin.
33. **Admin v2** — analytics endpoint (DAU, requests/day, provider error rates, credit burn), user suspend/unsuspend (`users.suspended_at` already checked by `authenticateApiKey` — add the setter route), audit-log read API with filters; expand `admin-surface.tsx`.

---

## Explicit non-goals (this roadmap)

- **Billing/Stripe** — credits stay admin-granted until the token-priced model (Task 24) proves out; revisit after Phase 4.
- **Voice input** — `Permissions-Policy: microphone=()` currently blocks it; enabling requires a privacy decision, not just code.
- **Multi-member workspaces** — tenants stay 1:1 personal; memberships exist but team UX is out of scope.
- **Code execution / repo runners** — permanent product boundary.
- **Mobile native apps, PWA install** — responsive web only for now.
- **Memory / cross-chat personalization** — deferred; custom instructions (Task 25) covers 80% of the value.

## Self-review notes

- Spec coverage: every gap in the chat-response gap analysis maps to a task (sign-out→1, delete-confirm→2, markdown→3, scroll→4, drafts→5, paste→6, retry→7, pins/archive/N+1/lazy→8/9/13, edit/regenerate→10/11/14, titles→12, streaming perf→15, sharing→16, search→17, attachments→18/19/20, export→21, replica-safe cancel/ratelimit→22, quotas→23, token pricing→24, system prompt→25, palette/shortcuts→26, stream resume→27, providers→28, usage API→29, build persistence→30, account deletion→31, feedback→32, admin→33).
- Type consistency: `hive.parent_message_id` / `hive.regenerate_of` / `hive.attachment_ids` are used identically across API and web tasks; cursor pagination shape `{ data, next_cursor }` is uniform; `pinned` PATCH field matches the `pinned_at` column.
- Placeholder scan: Phase 0 is fully code-complete; Phases 1–4 specify exact files, endpoints, schemas, and algorithms, and each gets its own expanded TDD plan at scheduling time (stated explicitly rather than hand-waved).
