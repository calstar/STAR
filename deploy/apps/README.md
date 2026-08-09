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

## P&ID diagram versioning (S3)

Each user's P&ID diagrams autosave to a working copy on the `userdata` volume;
their **version history** — automatic *microversions* + explicit *releases* —
lives in a **versioned S3 bucket**. This is optional: leave `PID_S3_BUCKET` empty
and history falls back to the local volume (fine for a single dev box, but the
history then shares the box's fate — S3 is what makes it durable + off-box).

This machine is **not** on EC2, so it authenticates with **IAM access keys**, not
an instance role.

**One-time AWS setup** (run where you're logged into AWS — your laptop is fine):
```bash
# 1. Versioned, private bucket
aws s3api create-bucket --bucket star-pid-designer --region us-east-2 \
  --create-bucket-configuration LocationConstraint=us-east-2
aws s3api put-public-access-block --bucket star-pid-designer \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket star-pid-designer \
  --versioning-configuration Status=Enabled
# Prune old microversions (noncurrent versions of current.json), keeping the
# latest state + every release (their own current objects) forever.
aws s3api put-bucket-lifecycle-configuration --bucket star-pid-designer \
  --lifecycle-configuration '{"Rules":[{"ID":"prune-microversions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'

# 2. IAM user + access keys, scoped to just this bucket
aws iam create-user --user-name star-pid-designer
aws iam put-user-policy --user-name star-pid-designer \
  --policy-name pid-s3 --policy-document file://deploy/apps/pid-s3-policy.json
aws iam create-access-key --user-name star-pid-designer   # copy the keys
```

**On the apps machine**, add to `.env` (then `docker compose … up -d`):
```
PID_S3_BUCKET=star-pid-designer
PID_S3_PREFIX=pid
AWS_DEFAULT_REGION=us-east-2
AWS_ACCESS_KEY_ID=AKIA…
AWS_SECRET_ACCESS_KEY=…
```

**Verify:** open pid-designer, create a diagram, edit for a few minutes, then
`aws s3api list-object-versions --bucket star-pid-designer --prefix pid/` — you'll
see microversions accrue as versions of `…/current.json`, and any release as its
own `…/releases/<label>.json`.

## Engine Design + Recovery Calculator config versioning (S3)

Same model, same tiers: each user's designs autosave to a working copy on the
`userdata` volume, and their **version history** (microversions + releases) goes
to a versioned S3 bucket — or the local volume when the bucket var is empty.
Give each app its own bucket (or reuse one bucket with distinct prefixes); both
reuse the same `AWS_*` credentials as the P&ID setup.

Repeat the **One-time AWS setup** above for each app's bucket, e.g.
`star-engine-design` and `star-recovery-calculator`, including the **same
lifecycle rule** (prune noncurrent versions of `…/current.json`; the immutable
`releases/` objects are current versions and are untouched):
```bash
aws s3api put-bucket-lifecycle-configuration --bucket star-engine-design \
  --lifecycle-configuration '{"Rules":[{"ID":"prune-microversions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'
```

**On the apps machine**, add to `.env`:
```
ENGINE_S3_BUCKET=star-engine-design
ENGINE_S3_PREFIX=engine
RECOVERY_S3_BUCKET=star-recovery-calculator
RECOVERY_S3_PREFIX=recovery
```

**Verify:** open engine-design (or recovery-calculator), edit a design, cut a
release, then `aws s3api list-object-versions --bucket star-engine-design
--prefix engine/`.

## Notes
- **`JWT_SECRET` must match EC2 exactly** — it's the whole trust link.
- **Per-user data** (engine + recovery saved configs, recovery units, **P&ID
  working copies**) lives in the `userdata` volume on this machine, keyed by
  `X-Auth-Email`. P&ID *version history* additionally lives in S3 (above).
- **Updating:** `docker compose --profile tunnel pull && docker compose --profile tunnel up -d`
  (CI republishes `:latest` on every push to `landing-page`).
