# Free-provider routing in HIVE 0.1

HIVE can route across zero-price models and free account tiers while keeping the selected provider, model, and fallback path visible in every route receipt.

## Supported provider families

| Provider | HIVE mode | Default route |
| --- | --- | --- |
| Groq | Free account tier | `llama-3.3-70b-versatile` |
| NVIDIA NIM | Free developer endpoints | `meta/llama-3.3-70b-instruct` |
| OpenRouter | Guaranteed zero-price router | `openrouter/free` |
| Google Gemini | Free account tier | `gemini-2.5-flash` |
| OpenCode Zen | Documented zero-price chat models | Daily-refreshed allowlist |
| Nous Portal | Public free recommendation feed | Daily-refreshed free list |
| Cerebras | Free trial tier | `gpt-oss-120b` |
| SambaNova | Free account tier | `Meta-Llama-3.3-70B-Instruct` |
| Hugging Face | Monthly free inference credit | `openai/gpt-oss-120b:fastest` |
| GitHub Models | Included rate-limited usage | `openai/gpt-4.1-mini` |
| Mistral | Free mode | `mistral-small-latest` |
| Custom | Any public HTTPS OpenAI-compatible endpoint | User supplied |

Provider catalogs and free tiers change. OpenCode availability is intersected with its documented zero-price chat-model allowlist, Nous is read from its public free recommendation endpoint, and OpenRouter delegates selection to `openrouter/free`. HIVE refreshes the first two catalogs at most once per day and retains its last safe list if a refresh fails.

## Use credentials already present on this computer

Run a redacted inventory first:

```powershell
npm run providers:scan
```

Start HIVE with the discovered credentials:

```powershell
npm run dev:free
```

The development-only bridge reads supported keys from OpenCode and OpenClaw, passes them only to the HIVE API child process in memory, and never prints or writes secret values. The web and worker child processes receive a provider-secret-stripped environment. Existing environment variables win over discovered values. The bridge deliberately does not reuse OAuth refresh/access tokens such as GitHub Copilot credentials because their scopes and intended audience cannot be assumed.

The regular `npm run dev` command never scans other applications. Production rejects `HIVE_LOCAL_PROVIDER_BRIDGE=true`.

## Daily quota behavior

HIVE ranks eligible free routes first. When an upstream returns a quota, rate-limit, authentication, or availability failure, HIVE records the attempt and cools that exact route down. It understands `Retry-After`, generic reset headers, and the daily request/token reset headers used by free-tier providers. Subsequent requests skip the cooling route and continue through the remaining eligible providers. When a successful response says the daily remainder is zero, the route is proactively cooled until the advertised reset.

An explicit model pin still permits fallback unless the request sets `allow_fallback` to false. Cooling state is held by the API process in HIVE 0.1; restarting the API clears it, while the provider remains the final authority on quota enforcement.

## Cost and privacy boundaries

“Free account tier” is an account property, not a zero-price model identifier. HIVE cannot inspect whether billing has been enabled on Groq, Gemini, Cerebras, SambaNova, GitHub, Mistral, NVIDIA, or Hugging Face. Keep paid usage disabled or configure provider-side budgets if a hard zero-spend guarantee matters. OpenRouter's `openrouter/free`, the OpenCode free allowlist, and Nous `:free` recommendations provide a model-level zero-price signal.

OpenCode documents that traffic sent to some free models may be retained or used for model improvement. Do not send personal, confidential, or regulated data to those endpoints. Provider-side terms and privacy policies remain authoritative.

Nous Portal normally uses OAuth-issued bearer credentials. HIVE accepts a current Portal bearer token through `NOUS_PORTAL_TOKEN` or `NOUS_API_KEY`; it does not silently take over a Hermes OAuth session. A Hermes subscription proxy can be connected only when it is exposed as an intentionally configured public HTTPS OpenAI-compatible endpoint.

Custom providers remain the extension point for Cloudflare Workers AI account URLs and future compatible services. Private, loopback, metadata, redirecting, and credential-embedded URLs remain blocked by the SSRF protections.
