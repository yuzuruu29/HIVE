# HIVE

HIVE (Hyper Intelligence for Verified Engineering) is a verified agentic coding runtime with both a CLI/TUI and a Windows desktop companion. Both surfaces use the same TypeScript core, isolated Git worktrees, provider configuration, multi-agent orchestration, and guarded change approval. HIVE never pushes or opens a pull request automatically.

## Visual Identity
- The native terminal uses the selected hive-only fallback in its empty state.
- Violet wordmark indicates verified agentic coding.

The Desktop Projects interface and native TUI now share durable project/session
history. See [shared GUI/TUI architecture, launch, migration and verification](docs/GUI_TUI_INTEGRATION.md)
for the integration's current source and release boundaries.

## Repository Consolidation
`C:\HIVE` is the single home for the HIVE project. The `the-hive-skill` (hive-mind-council) repo was consolidated here:
- `skills/hive-mind-council/` — the built-in **hive skill** (vendored from `the-hive-skill`, Apache-2.0).

The `hive-cloud` web workspace (AGPL-3.0) is **not vendored here**; its source lives upstream at [github.com/yuzuruu29/hive-cloud](https://github.com/yuzuruu29/hive-cloud). The optional `hive-cloud` provider preset below talks to the deployed cloud API and needs only its base URL and API key.

The previous sibling folders (`hive-cloud`, `the-hive-skill`, `HiveMind`, and temp/backup copies) were moved to `C:\_hive_archive_2026-08-16\` as a reversible backup. Nothing was permanently deleted; remove that archive when you no longer need the originals. See [`NOTICE.md`](NOTICE.md) for license details.

## Provider Setup

Choose **BYOK** (your own API key), a **local model server**, or **ChatGPT subscription sign-in through installed Codex**. Local servers can run without a key. HIVE saves API-key environment references; subscription credentials stay in Codex's OS keyring under a separate HIVE account. See [provider setup](docs/CLI_BYOK_LOCAL.md) and [ChatGPT setup and limits](docs/CLI_CHATGPT_SUBSCRIPTION.md).

### Interactive Setup (Recommended)
The wizard offers BYOK, local and ChatGPT subscription modes. API/local setup asks for the actual model and tests its health prerequisite; subscription setup prints explicit sign-in instructions. Role defaults remain unchanged unless you explicitly replace them:
```bash
hive providers setup
```

Inside HIVE, use `/connect` to choose either mode, then complete its editable registration command. Use `/providers test ID`, `/providers approve ID` and `/model ID/MODEL` to select it for the conversation. `/providers models ID` lists actual models and lets you select one. This choice persists across restart without changing your default roles.

### Manual Setup
For CI/CD or power-user configuration, you can add providers manually.

Add the optional HIVE 0.1 preset using the deployed HIVE Cloud API URL and a reveal-once `hive_live_` key:
```powershell
$env:HIVE_API_KEY = "hive_live_your_key"
hive providers add --id hive-cloud --kind openai-compatible --base-url https://your-api.up.railway.app/v1 --api-key-env HIVE_API_KEY --model hive-0.1
```

The setup wizard also offers **HIVE 0.1** as a preset. The Windows desktop companion stores the HIVE key in its encrypted credential vault and asks for the deployed `/v1` base URL. Local providers and offline work remain unchanged.

Add an OpenAI-compatible custom provider:
```bash
hive providers add --id my-custom-openai --kind openai-compatible --base-url https://api.custom.com/v1 --api-key-env CUSTOM_API_KEY --model my-model
```

Add an OpenRouter provider:
```bash
hive providers add --id openrouter-main --kind openrouter --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --model qwen/qwen3-coder
```

Add a local Ollama provider (replace `YOUR_INSTALLED_MODEL` with its actual ID):
```bash
hive providers add --id local-ollama --preset ollama --model YOUR_INSTALLED_MODEL
```

Add a keyless local OpenAI-compatible server:
```bash
hive providers add --id local-models --preset local --base-url http://127.0.0.1:1234/v1 --model YOUR_LOADED_MODEL
hive providers models local-models
```

### Approve and Test a Provider
Before HIVE will allow a provider to execute, you must explicitly approve it. You can optionally run a non-destructive health check.
```bash
hive providers test local-ollama
hive providers approve local-ollama
```

### Assigning Roles
HIVE orchestrates coding through `planner`, `builder`, `validator`, and `reviewer` roles. You can assign different providers and models to specific roles:
```bash
hive providers roles set builder local-ollama codellama
hive providers roles set reviewer openrouter-main anthropic/claude-3-sonnet
```

HIVE's chatbot and hivebot mode use **BYOK role assignment** so you control which model serves each persona. The chatbot roles are: `planning`, `coding`, `heavy-reasoning`, `game-builder`, `project-coworker`, `study-buddy`, plus an `auto` mode that classifies each message and picks the right role. Assign a model to any of them:
```bash
hive providers roles set planning openai gpt-4o
hive providers roles set coding openrouter-main qwen/qwen3-coder
hive providers roles set heavyReasoning openai o1
hive providers roles set gameBuilder anthropic claude-3-5-sonnet
hive providers roles set projectCoworker openai gpt-4o-mini
hive providers roles set studyBuddy openai gpt-4o-mini
```
Run `hive chat` then `/list` to see current assignments, or `hive providers roles` for the raw JSON.

### Runtime Provider Overrides
If you need to quickly override the provider for a specific task without modifying roles:
```bash
hive run "fix the bug" --provider local-ollama --model llama3
```

### Supported Providers
- **`openai`**: OpenAI Official endpoints
- **`openai-compatible`**: Custom OpenAI-like endpoints (vLLM, LMStudio, TokenRouter)
- **`openrouter`**: OpenRouter endpoints
- **`ollama`**: Local Ollama endpoints (No auth required)
- **`anthropic`**: *(Basic integration configured)*
- **`google`**: *(Basic integration configured)*
- **`oauth`**: *(Not currently implemented - API Keys are recommended)*

## HIVE Scout Context Engine
HIVE uses the **Scout Context Engine** to deterministically gather local repository intelligence for its agents. 

- **Local-first**: Operates entirely locally without vector databases or embeddings.
- **Safety-focused**: Strictly ignores `.env`, `.git`, `node_modules`, and explicitly blocks reading raw secrets.
- **Budget-aware**: Truncates context automatically to a max budget (e.g. 20,000 characters) to preserve prompt space.
- **Task-ranked**: Boosts the priority of files based on heuristic keyword overlaps with your prompt.

### How Scout Helps Planner and Builder
By injecting this bounded, deterministic context block directly into the Planner and Builder execution prompts, HIVE significantly reduces hallucinations. The Planner uses the contextual architecture and top-ranked target files to generate more accurate multi-step execution plans. The Builder uses the dynamically extracted structural snippets (imports and class definitions) and task-specific risk notes to avoid breaking existing interfaces or leaking safe states.

You can inspect what Scout sees manually via the CLI:
```bash
hive scout --task "provider setup"
hive scout --files
hive scout --json
```

## Chatbot & Hivebot

HIVE ships with a built-in chatbot and a **hivebot** swarm mode. Both are built on the same BYOK provider routing as the coding runtime, so your API keys (via env vars) and per-role model assignments apply everywhere. Chatbot and hivebot roles accept **both kebab-case and camelCase** names interchangeably everywhere (e.g. `heavy-reasoning` and `heavyReasoning`, `game-builder` and `gameBuilder`).

### Chatbot (`hive chat`)
- `hive chat "your message"` — single-turn answer. Each turn prints a **receipt** to stderr: `[role → provider/model · tokens · latency]`.
- `hive chat` — interactive REPL. Non-agent turns **stream** output to the terminal as it arrives (providers without streaming fall back to buffered output; one-shot `--json`, agentic mode, and hivebot stay buffered). Inline commands: `/role <slug>`, `/auto`, `/model <provider/model>`, `/agent on|off`, `/ground on|off|refresh`, `/list`, `/skill`, `/sessions`, `/resume <id>`, `/clear`, `/exit`, `/help`.
- Personae: `planning`, `coding`, `heavy-reasoning`, `game-builder`, `project-coworker`, `study-buddy`. In `/auto` mode (default), HIVE classifies each message and routes it to the best-fit role.

Flags:
- `--role <slug>` — force a persona (kebab or camel). Invalid roles error out with the valid list.
- `--agent` — **agentic mode**: the model may call **read-only tools** (`read_file`, and related safe reads) to ground its answer. It cannot modify anything.
- `--ground` — **Scout grounding**: inject a bounded Scout context pack (repo summary, ranked files, docs — capped at 12k chars) ahead of the persona prompt. The pack builds lazily from your first grounded message; `/ground refresh` rebuilds it, `/ground off` disables it. If Scout fails, the turn proceeds ungrounded. In `--json` mode a `{"type":"grounding"}` event reports `built` (with `chars`) or `unavailable`.
- `--json` — emit machine-friendly **newline-delimited JSON events** (user, role, grounding, receipt, assistant, error). Requires a message: `hive chat --json "your message"`.
- `--model <provider/model>` — manual provider + model override for the turn.
- `--resume <id>` — **resume** a saved chat session before the first message, restoring prior messages into context.

### Sessions & resume
The REPL persists each completed turn to `.hivemind/` via the chat session store. Use `/sessions` to list saved sessions, `/resume <id>` inside the REPL to switch sessions, or pass `--resume <id>` on the command line to load a session up front. Sessions store messages, the active role, any manual model override, and whether Scout grounding was enabled (the pack itself is rebuilt on resume).

### Hivebot swarm (`hive hivebot "<task>"`)
Delegates the task across the built-in six-role council (Queen → Scout → Architect → Forger → Sentinel → Scribe). Each council agent runs as its own LLM turn served by its assigned model (e.g. `planning` for Queen/Architect, `coding` for Scout/Forger, `heavy-reasoning` for Sentinel, `project-coworker` for Scribe).

Flags:
- `--preset <quick|standard|deep|audit>` — force a **budget preset** (token budget + repair rounds). Without it, the Queen classifies the task and selects a preset. An invalid value errors immediately with the valid list.
- `--provider <id>` — force the provider for every council stage.
- `--model <m>` — force the model for every council stage.

Running `hive hivebot` with no task prints usage. The swarm:
- Runs Scout and Architect in parallel when the preset allows.
- Sends the Forger's work to the **Sentinel**, which issues a **verdict** (`PASS` / `FAIL` / `BLOCKED`); on `FAIL` it triggers **bounded repair** — up to the preset's `repairRounds`, the Forger addresses the Sentinel's findings and re-validates.
- Honors the preset's **token budget**; exceeding it stops the run with a `BUDGET_EXCEEDED` status.
- Writes **artifacts** under `.hivemind/hivebot-runs/<runId>/`: a machine-readable `run.json` and a human-readable `report.md`, plus a summary line with status, preset, stage count, tokens, and run id.

### Bring Your Own Keys (BYOK)
Add providers with an env-var reference (keys are never stored in config):
```bash
hive providers add --id openai-main --kind openai --api-key-env OPENAI_API_KEY --model gpt-4o
hive providers approve openai-main
```
Then assign a model to each chatbot role (see [Assigning Roles](#assigning-roles)). With no role assigned, HIVE falls back to your first approved provider.

## What HIVE Is Not
- Not a full IDE.
- Not an uncontrolled auto-coder that pushes directly to production.
- Not production-certified yet.

## HIVE vs OpenCode/Kimchi
HIVE is inspired by the terminal-first workflow of modern coding agents, but focuses on a verified engineering loop: scoped worktrees, explicit approval, guarded provider execution, role-based swarm agents, and safety-first patch review.
HIVE is moving toward a terminal coding harness with provider routing, sessions, and workflow mode.

## Architecture
User Task -> Planner -> Builder -> Validator -> Reviewer -> Diff -> Approval -> Commit -> Push/PR

## Quickstart

### Install the CLI from npm

The npm package is **`@uzzy-malolos/hive`**; the command remains **`hive`**.
It requires Node.js **22.17 or newer** and Git for coding workflows. The Windows
desktop app is distributed separately and is not installed by this command.

Once a public version has been published:

```bash
npm install -g @uzzy-malolos/hive
hive --help
hive providers setup
```

Then run `hive` inside the Git repository you want to work on. Model requests
require your chosen API credential, running local model, or supported subscription
sign-in; installing the CLI does not install a model or include provider credits.

`hive@uzzy-malolos` is not this package: npm interprets it as a tag of the unrelated
unscoped `hive` package. See [npm release and local-install checks](docs/NPM_RELEASE.md)
for the unpublished-package workflow and release checklist.

### Develop from source

```bash
git clone https://github.com/yuzuruu29/HIVE.git
cd HIVE
npm ci
npm run build
npm test

# Check status
npm run hive -- status

# Run a task
node bin/hive.mjs run "small task"
```

## Windows Desktop: shared projects and conversations

The React/Electron companion now opens a charcoal project sidebar, nested sessions,
one conversation and one composer. Code, Plan and Chat use the existing live
engines through the same shared session service as the native TUI.

- Create, search, rename, archive and restore sessions without moving another
  client's selection or draft.
- Choose configured models, workflow and permissions; inspect the backend's
  effective policy and approve individual scoped tool requests.
- Expand role activity, open optional changes/checks, inspect actual command
  results and mark a completed attempt reviewed. Guarded Git actions retain their
  separate current-state verification and confirmation.
- Stop a run and continue through a new linked attempt; previous output and
  partial changes remain visible.
- Keep the existing Paper theme, provider/settings dialogs, keyboard controls and
  responsive navigation. **Legacy history & tools** reads earlier Chat/Code history;
  new conversations and runs start in Projects.

Existing history imports only after a reviewed preview and backup. Shared history
lives in `~/.hive/interface-v1/catalog.json`; legacy records and coding worktrees
remain under their repositories. Drafts and scroll positions are client-local and
currently memory-only. See [the integration guide](docs/GUI_TUI_INTEGRATION.md) for
storage, migration/rollback, terminal commands and actual verification limits.

Verified locally on Windows across 2026-10-18–19: core 1224/1224, final affected
regressions 113/113 (overlapping), renderer 194/194, native Electron 3/3, actual
ConPTY/Electron cross-client checks, native visual checks and a restricted live
Gemini task with real diff/command evidence. Final manual NSIS/portable builds,
PE-resource audit and actual packaged/portable smokes also passed.
Automatic approval review blocked local verification cleanup,
so those outputs are retained with their manifest. NSIS install/uninstall
was not run because it would overwrite an existing updater cache; that file and the
original dirty checkout were preserved. See the guide for evidence and platform limits.

Development and verification:

```bash
npm run build:desktop
npm run desktop:start
npm run test:desktop-renderer
npm run desktop:e2e
```

Create unsigned local Windows artifacts:

```bash
npm run desktop:dist
npm run desktop:smoke
```

Artifacts are written to `dist-binaries/` as a per-user NSIS setup executable and a no-install portable executable. Both editions store settings and encrypted credential blobs in Windows AppData, and use the shared user-home catalog described above; legacy threads, coding sessions, reports and worktrees stay under the repository's `.hivemind/` directory. Local unsigned builds are for internal evaluation, updates are installed manually, and signing is enabled only when standard electron-builder certificate secrets are configured. Packaging instructions do not establish acceptance of a new revision; check its recorded verification status.

See [Windows desktop release and operator guide](docs/WINDOWS_DESKTOP_RELEASE.md) for packaging, signing, checksums, smoke testing, storage, and release procedures.

## CLI Commands
- `hive` (no args): Open the interactive coding terminal.
- `hive "fix the parser"`: Open the terminal with an initial request.
- `hive -p "fix the parser" --json`: Run headlessly; structured results stay on stdout, including failures.
- `hive -p - --output-format streaming-json`: Explicitly read a prompt from stdin and stream JSONL.
- `hive --continue` or `hive --resume <cli-id>`: Restore a CLI conversation; add a prompt for a new turn.
- `hive --resume <cli-id> --fork-session`: Restore context into a new conversation and independent coding worktree before applying a new prompt.
- `hive --model <provider/model> --image <file> "inspect this screenshot"`: Use a conversation-local model and actual image input.
- `hive providers setup` or `/connect` inside HIVE: Choose BYOK, a local provider or Codex-managed ChatGPT sign-in, then select an actual model.
- `hive --plan "inspect this change"` or `hive --review`: Use an invocation-local read-only mode.
- `hive code "<objective>"`: Start a multi-agent coding session led by the Queen.
- `hive code --resume <session-id>`: Reinspect the repository and continue a saved coding session.
- `hive run "<task>"`: Start a new task flight.
- `hive status`: Check the status of the current flight.
- `hive diff [--full]`: View the patch diff generated by the agents.
- `hive approve`: Approve the current task's changes.
- `hive discard`: Discard the current task.
- `hive push --confirmed`: Push the approved task to the remote repository.
- `hive pr --confirmed`: Create a Pull Request for the approved task.
- `hive scout [--task "<task>"] [--json] [--files]`: Run the Scout context engine to gather intelligence.
- `hive chat ["message"]`: Start the HIVE chatbot. With no argument it opens an interactive REPL; with a message it answers in one shot.
- `hive hivebot "<task>"`: Run a **hivebot** swarm — delegates the task to the built-in hive-mind-council (Queen → Scout → Architect → Forger → Sentinel → Scribe), each role served by its assigned BYOK model.

In the interactive terminal, Enter submits and Ctrl+J adds a newline. Messages submitted during a turn wait in order; Esc cancels the current turn and starts the next message after cancellation finishes. A second Esc or Ctrl+C clears the queue. Ctrl+Left/Right selects tool cards and Ctrl+O expands the selected card. The status line refreshes the Git branch after each turn. Tool previews use redacted results from the run.

The terminal supports Unicode grapheme editing, bracketed multiline paste, history drafts, `/new`, `/resume`, `/continue`, `/rename`, `/fork`, `/compact`, `/context`, `/find`, `/export`, and `/copy`. `/model` selects an approved conversation-local model; `@"path with spaces":10-20` attaches bounded file context. `!command` or `/shell` runs an approved command with streaming output and cancellation. `/diff`, `/checkpoints`, and `/rewind files [id]` inspect or restore managed changes with explicit confirmation. `/rewind` alone changes the visible transcript.

Use `/mcp`, `/skills`, `/skill`, `/plugins`, `/hooks` and `/lsp` for the opt-in extension ecosystem. Marketplace installation fetches pinned compatible bundles, initially disabled and untrusted; see [marketplace plugins](docs/CLI_MARKETPLACES.md). [Advanced protocols](docs/CLI_PROTOCOLS.md) cover modern MCP tasks/lifecycle/subscriptions, legacy streams/tasks, approved sampling/elicitation, five Claude hook handler types, explicit output styles, literal command arguments, specialist agents, dependency gates and LSP queries. `/mcp login`, `auth-status` and `logout` support [HTTP OAuth](docs/CLI_OAUTH.md). Follow-ups retain the coding worktree; `/fork` independently copies permitted staged/unstaged/untracked state. Session leases prevent concurrent CLI writers. See [CLI configuration](docs/CLI_EXTENSIONS.md) and [the parity record](docs/HIVE_CLI_PARITY.md) for exact verification and limits.

`hive providers verify <id> --coding --json` checks actual buffered/streaming generation and a bounded file-write tool workflow with one configured provider/model. It can consume quota; see [provider verification](docs/CLI_PROVIDER_VERIFICATION.md) for limits and actual local-model evidence.

### Modes & Sessions
- Coding modes: `hive code "<objective>" --mode <auto|plan|review>`.
- Coding controls: `--max-agents`, `--max-retries`, `--provider`, `--model`, and `--approval <safe|changes|always>`.
- Output controls: `--no-tui` streams readable events; `--json` emits undecorated newline-delimited JSON events.
- `hive mode`: View the current operating mode.
- `hive mode set <guarded|standard|autonomous|plan|review>`: Set the current safety mode.
- `hive sessions` or `hive sessions list`: List coding sessions and legacy task cells. Archived sessions stay in the list with an `archived` flag. JSON output includes `archived`.
- `hive sessions show <id>`: Show detailed JSON for either session format.
- `hive sessions fork <id>`: Copy a settled coding session into an independent branch and worktree, preserving its index and permitted working files. Legacy task cells retain metadata-only fork restrictions. See [workspace forks](docs/CLI_WORKTREE_FORKS.md).
- `hive sessions adopt <id>`: Preview deliberate external edits or an older saved fingerprint. The printed confirmation command accepts that exact inspected state and invalidates prior validation; files remain unchanged.
- `hive sessions archive <id>`: Mark a session archived without deleting it. Archived sessions cannot be resumed until restored.
- `hive sessions unarchive <id>`: Clear the archived flag.
- `hive resume <id>` or `hive sessions resume <id>`: Set a saved session as active.
- `hive agents`: List persisted subagents across coding sessions.
- `hive agents show <id>`: Show a persisted subagent and its owning session.
- `hive report <session-id>`: Generate a deterministic Markdown run report.
- `hive report <session-id> --json`: Generate the versioned machine-readable report.
- `hive report <session-id> --output <path>`: Write inside the repository without overwriting an existing file.

## Community and Commercial Boundary

The complete local runtime, local/BYOK providers, orchestration, safety controls, sessions, and run reports remain Community functionality with no account or billing dependency. Future hosted capabilities are designed as a separate server-authoritative control plane. See [`docs/monetization/COMMUNITY_AND_COMMERCIAL_BOUNDARY.md`](docs/monetization/COMMUNITY_AND_COMMERCIAL_BOUNDARY.md).

## Safety Guarantees
- **Worktree isolation**: Agents work in isolated git worktrees, preventing conflicts and accidental changes to your main branch.
- **Approve-before-commit**: No code is committed to your branch without explicit human approval.
- **No auto-push**: HIVE will never push to remote without you running `hive push --confirmed`.
- **Explicit push/PR confirmation**: Required flags ensure deliberate action.
- **Scoped staging**: Only changes requested and verified are staged.
- **Denylist protection**: Prevents modification of sensitive files (e.g., `.env`, `.git/`).
- **Secret redaction**: Transcripts and outputs redact common secrets to prevent accidental leaks.
- **Durable task records**: Task state is reliably stored locally in `.hivemind/coder-tasks`.

## Roadmap
- Direct local mode hardening
- Provider setup wizard
- VS Code extension wrapper
- GitHub App integration
- Hosted team mode later
