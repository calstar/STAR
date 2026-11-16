#!/bin/bash
# Area "config", the halves ctest does not run: the TypeScript loaders (npx tsx from
# diablo_server/backend) and the Python config readers. The C++ half is the ctest
# characterization_config_cpp. Hermetic: reads files, writes only to a temp dir.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fail=0
bash "$HERE/check.sh" ts || fail=1
bash "$HERE/check.sh" py || fail=1
exit "$fail"
