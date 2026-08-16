FROM node:22.20.0-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/router/package.json packages/router/package.json
COPY packages/security/package.json packages/security/package.json
RUN npm ci --ignore-scripts
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build:packages && npm run build -w @hive-cloud/web

FROM node:22.20.0-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S -g 1001 hive && adduser -S -u 1001 -G hive hive
COPY --from=builder --chown=hive:hive /app/apps/web/.next/standalone ./
COPY --from=builder --chown=hive:hive /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=hive:hive /app/apps/web/public ./apps/web/public
USER hive
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health/live || exit 1
CMD ["node", "apps/web/server.js"]
