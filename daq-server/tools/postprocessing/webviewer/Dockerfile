# DAQ Run Viewer — single image that serves both the API and the built SPA.
#
# Unlike the other apps (separate api + frontend containers), this app's
# FastAPI backend mounts the built frontend at / itself (backend/main.py), and
# the frontend calls the API via relative /api paths. So one process on 8420
# serves everything — matching the app's own `run.sh --build` mode.
#
# The one thing that sets this image apart: it bakes in the `elodin-db` binary
# so the backend can run `elodin-db export …` against the run DBs that are
# bind-mounted in at /data/elodin (read-only). See docker-compose.yml.

# ── Stage 1: build the frontend ──────────────────────────────────────────────
FROM node:24-alpine AS frontend
WORKDIR /app

# npm resilience for CI networks (same rationale as the other frontend images):
# retry through socket resets rather than aborting the whole build.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_MAXSOCKETS=3
COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    n=0; \
    until npm ci; do \
      n=$((n+1)); \
      if [ "$n" -ge 4 ]; then echo "npm ci failed after $n attempts" >&2; exit 1; fi; \
      echo "npm ci hit a network error (attempt $n) -- retrying in 10s"; \
      sleep 10; \
    done
COPY frontend/ ./
RUN npm run build   # -> /app/dist

# ── Stage 2: python runtime ──────────────────────────────────────────────────
FROM python:3.12-slim
WORKDIR /app

# elodin-db: the prebuilt binary for the version pinned in daq-server/setup.sh.
# The cargo-dist installer drops it in ~/.cargo/bin; symlink onto PATH so the
# backend's find_elodin_db() (checks ~/.cargo/bin/elodin-db, then `which`)
# resolves it regardless of HOME. curl is build-only, so remove it after.
ARG ELODIN_VERSION=v0.16.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    curl --proto '=https' --tlsv1.2 -LsSf \
      "https://github.com/elodin-sys/elodin/releases/download/${ELODIN_VERSION}/elodin-db-installer.sh" | sh; \
    if [ -x /root/.cargo/bin/elodin-db ]; then bin=/root/.cargo/bin/elodin-db; \
    elif [ -x /root/.local/bin/elodin-db ]; then bin=/root/.local/bin/elodin-db; \
    else bin="$(command -v elodin-db || find /root -type f -name elodin-db | head -1)"; fi; \
    ln -sf "$bin" /usr/local/bin/elodin-db; \
    test -x /usr/local/bin/elodin-db; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
# main.py resolves the SPA at <app>/frontend/dist (parent.parent of backend/).
COPY --from=frontend /app/dist ./frontend/dist

# Defaults; docker-compose overrides the mount paths. ELODIN_DB_DIR is the
# read-only run-DB mount, WEBVIEWER_CACHE_DIR the writable parquet cache.
ENV ELODIN_DB_DIR=/data/elodin \
    WEBVIEWER_CACHE_DIR=/cache

EXPOSE 8420
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8420"]
