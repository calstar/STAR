# Build context is the REPO ROOT, not this directory.
#
# This app does not yet compile anything from lib/ — it adopts lib/stardesign-ui
# in Phase 09 and lib/feed-canvas in Phase 10. The root context is set now
# anyway, because switching a Dockerfile's context later means changing the
# publisher, the CI matrix and every COPY path at once, and the cost of the
# larger context today is a .dockerignore line.
FROM node:24-alpine AS builder
# Mirrors the repo layout on purpose: once this app reaches shared source as
# ../../lib/..., it has to sit two levels below whatever holds lib/ inside the
# image exactly as it does in a checkout.
WORKDIR /build/app/frontend

# Env vars, not flags -- npm spawns child processes for lifecycle scripts, and
# these reach them. `npm ci` failing with ECONNRESET part way through a large
# install should retry, not abort the build.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_MAXSOCKETS=3
COPY feed-twin/frontend/package*.json ./
# Retry loop, because npm's own fetch-retries do not cover a socket reset part
# way through a tarball -- that aborts the whole install. The cache mount means
# each attempt resumes from what the previous one already fetched, and the loop
# still fails the build after 4 tries rather than silently continuing.
RUN --mount=type=cache,target=/root/.npm \
    n=0; \
    until npm ci; do \
      n=$((n+1)); \
      if [ "$n" -ge 4 ]; then echo "npm ci failed after $n attempts" >&2; exit 1; fi; \
      echo "npm ci hit a network error (attempt $n) -- retrying in 10s"; \
      sleep 10; \
    done
COPY feed-twin/frontend/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm npm install -g serve
COPY --from=builder /build/app/frontend/dist ./dist
EXPOSE 4178
CMD ["serve", "-s", "dist", "-l", "4178"]
