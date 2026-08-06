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
cp .env.example .env    # fill in — REUSE the existing OPENPROJECT_SECRET_KEY_BASE
                        # and the SAME JWT_SECRET as before

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
