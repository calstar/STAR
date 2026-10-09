FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Node runs the TypeScript sources directly (type stripping); no build step.
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config ./config

RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# --disable-warning keeps node:sqlite's "experimental" notice out of the logs.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
