#!/usr/bin/env bash
# Serial monitor over the ST-Link (RTT): shows what the bench build prints.
#
#   pio run -e bench -t upload      # once: the bench firmware
#   scripts/serial.sh               # Ctrl-C to stop
#
# OpenOCD finds the firmware's RTT buffer (_SEGGER_RTT) and serves it on TCP
# port 9090; this script shows that port. Any serial monitor can attach to
# it instead: pio device monitor --port socket://localhost:9090
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ELF="$HERE/.pio/build/bench/firmware.elf"
PORT="${PORT:-9090}"
OCD_DIR="$HOME/.platformio/packages/tool-openocd"
NM="$(ls "$HOME"/.platformio/packages/toolchain-gccarmnoneeabi*/bin/arm-none-eabi-nm | head -1)"

[ -f "$ELF" ] || { echo "no bench build: pio run -e bench -t upload"; exit 1; }
ADDR="0x$("$NM" "$ELF" | awk '$3 == "_SEGGER_RTT" {print $1}')"
[ "$ADDR" != "0x" ] || { echo "_SEGGER_RTT not in $ELF"; exit 1; }

"$OCD_DIR/bin/openocd" -s "$OCD_DIR/openocd/scripts" \
  -f interface/stlink.cfg -f target/stm32h7x.cfg \
  -c "init" -c "rtt setup $ADDR 64 \"SEGGER RTT\"" -c "rtt start" \
  -c "rtt server start $PORT 0" >/tmp/star_serial_openocd.log 2>&1 &
OCD=$!
trap 'kill $OCD 2>/dev/null' EXIT
sleep 2
echo "-- RTT on localhost:$PORT (Ctrl-C to stop) --"
python3 -u -c '
import socket, sys
s = socket.create_connection(("localhost", int(sys.argv[1])))
while True:
    d = s.recv(4096)
    if not d:
        break
    sys.stdout.write(d.decode(errors="replace"))
' "$PORT"
