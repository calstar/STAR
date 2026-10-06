#!/bin/bash
# Integration test: stacklight_service -> UDP packets reach the "board" with the right lights.
# Uses --force-state so no Elodin/sim is needed. Usage: bash daq-server/test/test_stacklight.sh
BIN="${STACKLIGHT_BIN:-$(dirname "$0")/../build/bin/stacklight_service}"
PORT=5099
FAILS=0

[ -x "$BIN" ] || { echo "FAIL: $BIN not found (build first, or set STACKLIGHT_BIN)"; exit 1; }

# check_state <name> <state number> <expected lights: red,yellow,green,buzzer>
check_state() {
    local name="$1" num="$2" expected="$3"
    "$BIN" --force-state "$num" --config /dev/null \
           --target-ip 127.0.0.1 --target-port $PORT --interval-ms 200 >/dev/null 2>&1 &
    local svc=$!
    python3 - "$PORT" "$name" "$expected" <<'PY'
import socket, sys
port, name, expected = int(sys.argv[1]), sys.argv[2], sys.argv[3]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", port))
s.settimeout(5)
try:
    data, _ = s.recvfrom(256)
except socket.timeout:
    print(f"FAIL {name}: no packet received within 5s"); sys.exit(1)
if len(data) != 10 or data[0] != 14:
    print(f"FAIL {name}: bad packet (len={len(data)}, type={data[0] if data else None}): {data.hex()}"); sys.exit(1)
got = ",".join(str(b) for b in data[6:])
if got != expected:
    print(f"FAIL {name}: lights (red,yellow,green,buzzer) = {got}, expected {expected}"); sys.exit(1)
print(f"PASS {name}: lights = {got}")
PY
    local rc=$?
    kill $svc 2>/dev/null
    wait $svc 2>/dev/null
    [ $rc -eq 0 ] || FAILS=$((FAILS + 1))
}

#            name              state  red,yellow,green,buzzer
check_state  IDLE                 1   0,0,1,0
check_state  DEBUG                0   0,1,0,0
check_state  CALIBRATE           14   0,1,0,0
check_state  VENT                13   0,1,0,0
check_state  ARMED                2   1,1,0,0
check_state  READY               15   1,1,0,0
check_state  PRESS_STANDBY       20   1,1,0,0
check_state  FUEL_FILL            3   1,0,0,0
check_state  GN2_HIGH_PRESS      11   1,0,0,0
check_state  FIRE                16   1,0,0,1
check_state  ENGINE_ABORT        17   1,0,0,1
check_state  GSE_ABORT           18   1,0,0,1
check_state  EMERGENCY_ABORT     19   1,0,0,1
check_state  UNKNOWN            255   1,1,1,1

if [ $FAILS -eq 0 ]; then
    echo "ALL STACKLIGHT TESTS PASSED"
    exit 0
else
    echo "$FAILS STACKLIGHT TEST(S) FAILED"
    exit 1
fi
