#!/usr/bin/env bash
# Regenerate tests/golden/*.json from OpenRocket 24.12 itself.
#   OPENROCKET_JAR=/path/OpenRocket-24.12.jar tools/oracle/run.sh [file.ork ...]
# With no files, runs every tests/rockets/*.ork. Needs a JDK 17+.
# GOLDEN_DIR (default tests/golden) is where the JSON goes; the aerodynamics
# test-bed is  GOLDEN_DIR=tests/golden_aero tools/oracle/run.sh tests/rockets_aero/*.ork
# The jar: https://github.com/openrocket/openrocket/releases/download/release-24.12/OpenRocket-24.12.jar
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
jar="${OPENROCKET_JAR:?set OPENROCKET_JAR to OpenRocket-24.12.jar}"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
javac -d "$build" -cp "$jar" "$here/Oracle.java"
if [ $# -eq 0 ]; then set -- "$root"/tests/rockets/*.ork; fi
for f in "$@"; do
  out="${GOLDEN_DIR:-$root/tests/golden}/$(basename "$f" .ork).json"
  # OpenRocket logs to stdout; the document is the one line that starts with '{'.
  if java -Djava.awt.headless=true -cp "$jar:$build" Oracle "$f" 2>/dev/null | grep '^{' > "$out.tmp" && [ -s "$out.tmp" ]; then
    mv "$out.tmp" "$out"; echo "ok   $(basename "$f")"
  else
    rm -f "$out.tmp"; echo "FAIL $(basename "$f")"
  fi
done
