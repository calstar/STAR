#!/bin/sh
# Host tests for the SD NAND backup log: C (ASan/UBSan, -Werror) then Python.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
FC="$HERE/../Flight_Computer/src"
OUT="${TMPDIR:-/tmp}/sdlog_test"
mkdir -p "$OUT"
cc -std=c11 -g -Wall -Wextra -Wpedantic -Werror -fsanitize=address,undefined \
   -fno-omit-frame-pointer -I"$HERE" -I"$FC/app" -I"$FC/chips" \
   "$HERE/test_sdlog.c" "$HERE/sdlog_core.c" "$HERE/dev_sdnand.c" \
   "$FC/app/emmc_log.c" "$FC/app/flight_state.c" "$FC/chips/sd_spi.c" \
   -o "$OUT/test_sdlog"
"$OUT/test_sdlog" "$OUT/e2e.bin"
cd "$HERE" && SDLOG_E2E_IMAGE="$OUT/e2e.bin" python3 -m unittest test_sdlog_read
