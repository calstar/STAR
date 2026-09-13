# Test-GUI

Standardized, per-board test GUIs for the STAR **Diablo** avionics boards
(LC, PT, TC, RTD, Actuator). Each board gets its own small app that runs on a
tester's laptop, acts as the ground DAQ **server**, and shows — in one window —
everything the board does: state machine, heartbeats, Ethernet/packet health,
live per-connector readings, and self-test results, plus controls to send the
board every packet it understands (for the actuator board that includes
per-actuator ON/OFF toggles and PWM commands).

```
Test-GUI/
├── boardgui/              # shared framework (import this; don't duplicate it)
│   ├── protocol.py        # DAQv2-Comms wire format — encode/decode (stdlib only)
│   ├── profile.py         # BoardProfile: the one object that defines a board
│   ├── network.py         # UDP receiver thread + control sender + packet stats
│   ├── discovery.py       # where to send: learn the board's address (stdlib only)
│   ├── dhcp.py            # address server: MAC -> IP reservations (stdlib only)
│   ├── dhcp_task.py       # Qt thread wrapper around dhcp.py
│   ├── ota.py             # firmware upload over Ethernet (stdlib only)
│   ├── ota_task.py        # Qt thread wrapper around ota.py
│   ├── serial_link.py     # serial (USB) port list + reader thread (pyserial)
│   ├── serial_parse.py    # parse the board's USB debug stream (stdlib only)
│   ├── gui.py             # generic monitor window, built from a BoardProfile
│   ├── logsetup.py        # rotating file + console logging
│   ├── launch.py          # profile -> running app (args, logging, QApplication)
│   ├── demo_board.py      # headless fake sense board for the Ethernet path
│   ├── demo_actuator_board.py  # headless fake actuator board (no hardware)
│   ├── demo_net.py        # the fake boards' zero-config discovery emulation
│   └── qt.py              # PyQt6/PyQt5 compatibility shim
├── Sense-GUI/             # LC, PT, TC and RTD — one app for all of them
│   ├── sense_gui.py       # <- profiles + launch(), pick with --board
│   ├── requirements.txt
│   └── README.md
├── Actuator-GUI/          # Actuator board  (reference actuator example)
│   ├── actuator_gui.py    # <- profile (kind="actuator") + launch()
│   ├── requirements.txt
│   └── README.md
└── logs/                  # rotating log files, one per board type
```

The design goal: **boards that behave the same share one app.** The four sense
boards (LC/PT/TC/RTD) run the same firmware core and differ only in connector
count, units and ADC reference, so they are one app with a `--board` switch.
Actuator boards take a different config packet and have per-actuator controls,
so they are the one genuine second app. Everything protocol-, network- and
UI-related is shared by both.

## Quick start (any sense board)

```bash
cd Sense-GUI
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python sense_gui.py --board lc      # or pt / tc / rtd; --list shows them all
```

See [`Sense-GUI/README.md`](Sense-GUI/README.md) for network setup and usage.

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

A board boots into *WaitingForServer*, sending heartbeats. Send a sense board
a `SENSOR_CONFIG` and it self-tests, goes *Active*, and streams `SENSOR_DATA`
(signed ADC codes). Send the actuator board an `ACTUATOR_CONFIG` and it goes
*Active*, streams current-sense `SENSOR_DATA` (float volts), and obeys
`ACTUATOR_COMMAND` / `PWM_ACTUATOR_COMMAND`.

## Adding another board

**If it is a sense board** (reads connectors, takes SENSOR_CONFIG), do not make
a new app — add an entry to `SENSE_BOARDS` in `Sense-GUI/sense_gui.py` and it
appears under `--board`. That is the whole job.

**If it behaves differently enough to need its own app**, copy `Actuator-GUI/`
— its profile sets `kind="actuator"` and `value_encoding="float"`, which swaps
SENSOR_CONFIG for ACTUATOR_CONFIG and adds the actuator/PWM controls — then:

1. Rename the profile function and the file.
2. Edit the `BoardProfile` — the values come from two places:
   - **firmware** `firmware/Hotfire_Code/<BOARD>_Hotfire/src/main.cpp`
     (which connectors/channels the board reads), and
   - **DAQ config** `daq-server/config/config.toml` `[boards.<board>]`
     (`board_id`, `ip`, `voltage_reference`, `active_connectors`, …).
3. Set `board_type` to the board's tag, give it a `title`, `reading_name` and
   `value_unit`.
4. Run it. No other code changes are needed — the shared window adapts.

```python
# a sense board is just a row in SENSE_BOARDS:
"pt": dict(type="PT", id=21, wired=list(range(1, 11)),
           active=[1, 2, 3], ref=1, abort=True,
           reading="Pressure voltage", unit="V", label="PT",
           project="firmware/Hotfire_Code/PT_Hotfire"),
```

## Verifying the protocol layer (no display needed)

`boardgui/protocol.py` is pure standard library and ships a round-trip
self-test:

```bash
python -m boardgui.protocol       # -> "protocol self-test: OK (...)"
python -m boardgui.serial_parse   # -> "serial_parse self-test: OK"
python -m boardgui.discovery      # -> "discovery self-test: OK"
python -m boardgui.demo_net       # -> "demo_net self-test: OK"
python -m boardgui.ota            # -> "ota self-test: OK"
python -m boardgui.dhcp           # -> "dhcp self-test: OK"
```

Fake boards for GUI testing with no hardware (see each GUI's README):

```bash
python -m boardgui.demo_board            # fake LC/sense board on localhost
python -m boardgui.demo_actuator_board   # fake actuator board on localhost
```

Add `--discover` to emulate how the real firmware finds its server, and
`--dhcp-server` to make a fake board ask this GUI for its address the way a
real one does:

```bash
python -m boardgui.demo_board --dhcp-server 127.0.0.1:6767 --discover
```

## Addresses: the GUI decides, the board asks

Boards do not choose their own IP. Every LC and Actuator board spends its first
5 seconds asking for one by DHCP (`-DSENSOR_ETH_USE_DHCP`, see
`firmware/Hotfire_Code/common/board_net.h`) and uses whatever it is given. The
**Addresses** tab is what answers, from a table of **MAC → IP reservations**
this GUI owns — so a board's address is decided in one place, by people, and is
the same every boot.

Registering a board takes one step: connect it over USB on the Monitor tab. It
prints its MAC at boot, the Addresses tab fills it in and suggests the IP that
matches its board ID, and **Save reservation** writes it. From then on the board
gets that address whenever it boots with the server running.

```
MAC: DE:AD:BE:EF:2A:3C          <- the board, over USB serial
    ↓
de:ad:be:ef:2a:3c → 192.168.2.41   <- the reservation you save
    ↓
[NET] server assigned us 192.168.2.41    <- the board, next boot
```

Two things to know before starting the server:

* **Port 67 is privileged**, so the GUI needs to be started with `sudo` to hand
  out addresses. Without it the tab says so rather than failing silently.
* **It answers only MACs in the table.** A second DHCP server on a shared
  network is otherwise a hazard — this one cannot hand an address to anything
  it has not been told about, and an unregistered board that asks is surfaced
  in the tab instead.

If no DHCP server answers at all, a board falls back to its old static
`192.168.2.<BOARD_ID>` so it is never mute on the wire and `daq-server`'s
per-board static IPs still work. The board says so loudly on serial, and the
**Address source** line tells you which of the two you are looking at. Build
the firmware with `-DSTAR_NET_DHCP_ONLY` to remove even that fallback.

The board still finds *us* on its own — it broadcasts BOARD_HEARTBEAT until a
server talks to it and learns the server's address from that packet — so the
**Board IP** field on the Monitor tab still tracks the board automatically, and
still takes a manual override.

## Reference boards (from `daq-server/config/config.toml`)

| Board | type | id | IP | ref voltage | notes |
|-------|------|----|----|-------------|-------|
| LC #1 | LC | 41 | 192.168.2.41 | VDD | connectors 1–3 active |
| LC #2 | LC | 42 | 192.168.2.42 | 2.5 V int | connectors 1,2,6 |
| PT #1 | PT | 21 | 192.168.2.21 | VDD | abort-critical |
| TC #1 | TC | 51 | 192.168.2.51 | 2.5 V int | |
| RTD #1| RTD | 31 | 192.168.2.31 | 2.5 V int | |
| ACT #1| ACTUATOR | 11 | 192.168.2.11 | — | 10 actuators + current sense |
| ACT #2| ACTUATOR | 12 | 192.168.2.12 | — | designated survivor |

Server (this laptop) is expected at **192.168.2.20**; boards send data to
`:5006` and listen for control on `:5005`.

## Updating firmware (the OTA tab)

Every STAR board with a W5500 listens for firmware on TCP 3232
(`firmware/libraries/STAR_EthernetOTA`). The **OTA** tab pushes a new image
there — no USB cable, and no need to be standing next to the stand.

It defaults to the address the Monitor tab is currently talking to, which is
the one this GUI assigned the board.

Two ways to send:

* **Build it now, with a test message baked in.** Compiles the board's
  PlatformIO project with `-DSTAR_OTA_TEST_MESSAGE` set to whatever you type,
  then uploads it. Needs PlatformIO on PATH. Nothing in the repo is modified —
  the flag goes in through the environment.
* **Upload a `firmware.bin` I already built.** Point it at
  `.pio/build/<env>/firmware.bin`.

### Knowing it actually landed

An update that quietly does nothing is the failure mode worth catching, so the
tab checks two independent things and reports both:

* **Firmware hash.** The board computes the SHA-256 of its own running image at
  boot and reports it in every heartbeat. When that matches the hash of the
  binary we sent, the tab says **Verified** — the board is provably running
  that exact image.
* **Test message.** A board built with a message prints `[OTA-MSG] <text>` on
  serial every couple of seconds. Give each upload a different message and you
  can simply watch the board start saying something new. Connect the USB serial
  port on the Monitor tab and the tab shows the live message.

If the board *rejects* an image, it says so on serial (`[OTA] ERROR: …`) — the
tab surfaces that too, because from the network side a rejected upload
otherwise looks much like an accepted one.

The board reboots immediately after accepting an image, so expect it to go
quiet for a few seconds and come back with a new hash.
