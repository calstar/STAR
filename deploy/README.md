# Deploying the STAR internal tools

Everything behind one domain, one login, one `docker compose up`.

## How auth works

There is no auth code in the apps. Caddy asks the auth service about every
request before it forwards anything:

```
browser ──▶ Caddy ──▶ auth:5000/verify ──┐
                                          ├─ 2xx  ▶ forward to the app,
                                          │         with X-Auth-Email set
                                          └─ else ▶ copy that response
                                                    straight to the browser
```

That last line is the whole trick. Caddy's `forward_auth` treats only a 2xx as
"allow" and returns anything else verbatim, so `/verify` decides what an
unauthenticated visitor experiences:

| Original request | `/verify` answers | Result |
| --- | --- | --- |
| Browser navigating to a page | `302` to the login page | Google login, then back to the page they asked for |
| `fetch()` / XHR | `401` | The app's error handling runs |
| WebSocket upgrade | `401` | Reconnect logic runs |
| `POST` / `PUT` / `DELETE` | `401` | Body is not silently dropped by a redirect |

After login the JWT lives in a `session` cookie scoped to `.starberkeley.org`,
so signing in once covers every subdomain.

**Dev is unauthenticated because Caddy is not in the loop.** `./dev.sh` runs the
app directly on localhost; nothing calls `/verify`, so no login appears. There
is no dev-only bypass flag to forget to turn off.

## What runs where

| Service | Where | Port |
| --- | --- | --- |
| `caddy` | container | 80 / 443 |
| `auth` | container | 5000 |
| `landing` | container | 4175 |
| `engine-design-api` / `-frontend` | container | 8000 / 4173 |
| `pid-designer-api` / `-frontend` | container | 8001 / 4174 |
| DAQ server | **native, on the test stand** | 8081 (API + WS), 3000 (SPA) |

DAQ is deliberately not containerised: the C++ bridge, `elodin-db` and the
board links need the hardware. It runs under systemd
(`daq-server/deploy/systemd/`), and Caddy proxies to it over
`host.docker.internal` — or set `DAQ_BACKEND` / `DAQ_GUI` to a separate box.

## First deploy

```bash
cp .env.example .env                 # JWT_SECRET, domain, TLS mode
cp auth/.env.example auth/.env       # Google OAuth credentials
```

`JWT_SECRET` appears in both files and **must match**, or every app rejects
every login. Generate it once:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

In the Google Cloud console (APIs & Services → Credentials), add the callback
as an authorized redirect URI:

```
https://auth.starberkeley.org/callback
http://localhost:5000/callback        # only if you test the flow locally
```

Then:

```bash
docker compose up -d --build
```

Run it from the repo root — Compose resolves relative paths against the
directory holding `docker-compose.yml`.

## TLS

**Let's Encrypt (default).** Caddy obtains and renews certificates itself.
Needs ports 80 and 443 reachable from the internet, and DNS A records for
`starberkeley.org`, `auth.`, `engine-design.`, `pid-designer.`, `daq-server.`.

**Cloudflare Tunnel.** Cloudflare terminates TLS at the edge, so no inbound
ports and no certificates here:

```bash
# .env
SCHEME=http
CLOUDFLARE_TUNNEL_TOKEN=...          # Zero Trust → Networks → Tunnels

docker compose --profile tunnel up -d --build
```

Point every hostname at `http://caddy:80` in the tunnel's public hostname
config. With `SCHEME=http`, Caddy binds `:80` only and issues no certificates.
You can then drop the published `80:80` / `443:443` from the `caddy` service —
cloudflared is the only ingress.

## Adding an app

1. Add the service to `docker-compose.yml`.
2. Add a site block to `deploy/caddy/Caddyfile` — **with `import protected`**.
3. Add the DNS record.

Forgetting step 2's import is the mistake to watch for. The two FastAPI
backends also verify the cookie themselves (`AUTH_ENABLED=true`) as a second
line of defence, but that is belt-and-braces, not the gate.

## Shipping a merge

Both container boxes deploy themselves. A systemd timer on each runs
[`auto-update.sh`](auto-update.sh), which waits for the publish workflows to
finish, syncs the checkout to `origin/main`, and pulls + `up -d`s — so merging a
PR is the whole deploy. Setup and the per-box details are in
[`apps/README.md`](apps/README.md#auto-deploy-on-merge-to-main) and
[`ec2/README.md`](ec2/README.md#auto-deploy-on-merge-to-main).

The DAQ server is excluded: it has no container (see Known gaps).

## Verifying a deploy

```bash
curl -sI https://engine-design.starberkeley.org/        # 302 → auth.../login
curl -s  https://auth.starberkeley.org/healthz          # OK
curl -sI -H 'Accept: application/json' \
     https://engine-design.starberkeley.org/api/health  # 401, not a redirect
```

Check the Caddyfile without restarting anything:

```bash
docker run --rm -v "$PWD/deploy/caddy:/etc/caddy:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Known gaps

- **P&ID checkpointing is dev-only.** Diagram version control commits to a
  branch of this repo and pushes it, which needs a clone and a push credential
  the image does not carry. In production the designer saves to a volume and
  the checkpoint/history endpoints return 503 with an explanation. Mounting the
  repo plus a deploy key would enable it.
- **DAQ has no container.** Deploying it is still the systemd/tmux flow in
  `daq-server/deploy/` — auto-deploy covers the compose stacks only.
- **No automatic rollback.** Compose pins `:latest`, so a bad merge is rolled
  back by hand: pause the timer, then pin the previous `sha-<short>` tag (every
  image carries one) or revert on `main` and let the next tick ship it.
