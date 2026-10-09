# syntax=docker/dockerfile:1
# callink-worker: files approved STARProject reimbursements on CalLink and pushes
# CalLink's history back. Playwright's image carries the Chromium build matching
# the pinned playwright package (keep the two versions equal).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    CALLINK_HOME=/data

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY . .

# /data holds the signed-in browser profile, the scrape and the filing journal.
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME /data

# Dry by default: it checks every form but files nothing until CALLINK_WORKER_FLAGS=--live.
CMD ["sh", "-c", "exec node worker.mjs ${CALLINK_WORKER_FLAGS:-}"]
