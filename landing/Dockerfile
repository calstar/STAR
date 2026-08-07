FROM node:24-alpine AS builder
WORKDIR /app

# Env vars, not flags -- npm spawns child processes for lifecycle scripts, and
# these reach them. `npm ci` failing with ECONNRESET part way through a large
# install should retry, not abort the build.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_MAXSOCKETS=3
COPY package*.json ./
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
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm npm install -g serve
COPY --from=builder /app/dist ./dist
EXPOSE 4175
CMD ["serve", "-s", "dist", "-l", "4175"]
