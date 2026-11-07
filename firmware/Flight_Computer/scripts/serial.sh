#!/usr/bin/env bash
# Serial monitor over the ST-Link (RTT): shows what the bench build prints.
#
#   pio run -e bench -t upload      # once: a bench firmware (or bench_rx/_tx)
#   scripts/serial.sh               # Ctrl-C to stop
#
# OpenOCD finds the firmware's RTT buffer (_SEGGER_RTT) and serves it on TCP
# port 9090; this script shows that port. Any serial monitor can attach to
# it instead: pio device monitor --port socket://localhost:9090
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-9090}"
OCD_DIR="$HOME/.platformio/packages/tool-openocd"
# Any bench build (bench, bench_rx, bench_tx): OpenOCD searches all of DTCM
# (128 KB at 0x20000000, where .bss lives) for the "SEGGER RTT" tag, so the
# script does not depend on which build is on the board.
ADDR=0x20000000
SIZE=0x20000

"$OCD_DIR/bin/openocd" -s "$OCD_DIR/openocd/scripts" \
  -f interface/stlink.cfg -f target/stm32h7x.cfg \
  -c "init" -c "rtt setup $ADDR $SIZE \"SEGGER RTT\"" -c "rtt start" \
  -c "rtt server start $PORT 0" >/tmp/star_serial_openocd.log 2>&1 &
OCD=$!
trap 'kill $OCD 2>/dev/null' EXIT
echo "-- connecting to the board over the ST-Link (RTT, localhost:$PORT) --"
python3 -u -c '
import socket, sys, time
# OpenOCD needs a few seconds to find the buffer in DTCM: keep trying.
for _ in range(40):
    try:
        s = socket.create_connection(("localhost", int(sys.argv[1])))
        break
    except OSError:
        time.sleep(0.5)
else:
    sys.exit("no RTT server: is the ST-Link plugged in and the board on? "
             "See /tmp/star_serial_openocd.log")
print("-- connected (Ctrl-C to stop) --", flush=True)
while True:
    d = s.recv(4096)
    if not d:
        break
    sys.stdout.write(d.decode(errors="replace"))
' "$PORT"
