# Deploying `auth` to the OpenProject EC2 box

Standalone deploy of just the auth service, next to the existing OpenProject
container, exposed through a **Cloudflare Tunnel**. Nothing about OpenProject
changes: it keeps its A-record and its ports. Auth is reached only through the
tunnel, so no inbound ports are opened on the instance.

```
browser ──▶ Cloudflare edge (TLS) ──▶ cloudflared ──▶ auth:5000
```

> **Image, not build:** the auth image is built and pushed to GHCR by
> `.github/workflows/publish-auth.yml` (from the `landing-page` branch, where
> `auth/` lives). The box **pulls** it — no repo checkout, no build on the box.

> **Why not the root `docker-compose.yml`?** That one runs Caddy + every app and
> wants `:80`/`:443`, which OpenProject already uses. This folder runs only
> `auth` + `cloudflared`.

---

## 1. Cloudflare dashboard — create the tunnel

**Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared*.

1. Name it e.g. `star-auth`, save, and on the "Install connector" screen copy
   the **token** (the long string after `--token`). You need only the token —
   the container is the connector.
2. **Public Hostnames → Add a public hostname:**
   - Subdomain: `auth`  ·  Domain: `starberkeley.org`  ·  Path: *(empty)*
   - Service: **HTTP** → `auth:5000`

   Cloudflare auto-creates the `auth.starberkeley.org` CNAME → the tunnel.
   (The service host `auth` is the compose service name; cloudflared reaches it
   over the shared compose network.)

TLS is handled at the edge automatically — no certificates on the box.

## 2. Google OAuth — add the redirect URI

APIs & Services → Credentials → your OAuth 2.0 Client → **Authorized redirect
URIs**, add:

```
https://auth.starberkeley.org/callback
```

Logins bounce back to `/login` silently if this is missing.

## 3. On the EC2 box — get just this folder and configure

No full clone needed — the image comes from GHCR; you only need this folder's
two files. Docker is already present (OpenProject runs on it); confirm the
Compose plugin too (`docker compose version`).

Grab only `deploy/auth-ec2/` with a sparse, blobless, shallow checkout:

```bash
git clone --depth 1 --filter=blob:none --sparse -b landing-page \
  https://github.com/calstar/STAR.git
cd STAR
git sparse-checkout set deploy/auth-ec2
cd deploy/auth-ec2

cp .env.example .env
```

**GHCR is private by default**, so authenticate once so the box can pull the
image (PAT with `read:packages`), or make the package public in its GitHub
package settings:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin
```

Fill in `.env`:

| Var | Where it comes from |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | the OAuth client from step 2 |
| `JWT_SECRET` | `python -c "import secrets; print(secrets.token_hex(32))"` — **save it**, the local apps must reuse the same value |
| `FLASK_SECRET_KEY` | another `secrets.token_hex(32)` |
| `CLOUDFLARE_TUNNEL_TOKEN` | the tunnel token from step 1 |
| `AUTH_PUBLIC_URL` | `https://auth.starberkeley.org` (already the default) |

## 4. Bring it up

```bash
docker compose up -d --build
docker compose logs -f          # watch auth boot and cloudflared register
```

`cloudflared` should log `Registered tunnel connection`; `auth` should show
gunicorn workers booting.

## 5. Verify

```bash
curl -s https://auth.starberkeley.org/healthz          # -> OK
curl -sI https://auth.starberkeley.org/                 # -> 302 to /login
```

Then open `https://auth.starberkeley.org/` in a browser: it should send you
through Google and, for an `@berkeley.edu` account, land on a "✅ Logged in"
page. A non-berkeley.edu account gets a 403 by design.

## Updating later

The image tracks `:latest`, which CI republishes on every push to `auth/**`.
To roll the box forward, just re-pull:

```bash
cd STAR/deploy/auth-ec2
docker compose pull && docker compose up -d
```

## Changing the onshape-viewer allowlist

`auth/onshape_allowlist.txt` is baked into the image, so the normal way to add or
remove someone is: edit it on `landing-page`, push (CI republishes), then
`docker compose pull && up -d` on the box. For edits without a rebuild, mount an
override file and point `ONSHAPE_ALLOWLIST_FILE` at it in `.env`.

## Notes for when the apps come online (local machine)

- **Same `JWT_SECRET` everywhere.** The apps verify the cookie auth mints; a
  mismatch rejects every login.
- **Cookie domain is `.starberkeley.org`.** For single-sign-on to work, the
  tools on the local machine must also be served under `*.starberkeley.org`
  (their own tunnel/records) — a browser only sends the cookie to hosts under
  that domain. That's the next phase; tonight only stands up auth.
- Auth is the enforcement backend Caddy calls (`/verify`). On the local machine,
  Caddy's `forward_auth` upstream must point at this EC2 auth service.
