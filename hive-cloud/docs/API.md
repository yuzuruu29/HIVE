# HIVE 0.1 API

Use an OpenAI-compatible client with the API service base URL plus `/v1`, a generated `hive_live_` key, and model `hive-0.1`.

Supported endpoints:

- `GET /v1/models` requires `models:read`.
- `POST /v1/chat/completions` requires `chat:write` and supports JSON or SSE streaming.

HIVE adds these response headers: `X-HIVE-Request-Id`, `X-HIVE-Provider`, `X-HIVE-Model`, `X-HIVE-Route-Policy`, and `X-HIVE-Fallback-Count`. A failed stream after its first token returns an `upstream_stream_error` event and never silently switches providers mid-answer.

Use `Idempotency-Key` on requests that may be retried. Managed credits are debited once for a successful completion; BYOK requests and failed upstream attempts do not debit managed credits.
