# HIVE Cloud

**The open-source AI workspace that shows how every answer was routed.**

HIVE Cloud is an AGPL-3.0 licensed AI workspace with Queen-led multi-step orchestration, visible route receipts, and provider sovereignty.

## Quick Start (Self-Hosted)

```bash
git clone https://github.com/yuzuruu29/hive-cloud.git
cd hive-cloud
cp .env.example .env
# Edit .env with your settings
npm install
npm run dev
```

Open http://localhost:3000. BYOK works without PayPal.

## Features

- **Queen-Led Orchestration** — Multi-step Build and Council modes with review phases
- **Visible Route Receipts** — Every response shows model, provider, tokens, cost, and fallback
- **Provider Sovereignty** — BYOK, open-weight, and OpenAI-compatible routes
- **Managed Convenience** — Subscribe for zero-setup OpenAI and Anthropic ($15/mo Builder, $39/mo Pro)
- **Open Source** — AGPL-3.0, self-hostable, no vendor lock-in

## Architecture

```text
apps/
  api/     — API server (routes, billing, webhooks)
  web/     — Next.js frontend
  worker/  — Background job processor
packages/
  contracts/  — Shared types and Zod schemas
  database/   — Drizzle ORM schema and migrations
  router/     — Provider routing, adapters, credit settlement
  security/   — Encryption, auth, secrets
```

## License

AGPL-3.0-only. See [LICENSE.md](./LICENSE.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributions require DCO sign-off.

## Security

Use GitHub's private vulnerability reporting flow. See [SECURITY.md](./SECURITY.md).
