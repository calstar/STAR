# STAR server analytics

`analytics.starberkeley.org` shows both of STAR's servers in one panel: the EC2
box and the self-hosted apps box. It covers CPU, memory, disk, load, network,
uptime and the last deploy over time, per-container usage and health, and logs.
That means every container's output plus the DAQ server's `sensor-*` systemd
units, which run natively and not in Docker.

```
apps box:  analytics-agent ──HTTPS, bearer token──▶ analytics.starberkeley.org/api/ingest
                                                     (EC2 tunnel → caddy:80, not cookie-gated)
EC2 box:   analytics-agent ──http://analytics:8080──▶ analytics  (hub: SQLite + API + panel)
browser ─▶ analytics.starberkeley.org ─▶ caddy (STAR login) ─▶ hub (STARProject admins only)
```

It is one Go binary in one image, `ghcr.io/calstar/star-analytics`, with two
roles:

- **`analytics agent`** runs on each box. Every 15 s it samples the host
  (`/proc`, `statfs`) and every container. Container CPU and memory come from
  cgroup v2 files; the container list, state, health and restart counts come
  from the Docker API, read once a minute. Every 30 s it pushes one gzipped
  batch, along with any new log lines and the state file `deploy/auto-update.sh`
  writes. The agent only reads the host: every mount is `:ro`, and it only ever
  sends GETs to the Docker socket.
- **`analytics hub`** runs on EC2 only. It stores the batches in SQLite and serves
  the panel, which is a Vite/React app embedded in the binary. It has no host
  mounts and no Docker socket, because it is the half that faces the internet.

Agents push and the hub never pulls, so the apps box needs no new public
hostname, and the data flowing into EC2 costs nothing.

## Who can see it

Two gates, both of which must pass:

1. **Caddy** requires a STAR login (the `.starberkeley.org` session cookie), the
   same as STARProject. The one exception is `/api/ingest`, which uses its own
   check (see the next section).
2. **The hub** admits only **STARProject admins**: the same list that gates
   deletes in STARProject, managed under *Workspace setup → Admins*. The hub reads
   it from `http://starproject:3000/api/internal/admins` with
   `STARPROJECT_INTERNAL_SECRET` and caches it for a minute. If STARProject is
   unreachable, the hub keeps honouring the last list it got for 10 minutes and
   then admits nobody. It fails closed.

## Ingest auth

Each box has its own token. `ANALYTICS_AGENT_TOKENS` on the hub binds each token
to one host name, so the apps box's token is refused (403) when it tries to write
as `ec2`. A token must be at least 16 characters. A host whose token is empty is
treated as not set up yet and skipped.

## Footprint

| | limit | typical |
|---|---|---|
| hub | 96 MB, 0.25 CPU | ~5 MB RSS, ~0% CPU |
| agent | 64 MB, 0.1 CPU | ~13 MB RSS, <1% CPU |

An agent's cgroup can show more memory than its RSS. Reading the journal pulls
journal files into page cache, which the kernel charges to the reader and
reclaims as soon as the limit needs it. It is not a leak and it does not cause
an OOM.

The panel polls every 15 s, and only while its tab is visible.

Retention is 48 h of raw 15-second samples, then 5-minute average and max
rollups for 90 days. Logs are kept for 3 days, capped at about 200 MB. On top of
that, each source may send at most 500 lines per push, and a line is cut at
2 KB, so one container stuck in a log storm costs a bounded amount. The whole
database stays in the low hundreds of MB.

## Setting it up

This only needs doing once. Until it is done, both roles start and sit idle
rather than crash. Auto-deploy treats a crash-looping container as a failed
deploy, so a hub that refused to start would block every later EC2 deploy.

1. **Make two tokens and a secret:** run `openssl rand -hex 32` three times.
2. **EC2 box** (`deploy/ec2/.env`):
   ```
   ANALYTICS_EC2_TOKEN=<token 1>
   ANALYTICS_APPS_TOKEN=<token 2>
   STARPROJECT_INTERNAL_SECRET=<secret>
   ```
   Then run `docker compose up -d`. This recreates `starproject` so it picks up
   the secret.
3. **Apps box** (root `.env`): set `ANALYTICS_APPS_TOKEN=<token 2>`, the same
   value as on EC2. Then run `docker compose --profile tunnel up -d analytics-agent`.
4. **Cloudflare** (Zero Trust → Networks → Tunnels → the **EC2** tunnel → Public
   hostnames): add `analytics.starberkeley.org` → `http://caddy:80`.

## Checking it works

- `docker compose logs analytics-agent` on each box shows
  `agent "<host>": pushing to ...` and no `push failed`.
- Both host cards on the panel say **up**.
- If a box's agent stops, its card flips to **down** within 2 minutes.

## Local dev

```bash
# Go is not needed on the host; the golang image will do.
docker run --rm --network host -v "$PWD":/src -w /src golang:1.23-bookworm go test ./...

# The panel against a local hub. With no STARPROJECT_URL, the hub admits
# DEV_ADMIN_EMAILS, and DEV_AUTH_EMAIL stands in for Caddy's X-Auth-Email.
docker build --network host -t star-analytics:dev .
docker run --rm -p 8080:8080 -v analytics-dev:/data \
  -e ANALYTICS_AGENT_TOKENS=dev:dev-token-0123456789 \
  -e DEV_ADMIN_EMAILS=you@berkeley.edu -e DEV_AUTH_EMAIL=you@berkeley.edu \
  star-analytics:dev hub
cd web && npm install && npm run dev      # http://localhost:5178, /api proxied to :8080
```

To feed the dev hub real data, run an agent with the mounts from
`deploy/ec2/docker-compose.yml` and `HOST_NAME=dev`,
`HUB_URL=http://<hub>:8080` and `ANALYTICS_TOKEN=dev-token-0123456789`.

`--network host` on `docker build` and `docker run` is for WSL. Large downloads
over Docker's default bridge network get reset there, and Go module zips are
large.

## Configuration

| variable | role | default | |
|---|---|---|---|
| `ANALYTICS_AGENT_TOKENS` | hub | — | `host:token,...` |
| `STARPROJECT_URL` | hub | — | where the admin list comes from |
| `STARPROJECT_INTERNAL_SECRET` | hub | — | must match STARProject's `INTERNAL_API_SECRET` |
| `ANALYTICS_DB` | hub | `/data/analytics.db` | |
| `PORT` | hub | `8080` | |
| `DEV_ADMIN_EMAILS`, `DEV_AUTH_EMAIL` | hub | — | local dev only |
| `HOST_NAME`, `HUB_URL`, `ANALYTICS_TOKEN` | agent | — | an empty token means the agent idles |
| `HOST_PROC`, `HOST_ROOT`, `HOST_CGROUP` | agent | `/host/proc`, `/host/root`, `/host/cgroup` | |
| `DOCKER_SOCK` | agent | `/var/run/docker.sock` | |
| `DEPLOY_STATE` | agent | `/host/auto-update/state` | |
| `JOURNAL_DIR` | agent | — | unset means no journald logs |
| `JOURNAL_UNIT_PREFIXES` | agent | `sensor-` | user units whose logs to ship |
| `SAMPLE_INTERVAL`, `PUSH_INTERVAL` | agent | `15s`, `30s` | |
