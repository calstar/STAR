#!/usr/bin/env python3
"""
LC-GUI — test GUI for the STAR **Load Cell (LC)** board.

This whole file is just the board's profile plus one launch() call. Everything
else lives in the shared ``boardgui`` framework (one directory up), so making a
GUI for another board is a copy-paste-and-edit of this file.

What it shows / does (acting as the ground DAQ *server*):
  * top-left: which board/port is connected, with a green "Connected" light
    that lights when the board's 1 Hz heartbeats are arriving
  * board state machine (Setup / Active / Standalone Abort / Self-Test),
    engine state, firmware hash, heartbeat rate
  * Ethernet/packet health: totals, rates, per-type counts, malformed count
  * per-connector live load-cell readings (raw ADC code + voltage) and a plot
  * self-test (ADC + per-connector continuity) results
  * controls to send SERVER_HEARTBEAT, SENSOR_CONFIG (activates streaming),
    ABORT / CLEAR_ABORT / NO_CONNECTION_ABORT

Facts baked in below come from:
  * firmware/Hotfire_Code/LC_Hotfire/src/main.cpp   (ADC1 connectors 1,2,3,6,7)
  * daq-server/config/config.toml  [boards.lc_board] (id 41, ip .41, ref VDD)

Run:
    python3.11 lc_gui.py                 # LC board #1 (id 41, 192.168.2.41)
    python3.11 lc_gui.py --board-ip 192.168.2.42 --board-id 42   # LC board #2
"""

from __future__ import annotations

import os
import sys

# Make the shared framework importable whether run from this dir or elsewhere,
# without needing `pip install` of the framework itself.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from boardgui import BoardProfile          # noqa: E402
from boardgui.launch import launch         # noqa: E402


def lc_profile() -> BoardProfile:
    return BoardProfile(
        board_type="LC",
        title="LC Load Cell Board",
        # NOTE: the current LC firmware ships with the default BOARD_ID (21) — no
        # -DBOARD_ID=41 in its build — so the real board reports id 21 and takes
        # 192.168.2.21. The DAQ config *intends* LC to be 41; change these back to
        # 41 / 192.168.2.41 once the firmware adds -DBOARD_ID=41. You can also just
        # edit the Board IP field in the GUI, or pass --board-ip / --board-id.
        board_id=21,                 # board's reported id (IP low octet)
        board_ip="192.168.2.21",     # firmware static-fallback IP = 192.168.2.<id>
        server_ip="192.168.2.20",    # firmware sends heartbeats/data here (this PC)
        listen_port=5006,            # we receive board packets here
        control_port=5005,           # board listens here for our control packets
        # LC ADC1 differential connectors wired in firmware: {1,2,3,6,7}
        all_connectors=[1, 2, 3, 6, 7],
        # active_connectors from config.toml [boards.lc_board]
        active_connectors=[1, 2, 3],
        connector_labels={
            1: "Load Cell 1",
            2: "Load Cell 2",
            3: "Load Cell 3",
            6: "Load Cell 6",
            7: "Load Cell 7",
        },
        reading_name="Load-cell voltage",
        value_unit="V",
        reference_voltage=1,         # VDD (ratiometric) per config.toml
        necessary_for_abort=False,   # LC is not abort-critical
        enable_serial_printing=True,
    )


if __name__ == "__main__":
    raise SystemExit(launch(lc_profile()))
