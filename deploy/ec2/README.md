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
  --region us-east-1 --create-bucket-configuration LocationConstraint=us-east-1
aws s3api put-public-access-block --bucket star-openproject-backups \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket star-openproject-backups \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket star-openproject-backups \
  --lifecycle-configuration file://s3-lifecycle.json   # keep 90d; old versions 30d
```
(`us-east-1` is special: **omit** `--create-bucket-configuration` there.)

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
