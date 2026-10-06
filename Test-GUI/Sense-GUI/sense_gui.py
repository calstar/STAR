#!/usr/bin/env python3
"""
Sense-GUI — one test GUI for every STAR sense board: LC, PT, TC and RTD.

The four sense boards run the *same* firmware core
(`firmware/Hotfire_Code/common/SensorHotfireCore.h`), speak the same packets,
and differ only in how many connectors they have, what a reading means, and
which ADC reference they use. So they get one app, not four: pick the board
with `--board`.

    python sense_gui.py --board lc       # LC #1  (load cells)
    python sense_gui.py --board pt       # PT #1  (pressure transducers)
    python sense_gui.py --board tc       # TC #1  (thermocouples)
    python sense_gui.py --board rtd      # RTD #1 (RTDs)
    python sense_gui.py --list           # show every board it knows

Second boards of each type are `lc2`, `pt2`, `tc2`, `rtd2`. Anything in a
profile can still be overridden on the command line (`--board-ip`,
`--board-id`, …).

The facts below come from two places and nowhere else:
  * firmware  `firmware/Hotfire_Code/<BOARD>_Hotfire/src/main.cpp`
    (which connectors the board actually reads)
  * DAQ config `daq-server/config/config.toml` `[boards.*]`
    (board_id, ip, voltage_reference, active_connectors)

Actuator boards are a different animal — different config packet, different
controls — and keep their own app in `Actuator-GUI/`.
"""

from __future__ import annotations

import argparse
import os
import sys

# Make the shared framework importable whether run from this dir or elsewhere,
# without needing `pip install` of the framework itself.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from boardgui import BoardProfile          # noqa: E402
from boardgui.launch import launch         # noqa: E402

# --- what distinguishes each sense board ------------------------------------
# reference_voltage: 0 = internal 2.5 V, 1 = VDD/AVDD (ratiometric), 2 = 5 V
SENSE_BOARDS = {
    # key      type   id  wired connectors        active (config.toml)  ref  abort  reading name          unit
    "lc":  dict(type="LC",  id=41, wired=[1, 2, 3, 6, 7],          active=[1, 2, 3],                ref=1, abort=False,
                reading="Load-cell voltage", unit="V", label="Load Cell",
                project="firmware/Hotfire_Code/LC_Hotfire",
                note="ADC1 differential pairs only: connectors 1,2,3,6,7"),
    "lc2": dict(type="LC",  id=42, wired=[1, 2, 3, 6, 7],          active=[1, 2, 6],                ref=0, abort=False,
                reading="Load-cell voltage", unit="V", label="Load Cell",
                project="firmware/Hotfire_Code/LC_Hotfire"),
    "pt":  dict(type="PT",  id=21, wired=list(range(1, 11)),       active=list(range(1, 11)),       ref=1, abort=True,
                reading="Pressure voltage", unit="V", label="PT",
                project="firmware/Hotfire_Code/PT_Hotfire",
                note="abort-critical: a PT dropout can trigger a standalone abort"),
    "pt2": dict(type="PT",  id=22, wired=list(range(1, 11)),       active=[1, 2, 3, 4],             ref=0, abort=True,
                reading="Pressure voltage", unit="V", label="PT",
                project="firmware/Hotfire_Code/PT_Hotfire"),
    "tc":  dict(type="TC",  id=51, wired=list(range(1, 11)),       active=[2, 3, 4, 5],             ref=0, abort=False,
                reading="Thermocouple voltage", unit="V", label="TC",
                project="firmware/Hotfire_Code/TC_Hotfire"),
    "tc2": dict(type="TC",  id=52, wired=list(range(1, 11)),       active=[],                       ref=0, abort=False,
                reading="Thermocouple voltage", unit="V", label="TC",
                project="firmware/Hotfire_Code/TC_Hotfire"),
    "rtd": dict(type="RTD", id=31, wired=[1, 2, 3, 4],             active=[1, 2, 3, 4],             ref=0, abort=False,
                reading="RTD voltage", unit="V", label="RTD",
                project="firmware/Hotfire_Code/RTD_Hotfire",
                note="two ADS1263 chips: ADC1 does connectors 1-2, ADC2 does 3-4"),
    "rtd2": dict(type="RTD", id=32, wired=[1, 2, 3, 4],            active=[],                       ref=0, abort=False,
                 reading="RTD voltage", unit="V", label="RTD",
                 project="firmware/Hotfire_Code/RTD_Hotfire"),
}

TITLES = {
    "LC": "LC Load Cell Board",
    "PT": "PT Pressure Board",
    "TC": "TC Thermocouple Board",
    "RTD": "RTD Temperature Board",
}


def sense_profile(key: str) -> BoardProfile:
    """Build the profile for one sense board."""
    try:
        b = SENSE_BOARDS[key]
    except KeyError:
        raise SystemExit(
            f"unknown board {key!r}. Known: {', '.join(sorted(SENSE_BOARDS))}")

    suffix = " #2" if key.endswith("2") else ""
    return BoardProfile(
        board_type=b["type"],
        title=f"{TITLES[b['type']]}{suffix}",
        board_id=b["id"],
        # The static fallback address. The board normally uses whatever the
        # Addresses tab assigned it, and the GUI retargets automatically.
        board_ip=f"192.168.2.{b['id']}",
        server_ip="192.168.2.20",
        listen_port=5006,
        control_port=5005,
        all_connectors=list(b["wired"]),
        active_connectors=list(b["active"]),
        connector_labels={c: f"{b['label']} {c}" for c in b["wired"]},
        reading_name=b["reading"],
        value_unit=b["unit"],
        reference_voltage=b["ref"],
        necessary_for_abort=b["abort"],
        enable_serial_printing=True,
        firmware_project=b["project"],
        firmware_env="adafruit_feather_esp32s3",
    )


def _list_boards() -> None:
    print("Sense boards this GUI knows:\n")
    print(f"  {'key':6} {'type':5} {'id':>3}  {'address':16} {'connectors':22} reference")
    for key, b in SENSE_BOARDS.items():
        active = ",".join(str(c) for c in b["active"]) or "(none configured)"
        ref = {0: "internal 2.5 V", 1: "VDD (ratiometric)", 2: "5 V"}[b["ref"]]
        print(f"  {key:6} {b['type']:5} {b['id']:>3}  "
              f"{'192.168.2.' + str(b['id']):16} {active:22} {ref}")
        if b.get("note"):
            print(f"         {b['note']}")
    print("\n  e.g.  python sense_gui.py --board pt")


def main(argv=None) -> int:
    # Pull --board/--list out first, then hand the rest to launch() so every
    # existing override (--board-ip, --listen-port, ...) still works.
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--board", default="lc", choices=sorted(SENSE_BOARDS))
    pre.add_argument("--list", action="store_true")
    args, rest = pre.parse_known_args(argv)

    if args.list:
        _list_boards()
        return 0
    if "-h" in rest or "--help" in rest:
        print(__doc__)
        print("Board keys:", ", ".join(sorted(SENSE_BOARDS)), "\n")
    return launch(sense_profile(args.board), rest)


if __name__ == "__main__":
    raise SystemExit(main())
