# syntax=docker/dockerfile:1

# ── Builder ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Network-resilience knobs — flaky registries shouldn't fail the build (matches
# the retry/env pattern in the repo's other frontend Dockerfiles).
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

# Prisma's query engine needs openssl present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    for i in 1 2 3 4; do npm ci && break || (echo "npm ci retry $i" && sleep 10); done

COPY . .
# `build` = `prisma generate && next build` (see package.json). The one page is
# force-dynamic, so the build never touches the database.
RUN npm run build

# ── Runtime ────────────────────────────────────────────────────────────────
# Debian slim (not alpine) on purpose: Prisma's engine + OpenSSL is far less
# fiddly on glibc than on musl.
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# openssl for the runtime query engine; global prisma CLI for `migrate deploy`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g prisma@6

# Next standalone server + static assets + public dir.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The generated Prisma client + query engine binary — copied explicitly so the
# engine .so is present even if Next's file tracing missed it.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Schema + migrations for the startup `prisma migrate deploy`.
COPY --from=builder /app/prisma ./prisma

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
