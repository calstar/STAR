#!/usr/bin/env bash
# STARProject → S3 backup / restore for the deploy/ec2 stack.
#
#   starproject-backup.sh backup           # pg_dump the DB → a dated S3 key
#   starproject-backup.sh list             # show what's in the bucket
#   starproject-backup.sh restore <db-key> # DESTRUCTIVE — overwrites live data
#                                          # (add a users-key to restore the
#                                          #  auth roster too)
#
# STARProject stores everything in Postgres (no uploads volume). Alongside it
# this grabs the auth login roster (auth/users.json on the auth_data volume) —
# the list of everyone who has signed in, which is what the design tools' "share
# with" picker is built from. It rebuilds itself as people sign in, so losing it
# is survivable; but an empty picker the morning after a restore is a confusing
# way to discover it was skipped, and it is a few kilobytes.
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
AUTH_SERVICE="${AUTH_SERVICE:-auth}"                       # holds the login roster
AUTH_USERS_PATH="${AUTH_USERS_PATH:-/data/users.json}"     # matches AUTH_USERS_FILE
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="docker compose -f $COMPOSE_DIR/docker-compose.yml"

log() { printf '%s  %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# pg_dump inside the Postgres container, as its configured superuser/database.
dump_db() {   # $1 = output file
  $COMPOSE exec -T "$DB_SERVICE" sh -lc \
    'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$1"
}

# The roster, straight off the auth container's volume. Best-effort: it is a
# convenience next to the DB, never a reason to fail the backup that matters.
dump_users() {   # $1 = output file
  $COMPOSE exec -T "$AUTH_SERVICE" sh -lc "cat '$AUTH_USERS_PATH'" > "$1" 2>/dev/null || true
}

# ── backup ──────────────────────────────────────────────────────────────────
do_backup() {
  local stamp tmp
  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  log "pg_dump → db.dump"
  dump_db "$tmp/db.dump"
  [ -s "$tmp/db.dump" ] || die "db.dump is empty — aborting (nothing uploaded)"

  log "read auth roster → users.json"
  dump_users "$tmp/users.json"

  log "upload → $BUCKET  (stamp $stamp)"
  aws s3 cp "$tmp/db.dump" "$BUCKET/db/$stamp.dump"
  if [ -s "$tmp/users.json" ]; then
    aws s3 cp "$tmp/users.json" "$BUCKET/users/$stamp.json"
  else
    log "note: auth roster empty or unreadable — skipped (DB backup unaffected)"
  fi
  log "backup complete: $stamp"
}

# ── list ────────────────────────────────────────────────────────────────────
do_list() {
  echo "== $BUCKET/db/ ==" >&2; aws s3 ls "$BUCKET/db/" --recursive --human-readable
  echo "== $BUCKET/users/ ==" >&2; aws s3 ls "$BUCKET/users/" --recursive --human-readable || true
}

# ── restore (DESTRUCTIVE) ────────────────────────────────────────────────────
do_restore() {
  local db_key="${1:?usage: restore <db-key> [users-key]}"
  local users_key="${2:-}"
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

  if [ -n "$users_key" ]; then
    log "download + restore auth roster"
    aws s3 cp "$BUCKET/users/$users_key" "$tmp/users.json"
    $COMPOSE exec -T "$AUTH_SERVICE" sh -lc "cat > '$AUTH_USERS_PATH'" < "$tmp/users.json"
  fi

  log "restore complete — restart the app: $COMPOSE restart starproject"
}

# ── dispatch ────────────────────────────────────────────────────────────────
case "${1:-}" in
  backup)  do_backup ;;
  list)    do_list ;;
  restore) shift; do_restore "$@" ;;
  *) echo "usage: $0 {backup|list|restore <db-key> [users-key]}" >&2; exit 2 ;;
esac
