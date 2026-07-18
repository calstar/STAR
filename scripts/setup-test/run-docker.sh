#!/usr/bin/env bash
# run-docker.sh — test setup.sh in a clean Ubuntu container.
#
# Usage: bash scripts/setup-test/run-docker.sh <project>
#   project: pid-designer | engine-design | firmware | daq-server | all
#
# What it does:
#   1. Builds the ubuntu:24.04 test image (cached).
#   2. rsyncs the working tree into the container (excludes .venv, node_modules,
#      build/ — we want to test a fresh install, not reuse local artifacts).
#   3. Runs `bash setup.sh --<project> --yes` inside the container.
#   4. Runs the per-project smoke check from scripts/setup-test/smoke/.
#
# Flags:
#   --keep       Don't remove the container on exit (useful for poking around).
#   --shell      Drop into a shell after setup + smoke complete.
#   --no-cache   Force full image rebuild.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="star-setup-test"

PROJECT=""
KEEP=0
SHELL_AFTER=0
NO_CACHE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --shell) SHELL_AFTER=1 ;;
    --no-cache) NO_CACHE=1 ;;
    -h|--help)
      awk '/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      if [ -z "$PROJECT" ]; then PROJECT="$1"
      else echo "Unexpected arg: $1" >&2; exit 1
      fi
      ;;
  esac
  shift
done

if [ -z "$PROJECT" ]; then
  echo "Usage: $0 <pid-designer|engine-design|firmware|daq-server|all>" >&2
  exit 1
fi

case "$PROJECT" in
  pid-designer|engine-design|firmware|daq-server|all) ;;
  *) echo "Unknown project: $PROJECT" >&2; exit 1 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — install Docker Desktop or docker-ce first." >&2
  exit 1
fi

echo "── Building test image ($IMAGE)"
BUILD_ARGS=()
[ "$NO_CACHE" = "1" ] && BUILD_ARGS+=("--no-cache")
docker build "${BUILD_ARGS[@]}" -t "$IMAGE" "$SCRIPT_DIR"

RM_FLAG="--rm"
[ "$KEEP" = "1" ] && RM_FLAG=""

# Build the in-container command. We rsync into /home/tester/STAR (excluding
# host build artifacts so we don't accidentally pass a "green" test that just
# reused the host's .venv), then run setup + smoke.
SETUP_INVOCATION="bash setup.sh --$PROJECT --yes"
SMOKE_INVOCATION="bash scripts/setup-test/smoke/$PROJECT.sh"

IN_CONTAINER=$(cat <<EOF
set -euo pipefail
echo "── Copying repo into container (excluding build artifacts)"
rsync -a \\
  --exclude='.venv' \\
  --exclude='node_modules' \\
  --exclude='build/' \\
  --exclude='**/build/' \\
  --exclude='.next' \\
  --exclude='dist' \\
  --exclude='*.pyc' \\
  --exclude='__pycache__' \\
  /repo/ /home/tester/STAR/
cd /home/tester/STAR

echo "── Running setup"
$SETUP_INVOCATION

echo "── Running smoke check(s)"
$SMOKE_INVOCATION

echo ""
echo "✓ setup + smoke passed for: $PROJECT"
EOF
)

if [ "$SHELL_AFTER" = "1" ]; then
  IN_CONTAINER="$IN_CONTAINER"$'\n''echo ""; echo "Dropping into shell. Ctrl-D to exit."; exec bash'
fi

echo "── Running container"
# Only pass -it when we actually have a TTY (interactive terminal). CI or
# tool-driven runs without a tty would fail on `-it` with "cannot attach stdin
# to a TTY-enabled container". --shell requires interactive by definition.
TTY_FLAGS=()
if [ -t 0 ] && [ -t 1 ]; then
  TTY_FLAGS+=("-it")
elif [ "$SHELL_AFTER" = "1" ]; then
  echo "  ✗ --shell requires a TTY" >&2
  exit 1
fi

# shellcheck disable=SC2086
docker run $RM_FLAG "${TTY_FLAGS[@]}" \
  -v "$REPO_ROOT:/repo:ro" \
  "$IMAGE" \
  bash -c "$IN_CONTAINER"
