# Sense-GUI

Test GUI for every STAR **sense board** — **LC**, **PT**, **TC** and **RTD**.
It runs on your laptop and shows everything the board does: its state machine,
heartbeats, Ethernet/packet health, per-connector readings, and self-test
results — plus buttons to send the board every control packet it understands,
and tabs to assign its IP address and push new firmware to it.

All four boards run the same firmware core
(`firmware/Hotfire_Code/common/SensorHotfireCore.h`) and speak the same
packets. They differ only in how many connectors they have, what a reading
means, and which ADC reference they use — so they share one app instead of
four near-identical copies. Pick the board with `--board`:

```bash
python sense_gui.py --list           # every board it knows
python sense_gui.py --board lc       # LC #1   (load cells)
python sense_gui.py --board pt       # PT #1   (pressure transducers)
python sense_gui.py --board tc       # TC #1   (thermocouples)
python sense_gui.py --board rtd      # RTD #1  (RTDs)
```

Second boards of each type are `lc2`, `pt2`, `tc2`, `rtd2`. The window adapts
itself — connector count, labels, units, reference voltage, and whether the
board is abort-critical all come from the profile.

| key | board | id | connectors wired | reference |
|-----|-------|----|------------------|-----------|
| `lc` / `lc2` | Load Cell | 41 / 42 | 1,2,3,6,7 (ADC1 differential pairs) | VDD / internal |
| `pt` / `pt2` | Pressure | 21 / 22 | 1–10 | VDD / internal |
| `tc` / `tc2` | Thermocouple | 51 / 52 | 1–10 | internal 2.5 V |
| `rtd` / `rtd2` | RTD | 31 / 32 | 1–4 (two ADS1263 chips) | internal 2.5 V |

PT boards are **abort-critical** — the profile sets `necessary_for_abort`, so a
dropout there can put the board into a standalone abort.

Actuator boards are a different animal (different config packet, per-actuator
controls) and keep their own app in [`../Actuator-GUI/`](../Actuator-GUI).

It has **two ways to connect**, and you can use either or both:

* **Serial (USB)** — the top-left dropdown. Pick the port the board is plugged
  into, click Connect, and the board's debug stream drives the stats. This is
  the simplest path: just a USB cable, no network setup.
* **Ethernet (UDP)** — the "Start Ethernet UDP" button (top-right). The GUI acts
  as the DAQ server, receives the board's binary telemetry, and can **send**
  SERVER_HEARTBEAT / SENSOR_CONFIG / ABORT (sending needs this path).

<p align="center"><i>One person, one board, one window.</i></p>

## Install (once)

Python **3.11** is recommended.

```bash
cd Test-GUI/Sense-GUI
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python sense_gui.py --board lc      # LC #1
python sense_gui.py --board rtd     # RTD #1
```

Every profile value can still be overridden: `--board-ip`, `--board-id`,
`--listen-port` (default 5006), `--control-port` (default 5005), `--bind-ip`
(default 0.0.0.0). Run `python sense_gui.py -h` for all of them.

## Using it — Serial (USB), the simple path

1. Plug the board into USB.
2. Top-left: pick the port from the **Serial port** dropdown (hit **⟳** to
   rescan; the board is usually a `/dev/cu.usbmodem…` on macOS or `COMx` on
   Windows), leave **Baud** at `115200`, and click **Connect**.
3. The light goes 🟢 **Connected** once the board's serial output is flowing.

The top-left light:

| Light | Meaning |
|-------|---------|
| ⚪ grey | not connected |
| 🟡 amber | port open, waiting for / no data |
| 🟢 **Connected** | board serial lines arriving (≤ 3 s old) |

From the serial stream the GUI fills in: state machine, firmware hash, board ID,
Ethernet link status, heartbeats, and the the per-connector readings
(printed ~1×/s) with the plot. Tick **echo raw serial to log** to see the raw
text. (The board's `enable_serial_printing` must be on — it is by default.)

## Using it — Ethernet (UDP), for packet testing + control

Click **Start Ethernet UDP** (top-right). The GUI binds UDP `5006` to receive
the board's binary telemetry and populates the **Ethernet / Packets** panel
(totals, rates, per-type counts, malformed). This is also the only path that can
**send** to the board:

* **Send SENSOR_CONFIG (activate board)** → board self-tests, goes *Active*, and
  streams `SENSOR_DATA` at full rate.
* **Auto SERVER_HEARTBEAT** keeps the board's server-connection alive.
* **ABORT / Clear Abort / No-Conn Abort** exercise the abort path (only bites if
  the config you sent had `necessary_for_abort`).

The **Board IP** field (top-right) is where control packets are sent. It starts
at the profile default, **auto-updates to the board's real address** once its
packets arrive, and you can **type a different IP + Set** to override at any time.

Network setup for this path: **the GUI assigns the board's address.** The
firmware asks for one by DHCP at boot (`-DSENSOR_ETH_USE_DHCP`) and uses
whatever it is given; the **Addresses** tab answers from its MAC → IP table.
Register the board once — connect it over USB, its MAC appears in that tab,
save the reservation — and it lands on the same address every boot.

The GUI needs `sudo` to serve addresses (port 67 is privileged), and it answers
only MACs you have registered, so it cannot disturb anything else on the
network. If no address server is running, the board falls back to its old
static `192.168.2.<board_id>` and says so on serial, so it is never unreachable.

The board still finds *us* by broadcasting its heartbeat until we reply, so the
**Board IP** field tracks it automatically either way.

> Old manual path (still works, and is what the production DAQ server uses):
> put your laptop at the board's static subnet with
> `networksetup -setmanual "USB 10/100/1000 LAN" 192.168.2.20 255.255.255.0 192.168.2.1`
> (revert with `networksetup -setdhcp "USB 10/100/1000 LAN"`).

## Try it with no board (demo mode)

You can exercise the **Ethernet path** on one laptop, no hardware:

```bash
# terminal 1 — a fake sense board on localhost
python -m boardgui.demo_board
# terminal 2 — the GUI, pointed at localhost
python sense_gui.py --board-ip 127.0.0.1
```

To exercise the **address assignment** and **discovery** paths too — the parts
that are easy to get wrong and impossible to test from a static fake:

```bash
python -m boardgui.demo_board --dhcp-server 127.0.0.1:6767 --discover
```

The fake board then does a real DHCP exchange against this GUI's address server
(point `--dhcp-server` at whatever port the Addresses tab is using), reports the
address it was assigned, falls back loudly if nothing answers, and broadcasts
until the GUI talks to it — the same sequence the real firmware runs.

## Logs

Every event is mirrored to a rotating log file at
`Test-GUI/logs/<board>_gui.log` (5 × 2 MB) and shown in the on-screen Log panel.

## How it maps to the firmware

| GUI element | Firmware behaviour |
|-------------|--------------------|
| Connected light / heartbeat rate | `BOARD_HEARTBEAT` every 1000 ms (`SensorHotfireCore.h`) |
| State | `BoardState` in the heartbeat (Setup→Active→Standalone Abort→Self-Test) |
| Send SENSOR_CONFIG | drives `WaitingForServer → SelfTest → Active` |
| Per-connector readings | differential ADS126X reads on ADC1 connectors 1,2,3,6,7 (`main.cpp`) |
| Self-Test panel | `SELF_TEST` packet: ADC TDAC + per-connector continuity |
| Ethernet / Packets | proves the UDP/Ethernet path end-to-end |

See `../README.md` for the framework and how to add a GUI for another board.
