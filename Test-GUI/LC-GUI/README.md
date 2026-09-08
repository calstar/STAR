# LC-GUI

Test GUI for the STAR **Load Cell (LC)** board. It runs on your laptop and shows
everything the LC board does: its state machine, heartbeats, Ethernet/packet
health, per-connector load-cell readings, and self-test results — plus buttons
to send the board every control packet it understands.

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
cd Test-GUI/LC-GUI
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python lc_gui.py                                  # LC board #1  (id 41, 192.168.2.41)
python lc_gui.py --board-ip 192.168.2.42 --board-id 42   # LC board #2
```

Other flags: `--listen-port` (default 5006), `--control-port` (default 5005),
`--bind-ip` (default 0.0.0.0). Run `python lc_gui.py -h` for all of them.

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
Ethernet link status, heartbeats, and the per-connector load-cell readings
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

Network setup for this path: **none, usually.** LC firmware is zero-config
(`SENSOR_ETH_ZEROCONF`): at boot it tries DHCP (5 s), falls back to static
`192.168.2.<board_id>`, and if still nobody talks to it, alternates onto a
link-local `169.254.x.y` address every 10 s — broadcasting its heartbeat the
whole time. Your laptop's self-assigned `169.254.x.x` (what every OS does with
no DHCP) is enough: the GUI hears the broadcast, learns the board's address,
and the board learns the GUI's from the reply. Worst case ~20 s from board
power-on to 🟢. If your OS firewall prompts, allow Python to receive UDP.

The board **locks its address on first contact** (safety: it never re-addresses
mid-session), so if you swap laptops, give it ~12 s to notice the silence and
resume discovery — or just power-cycle it.

> Old manual path (still works, and is what the production DAQ server uses):
> put your laptop at the board's static subnet with
> `networksetup -setmanual "USB 10/100/1000 LAN" 192.168.2.20 255.255.255.0 192.168.2.1`
> (revert with `networksetup -setdhcp "USB 10/100/1000 LAN"`).

## Try it with no board (demo mode)

You can exercise the **Ethernet path** on one laptop, no hardware:

```bash
# terminal 1 — a fake LC board on localhost
python -m boardgui.demo_board
# terminal 2 — the GUI, pointed at localhost
python lc_gui.py --board-ip 127.0.0.1
```

In the GUI click **Start Ethernet UDP**, then **Send SENSOR_CONFIG**. The fake
board self-tests, goes Active, and streams sine-wave load-cell data so you can
see the plot, packet counters, and self-test behave exactly as with real
hardware. (The demo covers the UDP path; the serial path needs a real board.)

## Logs

Every event is mirrored to a rotating log file at
`Test-GUI/logs/lc_gui.log` (5 × 2 MB) and shown in the on-screen Log panel.

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
