#!/usr/bin/env python3
"""
Actuator-GUI — test GUI for the STAR **Actuator** board.

This whole file is just the board's profile plus one launch() call. Everything
else lives in the shared ``boardgui`` framework (one directory up), so making a
GUI for another board is a copy-paste-and-edit of this file.

What it shows / does (acting as the ground DAQ *server*):
  * top-left: which board/port is connected, with a green "Connected" light
    that lights when the board's 1 Hz heartbeats are arriving
  * board state machine (Setup / Active / the abort states), engine state,
    firmware hash, heartbeat rate
  * Ethernet/packet health: totals, rates, per-type counts, malformed count
  * per-actuator live current-sense readings (float volts) and a plot
  * controls to send SERVER_HEARTBEAT, ACTUATOR_CONFIG (activates streaming),
    per-actuator ON/OFF ACTUATOR_COMMANDs, PWM_ACTUATOR_COMMAND,
    ABORT / CLEAR_ABORT / NO_CONNECTION_ABORT

Facts baked in below come from:
  * firmware/Hotfire_Code/Actuator_Hotfire/src/main.cpp  (10 actuators,
    current-sense streamed as IEEE-754 float volts at 10 Hz)
  * daq-server/config/config.toml  [boards.actuator_board] (id 11, ip .11)

Run:
    python3.11 actuator_gui.py                # actuator board #1
    python3.11 actuator_gui.py --board-ip 192.168.2.12 --board-id 12  # board #2
"""

from __future__ import annotations

import os
import sys

# Make the shared framework importable whether run from this dir or elsewhere,
# without needing `pip install` of the framework itself.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from boardgui import BoardProfile          # noqa: E402
from boardgui.launch import launch         # noqa: E402


def actuator_profile() -> BoardProfile:
    return BoardProfile(
        board_type="ACT",
        title="Actuator Board",
        kind="actuator",
        # NOTE: the current actuator firmware ships with the default BOARD_ID
        # (21) — no -DBOARD_ID=11 in its build — so the real board reports id 21
        # and statically falls back to 192.168.2.21. The DAQ config *intends*
        # actuator #1 to be 11 / 192.168.2.11; change these back once the
        # firmware adds -DBOARD_ID=11. With zeroconf the GUI auto-discovers the
        # board's real address anyway; you can also edit the Board IP field or
        # pass --board-ip / --board-id.
        board_id=21,                 # board's reported id (IP low octet)
        board_ip="192.168.2.21",     # firmware static-fallback IP = 192.168.2.<id>
        server_ip="192.168.2.20",    # firmware sends heartbeats/data here (this PC)
        listen_port=5006,            # we receive board packets here
        control_port=5005,           # board listens here for our control packets
        # 10 actuator channels, each with a current-sense ADC input
        all_connectors=list(range(1, 11)),
        connector_labels={i: f"Actuator {i}" for i in range(1, 11)},
        reading_name="Current sense",
        value_unit="V",
        # firmware sends analogRead volts as IEEE-754 float bits, not ADC codes
        value_encoding="float",
        necessary_for_abort=False,
        enable_serial_printing=True,
        # ACTUATOR_CONFIG defaults: not the abort controller; vent/abort states
        # all 0 (off) — the safe bench-test choice. Flip entries to 1 to
        # exercise the abort path, e.g. abort_vent_states={1: 1, 2: 1}.
        is_abort_controller=False,
        abort_vent_states={},
        abort_abort_states={},
    )


if __name__ == "__main__":
    raise SystemExit(launch(actuator_profile()))
