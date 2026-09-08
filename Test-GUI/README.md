# Test-GUI

Standardized, per-board test GUIs for the STAR **Diablo** avionics boards
(LC, PT, TC, RTD). Each board gets its own small app that runs on a tester's
laptop, acts as the ground DAQ **server**, and shows — in one window —
everything the board does: state machine, heartbeats, Ethernet/packet health,
live per-connector readings, and self-test results, plus controls to send the
board every packet it understands.

```
Test-GUI/
├── boardgui/              # shared framework (import this; don't duplicate it)
│   ├── protocol.py        # DAQv2-Comms wire format — encode/decode (stdlib only)
│   ├── profile.py         # BoardProfile: the one object that defines a board
│   ├── network.py         # UDP receiver thread + control sender + packet stats
│   ├── serial_link.py     # serial (USB) port list + reader thread (pyserial)
│   ├── serial_parse.py    # parse the board's USB debug stream (stdlib only)
│   ├── gui.py             # generic monitor window, built from a BoardProfile
│   ├── logsetup.py        # rotating file + console logging
│   ├── launch.py          # profile -> running app (args, logging, QApplication)
│   ├── demo_board.py      # headless fake board for the Ethernet path (no hardware)
│   └── qt.py              # PyQt6/PyQt5 compatibility shim
├── LC-GUI/                # Load Cell board  (reference example)
│   ├── lc_gui.py          # <- the entire board app: a profile + launch()
│   ├── requirements.txt
│   └── README.md
└── logs/                  # rotating log files, one per board type
```

The design goal: **a new board GUI is one short file.** Everything protocol-,
network-, and UI-related is shared, so the GUIs stay consistent and a new person
can recreate one in minutes.

## Quick start (LC board)

```bash
cd LC-GUI
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python lc_gui.py
```

See [`LC-GUI/README.md`](LC-GUI/README.md) for network setup and usage.

## How it talks to a board

Two independent links, either or both usable at once:

**Serial (USB)** — the GUI reads the board's debug stream (`serial_link.py` +
`serial_parse.py`) and derives state, firmware hash, board ID, Ethernet link
status, heartbeats, and per-connector readings from the text. Read-only; no
network needed.

**Ethernet (UDP)** — the boards and GUI speak the **DAQv2-Comms** protocol
(`firmware/libraries/DAQv2-Comms`, mirrored byte-for-byte in
`boardgui/protocol.py`). This is the path that can send to the board:

```
board  --UDP-->  us (server) : BOARD_HEARTBEAT (1 Hz), SENSOR_DATA, SELF_TEST   [port 5006]
us     --UDP-->  board       : SERVER_HEARTBEAT, SENSOR_CONFIG, ABORT/CLEAR     [port 5005]
```

A board boots into *WaitingForServer*, sending heartbeats. Send it a
`SENSOR_CONFIG` and it self-tests, goes *Active*, and streams `SENSOR_DATA`.

## Adding a GUI for another board

1. Copy `LC-GUI/` to e.g. `PT-GUI/` and rename `lc_gui.py` → `pt_gui.py`.
2. Edit the `BoardProfile` — the values come from two places:
   - **firmware** `firmware/Hotfire_Code/<BOARD>_Hotfire/src/main.cpp`
     (which connectors/channels the board reads), and
   - **DAQ config** `daq-server/config/config.toml` `[boards.<board>]`
     (`board_id`, `ip`, `voltage_reference`, `active_connectors`, …).
3. Set `board_type` to the board's tag (`"PT"`, `"TC"`, `"RTD"`), give it a
   `title`, `reading_name` (e.g. "Pressure", "Temperature") and `value_unit`.
4. Run it. No other code changes are needed — the shared window adapts.

```python
# pt_gui.py (sketch)
BoardProfile(
    board_type="PT", title="PT Pressure Board",
    board_id=21, board_ip="192.168.2.21",
    all_connectors=list(range(1, 11)), active_connectors=[1, 2, 3],
    reading_name="Pressure voltage", value_unit="V",
    reference_voltage=1, necessary_for_abort=True,
)
```

## Verifying the protocol layer (no display needed)

`boardgui/protocol.py` is pure standard library and ships a round-trip
self-test:

```bash
python -m boardgui.protocol       # -> "protocol self-test: OK (...)"
python -m boardgui.serial_parse   # -> "serial_parse self-test: OK"
```

## Reference boards (from `daq-server/config/config.toml`)

| Board | type | id | IP | ref voltage | notes |
|-------|------|----|----|-------------|-------|
| LC #1 | LC | 41 | 192.168.2.41 | VDD | connectors 1–3 active |
| LC #2 | LC | 42 | 192.168.2.42 | 2.5 V int | connectors 1,2,6 |
| PT #1 | PT | 21 | 192.168.2.21 | VDD | abort-critical |
| TC #1 | TC | 51 | 192.168.2.51 | 2.5 V int | |
| RTD #1| RTD | 31 | 192.168.2.31 | 2.5 V int | |

Server (this laptop) is expected at **192.168.2.20**; boards send data to
`:5006` and listen for control on `:5005`.
