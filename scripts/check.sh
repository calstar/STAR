#!/usr/bin/env bash
# Every gate CI runs on the feed system, run here, the same way.
#
#   scripts/check.sh          fast tier: everything but tests marked `slow` (~3 min)
#   scripts/check.sh full     everything, slow tests and the Layer X parity test included
#
# Mirrors the gates of .github/workflows/feed-twin-ci.yml: black, mypy --strict,
# pytest for lib/feedtwin and feed-twin, the backend import, the physics benchmark
# CLAUDE.md asks for after every physics change (a skipped tier fails it, as in
# CI), the frontend build, unit tests and Playwright e2e. What it cannot run here
# it prints as a SKIP row saying why -- the e2e without Playwright's Chromium, the
# full tier's Layer X parity test without EngineDesign/.venv -- and two CI jobs it
# never runs are listed as CI only (engine-design-compat's pip check and dual
# import in a fresh EngineDesign environment; the Docker image builds). So a green
# summary with no SKIP rows is a green CI, less those two. CI runs the library on
# Python 3.12 and the app on 3.11; a local run on another version is said so up
# front, because four gates have broken on that gap alone before.
#
# Exit status is non-zero if any gate failed; a summary table is printed last.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TIER=${1:-fast}
MARK=()
if [ "$TIER" != "full" ]; then
  MARK=(-m "not slow")
fi

PY=${PYTHON:-python3}
version=$($PY -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
case "$version" in
  3.11|3.12) ;;
  *) echo "warning: Python $version; CI runs 3.11 (app) and 3.12 (library)." ;;
esac

results=()
failed=0
gate() {
  local name=$1; shift
  local started=$SECONDS
  echo
  echo "== $name"
  if "$@"; then
    results+=("PASS  $(printf '%4ds' $((SECONDS - started)))  $name")
  else
    results+=("FAIL  $(printf '%4ds' $((SECONDS - started)))  $name")
    failed=1
  fi
}

# CI formats with the black lib/feedtwin/pyproject.toml pins. Another version
# disagrees about a few files and fails this gate on formatting alone; point
# BLACK at the pinned one (pip install black==<pin> into a venv) to match CI.
BLACK=${BLACK:-$PY -m black}
pinned=$(grep -o 'black==[0-9.]*' lib/feedtwin/pyproject.toml | head -1 | cut -d= -f3)
have=$($BLACK --version 2>/dev/null | head -1 | grep -o '[0-9][0-9.]*' | head -1)
if [ -n "$pinned" ] && [ "$have" != "$pinned" ]; then
  echo "warning: black $have here; CI pins $pinned. Set BLACK to a black==$pinned to match CI."
fi
gate "lib: black"   $BLACK --check lib/feedtwin
gate "lib: mypy"    bash -c "cd lib/feedtwin && $PY -m mypy"
# ${MARK[@]+...}: an empty array is "unbound" to macOS's bash 3.2 under set -u,
# which killed the full tier on its first gate.
# Across cores when pytest-xdist is installed (it is in lib/feedtwin's dev extra).
PAR=""
if $PY -c "import xdist" 2>/dev/null; then PAR="-n auto"; fi
gate "lib: pytest"  $PY -m pytest lib/feedtwin/tests -q -p no:cacheprovider $PAR ${MARK[@]+"${MARK[@]}"}
if [ -n "$PAR" ]; then
  gate "lib: timing" $PY -m pytest lib/feedtwin/tests/test_props_performance.py -q -p no:cacheprovider
fi
gate "app: imports" bash -c "cd feed-twin && $PY -c 'import backend.main'"
gate "app: black"   bash -c "cd feed-twin && $BLACK --check backend tests"
gate "app: mypy"    bash -c "cd feed-twin && $PY -m mypy backend --strict --ignore-missing-imports"
# The fast tier skips slow tests (the timing test is one). The full tier runs the
# wall-clock test on its own when the rest go across workers, as CI does.
APP_M="${MARK[@]+not slow}"
if [ -n "$PAR" ] && [ -z "$APP_M" ]; then APP_M="not timing"; fi
gate "app: pytest"  bash -c "cd feed-twin && $PY -m pytest tests -q -p no:cacheprovider $PAR ${APP_M:+-m '$APP_M'}"
if [ "$APP_M" = "not timing" ]; then
  gate "app: timing" bash -c "cd feed-twin && $PY -m pytest tests -q -p no:cacheprovider -m timing"
fi
# As CI runs it: a tier it skips (the steady fire, when the backend does not
# import or the library has no shipped engine) fails the gate.
BENCH_LOG=$(mktemp)
gate "physics benchmark" bash -c \
  "set -o pipefail; $PY scripts/physics_benchmark.py | tee '$BENCH_LOG' && ! grep -n '\\[SKIP\\]' '$BENCH_LOG'"
rm -f "$BENCH_LOG"
if command -v npm >/dev/null && [ -d feed-twin/frontend/node_modules ]; then
  gate "frontend: build" bash -c "cd feed-twin/frontend && npm run build --silent"
  gate "frontend: unit"  bash -c "cd feed-twin/frontend && npm test --silent"
  # CI's frontend-e2e job: the demo path in Chromium, on a stack the config
  # boots over a throwaway library. Only where Playwright's own Chromium is.
  if (cd feed-twin/frontend && node -e "
      const fs = require('fs'); const { chromium } = require('@playwright/test');
      process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);" 2>/dev/null); then
    gate "frontend: e2e" bash -c "cd feed-twin/frontend && npm run test:e2e --silent"
  else
    results+=("SKIP          frontend: e2e (no Playwright Chromium: npx playwright install chromium in feed-twin/frontend)")
  fi
else
  results+=("SKIP          frontend (run npm install in feed-twin/frontend)")
fi
if [ "$TIER" = "full" ]; then
  if [ -x EngineDesign/.venv/bin/python ]; then
    gate "Layer X <-> cockpit parity" bash -c \
      "cd EngineDesign && PYTHONPATH=../lib/stardesign .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_layerx_cockpit_parity.py"
  else
    results+=("SKIP          Layer X <-> cockpit parity (no EngineDesign/.venv: bash setup.sh --engine-design)")
  fi
fi
results+=("CI only       engine-design-compat (pip check + dual import, fresh EngineDesign env), Docker image builds")

echo
echo "== summary ($TIER tier, Python $version)"
printf '%s\n' "${results[@]}"
exit $failed
