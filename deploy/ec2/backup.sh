#!/usr/bin/env bash
# OpenProject → S3 backup / restore for the deploy/ec2 stack.
#
#   backup.sh backup            # pg_dump the DB + tar the assets → dated S3 keys
#   backup.sh list              # show what's in the bucket
#   backup.sh restore <db-key> <assets-key>   # DESTRUCTIVE — overwrites live data
#
# Auth: relies on the EC2 instance's IAM role (no keys on disk). The AWS CLI
# picks up role creds from instance metadata automatically.
#
# Consistency: the DB goes through `pg_dump` (a live, internally-consistent
# logical dump — no downtime). The assets volume is static files, so a plain
# tar is safe. Both are written to a temp dir and size-checked BEFORE upload,
# so a failed dump never overwrites a good backup with a truncated one.
set -euo pipefail

# ── config (override via env) ───────────────────────────────────────────────
BUCKET="${BACKUP_BUCKET:-s3://star-openproject-backups}"   # no trailing slash
OP_SERVICE="${OP_SERVICE:-openproject}"                     # compose service name
ASSETS_VOLUME="${ASSETS_VOLUME:-openproject_assets}"        # external volume name
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="docker compose -f $COMPOSE_DIR/docker-compose.yml"

log()  { printf '%s  %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

# pg_dump inside the all-in-one container, using the URL the app itself uses.
dump_db() {   # $1 = output file
  $COMPOSE exec -T "$OP_SERVICE" bash -lc \
    'test -n "${DATABASE_URL:-}" || { echo "DATABASE_URL not set in container" >&2; exit 3; }; \
     pg_dump -Fc "$DATABASE_URL"' > "$1"
}

# ── backup ──────────────────────────────────────────────────────────────────
do_backup() {
  local stamp tmp
  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  log "pg_dump → db.dump"
  dump_db "$tmp/db.dump"
  [ -s "$tmp/db.dump" ] || die "db.dump is empty — aborting (nothing uploaded)"

  log "tar assets ($ASSETS_VOLUME) → assets.tgz"
  docker run --rm -v "${ASSETS_VOLUME}:/d:ro" alpine tar czf - -C /d . > "$tmp/assets.tgz"
  [ -s "$tmp/assets.tgz" ] || die "assets.tgz is empty — aborting (nothing uploaded)"

  log "upload → $BUCKET  (stamp $stamp)"
  aws s3 cp "$tmp/db.dump"    "$BUCKET/db/$stamp.dump"
  aws s3 cp "$tmp/assets.tgz" "$BUCKET/assets/$stamp.tgz"
  log "backup complete: $stamp"
}

# ── list ────────────────────────────────────────────────────────────────────
do_list() {
  echo "== $BUCKET/db/ =="     >&2; aws s3 ls "$BUCKET/db/"     --recursive --human-readable
  echo "== $BUCKET/assets/ ==" >&2; aws s3 ls "$BUCKET/assets/" --recursive --human-readable
}

# ── restore (DESTRUCTIVE) ────────────────────────────────────────────────────
do_restore() {
  local db_key="${1:?usage: restore <db-key> <assets-key>}"
  local assets_key="${2:?usage: restore <db-key> <assets-key>}"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  cat >&2 <<WARN
!! RESTORE OVERWRITES LIVE DATA !!
  DB     ← $BUCKET/db/$db_key      (pg_restore --clean drops & recreates objects)
  assets ← $BUCKET/assets/$assets_key  (assets volume is WIPED then unpacked)
Do this in a maintenance window; active sessions may see transient errors.
WARN
  read -rp "Type 'RESTORE' to proceed: " ans
  [ "$ans" = "RESTORE" ] || die "aborted"

  log "download db + assets"
  aws s3 cp "$BUCKET/db/$db_key"         "$tmp/db.dump"
  aws s3 cp "$BUCKET/assets/$assets_key" "$tmp/assets.tgz"

  log "pg_restore (clean, no-owner)"
  $COMPOSE exec -T "$OP_SERVICE" bash -lc \
    'pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL"' < "$tmp/db.dump"

  log "restore assets volume ($ASSETS_VOLUME)"
  docker run --rm -i -v "${ASSETS_VOLUME}:/d" alpine \
    sh -c 'rm -rf /d/* /d/..?* /d/.[!.]* 2>/dev/null; tar xzf - -C /d' < "$tmp/assets.tgz"

  log "restore complete — restart the stack: $COMPOSE restart $OP_SERVICE"
}

# ── dispatch ────────────────────────────────────────────────────────────────
case "${1:-}" in
  backup)  do_backup ;;
  list)    do_list ;;
  restore) shift; do_restore "$@" ;;
  *) echo "usage: $0 {backup|list|restore <db-key> <assets-key>}" >&2; exit 2 ;;
esac
