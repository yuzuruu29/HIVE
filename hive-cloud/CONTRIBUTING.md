# Contributing to HIVE Cloud

## Developer Certificate of Origin

All contributors must sign off on their commits using the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Add `Signed-off-by: Your Name <your@email.com>` to each commit message, or use `git commit -s`.

## Development Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and configure
3. Run `npm install`
4. Run `npm run dev` — starts API, Web, and Worker
5. Run `npm test` to verify everything works

## Pull Request Process

1. Create a feature branch from `main`
2. Write tests for your changes
3. Ensure `npm run preflight` passes (typecheck + test + build)
4. Use signed-off commits (`git commit -s`)
5. Open a PR with description and linked issue

## Code Style

- TypeScript strict mode
- Drizzle ORM for database access
- Hono for API routes
- React Server Components preferred for Next.js pages
- All monetary values in integer cents/microusd — never floats
