FROM node:22-alpine AS builder
WORKDIR /app

# Env vars, not flags -- npm spawns child processes for lifecycle scripts, and
# these reach them. `npm ci` failing with ECONNRESET part way through a large
# install should retry, not abort the build.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm npm install -g serve
COPY --from=builder /app/dist ./dist
EXPOSE 4174
CMD ["serve", "-s", "dist", "-l", "4174"]
