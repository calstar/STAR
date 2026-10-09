# Actuator-GUI

Test GUI for the STAR **Actuator** board. It runs on your laptop and shows
everything the actuator board does: its state machine, heartbeats,
Ethernet/packet health, per-actuator current-sense readings — plus buttons to
send the board every control packet it understands, including per-actuator
ON/OFF toggles and PWM bursts.

It has **two ways to connect**, and you can use either or both:

* **Serial (USB)** — the top-left dropdown. Pick the port the board is plugged
  into, click Connect, and the board's debug stream drives the stats. This is
  the simplest path: just a USB cable, no network setup.
* **Ethernet (UDP)** — the "Start Ethernet UDP" button (top-right). The GUI acts
  as the DAQ server, receives the board's binary telemetry, and can **send**
  SERVER_HEARTBEAT / ACTUATOR_CONFIG / ACTUATOR_COMMAND / PWM / ABORT
  (sending needs this path).

<p align="center"><i>One person, one board, one window.</i></p>

## Install (once)

Python **3.11** is recommended.

```bash
cd Test-GUI/Actuator-GUI
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python actuator_gui.py                                      # actuator board #1
python actuator_gui.py --board-ip 192.168.2.12 --board-id 12    # board #2
```

Other flags: `--listen-port` (default 5006), `--control-port` (default 5005),
`--bind-ip` (default 0.0.0.0). Run `python actuator_gui.py -h` for all of them.

## Using it — Serial (USB), the simple path

1. Plug the board into USB.
2. Top-left: pick the port from the **Serial port** dropdown (hit **⟳** to
   rescan; the board is usually a `/dev/cu.usbmodem…` on macOS or `COMx` on
   Windows), leave **Baud** at `115200`, and click **Connect**.
3. The light goes 🟢 **Connected** once the board's serial output is flowing.

From the serial stream the GUI fills in: state machine, firmware hash, board ID,
Ethernet link status, and heartbeats. Tick **echo raw serial** to see the raw
text. (The board's `enable_serial_printing` must be on — it is by default.)

## Using it — Ethernet (UDP), for packet testing + control

Click **Start Ethernet UDP** (top-right). The GUI binds UDP `5006` to receive
the board's binary telemetry and populates the **Ethernet / Packets** panel.
This is also the only path that can **send** to the board:

* **Send ACTUATOR_CONFIG (activate board)** → board goes *Active* and streams
  per-actuator current-sense `SENSOR_DATA` at 10 Hz (float volts). Tick
  **abort controller** first to mark the board as the designated survivor.
* **Actuator toggles 1–10** send `ACTUATOR_COMMAND` (green = commanded ON);
  **All OFF** de-energizes everything in one packet. The current-sense plot
  responds so you can verify each channel end-to-end.
* **PWM row** sends a `PWM_ACTUATOR_COMMAND` burst (id / duration ms / duty /
  frequency).
* **Auto SERVER_HEARTBEAT** keeps the board's server-connection alive (the
  board watches for server silence).
* **ABORT / Clear Abort / No-Conn Abort** exercise the abort path.

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
# terminal 1 — a fake actuator board on localhost
python -m boardgui.demo_actuator_board
# terminal 2 — the GUI, pointed at localhost
python actuator_gui.py --board-ip 127.0.0.1
```

To exercise the **address assignment** and **discovery** paths too — the parts
that are easy to get wrong and impossible to test from a static fake:

```bash
python -m boardgui.demo_actuator_board --dhcp-server 127.0.0.1:6767 --discover
```

The fake board then does a real DHCP exchange against this GUI's address server
(point `--dhcp-server` at whatever port the Addresses tab is using), reports the
address it was assigned, falls back loudly if nothing answers, and broadcasts
until the GUI talks to it — the same sequence the real firmware runs.

## Logs

Every event is mirrored to a rotating log file at
`Test-GUI/logs/act_gui.log` (5 × 2 MB) and shown in the on-screen Log panel.

## How it maps to the firmware

| GUI element | Firmware behaviour |
|-------------|--------------------|
| Connected light / heartbeat rate | `BOARD_HEARTBEAT` every 1000 ms (`main.cpp`) |
| State | `BoardState` in the heartbeat (Setup→Active→abort states) |
| Send ACTUATOR_CONFIG | drives `WaitingForServer → Active` |
| Actuator toggles / PWM | `ACTUATOR_COMMAND` / `PWM_ACTUATOR_COMMAND` on :5005 |
| Per-actuator readings | `analogRead` current-sense volts, float-encoded, 10 Hz |
| Ethernet / Packets | proves the UDP/Ethernet path end-to-end |

See `../README.md` for the framework and how to add a GUI for another board.
