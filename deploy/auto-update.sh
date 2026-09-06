#!/usr/bin/env bash
# STAR auto-deploy — pull the images CI published for `main` and restart the stack.
#
#   auto-update.sh                 # one tick: sync repo, pull images, up -d
#   auto-update.sh --dry-run       # say what it would do, change nothing
#   auto-update.sh --force         # redeploy even when nothing changed
#
# Runs on a systemd timer on each deploy box (see deploy/apps/systemd/ and
# deploy/ec2/systemd/). Pull-based on purpose: both boxes are outbound-only
# behind Cloudflare (`ufw default deny incoming`), so nothing has to hold an SSH
# key or a tunnel service token for them. The cost is timer-interval latency.
#
# ── Why it waits for CI to go idle ───────────────────────────────────────────
# publish-apps.yml builds a dozen images in a matrix that finishes over ~5-40
# minutes, all pushing `:latest`. A timer that pulls mid-matrix gets a NEW api
# against an OLD frontend. So before pulling, this asks the GitHub Actions API
# whether any run of the watched workflows is still queued/in-progress on the
# deploy branch, and skips the tick if so. The repo is public, so that needs no
# credentials (set GITHUB_TOKEN anyway if you raise the timer frequency — see
# the rate-limit note below).
#
# Anything the API can't answer (network down, rate limited) SKIPS the tick
# rather than deploying blind: a late deploy is cheap, a half-deploy is not.
set -euo pipefail

# ── config (override via env, or /etc/star-auto-update.conf in the units) ────
# Defaults are derived from this script's own location: it lives at
# <repo>/deploy/auto-update.sh, so the repo root is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# Where `docker compose` runs. Apps box: the repo root. EC2: $REPO_DIR/deploy/ec2.
COMPOSE_DIR="${COMPOSE_DIR:-$REPO_DIR}"
# Space-separated compose profiles. Apps box: "tunnel". EC2: "" (the `legacy`
# OpenProject profile stays off).
COMPOSE_PROFILES_LIST="${COMPOSE_PROFILES_LIST:-}"
BRANCH="${BRANCH:-main}"
GITHUB_REPO="${GITHUB_REPO:-calstar/STAR}"
# Workflows that publish images either box runs. Both boxes run star-auth, and
# both draw from publish-apps.yml (the apps box for its ten app images, EC2 for
# star-starproject), so the same pair gates both.
WATCH_WORKFLOWS="${WATCH_WORKFLOWS:-publish-apps.yml publish-auth.yml}"
STATE_DIR="${STATE_DIR:-/var/lib/star-auto-update}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/state}"
LOCK_FILE="${LOCK_FILE:-$STATE_DIR/lock}"
# Don't deploy a commit younger than this: GitHub takes a few seconds to create
# a workflow run after a push, and until it exists the "is CI busy?" check above
# would see an idle CI and happily deploy a commit whose images aren't built.
SETTLE_SECONDS="${SETTLE_SECONDS:-120}"
PRUNE="${PRUNE:-1}"                       # `docker image prune -f` after a deploy
# OFF by default and it should stay that way on the EC2 box: compose counts the
# containers of a *disabled profile* as orphans, so `--remove-orphans` there
# would delete a running `legacy`-profile OpenProject during a rollback.
REMOVE_ORPHANS="${REMOVE_ORPHANS:-0}"
# GITHUB_TOKEN is optional: unauthenticated is 60 req/hr per IP and a tick costs
# one request per watched workflow (2 by default = 24/hr at the 5-minute timer).
# Set it if you shorten the interval or the box shares an IP.

FORCE=0; DRY_RUN=0; SKIP_CI_CHECK=0; ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)          FORCE=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    # Deploy whatever `:latest` points at right now, without waiting for CI.
    --skip-ci-check)  SKIP_CI_CHECK=1 ;;
    # Overwrite local edits to tracked files instead of leaving the repo alone.
    --allow-dirty)    ALLOW_DIRTY=1 ;;
    -h|--help)        sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '%s  %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }
skip() { log "skip: $*"; exit 0; }        # a skipped tick is success, not failure

# ── single-flight ────────────────────────────────────────────────────────────
# A slow pull must not overlap the next timer tick.
mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || skip "another run holds $LOCK_FILE"

command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
# `.git` is a directory in a normal clone but a file in a worktree, so ask git.
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_DIR is not a git checkout"
[[ -f "$COMPOSE_DIR/docker-compose.yml" ]] || die "no docker-compose.yml in $COMPOSE_DIR"

compose() {
  local args=()
  local p
  for p in $COMPOSE_PROFILES_LIST; do args+=(--profile "$p"); done
  # cd rather than -f so the project name and .env resolution match exactly what
  # a human running `cd <dir> && docker compose ...` gets.
  ( cd "$COMPOSE_DIR" && docker compose "${args[@]}" "$@" )
}

# ── 1. is CI still publishing? ───────────────────────────────────────────────
# One request per workflow. `status!=completed` covers queued, in_progress and
# waiting (a run held for an environment approval).
ci_busy() {
  local wf url body code active
  for wf in $WATCH_WORKFLOWS; do
    url="https://api.github.com/repos/$GITHUB_REPO/actions/workflows/$wf/runs?branch=$BRANCH&per_page=20"
    body="$(mktemp)"
    local curl_args=(-sSL --max-time 20 -o "$body" -w '%{http_code}'
                     -H "Accept: application/vnd.github+json"
                     -H "X-GitHub-Api-Version: 2022-11-28")
    [[ -n "${GITHUB_TOKEN:-}" ]] && curl_args+=(-H "Authorization: Bearer $GITHUB_TOKEN")
    code="$(curl "${curl_args[@]}" "$url" || echo 000)"

    if [[ "$code" == "404" ]]; then
      # Renamed or deleted workflow. Treating this as "busy" would wedge the box
      # permanently, so warn and let the deploy proceed.
      log "warn: workflow $wf not found (HTTP 404) — not gating on it; fix WATCH_WORKFLOWS"
      rm -f "$body"; continue
    fi
    if [[ "$code" != "200" ]]; then
      rm -f "$body"
      log "GitHub API returned HTTP $code for $wf"
      return 0        # unknown state -> treat as busy -> skip the tick
    fi

    active="$(python3 - "$body" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    runs = json.load(fh).get("workflow_runs", [])
busy = [r for r in runs if r.get("status") != "completed"]
print(len(busy))
for r in busy[:3]:
    print("   in flight: run %s %s (%s)" % (r.get("run_number"), r.get("status"), (r.get("head_sha") or "")[:7]), file=sys.stderr)
PY
)" || { rm -f "$body"; log "could not parse the API response for $wf"; return 0; }
    rm -f "$body"

    if [[ "$active" != "0" ]]; then
      log "$wf has $active run(s) still publishing"
      return 0
    fi
  done
  return 1
}

if [[ "$SKIP_CI_CHECK" == "1" ]]; then
  log "--skip-ci-check: not waiting for the publish workflows"
elif ci_busy; then
  skip "CI is mid-publish; :latest may be half-updated"
fi

# ── 2. sync the checkout (compose file, Caddyfile, this script) ──────────────
# Shallow clones (the apps box is one) must keep fetching shallow; a full clone
# must not be silently converted into one.
fetch_args=(fetch --quiet origin "$BRANCH")
[[ "$(git -C "$REPO_DIR" rev-parse --is-shallow-repository)" == "true" ]] && fetch_args+=(--depth 1)
git -C "$REPO_DIR" "${fetch_args[@]}" || die "git fetch failed"

target="$(git -C "$REPO_DIR" rev-parse FETCH_HEAD)"
current="$(git -C "$REPO_DIR" rev-parse HEAD)"
commit_ts="$(git -C "$REPO_DIR" show -s --format=%ct "$target")"
age=$(( $(date +%s) - commit_ts ))
if [[ "$target" != "$current" && "$age" -lt "$SETTLE_SECONDS" ]]; then
  skip "${target:0:7} is only ${age}s old; letting CI register its runs first"
fi

git_moved=0
if [[ "$target" == "$current" ]]; then
  :
elif [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" && "$ALLOW_DIRTY" == "0" ]]; then
  # Someone hand-edited a tracked file on the box (the apps README used to
  # suggest deleting caddy's 80/443 port lines here). Clobbering that silently
  # would quietly undo it, so leave the checkout alone and still ship the images.
  log "warn: tracked files are modified in $REPO_DIR — NOT syncing the checkout."
  log "warn:   move the edit into .env, or re-run with --allow-dirty to discard it:"
  git -C "$REPO_DIR" status --porcelain --untracked-files=no | sed 's/^/warn:   /' >&2
elif [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: would reset $REPO_DIR to ${target:0:7}"
  git_moved=1
else
  log "syncing $REPO_DIR: ${current:0:7} -> ${target:0:7}"
  git -C "$REPO_DIR" reset --hard --quiet "$target" || die "git reset failed"
  git_moved=1
fi

# ── 3. pull, and decide whether anything actually changed ────────────────────
# Compare resolved registry digests rather than trusting `:latest` to have moved:
# this is what makes a quiet tick genuinely a no-op.
digests() {
  local img d
  while read -r img; do
    [[ -n "$img" ]] || continue
    d="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}<local>{{end}}' "$img" 2>/dev/null || echo '<missing>')"
    printf '%s %s\n' "$img" "$d"
  done < <(compose config --images | sort -u)
}

before="$(digests)"
if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: would run 'docker compose pull' in $COMPOSE_DIR"
  exit 0
fi
log "pulling images in $COMPOSE_DIR"
compose pull --quiet || die "docker compose pull failed"
after="$(digests)"

changed="$(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep '^>' | awk '{print $1}' || true)"
if [[ -z "$changed" && "$git_moved" == "0" && "$FORCE" == "0" ]]; then
  log "up to date at ${current:0:7} — nothing to deploy"
  exit 0
fi
[[ -n "$changed" ]] && log "new images: $(printf '%s ' $changed)"

# ── 4. deploy ────────────────────────────────────────────────────────────────
up_args=(up -d)
[[ "$REMOVE_ORPHANS" == "1" ]] && up_args+=(--remove-orphans)
compose "${up_args[@]}" || die "docker compose up failed — the stack may be half-updated"

# ── 5. verify, then record ───────────────────────────────────────────────────
# Give containers a moment to fail their first start before judging them.
sleep 15
bad="$(compose ps --all --format json | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)
# Compose emits either a JSON array or one object per line depending on version.
try:
    rows = json.loads(raw)
    if isinstance(rows, dict):
        rows = [rows]
except json.JSONDecodeError:
    rows = [json.loads(l) for l in raw.splitlines() if l.strip()]
for r in rows:
    state, health = r.get("State", ""), (r.get("Health") or "")
    if state != "running" or health == "unhealthy":
        print("%s (%s%s)" % (r.get("Service", "?"), state, "/" + health if health else ""))
')"

if [[ -n "$bad" ]]; then
  log "DEPLOY UNHEALTHY at ${target:0:7} — these services are not running:"
  printf '%s\n' "$bad" | sed 's/^/    /' >&2
  log "logs: cd $COMPOSE_DIR && docker compose logs --tail=100 <service>"
  # Deliberately do NOT record state: the next tick retries. Rolling back
  # automatically isn't possible while compose pins `:latest`; to pin a known
  # good build by hand, every image also carries a `sha-<short>` tag.
  exit 1
fi

[[ "$PRUNE" == "1" ]] && docker image prune -f >/dev/null 2>&1 || true

{
  echo "deployed_commit=$target"
  echo "deployed_at=$(date -u +%FT%TZ)"
  echo "compose_dir=$COMPOSE_DIR"
  echo "# resolved image digests"
  printf '%s\n' "$after" | sed 's/^/# /'
} > "$STATE_FILE"

log "deployed ${target:0:7} — $(compose ps -q | wc -l) containers running"
