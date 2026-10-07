#!/usr/bin/env bash
# Every gate CI runs on the feed system, run here, the same way.
#
#   scripts/check.sh          fast tier: everything but tests marked `slow` (~3 min)
#   scripts/check.sh full     everything, slow tests and the Layer X parity test included
#
# Mirrors .github/workflows/feed-twin-ci.yml step for step (black, mypy --strict,
# pytest for lib/feedtwin and feed-twin, the frontend build and unit tests) plus
# the physics benchmark CLAUDE.md asks for after every physics change. CI runs the
# library on Python 3.12 and the app on 3.11; a local run on another version is
# said so up front, because four gates have broken on that gap alone before.
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
gate "lib: pytest"  $PY -m pytest lib/feedtwin/tests -q -p no:cacheprovider ${MARK[@]+"${MARK[@]}"}
gate "app: black"   bash -c "cd feed-twin && $BLACK --check backend tests"
gate "app: mypy"    bash -c "cd feed-twin && $PY -m mypy backend --strict --ignore-missing-imports"
gate "app: pytest"  bash -c "cd feed-twin && $PY -m pytest tests -q -p no:cacheprovider ${MARK[@]+-m 'not slow'}"
gate "physics benchmark" $PY scripts/physics_benchmark.py
if command -v npm >/dev/null && [ -d feed-twin/frontend/node_modules ]; then
  gate "frontend: build" bash -c "cd feed-twin/frontend && npm run build --silent"
  gate "frontend: unit"  bash -c "cd feed-twin/frontend && npm test --silent"
else
  results+=("SKIP          frontend (run npm install in feed-twin/frontend)")
fi
if [ "$TIER" = "full" ] && [ -x EngineDesign/.venv/bin/python ]; then
  gate "Layer X <-> cockpit parity" bash -c \
    "cd EngineDesign && PYTHONPATH=../lib/stardesign .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_layerx_cockpit_parity.py"
fi

echo
echo "== summary ($TIER tier, Python $version)"
printf '%s\n' "${results[@]}"
exit $failed
