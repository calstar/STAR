# Deploy the apps machine (engine, pid, recovery, onshape, landing)

The apps run on their own machine behind a **second** Cloudflare Tunnel, separate
from the EC2 box (which runs OpenProject + the central login auth). This machine
runs the root `docker-compose.yml`: Caddy (the gate) + a **verify-only** auth +
all app frontends/APIs + cloudflared.

```
browser ─▶ Cloudflare edge (TLS) ─▶ cloudflared ─▶ caddy ─▶ app
                                                      └▶ auth:5000/verify (local, fast)
login?  ─▶ caddy/auth bounces to https://auth.starberkeley.org  (EC2, the one login box)
```

**Auth model:** login is centralized on EC2; this machine runs the *same* auth
image in `AUTH_VERIFY_ONLY=true` mode, which only validates the `.starberkeley.org`
cookie (shared `JWT_SECRET`) and applies the onshape allowlist. No Google secret
lives here. One minter (EC2), many verifiers.

## 1. Cloudflare — a second tunnel for this machine
Zero Trust → Networks → Tunnels → **create a new tunnel** (Docker), copy the token.
Add **Public Hostnames**, all → Service **HTTP** `caddy:80`:

| Subdomain | Domain |
| --- | --- |
| *(none / apex)* | `starberkeley.org` → landing |
| `engine-design` | `starberkeley.org` |
| `pid-designer` | `starberkeley.org` |
| `recovery-calculator` | `starberkeley.org` |
| `onshape-viewer` | `starberkeley.org` |

Do **not** add `auth.` here — that stays on the EC2 tunnel.

## 2. On the apps machine — get the compose + configure
Images are pulled from GHCR (built by `publish-apps.yml` / `publish-auth.yml`), so
the box needs only the root compose + `.env`, not the app source. Grab just those
with a sparse checkout:

```bash
git clone --depth 1 --filter=blob:none --sparse -b landing-page \
  https://github.com/calstar/STAR.git
cd STAR
git sparse-checkout set deploy/apps      # cone mode also brings the root files
                                         # (docker-compose.yml, .env.example)
cp .env.example .env
```

GHCR packages are private by default, so log in once (classic PAT, `read:packages`)
or make the `star-*` packages public:
```bash
echo "<classic_PAT>" | docker login ghcr.io -u <github-user> --password-stdin
```

Set in `.env`:
| Var | Value |
| --- | --- |
| `JWT_SECRET` | **the same value as the EC2 auth** (or cookies are rejected) |
| `AUTH_VERIFY_ONLY` | `true` |
| `AUTH_PUBLIC_URL` | `https://auth.starberkeley.org` |
| `SCHEME` | `http` (Cloudflare terminates TLS) |
| `CLOUDFLARE_TUNNEL_TOKEN` | this machine's tunnel token |

No `auth/.env` is needed (verify-only). For live Onshape builds, put the key pair
in `onshape-viewer/.env` (optional — cache-first endpoints work without it).

## 3. Launch
```bash
docker compose --profile tunnel pull              # SCHEME=http is read from .env
docker compose --profile tunnel up -d
docker compose ps
```
(Building on the box instead — needs a full clone and ≥4 GB RAM for the React
builds — is `docker compose --profile tunnel up -d --build`.)
Then drop the host's published web ports (cloudflared is the only ingress): remove
the `80:80` / `443:443` lines from the `caddy` service, or block them at the
firewall. SSH (22) is all you need inbound.

## 4. Verify
Open `https://engine-design.starberkeley.org` in a browser → it bounces to
`auth.starberkeley.org` (EC2) to sign in → back to the app. Then:
```bash
curl -sI https://engine-design.starberkeley.org/          # 302 → auth.../login
```
Log in as an `@berkeley.edu` account; open onshape-viewer to confirm the allowlist
(non-approved users authenticate but get 403 there).

## Notes
- **`JWT_SECRET` must match EC2 exactly** — it's the whole trust link.
- **Per-user data** (engine + recovery saved configs, recovery units) lives in the
  `userdata` volume on this machine, keyed by `X-Auth-Email`.
- **Updating:** `docker compose --profile tunnel pull && docker compose --profile tunnel up -d`
  (CI republishes `:latest` on every push to `landing-page`).
