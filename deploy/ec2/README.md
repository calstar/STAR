# STAR EC2 box — OpenProject + auth, one tunnel

Unified stack: OpenProject, auth, and cloudflared on one network. Reaches both
apps by service name through the tunnel — no host ports, no A-records.
Supersedes `deploy/auth-ec2/`.

## Cutover (safe — no data loss)

Run on the box. **Never use `docker compose down -v`** (that deletes volumes).

```bash
# 0. Confirm the data volumes exist under these exact names
docker volume ls | grep openproject      # -> openproject_pgdata, openproject_assets

# 1. Back up first (belt-and-braces)
docker run --rm -v openproject_pgdata:/d -v "$PWD":/b alpine tar czf /b/pgdata-backup.tgz -C /d .
docker run --rm -v openproject_assets:/d -v "$PWD":/b alpine tar czf /b/assets-backup.tgz -C /d .

# 2. Stop the old stacks (volumes are kept)
cd ~/openproject && docker compose down
cd ~/STAR/deploy/auth-ec2 && docker compose down    # stops the auth-only cloudflared

# 3. Get this folder + config
cd ~/STAR && git pull && git sparse-checkout add deploy/ec2 && cd deploy/ec2

# Reuse the .env you already filled for auth-ec2 — carry it forward (a NEW file
# in this folder; the original is untouched) instead of `cp .env.example .env`.
# It already has GOOGLE_*, JWT_SECRET, FLASK_SECRET_KEY, AUTH_PUBLIC_URL and the
# same CLOUDFLARE_TUNNEL_TOKEN; only the two OpenProject vars are missing.
cp ~/STAR/deploy/auth-ec2/.env .env

grep -ri SECRET_KEY_BASE ~/openproject   # the EXISTING value — never regenerate

# Open the file and add the two OpenProject lines at the bottom (Ctrl-O, Enter,
# Ctrl-X to save+exit). Editing beats a paste-a-heredoc, which stalls at a `>`
# prompt if the closing EOF doesn't come through.
nano .env
#   # ── OpenProject ──
#   OPENPROJECT_HOST__NAME=openproject.starberkeley.org
#   OPENPROJECT_SECRET_KEY_BASE=<the value from the grep above>

# Sanity-check: each present exactly once, non-empty
grep -E 'JWT_SECRET|SECRET_KEY_BASE|TUNNEL_TOKEN' .env

# 4. Up
docker compose up -d
docker compose ps
```

## Repoint the tunnel
Cloudflare → your tunnel → Public Hostnames:
- `auth.starberkeley.org` → `http://auth:5000` (unchanged)
- `openproject.starberkeley.org` → **`http://openproject:80`** (was `localhost:80`)

Then in DNS, delete OpenProject's old **A-record** (the tunnel manages its CNAME).

## Verify
```bash
curl -s https://auth.starberkeley.org/healthz    # -> OK
```
Open `https://openproject.starberkeley.org` → your existing projects/users load
(proves the volumes carried over). Only after that, confirm port 80 is closed:
`sudo ss -tlnp '( sport = :80 )'` shows nothing.

## Rollback
`cd deploy/ec2 && docker compose down`, then `cd ~/openproject && docker compose up -d`.
Data is untouched (same volumes). Restore a backup only if a volume was lost:
`docker run --rm -v openproject_pgdata:/d -v "$PWD":/b alpine sh -c "rm -rf /d/* && tar xzf /b/pgdata-backup.tgz -C /d"`.

## Email (Amazon SES)

OpenProject sends notifications, invites, and password resets by **relaying
through Amazon SES** over SMTP (port 587) — it is not a mail server itself, and
nothing here depends on OpenProject running on EC2 (SES accepts SMTP from
anywhere). Compose already wires the `OPENPROJECT_SMTP__*` vars; you supply the
creds + DNS. Do this once.

### 1. Verify the domain in SES

SES console (pick a region — `us-east-2` matches the backup bucket) → **Verified
identities → Create identity → Domain** → `starberkeley.org` → enable **Easy
DKIM** (RSA 2048). SES shows **3 CNAME records**.

### 2. Add DNS records in Cloudflare

All of these are **DNS-only (grey cloud)** — never proxy them:

| Type | Name | Value | Notes |
|------|------|-------|-------|
| CNAME ×3 | `<token>._domainkey` | `<token>.dkim.amazonses.com` | the 3 SES gives you — DKIM, this is what makes DMARC pass |
| TXT | `@` | `v=spf1 include:amazonses.com ~all` | SPF. **Merge** into your existing SPF if one exists — only one SPF TXT allowed |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@starberkeley.org` | start at `p=none` to monitor, tighten later |

SES marks the identity **verified** within minutes once the DKIM CNAMEs
resolve. *(Optional: set a custom MAIL FROM subdomain in SES for SPF alignment —
adds one MX + one TXT. DKIM alone already passes DMARC, so skip unless needed.)*

### 3. Create SMTP credentials

SES console → **SMTP settings → Create SMTP credentials**. This provisions an
IAM user and shows an **SMTP username + password** *once* (the password is
derived from an AWS secret key — it is NOT your account secret key). Put them in
`.env` as `SES_SMTP_USERNAME` / `SES_SMTP_PASSWORD`, and set `SES_SMTP_ADDRESS`
to the region you verified in (`email-smtp.<region>.amazonaws.com`).

### 4. Leave the sandbox

New SES accounts are **sandboxed**: they can only send *to* addresses you've
verified. To email arbitrary teammates, SES console → **Account dashboard →
Request production access** (short form, usually approved < 24h). Until then,
verify each recipient under Verified identities to test.

### 5. Apply + test

```bash
cd ~/STAR/deploy/ec2 && git pull
grep -E 'SES_SMTP_(USERNAME|PASSWORD)' .env    # both non-empty
docker compose up -d openproject               # picks up the new env
```
In OpenProject: **Administration → Emails and notifications → Email
notifications → Send test email**. Check SES **Account dashboard** for the send
count, and the DKIM/SPF results in the received message's headers.

## Off-box backups to S3

`backup.sh` sends a **consistent** snapshot to S3 on a schedule: `pg_dump` the DB
(live, no downtime) + `tar` the assets volume, each uploaded under a **dated key**.
With **bucket versioning** on, an overwrite or delete of a key is still
recoverable, and a **lifecycle rule** ages old copies out so cost stays flat.

```
s3://star-openproject-backups/db/2026-08-08T0300Z.dump
s3://star-openproject-backups/assets/2026-08-08T0300Z.tgz
```

### One-time AWS setup

**1. Bucket — versioning on, public access blocked** (pick your region):
```bash
aws s3api create-bucket --bucket star-openproject-backups \
  --region us-east-2 --create-bucket-configuration LocationConstraint=us-east-2
aws s3api put-public-access-block --bucket star-openproject-backups \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket star-openproject-backups \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket star-openproject-backups \
  --lifecycle-configuration file://s3-lifecycle.json   # keep 90d; old versions 30d
```
(Only `us-east-1` omits `--create-bucket-configuration`; every other region,
including `us-east-2`, requires the matching `LocationConstraint` as shown.)

**2. IAM role on the instance — no keys on the box.** Console → IAM → Roles →
create role → *AWS service: EC2* → attach a policy from `iam-backup-policy.json`
(edit the bucket name if you changed it), then EC2 → the instance → Actions →
Security → **Modify IAM role** → attach it. The AWS CLI then signs requests with
auto-rotating role creds pulled from instance metadata — nothing to store.
The policy grants **Put/Get/List only, not Delete**: a compromised box can write
backups but can't erase history; the lifecycle rule does deletions server-side.

Verify the box can reach the bucket:
```bash
aws sts get-caller-identity          # shows the assumed role
aws s3 ls s3://star-openproject-backups/
```

### Run it

```bash
./backup.sh backup     # take one now
./backup.sh list       # what's in the bucket
```

### Schedule it (systemd timer, 03:00 UTC daily)

```bash
# Edit the paths in the unit if the repo isn't at /home/ec2-user/STAR
sudo cp systemd/openproject-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openproject-backup.timer
systemctl list-timers openproject-backup.timer   # next run
journalctl -u openproject-backup.service -n 50    # last run's log
```

### Restore (DESTRUCTIVE — maintenance window)

```bash
./backup.sh list                                   # copy the keys you want
./backup.sh restore 2026-08-08T0300Z.dump 2026-08-08T0300Z.tgz
```
`pg_restore --clean` drops & recreates DB objects and the assets volume is wiped
then unpacked, so active sessions may see transient errors — do it during
downtime. To recover a *specific S3 version* of a key (versioning), download it
by `--version-id` first, then feed that file in.

### Tunables
`backup.sh` reads `BACKUP_BUCKET`, `OP_SERVICE`, `ASSETS_VOLUME` from the env
(defaults: `s3://star-openproject-backups`, `openproject`, `openproject_assets`).
The DB dump uses the container's own `DATABASE_URL`, so it needs no DB creds here.
