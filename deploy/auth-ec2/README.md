# Deploy `auth` to the OpenProject EC2 box

Auth runs next to OpenProject, exposed via a Cloudflare Tunnel. No inbound ports,
OpenProject untouched. The image comes from GHCR (built by
`.github/workflows/publish-auth.yml` on `landing-page`) — the box only needs this
folder's two files + a `.env`.

```
browser ─▶ Cloudflare edge (TLS) ─▶ cloudflared ─▶ auth:5000
```

## 1. Cloudflare tunnel
Zero Trust → Networks → Tunnels → create tunnel, copy the token. Add a **Public
Hostname**: `auth` · `starberkeley.org` → Service **HTTP** `auth:5000`.

## 2. Google OAuth
APIs & Services → Credentials → your OAuth client → add redirect URI:
`https://auth.starberkeley.org/callback`

## 3. GHCR access (box must pull a private package)
On the box, log in with a **classic** PAT that has `read:packages` (fine-grained
tokens are unreliable for GHCR):
```bash
echo "<classic_PAT>" | docker login ghcr.io -u <github-user> --password-stdin
```

## 4. Files + config
```bash
git clone --depth 1 --filter=blob:none --sparse -b landing-page \
  https://github.com/calstar/STAR.git
cd STAR && git sparse-checkout set deploy/auth-ec2 && cd deploy/auth-ec2
cp .env.example .env      # .env.example is a hidden dotfile — use `ls -a`
```
Fill `.env` (no quotes, `KEY=value`):
| Var | Source |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client |
| `JWT_SECRET` | `python3 -c "import secrets; print(secrets.token_hex(32))"` — **save it**, local apps reuse it |
| `FLASK_SECRET_KEY` | another `token_hex(32)` |
| `CLOUDFLARE_TUNNEL_TOKEN` | tunnel token |
| `AUTH_PUBLIC_URL` | `https://auth.starberkeley.org` (default) |

## 5. Launch + verify
```bash
docker compose up -d
docker compose ps                                  # auth + cloudflared running
curl -s https://auth.starberkeley.org/healthz      # -> OK
```
Browse `https://auth.starberkeley.org/` → Google login → `@berkeley.edu` lands on
"✅ Logged in". Non-approved onshape-viewer users still authenticate here but get
403 at that app (see `auth/allowlist.py`).

## Update later
`.env` never leaves the box. To ship new auth code: push to `landing-page` (CI
republishes `:latest`), then `docker compose pull && docker compose up -d`.

## Notes
- **Local-machine apps:** reuse the same `JWT_SECRET`, serve under
  `*.starberkeley.org`, and point their Caddy `forward_auth` at this EC2 auth.
- **onshape allowlist:** onshape-viewer runs on the apps machine, so its
  approved-users roster lives there (a gitignored `onshape_allowlist.txt` mounted
  into that machine's auth) — see deploy/apps/README.md. This EC2 login auth does
  not gate onshape and needs no roster.
- **Moving OpenProject onto the tunnel later:** its ingress must target
  `http://host.docker.internal:80` (host-gateway), not `localhost` — OpenProject
  runs on the host, not this compose network.
