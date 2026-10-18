# Real provider verification

Use [BYOK or local setup](CLI_BYOK_LOCAL.md) through `hive providers setup`
or `/connect` to register your own-key API or a keyless local runtime first.

`providers test` checks the provider's health prerequisite. Use `providers verify`
to make real generation requests against one approved provider and model:

```text
hive providers verify PROVIDER --model MODEL --coding --output test-results/provider-check.json --json
```

Configure credentials through the normal provider setup or referenced environment
variable first. Do not paste tokens into prompts or source. Verification uses the
explicit model, or that provider's configured default; it never substitutes a
model/provider, changes role assignments, or imports another client's account.
Anthropic and Google adapters currently use their fixed official endpoints;
verification rejects unsupported base URL overrides before making requests.

The report distinguishes four checks:

- `health`: the adapter's prerequisite, such as listing available models. This
  alone does not establish working generation.
- `buffered`: a real completion must return a fresh exact marker.
- `streaming`: actual chunks and the final response must agree on that marker.
  An adapter without streaming is reported as skipped and cannot pass the full
  verification.
- `coding`, requested by `--coding`: the model must use HIVE's structured tool
  loop to write the exact requested bytes to `probe.txt` in a disposable
  directory. Only read/create/write of that file is available. Commands and
  project files are unavailable, and the directory is removed afterward.

Generation can consume provider quota or incur charges. The default output cap
is 512 tokens per request, configurable with `--max-output-tokens 1..32768`.
Buffered and streaming checks each make one request; the coding check permits
at most three model turns and two tool calls. Input tokens and provider-specific
reasoning accounting still apply. The default deadline is 60 seconds per check;
`--timeout-ms` accepts 100 through 120000. A model that needs a larger budget can
fail the strict probe; a failed probe is retained rather than treated as success.

Reports include the selected provider/model, endpoint origin, timestamps,
per-check outcome and duration, and provider-reported usage where available.
They exclude generated text, private reasoning, markers and credential values.
`--output` writes a new file inside the repository and refuses an existing file
before making generation requests. Exit codes are 0 for pass, 1 for failure, and
130 for cancellation. Failed health skips generation explicitly.

## Current evidence

On **2026-10-18 (Asia/Manila)**, fresh bounded checks passed buffered output,
actual streaming and exact-file HIVE tool execution for **`gemini-3.5-flash-lite`**
and the existing HIVE-owned **`gpt-6-astra`** subscription account. Gemini used
512 output tokens per request; the subscription protocol used wall-clock,
turn/tool and output-byte bounds because it does not support a token cap.
The saved `local-ollama` / `test-model` endpoint remained unreachable and its
generation checks were skipped. Provider/role files retained identical hashes;
no credential values or generated private output were saved. Evidence:
`test-results/live-release-20261018/live/live-provider-evidence.json`.

On **2026-10-17 (Asia/Manila)**, the owner completed HIVE's isolated ChatGPT
device sign-in. A fresh Codex app-server process confirmed a ChatGPT Plus account
and seven catalog entries without exporting identity or credentials. Real
**`gpt-6-astra`** subscription inference passed exact buffered output, ten actual
streaming chunks, and an exact file write through HIVE's structured tool loop in
two turns/one tool call. The runtime used empty ephemeral Codex workspaces and
HIVE separately executed the permitted file operation. Other client credentials
and all four HIVE project/global provider/role files stayed unchanged.

Evidence: `test-results/cli-chatgpt-account-2026-10-16T19-08-15-947Z.json`.
The separate public CLI journey also registered an isolated provider, confirmed
the saved account, approved it and completed a real Astra-backed `hive code
--mode plan` session in a disposable Git repository, with all four processes
exiting 0 and cleanup verified:
`test-results/cli-chatgpt-public-cli-2026-10-16T19-14-35-663Z.json`.
The first run passed text/streaming but failed the file-write workflow; its
report is retained as `cli-chatgpt-account-2026-10-16T19-05-59-293Z.json`.
The provider boundary now explicitly permits emitting HIVE's tool-call JSON as
text while prohibiting native Codex execution. Supported child settings also
disable bundled skill instructions. The coding probe's aggregate token fields
were not mapped into HIVE usage shape, so its zero counters are **not evidence
of zero usage**; file/turn/tool proof remains independent. No billing claim is
made.

The installed app-server exposes no output-token cap. This live subscription
probe used wall-clock, turn, tool and output-byte bounds and must not be confused
with the token-capped `providers verify` API probe. Capped requests fail explicitly.
See [subscription setup and boundaries](CLI_CHATGPT_SUBSCRIPTION.md).

On **2026-10-17 (Asia/Manila)**, HIVE passed authenticated Gemini discovery and
the public CLI verification flow against **`gemini-3.5-flash-lite`**. The owner
authorized use of the existing Windows user `GEMINI_API_KEY`; its value was
loaded only into task-owned child processes and never printed or saved.
Discovery returned 46 model IDs. Buffered output matched the fresh marker,
streaming delivered two actual chunks, and the coding probe wrote exact bytes
through the real HIVE tool loop in two model turns, under the original 512-token
per-request cap. Project/global provider and role files retained identical
hashes. The temporary Git workspace was removed.

Evidence: `test-results/cli-gemini-account-2026-10-16T18-33-33-584Z.json`
(timestamps are UTC). The first attempt stopped before inference because the
owned report directory was missing; its evidence is retained. The next attempt
proved the catalog could include a model unavailable to this account:
`gemini-2.5-flash-lite` was listed but generation returned a new-user restriction.
That failed report remains in
`test-results/cli-gemini-account-2026-10-16T18-33-20-586Z.json`.
The successful run selected Google's recommended replacement explicitly; it
did not add fallback or weaken the probe. This proves this account/model path,
not other providers, billing accuracy, vision or long-session reliability.

On 2026-10-16, the actual configured provider `local-ollama` at
`http://localhost:11434` with model `test-model` failed its health request with
`fetch failed`. Buffered, streaming and coding checks were skipped, and no
generation was attempted. The report is
`test-results/cli-real-provider-attempt-2026-10-16.json`.
No external-provider credential or reachable local Ollama runtime was available.
HIVE's own saved desktop provider metadata had no approved/configured remote
provider, and its credential store contained zero envelopes. No other client's
credentials were inspected or imported.
This initial configured-provider attempt remains a failed report.

A subsequent isolated real-model run passed all four checks through actual CLI
processes on 2026-10-16. It used Qwen2.5-Coder-1.5B-Instruct Q4_K_M with the
official portable llama.cpp CPU runtime, bound only to a fresh loopback port.
The buffered response matched a fresh marker, streaming delivered 11 actual
chunks, and the coding check executed a file write and completed in three model
turns. The original 512-token, three-turn and two-tool-call limits stayed intact.
The report is `test-results/cli-real-local-provider-2026-10-16T14-51-37-476Z.json`.

The first portable-model attempt passed buffered/streaming generation but failed
the coding call limit; its report remains
`test-results/cli-real-local-provider-2026-10-16T14-44-03-982Z.json`. Investigation
found that agents received a read example without the built-in tools' actual
argument schemas. HIVE now advertises its repository tool catalog and each
executor's available subset; this probe advertises only read/create/write.
Execution authorization and exact file/content checks remain separate guards.

The successful run pinned runtime tag `b11669` and model revision
`f86cb2c1fa58255f8052cc32aeede1b7482d4361`, checked downloaded sizes and SHA-256
hashes before execution, and recorded source/built-module hashes before and
after verification. Execution provenance, unchanged user/project provider and
role files, stopped server and removal of the owned 1.1 GB model are recorded in
`test-results/cli-real-local-provider-execution-1792162322752.json`.
No runtime was installed globally and no existing model/default was replaced.

This establishes actual local inference and the bounded file-write integration
for the tested model. External BYOK authentication, account consent, billing,
vision behavior and broader coding quality remain unverified. Normal use still
requires your chosen running local model or provider environment credential.

`tests/provider-verification.test.mjs` exercises caps, checks, timeout,
cancellation, exact endpoints and redaction with isolated adapters and a real
loopback HTTP server. `tests/cli-provider-journey.test.mjs` exercises real CLI
processes through a loopback model fixture, including restart, independent
workspace forks, edits, image transport and review. These fixtures do not prove
external model behavior or credentials.

Token-limit fields follow the official [OpenAI Chat Completions
reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[Anthropic Messages reference](https://platform.claude.com/docs/en/api/messages/create),
[Google GenerationConfig reference](https://ai.google.dev/api/generate-content#GenerationConfig),
and [Ollama model parameters](https://docs.ollama.com/modelfile#parameter).
