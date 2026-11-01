#!/usr/bin/env bash
# Synthesize and place-and-route a top for the flight part (LFE5U-25F-7TG144C)
# with the open-source flow, and report utilisation and Fmax against the
# 27.428571 MHz sample clock (36.46 ns).
#
#   ./synth.sh [top]      default top: dvbt_modulator
#
# No pin constraints yet (the board isn't drawn), so nextpnr places IO
# freely; the numbers are for sizing, not a bitstream to load.
#
# Package: the design doc picks the TQFP144, but Ubuntu's Project Trellis
# database (the open flow's pin data) only carries CABGA256/381 and CSFBGA285
# for this die. Logic, block RAM and timing are the die's, so CABGA256 sizes
# it correctly; check TQFP144 support before committing the board to it.
set -euo pipefail
cd "$(dirname "$0")"
TOP=${1:-dvbt_modulator}
OUT=build/$TOP
mkdir -p "$OUT"

yosys -q -l "$OUT/yosys.log" -p "read_verilog -DDVBT_ROM_DIR=\"rtl/rom\" rtl/*.v; synth_ecp5 -top $TOP -json $OUT/$TOP.json; tee -o $OUT/stat.txt stat"
nextpnr-ecp5 --25k --package CABGA256 --speed 7 --json "$OUT/$TOP.json" \
    --freq 27.43 --report "$OUT/report.json" --log "$OUT/nextpnr.log" -q
grep -E "Info: (Max frequency|\s+(TRELLIS_COMB|TRELLIS_FF|DP16KD|MULT18X18D|TRELLIS_IO|TRELLIS_RAMW)):" "$OUT/nextpnr.log" | sed 's/^Info: *//'
