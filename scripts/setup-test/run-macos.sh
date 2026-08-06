#!/usr/bin/env bash
# run-macos.sh — test setup.sh on native macOS in an isolated scratch dir.
#
# Usage: bash scripts/setup-test/run-macos.sh <project>
#   project: pid-designer | onshape-viewer | engine-design | firmware | daq-server | all
#
# What it does:
#   1. rsyncs the current working tree to $HOME/STAR-setup-test/ (scratch dir,
#      isolated from your real checkout so it doesn't pollute your .venv etc).
#   2. Runs `bash setup.sh --<project> --yes` in the scratch dir.
#   3. Runs the per-project smoke check.
#
# What it does NOT do:
#   - Test a truly fresh macOS. brew and Xcode CLT installed by prior setups
#     will still be there. That's fine — we're testing that setup.sh works
#     on a normal developer laptop, not a factory-fresh Mac.
#   - Uninstall anything. If you want to test a specific dep is installed
#     correctly, uninstall it manually first (e.g. `brew uninstall cmake`).
#
# Alternative: run inside Docker Desktop (`bash scripts/setup-test/run-docker.sh
# <project>`) — that tests the Linux path, but Docker Desktop on Mac uses a
# Linux VM under the hood, so it doesn't validate the macOS/Homebrew branches.
# Native run is the only way to catch macOS-specific bugs.
#
# Flags:
#   --scratch DIR   Use DIR instead of $HOME/STAR-setup-test
#   --keep          Don't prompt to remove existing scratch dir (assume yes).
#   -h, --help      Show help.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROJECT=""
SCRATCH="$HOME/STAR-setup-test"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scratch) SCRATCH="$2"; shift ;;
    --keep) KEEP=1 ;;
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
  echo "Usage: $0 <pid-designer|onshape-viewer|engine-design|firmware|daq-server|all>" >&2
  exit 1
fi

case "$PROJECT" in
  pid-designer|onshape-viewer|engine-design|firmware|daq-server|all) ;;
  *) echo "Unknown project: $PROJECT" >&2; exit 1 ;;
esac

# Sanity: are we actually on macOS? (Script also runs fine on Linux — it's
# just testing setup.sh in an isolated dir either way. Warn but don't fail.)
if [ "$(uname -s)" != "Darwin" ]; then
  echo "! Not running on macOS (uname: $(uname -s)) — you probably want run-docker.sh"
  echo "  Continuing anyway in 3s..."
  sleep 3
fi

if [ -d "$SCRATCH" ]; then
  if [ "$KEEP" = "1" ]; then
    echo "── Removing existing scratch dir: $SCRATCH"
    rm -rf "$SCRATCH"
  else
    printf "  Scratch dir exists at %s — remove and re-run? [y/N] " "$SCRATCH"
    read -r reply
    case "$reply" in
      [Yy]*) rm -rf "$SCRATCH" ;;
      *) echo "Aborted."; exit 1 ;;
    esac
  fi
fi

# Preflight: fail fast if there clearly isn't room, instead of dying halfway
# through the copy with a cryptic "No space left on device" and leaving a
# half-written scratch dir behind. We need roughly the source tree's size (minus
# the excluded artifacts, but a whole-tree estimate is a safe over-count). If
# free space is under 2x that, bail with a clear message.
NEED_KB="$(du -sk "$REPO_ROOT" 2>/dev/null | awk '{print $1}')"
FREE_KB="$(df -k "$(dirname "$SCRATCH")" | awk 'NR==2 {print $4}')"
if [ -n "$NEED_KB" ] && [ -n "$FREE_KB" ] && [ "$FREE_KB" -lt $((NEED_KB * 2)) ]; then
  echo "  ✗ Not enough free disk to copy the tree safely." >&2
  echo "    Need ~$((NEED_KB / 1024)) MB, have $((FREE_KB / 1024)) MB free at $(dirname "$SCRATCH")." >&2
  echo "    Free up space (e.g. 'rm -rf daq-server/.tmp' clears old test scratch) and re-run." >&2
  exit 1
fi

echo "── Copying working tree to scratch dir: $SCRATCH"
mkdir -p "$SCRATCH"
# Same excludes as run-docker.sh so both harnesses test the same "fresh" state.
# NOTE: daq-server/.tmp holds elodin integration-test scratch — sparse DB files
# whose *logical* size is multiple TB (only ~50M on disk). rsync without
# --sparse expands the holes into real zero-bytes and can fill the disk, so we
# both exclude it (it's gitignored — not part of a fresh clone) and pass -S.
rsync -aS \
  --exclude='.venv' \
  --exclude='node_modules' \
  --exclude='build/' \
  --exclude='**/build/' \
  --exclude='.tmp/' \
  --exclude='**/.tmp/' \
  --exclude='.next' \
  --exclude='dist' \
  --exclude='*.pyc' \
  --exclude='__pycache__' \
  "$REPO_ROOT/" "$SCRATCH/"

cd "$SCRATCH"

echo "── Running: bash setup.sh --$PROJECT --yes"
bash setup.sh --"$PROJECT" --yes
echo ""
echo "── smoke: $PROJECT"
bash scripts/setup-test/smoke/"$PROJECT".sh

echo ""
echo "✓ setup + smoke passed for: $PROJECT"
echo "  Scratch dir left at: $SCRATCH"
echo "  Remove with: rm -rf $SCRATCH"
