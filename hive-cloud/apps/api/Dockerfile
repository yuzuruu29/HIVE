FROM node:22.20.0-alpine AS builder
WORKDIR /app
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
COPY apps/api ./apps/api
RUN npm run build:packages && npm run build -w @hive-cloud/api
RUN npm prune --omit=dev --ignore-scripts

FROM node:22.20.0-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S -g 1001 hive && adduser -S -u 1001 -G hive hive
COPY --from=builder --chown=hive:hive /app/package.json ./package.json
COPY --from=builder --chown=hive:hive /app/node_modules ./node_modules
COPY --from=builder --chown=hive:hive /app/packages ./packages
COPY --from=builder --chown=hive:hive /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=hive:hive /app/apps/api/dist ./apps/api/dist
USER hive
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-4000}/health/live || exit 1
CMD ["node", "apps/api/dist/index.js"]
