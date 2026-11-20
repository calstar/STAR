#!/bin/bash
# WP3's include guard (LEDGER D71, D83, D96): the vendored Elodin header under
# diablo_server/lib/third_party/elodin is SYSTEM on fsw_daq_lib, so its gcc-12/clang-18 warnings
# stay out of the build, and PRIVATE to it, so daq_bridge_main.cpp.o compiles without it. Ninja
# writes `-isystem <path>` with a space; the space-less form matches nothing. Skips while the
# directory is not in the tree (WP3 not merged), fails if ninja cannot resolve either target.
#
#   bash test/characterization/include_guard.sh <build-dir>     # a Ninja build of this tree
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BUILD="${1:?usage: include_guard.sh <build-dir>}"
if [ ! -d "$ROOT/diablo_server/lib/third_party/elodin" ]; then
  echo "include guard: diablo_server/lib/third_party/elodin is not in this tree (pre-WP3); skipped"
  exit 0
fi
pat='isystem *[^ ]*third_party/elodin'
BRIDGE_OBJ=diablo_server/daq_bridge/CMakeFiles/daq_bridge.dir/daq_bridge_main.cpp.o
lib_cmds="$(ninja -C "$BUILD" -t commands fsw_daq_lib 2>&1)" ||
  { echo "include guard: ninja cannot resolve fsw_daq_lib in $BUILD: $lib_cmds"; exit 1; }
bridge_cmds="$(ninja -C "$BUILD" -t commands -s "$BRIDGE_OBJ" 2>&1)" ||
  { echo "include guard: ninja cannot resolve $BRIDGE_OBJ in $BUILD: $bridge_cmds"; exit 1; }
lib="$(grep -c "$pat" <<< "$lib_cmds")"
bridge="$(grep -c "$pat" <<< "$bridge_cmds")"
echo "include guard: -isystem …/third_party/elodin on fsw_daq_lib $lib time(s) (need >= 1), on daq_bridge_main.cpp.o $bridge (need 0)"
if [ "$lib" -ge 1 ] && [ "$bridge" -eq 0 ]; then echo "include guard: ok"; else echo "include guard: FAIL"; exit 1; fi
