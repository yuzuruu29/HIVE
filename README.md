# HIVE

HIVE (Hyper Intelligence for Verified Engineering) is a verified agentic coding runtime with both a CLI/TUI and a Windows desktop companion. Both surfaces use the same TypeScript core, isolated Git worktrees, provider configuration, multi-agent orchestration, and guarded change approval. HIVE never pushes or opens a pull request automatically.

## Visual Identity
- HIVE CLI uses a queen bee terminal motif.
- Violet wordmark indicates verified agentic coding.

## Repository Consolidation
`C:\HIVE` is the single home for the HIVE project. The `the-hive-skill` (hive-mind-council) repo was consolidated here:
- `skills/hive-mind-council/` — the built-in **hive skill** (vendored from `the-hive-skill`, Apache-2.0).

The `hive-cloud` web workspace (AGPL-3.0) is **not vendored here**; its source lives upstream at [github.com/yuzuruu29/hive-cloud](https://github.com/yuzuruu29/hive-cloud). The optional `hive-cloud` provider preset below talks to the deployed cloud API and needs only its base URL and API key.

The previous sibling folders (`hive-cloud`, `the-hive-skill`, `HiveMind`, and temp/backup copies) were moved to `C:\_hive_archive_2026-08-16\` as a reversible backup. Nothing was permanently deleted; remove that archive when you no longer need the originals. See [`NOTICE.md`](NOTICE.md) for license details.

## Provider Setup

HIVE supports multiple model providers (OpenAI, Anthropic, OpenRouter, Ollama, Google). Providers must be configured before they can be used. **Never store raw API keys directly in the CLI commands or configurations.** 

### Interactive Setup (Recommended)
The easiest way to configure a provider is to use the interactive wizard, which will prompt you for the required details, test the connection, and approve the provider automatically:
```bash
hive providers setup
```

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

Add a local Ollama provider:
```bash
hive providers add --id local-ollama --kind ollama --base-url http://localhost:11434 --model llama3
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
```bash
git clone https://github.com/yuzuruu29/HIVE.git
cd HIVE
npm install
npm run build
npm test

# Check status
npm run hive -- status

# Run a task
node bin/hive.mjs run "small task"
```

## Windows Desktop: Chat & Coder

The Windows 10/11 x64 desktop companion ships two top-level surfaces behind one shell, built with React and Electron.

**Chat** is the primary, Claude/ChatGPT-parity conversational surface:

- **Streaming conversations**: batched chunk events render live markdown with a pulsing caret, a typing loader with the resolved route (`auto -> coding - provider/model`), and stick-to-bottom scrolling that yields when you scroll up.
- **Personas & routing**: the `auto` classifier plus six BYOK personas (Planning, Coding, Heavy Reasoning, Game Builder, Project Co-worker, Study Buddy), each showing its resolved provider/model trust chip; per-conversation provider/model overrides.
- **Receipts, honestly**: every assistant message carries a truthful provider/model/token/latency chip — no fabricated numbers — with copy and retry actions.
- **Sessions**: conversations persist per repository under `.hivemind/chat-sessions/` with a filterable rail, derived titles, and archiving.
- **Opt-in Scout grounding**: prepend a bounded repo context pack to any turn (`[/ground]`).
- **Council mode**: `[/council]` routes a task through the six-role hivebot council with a progressive stage transcript, per-stage receipts, a summary card, and an "open artifacts folder" action.

**Coder** is the verified harness cockpit (unchanged in function, now poppable into its own OS window):

- **Live Turn Stepper**: 5-phase progress (`plan` → `scout` → `build` → `validate` → `review`) with elapsed timer and accessible event log stream.
- **Living Agent Cells (Hive View)**: Visual subagent grid displaying assigned roles, active file scopes, completion status badges, and overall swarm settlement progress meter.
- **Command Palette & Keyboard Shortcuts**: Instant command palette (`Ctrl+K`), mode switching (`Ctrl+Shift+1/2`), tab switching (`Ctrl+1/2/3`), quick composer submission (`Ctrl+Enter`), shortcut help (`?`), and collapsible navigation rails (`[/]` and `[\]`).
- **Two-Pane Diff Inspector**: Sticky file navigation rail with `+added / -removed` line statistics, per-file accordion collapse, safe truncation handling, and line wrapping toggle.
- **Rich Message Rendering**: Hand-rolled, zero-dependency, XSS-safe Markdown parser supporting fenced code blocks with 1-click clipboard copy, task checkboxes, headers, and forward-compatible token receipts.
- **Pop-out window**: the topbar `[^]` button opens (or focuses) a dedicated Coder OS window; every window keeps receiving all events, and a single Coder window is enforced for the one-active-run invariant. `?view=chat|coder` seeds a window's initial surface.
- **Background Presence & Notifications**: HTML5 system notification integration notifying on turn completion when the application window is inactive.
- **Preferences & Accessibility**: Layout density options (Comfortable / Compact), color accents (Vivid Violet / High Contrast), full WCAG AA contrast compliance, keyboard focus rings, and automatic reduced-motion integration.

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

Artifacts are written to `release/` as a per-user NSIS setup executable and a no-install portable executable. Both editions store settings and encrypted credential blobs in Windows AppData; repository threads, sessions, reports, and worktrees stay under that repository's `.hivemind/` directory. Local unsigned builds are for internal evaluation, updates are installed manually, and signing is enabled only when standard electron-builder certificate secrets are configured.

See [Windows desktop release and operator guide](docs/WINDOWS_DESKTOP_RELEASE.md) for packaging, signing, checksums, smoke testing, storage, and release procedures.

## CLI Commands
- `hive` (no args): View the interactive terminal home screen / dashboard.
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

### Modes & Sessions
- Coding modes: `hive code "<objective>" --mode <auto|plan|review>`.
- Coding controls: `--max-agents`, `--max-retries`, `--provider`, `--model`, and `--approval <safe|changes|always>`.
- Output controls: `--no-tui` streams readable events; `--json` emits undecorated newline-delimited JSON events.
- `hive mode`: View the current operating mode.
- `hive mode set <guarded|standard|autonomous|plan|review>`: Set the current safety mode.
- `hive sessions` or `hive sessions list`: List coding sessions and legacy task cells.
- `hive sessions show <id>`: Show detailed JSON for either session format.
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
