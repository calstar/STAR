#!/bin/bash
# Area "config", the halves ctest does not run: the TypeScript loaders (npx tsx from
# diablo_server/backend), the Python config readers, and the services that parse config in their
# own main, observed black-box (their logs and the datagrams they send). The C++ library half is
# the ctest characterization_config_cpp. The black-box half starts service binaries and binds
# 127.0.0.1 UDP listeners, so it runs under the stack lock (re-entrant when the caller holds it).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../../.." && pwd -P)"
BUILD="${CHAR_BUILD_DIR:-}"
if [ -z "$BUILD" ]; then
  for b in "$ROOT/build-gate" "$ROOT/build"; do
    [ -x "$b/bin/daq_bridge" ] && BUILD="$b" && break
  done
fi
fail=0
bash "$HERE/check.sh" ts || fail=1
bash "$HERE/check.sh" py || fail=1
if [ -z "$BUILD" ]; then
  echo "config/bin: no build dir with service binaries; run scripts/build.sh first"
  fail=1
else
  bash "$HERE/../with_stack_lock.sh" bash "$HERE/check.sh" bin "$BUILD/bin" || fail=1
fi
exit "$fail"
