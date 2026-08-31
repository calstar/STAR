#!/usr/bin/env bash
# STARProject → S3 backup / restore for the deploy/ec2 stack.
#
#   starproject-backup.sh backup           # pg_dump the DB → a dated S3 key
#   starproject-backup.sh list             # show what's in the bucket
#   starproject-backup.sh restore <db-key> # DESTRUCTIVE — overwrites live data
#
# STARProject stores everything in Postgres (no uploads volume), so this backs up
# the DB only — unlike the legacy OpenProject backup.sh which also tars assets.
#
# Auth: relies on the EC2 instance's IAM role (no keys on disk). The AWS CLI
# picks up role creds from instance metadata automatically.
#
# Consistency: `pg_dump` is a live, internally-consistent logical dump (no
# downtime). It's written to a temp dir and size-checked BEFORE upload, so a
# failed dump never overwrites a good backup with a truncated one.
set -euo pipefail

# ── config (override via env) ───────────────────────────────────────────────
BUCKET="${BACKUP_BUCKET:-s3://star-starproject-backups}"   # no trailing slash
DB_SERVICE="${DB_SERVICE:-starproject-db}"                 # compose service name
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="docker compose -f $COMPOSE_DIR/docker-compose.yml"

log() { printf '%s  %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# pg_dump inside the Postgres container, as its configured superuser/database.
dump_db() {   # $1 = output file
  $COMPOSE exec -T "$DB_SERVICE" sh -lc \
    'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$1"
}

# ── backup ──────────────────────────────────────────────────────────────────
do_backup() {
  local stamp tmp
  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  log "pg_dump → db.dump"
  dump_db "$tmp/db.dump"
  [ -s "$tmp/db.dump" ] || die "db.dump is empty — aborting (nothing uploaded)"

  log "upload → $BUCKET  (stamp $stamp)"
  aws s3 cp "$tmp/db.dump" "$BUCKET/db/$stamp.dump"
  log "backup complete: $stamp"
}

# ── list ────────────────────────────────────────────────────────────────────
do_list() {
  echo "== $BUCKET/db/ ==" >&2; aws s3 ls "$BUCKET/db/" --recursive --human-readable
}

# ── restore (DESTRUCTIVE) ────────────────────────────────────────────────────
do_restore() {
  local db_key="${1:?usage: restore <db-key>}"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  cat >&2 <<WARN
!! RESTORE OVERWRITES LIVE DATA !!
  DB ← $BUCKET/db/$db_key   (pg_restore --clean drops & recreates objects)
Do this in a maintenance window; active sessions may see transient errors.
WARN
  read -rp "Type 'RESTORE' to proceed: " ans
  [ "$ans" = "RESTORE" ] || die "aborted"

  log "download db"
  aws s3 cp "$BUCKET/db/$db_key" "$tmp/db.dump"

  log "pg_restore (clean, no-owner)"
  $COMPOSE exec -T "$DB_SERVICE" sh -lc \
    'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$tmp/db.dump"

  log "restore complete — restart the app: $COMPOSE restart starproject"
}

# ── dispatch ────────────────────────────────────────────────────────────────
case "${1:-}" in
  backup)  do_backup ;;
  list)    do_list ;;
  restore) shift; do_restore "$@" ;;
  *) echo "usage: $0 {backup|list|restore <db-key>}" >&2; exit 2 ;;
esac
