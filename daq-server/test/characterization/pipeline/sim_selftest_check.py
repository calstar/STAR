#!/usr/bin/env python3
"""The simulator's SELF_TEST packet, byte for byte, with and without --fail-connector.

    sim_selftest_check.py            # exit 0 when both hold, 1 with the first difference printed

LEDGER D48(1): a harness-only flag may be added to sim/board_simulator.py only if it defaults off
and lands with a test that the default output is byte-identical. The expected bytes below are
written out by hand from the wire format main's simulator and firmware share
(SensorHotfireCore.h: header(6) + adc_good(1) + num_sensors(1) + N x (sensor_id(1) + result(1))),
not computed from the module, so a change to the default encoding is a difference here, not a
new baseline. The header's millis field is pinned through _board_ms; nothing is bound or sent.

Checked:
  1. a board built as every existing launch builds it (no fail_connectors) sends exactly main's
     packet for board 21, connectors 1..10: all results 1, adc_good 1;
  2. the same board with fail_connectors={3} sends a packet that differs in exactly one byte, the
     result of connector 3 (1 -> 0); adc_good and every other result stay 1;
  3. a connector that is not active is ignored (fail_connectors={11}: default bytes).
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.join(HERE, "..", "..", "..", "sim", "board_simulator.py")

spec = importlib.util.spec_from_file_location("board_simulator", SIM)
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)

BOARD = {
    "type": "PT",
    "board_id": 21,
    "ip": "127.0.0.1",
    "active_connectors": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "pt_type": "ratiometric",
}
TS = 0x11223344  # the pinned board clock

# main's packet: type 12, version 0, millis 0x11223344 little-endian, adc_good 1, 10 sensors,
# then (sensor_id, 1) for connectors 1..10.
EXPECTED_DEFAULT = bytes.fromhex(
    "0c00"
    "44332211"
    "010a"
    "0101"
    "0201"
    "0301"
    "0401"
    "0501"
    "0601"
    "0701"
    "0801"
    "0901"
    "0a01"
)
# --fail-connector 21:3: only connector 3's result byte changes.
EXPECTED_FAIL_3 = bytes.fromhex(
    "0c00"
    "44332211"
    "010a"
    "0101"
    "0201"
    "0300"
    "0401"
    "0501"
    "0601"
    "0701"
    "0801"
    "0901"
    "0a01"
)


class FakeSock:
    def __init__(self):
        self.sent = []

    def sendto(self, data, addr):
        self.sent.append((bytes(data), addr))


def packet(**kw):
    board = bs.SimulatedBoard("pt_board", BOARD, "127.0.0.1", 26402, **kw)
    board.sock = FakeSock()
    board._board_ms = lambda now: TS
    board._send_self_test()
    assert len(board.sock.sent) == 1, board.sock.sent
    data, addr = board.sock.sent[0]
    assert addr == ("127.0.0.1", 26402), addr
    return data


def main():
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}:\n  got  {got.hex()}\n  want {want.hex()}")

    default = packet()
    check("default (no fail_connectors)", default, EXPECTED_DEFAULT)
    check(
        "default (fail_connectors=None)", packet(fail_connectors=None), EXPECTED_DEFAULT
    )
    check("inactive connector ignored", packet(fail_connectors={11}), EXPECTED_DEFAULT)
    failed = packet(fail_connectors={3})
    check("--fail-connector 21:3", failed, EXPECTED_FAIL_3)
    diff = [i for i, (a, b) in enumerate(zip(default, failed)) if a != b]
    if len(default) != len(failed) or diff != [13]:
        failures.append(
            f"the flag must change exactly one byte (connector 3's result at offset 13);"
            f" differing offsets: {diff}, lengths {len(default)} / {len(failed)}"
        )
    if failures:
        print("sim_selftest_check: FAIL\n" + "\n".join(failures), file=sys.stderr)
        return 1
    print(
        "sim_selftest_check: ok (default SELF_TEST bytes identical to main's; "
        "--fail-connector changes one result byte)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
