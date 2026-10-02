# STAR server analytics: one image, two roles (`analytics hub`, `analytics agent`).
# See README.md.

# ── Panel (Vite + React) ────────────────────────────────────────────────────
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── Binary: static, the panel embedded ──────────────────────────────────────
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /web/static ./web/static
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /analytics ./cmd/analytics

# ── Runtime ─────────────────────────────────────────────────────────────────
# Debian rather than distroless for one reason: the agent execs journalctl to read
# the DAQ units' journal on the apps box. trixie's systemd (257) reads journals
# written by Ubuntu 24.04+ hosts.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown 65534:65534 /data
COPY --from=build /analytics /usr/local/bin/analytics
# The hub runs as nobody (compose sets `user:`); /data is pre-owned so a fresh
# named volume inherits that. The agent runs as root to read the Docker socket.
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["analytics"]
CMD ["hub"]
