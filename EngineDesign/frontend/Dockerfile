# Build context is the REPO ROOT, not this directory: the app compiles
# lib/stardesign-ui from source, which a subproject context cannot see.
# Multi-stage: build Vite app, then serve with a minimal Node static server
FROM node:24-alpine AS builder
# Mirrors the repo layout on purpose: the app reaches the shared UI as
# ../../lib/stardesign-ui, so it has to sit two levels below whatever holds
# lib/ inside the image exactly as it does in a checkout.
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
COPY EngineDesign/frontend/package*.json ./
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
# The shared design-tool UI, compiled from source by this app's Vite. Copied
# before the app so a change to the app alone reuses the install layer above.
COPY lib/stardesign-ui/ /build/lib/stardesign-ui/
COPY EngineDesign/frontend/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm npm install -g serve
COPY --from=builder /build/app/frontend/dist ./dist
EXPOSE 4173
CMD ["serve", "-s", "dist", "-l", "4173"]
