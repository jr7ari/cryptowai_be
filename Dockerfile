# syntax=docker/dockerfile:1
# Build context: monorepo root
#   docker build -f apps/backend/Dockerfile -t crypto-hacks-backend .

FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci --workspace apps/backend --include-workspace-root=false --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /repo
COPY --from=deps /repo ./
COPY apps/backend ./apps/backend
RUN npm run build -w apps/backend && npm prune --omit=dev --workspace apps/backend --include-workspace-root=false

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    CONFIG_DIR=/app/config
RUN addgroup -S engine && adduser -S engine -G engine
COPY --from=build --chown=engine:engine /repo/node_modules ./node_modules
COPY --from=build --chown=engine:engine /repo/apps/backend/package.json ./package.json
COPY --from=build --chown=engine:engine /repo/apps/backend/dist ./dist
COPY --chown=engine:engine config ./config
USER engine
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
