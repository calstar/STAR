# Deploy the apps machine (engine, pid, recovery, onshape, landing)

The apps run on their own machine behind a **second** Cloudflare Tunnel, separate
from the EC2 box (which runs OpenProject + the central login auth). This machine
runs the root `docker-compose.yml`: Caddy (the gate) + a **verify-only** auth +
all app frontends/APIs + cloudflared.

> Setting up the box from a **blank Ubuntu install** (OS, Docker, SSH-over-the-tunnel,
> desktop auto-login)? Do [`FRESH-INSTALL.md`](FRESH-INSTALL.md) first, then this.

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
Add routes with **Add published application** (the new UI's name for a Public
Hostname). There is no service *type* dropdown — the **type is the URL scheme**:
`http://` for the apps, `ssh://` for SSH. Leave **Path** empty. All web routes →
Service URL `http://caddy:80`:

| Subdomain | Domain | Service URL |
| --- | --- | --- |
| *(none / apex)* | `starberkeley.org` → landing | `http://caddy:80` |
| `engine-design` | `starberkeley.org` | `http://caddy:80` |
| `pid-designer` | `starberkeley.org` | `http://caddy:80` |
| `recovery-calculator` | `starberkeley.org` | `http://caddy:80` |
| `onshape-viewer` | `starberkeley.org` | `http://caddy:80` |
| `daq-viewer` | `starberkeley.org` | `http://caddy:80` |

Plus one **SSH** route on the same tunnel for remote admin — the `ssh://` scheme
makes it SSH, and `cloudflared` maps `host.docker.internal` to the host via
`extra_hosts`, so it reaches the box's sshd:

| Subdomain | Domain | Service URL |
| --- | --- | --- |
| `ssh-rfs` | `starberkeley.org` | `ssh://host.docker.internal:22` |

Connect with `ProxyCommand cloudflared access ssh --hostname ssh-rfs.starberkeley.org`
— see [`FRESH-INSTALL.md`](FRESH-INSTALL.md) §7. Do **not** add `auth.` here —
that stays on the EC2 tunnel.

> **Firewall:** the connector reaches the host's sshd over the Docker bridge, so
> `ufw` must allow it — `sudo ufw allow from 172.16.0.0/12 to any port 22 proto
> tcp`. `bootstrap.sh` does this; without it SSH times out
> (`dial tcp 172.17.0.1:22: i/o timeout`) while the web apps still work.

## 2. On the apps machine — get the compose + configure
Images are pulled from GHCR (built by `publish-apps.yml` / `publish-auth.yml`), so
the box needs only the root compose + `.env`, not the app source. Grab just those
with a sparse checkout:

```bash
git clone --depth 1 --filter=blob:none --sparse -b main \
  https://github.com/calstar/STAR.git
cd STAR
git sparse-checkout set deploy/apps      # cone mode also brings the root files
                                         # (docker-compose.yml, .env.example)
cp .env.example .env
```

The `star-*` GHCR packages are **public**, so no `docker login` is needed — the
pull in §3 just works. (If you ever flip them back to private, log in first with
a classic PAT scoped `read:packages`: `echo "<PAT>" | docker login ghcr.io -u
<github-user> --password-stdin`.)

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

## Version history in S3 (P&ID + Engine + Recovery)

All three apps use the same model: each user's designs/diagrams autosave to a
working copy on the `userdata` volume, and their **version history** — automatic
*microversions* + explicit *releases* — lives in a **versioned S3 bucket**. This
is optional: leave a `*_S3_BUCKET` var empty and that app's history falls back to
the local volume (fine for a single dev box, but the history then shares the
box's fate — S3 is what makes it durable + off-box).

Each app gets **its own bucket** (blast-radius isolation), but they share **one
IAM user** — the apps machine holds a single `AWS_*` key pair in `.env`, so one
user with a policy spanning all three buckets is what lets every app reach its
own. This machine is **not** on EC2, so it authenticates with **IAM access
keys**, not an instance role.

**One-time AWS setup** (run where you're logged into AWS — your laptop is fine):
```bash
# 1. Three versioned, private buckets — same recipe for each.
for b in star-pid-designer star-engine-design star-recovery-calculator; do
  aws s3api create-bucket --bucket "$b" --region us-east-2 \
    --create-bucket-configuration LocationConstraint=us-east-2
  aws s3api put-public-access-block --bucket "$b" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-versioning --bucket "$b" \
    --versioning-configuration Status=Enabled
  # Prune old microversions (noncurrent versions of current.json), keeping the
  # latest state + every release (their own current objects) forever.
  aws s3api put-bucket-lifecycle-configuration --bucket "$b" \
    --lifecycle-configuration '{"Rules":[{"ID":"prune-microversions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'
done

# 2. ONE IAM user + access keys, policy scoped to all three buckets.
aws iam create-user --user-name star-app-s3
aws iam put-user-policy --user-name star-app-s3 \
  --policy-name app-s3 --policy-document file://deploy/apps/app-s3-policy.json
aws iam create-access-key --user-name star-app-s3   # copy the keys
```

> Bucket names are baked into `deploy/apps/app-s3-policy.json`. If you rename a
> bucket, edit the ARNs there too.

**On the apps machine**, add to `.env` (then `docker compose … up -d`):
```
PID_S3_BUCKET=star-pid-designer
PID_S3_PREFIX=pid
ENGINE_S3_BUCKET=star-engine-design
ENGINE_S3_PREFIX=engine
RECOVERY_S3_BUCKET=star-recovery-calculator
RECOVERY_S3_PREFIX=recovery
AWS_DEFAULT_REGION=us-east-2
AWS_ACCESS_KEY_ID=AKIA…
AWS_SECRET_ACCESS_KEY=…
```

**Verify:** open an app, edit for a few minutes / cut a release, then
`aws s3api list-object-versions --bucket star-pid-designer --prefix pid/` — you'll
see microversions accrue as versions of `…/current.json`, and any release as its
own `…/releases/<label>.json`. (Swap bucket + prefix for the other two apps.)

## Auto-deploy on merge to `main`

A systemd timer polls for the images CI has published and redeploys the stack, so
a merged PR reaches this box without anyone SSHing in. It is **pull-based on
purpose**: the machine is outbound-only (`ufw default deny incoming`), and a
push-based deploy would mean keeping an SSH key + a Cloudflare Access service
token in GitHub that grant shell here. The cost is up to one timer interval of
latency.

```bash
cd /opt/STAR
sudo cp deploy/apps/systemd/star-auto-update.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now star-auto-update.timer
sudo systemctl start star-auto-update.service     # run one tick now
journalctl -u star-auto-update -f
```

Each tick ([`deploy/auto-update.sh`](../auto-update.sh)):

1. **Waits for CI to go idle.** `publish-apps.yml` builds a dozen images in a
   matrix spread over ~5–40 minutes, all pushing `:latest`. Pulling mid-matrix
   would pair a *new* API with an *old* frontend, so the tick skips while any run
   of `publish-apps.yml` / `publish-auth.yml` is still queued or in progress. The
   repo is public, so this needs no credentials. Anything the API can't answer
   (offline, rate limited) also skips — a late deploy is cheap, a half-deploy is
   not.
2. **Syncs the checkout** to `origin/main`, so compose and Caddyfile changes ship
   with the images. A commit younger than `SETTLE_SECONDS` (120) is left for the
   next tick — GitHub takes a moment to create a workflow run, and until it
   exists step 1 would see an idle CI.
3. **Pulls and `up -d`s.** It compares resolved image *digests*, not tags, so a
   tick with nothing new is a genuine no-op and the journal stays readable.
4. **Verifies** every service came back running, and leaves the unit failed (and
   the recorded state unadvanced, so the next tick retries) if not.

| | |
| --- | --- |
| Deploy right now | `sudo systemctl start star-auto-update` |
| See what would happen | `sudo /opt/STAR/deploy/auto-update.sh --dry-run` |
| Deploy without waiting for CI | `… /deploy/auto-update.sh --skip-ci-check` |
| What is deployed | `cat /var/lib/star-auto-update/state` |
| Pause auto-deploy | `sudo systemctl disable --now star-auto-update.timer` |
| Per-box settings | `/etc/star-auto-update.conf` (`SETTLE_SECONDS`, `PRUNE`, `GITHUB_TOKEN`, …) |

**Caveats**
- **The DAQ server is not covered.** It's a native systemd install that needs the
  test-stand hardware, not a compose service — updating it stays the flow in
  [`../README.md`](../README.md).
- **Local edits to tracked files stop the checkout sync** (the tick warns in the
  journal and still ships the images). §3 above suggests deleting caddy's
  `80:80`/`443:443` lines on the box; `bootstrap.sh` already blocks those at the
  firewall, so prefer leaving the file alone. `--allow-dirty` discards such edits.
- **Rollback is manual** — compose pins `:latest`, so there is nothing to revert
  to automatically. Every image also carries a `sha-<short>` tag to pin by hand.
- **In-flight user work is safe.** All persistent data is in named volumes
  (`userdata`) or S3, which container recreation doesn't touch, and the design
  tools' autosave only advances its "last saved" marker on success — a few
  seconds of API downtime is retried on the next 4-second tick.

## Notes
- **`JWT_SECRET` must match EC2 exactly** — it's the whole trust link.
- **Per-user data** (engine + recovery saved configs, recovery units, **P&ID
  working copies**) lives in the `userdata` volume on this machine, keyed by
  `X-Auth-Email`. P&ID *version history* additionally lives in S3 (above).
- **Updating:** automatic — see [Auto-deploy on merge to `main`](#auto-deploy-on-merge-to-main)
  above. By hand it is `docker compose --profile tunnel pull && docker compose
  --profile tunnel up -d` (CI republishes `:latest` on every push to `main`).
