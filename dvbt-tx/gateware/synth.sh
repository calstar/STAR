#!/usr/bin/env bash
# Synthesize and place-and-route a top for the flight part (LFE5U-25F-7TG144C)
# with the open-source flow, and report utilisation and Fmax against the
# 27.428571 MHz sample clock (36.46 ns).
#
#   ./synth.sh [top]      default top: dvbt_modulator
#
# Sub-blocks have no pin constraints, so nextpnr places IO freely; the
# numbers are for sizing.
#
# Package TQFP144: Ubuntu's nextpnr-ecp5/Project Trellis database lacks it
# for this die, so place-and-route uses YoWASP's build of upstream nextpnr
# (pip install yowasp-nextpnr-ecp5), which carries it.
#   NEXTPNR=nextpnr-ecp5 PACKAGE=CABGA256 ./synth.sh   # the Ubuntu tools
set -euo pipefail
cd "$(dirname "$0")"
TOP=${1:-dvbt_modulator}
OUT=build/$TOP
mkdir -p "$OUT"

yosys -q -l "$OUT/yosys.log" -p "read_verilog -DDVBT_ROM_DIR=\"rtl/rom\" rtl/*.v; synth_ecp5 -top $TOP -json $OUT/$TOP.json; tee -o $OUT/stat.txt stat"
${NEXTPNR:-yowasp-nextpnr-ecp5} --25k --package "${PACKAGE:-TQFP144}" --speed 7 --json "$OUT/$TOP.json" \
    --freq 27.43 --report "$OUT/report.json" --log "$OUT/nextpnr.log" -q
grep -E "Info: (Max frequency|\s+(TRELLIS_COMB|TRELLIS_FF|DP16KD|MULT18X18D|TRELLIS_IO|TRELLIS_RAMW)):" "$OUT/nextpnr.log" | sed 's/^Info: *//'
