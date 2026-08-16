# Chat Harness Upgrade — HIVE chatbot/hivebot

Branch: `feat/chat-harness` (baseline commit 05d27c3). Goal: turn the MVP
`hive chat` / `hive hivebot` into a real harness — router-backed completions
with receipts, an agentic tool-loop mode, a protocol-faithful hivebot engine,
and persistent sessions.

## Global Constraints

- TypeScript strict, ESM (`"type": "module"`); all relative imports MUST use
  `.js` suffixes. Build with `npx tsc`; typecheck with `npx tsc --noEmit`.
- Tests are `.mjs` files under `tests/`, import from `../dist/...`, and run
  with `node --test --test-reporter=spec <file>`. ALWAYS run `npx tsc` before
  running tests (tests load `dist/`, not `src/`).
- Never store raw API keys anywhere; credentials are env-var references
  (`apiKeyEnv`) resolved by provider adapters.
- Do not break existing commands or tests. `npx tsc --noEmit` must pass and
  existing test files must remain green.
- Chat role BYOK keys are camelCase in `.hive/provider-roles.json`
  (`planning, coding, heavyReasoning, gameBuilder, projectCoworker, studyBuddy`).
  User-facing slugs are kebab-case (`heavy-reasoning`, ...). Everywhere a user
  types a role, BOTH forms must be accepted.
- The vendored skill lives at `skills/hive-mind-council/skills/hive-mind-council/`
  (contains `SKILL.md`, `agents/`, `references/`, `templates/`).
- Stay within each task's file list. Files outside the list are off-limits
  without controller approval.
- Environment: Windows, git-bash. Keep code platform-neutral (use
  `node:path`, forward APIs).
- YAGNI: build exactly what the task specifies. No speculative abstractions.

## Task 1: Foundation — shared chat types + ProviderRouter-backed engine

Files: `src/chat/types.ts` (new), `src/chat/engine.ts` (new),
`src/coding/types.ts` (edit), `src/chat/roles.ts` (edit),
`tests/chat-engine.test.mjs` (new).

1. `src/coding/types.ts`: add
   `export const CHAT_BINDING_ROLES = ["planning","coding","heavyReasoning","gameBuilder","projectCoworker","studyBuddy"] as const;`
   `export type ChatBindingRole = (typeof CHAT_BINDING_ROLES)[number];`
   and extend `ProviderBindingRole` to `"queen" | SubagentRole | ChatBindingRole`.
   Fix any type errors this union widening surfaces (there should be none —
   verify with `npx tsc --noEmit`).
2. `src/chat/types.ts`: define and export
   - `ChatMessage { role: "user"|"assistant"; content: string; at: string; receipt?: ChatReceipt }`
   - `ChatReceipt { role: string; providerId: string; model: string; source?: string; degraded?: boolean; promptTokens?: number; completionTokens?: number; totalTokens?: number; latencyMs?: number }`
   - `ChatRoleSelection = ChatBindingRole | "auto"`
   - `SessionProviderOverride { providerId?: string; model?: string }`
   - `ChatSessionRecord { id: string; createdAt: string; updatedAt: string; cwd: string; messages: ChatMessage[]; role: ChatRoleSelection; override?: SessionProviderOverride; }`
3. `src/chat/engine.ts`: export `createChatEngine(projectRoot: string, sessionId: string, options?: { globalProjectRoot?: string })` returning a `ChatEngine` with:
   - `complete(req: { role: ChatBindingRole | "queen" | SubagentRole; prompt: string; systemPrompt?: string; providerId?: string; model?: string; signal?: AbortSignal }): Promise<{ output: string; receipt: ChatReceipt }>`
     implemented over `ProviderRouter` (`src/coding/provider-router.ts`):
     call `router.resolve(role, override, signal)` for route metadata, then
     `router.complete(...)`; build the receipt from the resolved route
     (`providerId, model, source, degraded`) + `usage` + latency
     (`Date.now()` delta). Errors propagate to the caller.
   - `resolveRoute(role, override?)` exposing `{ providerId, model, source, degraded }`.
   - Construct with `new ProviderRouter({ projectRoot, sessionId, globalRegistry: new ProviderRegistry(os.homedir()) })`.
4. `src/chat/roles.ts`: import `ChatBindingRole` from `./types.js`; keep the
   six personas and `classifyTask` unchanged; add
   `export function normalizeChatRole(input: string): ChatBindingRole | null`
   accepting kebab-case AND camelCase forms (case-insensitive), returning
   `null` for unknown input. Keep `ROLE_KEY` mapping slugs to ProviderRoles keys.
5. Tests (`tests/chat-engine.test.mjs`): unit-test `normalizeChatRole` (valid
   kebab, valid camel, mixed case, invalid → null) and `classifyTask` sanity
   (≥4 cases from the personas). Test `createChatEngine.complete` with a stubbed
   `ProviderRouter`-shaped seam: engine.ts must accept an optional
   `router?: ProviderRouterLike` injection in options for tests — define a
   minimal structural interface for it — and verify the receipt is populated
   (providerId/model/tokens/latency) and output passthrough. Follow the import
   style of `tests/providers.test.mjs` (import from `../dist/...`).

## Task 2: Chat core rewrite — router-backed REPL + agentic mode

Files: `src/chat/chat-cli.ts` (rewrite), `src/chat/skill-locate.ts` (new),
`src/chat/agent-tools.ts` (new), `tests/chat-core.test.mjs` (new).
Do NOT touch `src/cli.ts`, `src/chat/hivebot.ts`, or `src/chat/engine.ts`.

1. Move `findRepoRoot` + `locateSkillRoot` (currently duplicated in
   `src/chat/hivebot.ts`) into `src/chat/skill-locate.ts` and export both.
   `describeSkill` in chat-cli must use `locateSkillRoot` (async) — removes the
   cwd-vs-repo-root inconsistency. `hivebot.ts` will be rewired to it in Task 3
   (leave `hivebot.ts` untouched; temporary duplication is acceptable).
2. Rewrite `runChat` in `src/chat/chat-cli.ts` on top of `createChatEngine`:
   - All completions go through the engine (health-aware fallback + receipts).
     Keep the existing exported signatures: `runChat(args, options)` →
     `{ exitCode, output }`, `ChatOptions { cwd?, signal? }`, and keep
     `resolveChatTarget` exported (hivebot.ts still imports it until Task 3).
   - Options accepted in `args` (parsed with a small flag parser, flags may
     appear anywhere): `--role <slug>` (initial role; accept kebab/camel via
     `normalizeChatRole`), `--json` (one-shot NDJSON output; see below),
     `--agent` (enable agentic mode for the session).
   - Conversation history is `ChatMessage[]` (from `./types.js`). Before each
     turn, apply a simple char-budget trim (keep the most recent messages that
     fit ~48,000 chars total) — the full compaction API arrives in Task 4; do
     not build it here.
   - Per-turn receipt line printed to stderr (so `--json` stdout stays clean):
     `[role → provider/model · 1,234 tok · 2.1s]` plus `(degraded)` when true;
     track session token totals; print totals on `/exit`.
   - Ctrl+C once cancels the in-flight turn (AbortController wired through the
     engine `signal`); Ctrl+C twice exits the REPL. Implement via readline
     `close`/SIGINT handling; keep it simple and documented.
   - Slash commands (accept kebab/camel everywhere a role is typed):
     `/role <slug>`, `/auto`, `/model <providerId>/<model>` — parse on the
     FIRST "/" only so OpenRouter-style IDs like `qwen/qwen3-coder` survive —
     `/list`, `/skill`, `/clear`, `/agent on|off`, `/exit`, `/help`.
   - `--json` one-shot mode: emit NDJSON events to stdout: `{"type":"user",...}`,
     `{"type":"role","role":"...","source":"auto|manual"}`,
     `{"type":"receipt",...}`, `{"type":"assistant","content":"..."}`.
3. `src/chat/agent-tools.ts`: READ-ONLY agent tools for the agentic mode,
   integrated with `StructuredAgentLoop` (`src/coding/agent-loop.ts` — study
   its `AgentToolExecutor` and `AgentCompletionClient` interfaces first and
   use them as exported, do not modify agent-loop.ts):
   - `read_file` (path, max 2000 lines), `list_files` (recursive, capped at
     500 entries), `search_files` (literal substring grep across text files,
     capped results). All resolve paths against the chat cwd, refuse paths
     escaping it (`path.resolve` + prefix check), and refuse denylisted
     entries (`.git`, `node_modules`, `.env*`, `.hivemind`, `dist`).
   - Export `createReadOnlyToolExecutor(cwd): AgentToolExecutor` and a
     `describeReadOnlyTools(): string` (tool descriptions for the system
     prompt). In agentic mode, run user turns through `StructuredAgentLoop`
     with the engine as completion client and this executor; non-agent turns
     remain single completions. Agent loop system prompt = persona prompt +
     tool descriptions + "You may use tools to ground answers; you cannot
     modify anything."
4. Tests (`tests/chat-core.test.mjs`): export and test the pure pieces:
   flag parsing (`--role`, `--json`, `--model` first-slash split via the
   exposed parse function), history budget trim, agent-tools denylist/escape
   refusal + read_file/list_files happy paths against a temp dir. Test the
   one-shot `--json` mode end-to-end with a stubbed engine seam (runChat must
   accept an injectable `createEngine` via ChatOptions for tests, defaulting
   to `createChatEngine`). Run per Global Constraints.

## Task 3: Hivebot protocol engine

Files: `src/chat/hivebot.ts` (rewrite), `src/chat/skill-protocol.ts` (new),
`tests/hivebot.test.mjs` (new). May import from `skill-locate.ts`,
`engine.ts`, `types.ts`, `roles.ts`; do not edit them.

1. `src/chat/skill-protocol.ts`: READ
   `skills/hive-mind-council/skills/hive-mind-council/references/orchestration-presets.md`,
   `council-protocol.md`, `handoff-schema.md`, and `verification-policy.md`
   first. Then implement:
   - `COUNCIL_PRESETS: Record<"quick"|"standard"|"deep"|"audit", HivebotPreset>`
     where `HivebotPreset { agents: string[]; repairRounds: number; maxOutputCharsPerStage: number; tokenBudget: number; parallel: boolean }`,
     aligned with the skill's preset semantics (document the mapping in a
     comment; where the skill file is ambiguous, choose conservative values
     and note it).
   - `loadAgentPrompt(skillRoot, agent)` (reads `agents/<Agent>.md`, trims to
     `maxOutputCharsPerStage`), and `loadProtocolDigest(skillRoot)` returning a
     compact digest (≤4,000 chars) stitched from the three reference files
     (headings + key rules) that gets appended to every agent system prompt.
2. Rewrite `src/chat/hivebot.ts`:
   - `runHivebot(task, options)` keeps returning `{ exitCode, output }` for
     `cli.ts` (do not edit cli.ts). Options extend `ChatOptions` with
     `preset?: "quick"|"standard"|"deep"|"audit"`, `providerId?: string`,
     `model?: string`, and an injectable `createEngine` seam (same pattern as
     Task 2) for tests.
   - Pipeline over `createChatEngine` completions:
     a. Queen classifies the task and selects the preset unless the caller
        forced one (parse a `PRESET: <name>` marker from Queen's output;
        default `standard` on ambiguity).
     b. Scout and Architect run CONCURRENTLY (`Promise.all`) when
        `preset.parallel` — each receives Queen's handoff, not each other's
        output; document why that's safe (independent concerns: context map vs
        plan).
     c. Forger receives Architect's plan + Scout's map. Sentinel receives
        Forger's patch manifest. Scribe runs last, only on completion.
   - Structured handoffs: each stage produces
     `StageResult { agent: string; role: ChatBindingRole; output: string; receipt: ChatReceipt }`;
     each stage's prompt contains only a bounded summary (≤4,000 chars) of
     prior stages' outputs — never the raw growing transcript.
   - Sentinel verdict: extract the first line matching
     `VERDICT:\s*(PASS|FAIL|BLOCKED)` (case-insensitive) from Sentinel output;
     absent marker → treat as `FAIL` with reason "verdict marker missing".
   - Bounded repair: on `FAIL`, re-run Forger with Sentinel's findings then
     re-run Sentinel, up to `preset.repairRounds`; `BLOCKED` stops immediately.
   - Stop conditions: return status `COMPLETE` (Sentinel PASS), `BLOCKED`,
     or `BUDGET_EXCEEDED` (when summed receipt tokens exceed
     `preset.tokenBudget` — check before each stage). Every terminal state
     carries a reason string.
   - Progress: print each stage header when it starts and a receipt line when
     it finishes (streaming feel; no end-of-run dump).
   - Artifact: write `.hivemind/hivebot-runs/<runId>/run.json` (task, preset,
     status, reason, stages incl. receipts, token totals) and `report.md`
     (human-readable: task, preset, per-stage outputs trimmed to 2,000 chars,
     final verdict, totals). `runId = hivebot-<epoch-ms>-<4 hex>`.
3. Tests (`tests/hivebot.test.mjs`) with a scripted stub engine (deterministic
   outputs): Queen selects `quick`; happy path → COMPLETE + artifacts written;
   Sentinel FAIL→PASS script → repair loop runs exactly once and reports
   COMPLETE; Sentinel BLOCKED script → stops before Scribe; missing verdict
   marker → FAIL path; token budget exceeded → BUDGET_EXCEEDED. Assert on the
   returned summary object AND the written `run.json`.

## Task 4: Chat sessions + token-budgeted compaction

Files: `src/chat/session-store.ts` (new), `src/chat/history.ts` (new),
`src/chat/chat-cli.ts` (edit), `tests/chat-sessions.test.mjs` (new).

1. `src/chat/session-store.ts`: `ChatSessionStore(repositoryRoot)` modeled on
   `src/coding/session-store.ts` conventions (study it first; atomic
   tmp-file + rename writes, JSON corruption guard with a typed error):
   - Storage dir `.hivemind/chat-sessions/`, one `<id>.json` per session plus
     `active.json` pointer. `id = chat-<epoch-ms>-<4 hex>`.
   - API: `save(record: ChatSessionRecord)`, `load(id)`, `list(): Promise<Array<{id, createdAt, updatedAt, messageCount, role}>>`,
     `setActive(id)`, `getActive()`, `clearActive()`.
2. `src/chat/history.ts`:
   - `compactHistory(messages: ChatMessage[], charBudget: number): { kept: ChatMessage[]; dropped: number; estimatedTokens: number }`
     — keeps the MOST RECENT messages whose cumulative content fits the
     budget (estimate tokens as `ceil(chars/4)`), always keeps the newest
     message, never splits a message.
   - `totalTokens(messages)` helper.
3. `chat-cli.ts` integration: after every completed turn, persist the session
   via ChatSessionStore (create on first turn, update after); replace the
   Task-2 interim trim with `compactHistory(messages, 48_000)`; new commands
   `/sessions` (list), `/resume <id>` (load messages + role + override);
   `runChat` options gain `resumeSessionId?: string` (resume before first
   prompt). Keep everything else from Task 2 intact.
4. Tests: store round-trip (save→load→list→setActive→getActive→clearActive)
   in a temp dir, corruption guard raises typed error; `compactHistory`
   edge cases (fits, over-budget keeps newest, single oversized message is
   kept, dropped count correct); resume flow via the injectable engine seam
   (two-turn script verifying messages restored).

## Task 5: CLI wiring + docs

Files: `src/cli.ts` (edit), `README.md` (edit), `package.json` (edit).

1. `src/cli.ts`:
   - `hive chat`: parse and forward `--role <slug>`, `--json`, `--agent`,
     `--resume <id>` to `runChat` (runChat already accepts them via args —
     route raw args minus the command word; ensure `--help` still works).
   - `hive hivebot "<task>"`: forward `--preset <quick|standard|deep|audit>`,
     `--provider <id>`, `--model <m>` (validate preset value, clear error
     otherwise).
   - Update the `help` command text to document the new flags.
2. `package.json`: append `tests/chat-engine.test.mjs tests/chat-core.test.mjs
   tests/hivebot.test.mjs tests/chat-sessions.test.mjs` to the `test` script's
   file list (keep existing files and ordering intact).
3. `README.md`: rewrite the "Chatbot & Hivebot" section to document: agentic
   mode (`--agent`, read-only tools), receipts, `--json`, sessions + resume,
   hivebot presets + repair + artifacts, and note that both kebab and camel
   role names are accepted everywhere. Keep it consistent with actual flags.
4. Verification: `npx tsc --noEmit`, `npx tsc`, then
   `node --test --test-reporter=spec tests/chat-engine.test.mjs tests/chat-core.test.mjs tests/hivebot.test.mjs tests/chat-sessions.test.mjs`
   — all green. Also run `node bin/hive.mjs --help` and confirm the new flags
   appear, and `node bin/hive.mjs hivebot 2>&1` prints usage (no task).
