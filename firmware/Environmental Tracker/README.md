# Environmental board

ESP32-C3-WROOM with a W5500 (Ethernet) and a BME280. Two jobs:

1. **Environmental data.** Temperature, absolute pressure and humidity to the DAQ at 5 Hz
   (`ENVIRONMENTAL_DATA`), shown on the DAQ's Environmental page.
2. **Bluetooth switch relay.** Holds a BLE connection to each Bluetooth altimeter switch
   (`firmware/Bluetooth_Switch`) the DAQ lists, and relays their status to the DAQ's Switches page.

Static address `192.168.2.25` (`ENV_BOARD_ID` in `src/main.h`). Each function stands alone: the
board boots with no USB host, keeps relaying switches with the BME280 missing (it says so in a
LOGS line every 10 s and retries), and keeps sending environmental data if Bluetooth won't start.
Only a missing W5500 is fatal: it reboots after 5 s and tries again.

```bash
pio run -e environmental              # build
pio run -e environmental -t upload    # flash over USB-C
pio test -e native                    # switch relay logic, on the host
```

## Switch relay

- **The list comes from the DAQ, every second.** `switch_service` sends `SWITCH_CONFIG`
  (role index + MAC, from `[switch_roles.*]` in the DAQ's `config.toml`; names stay on the
  server). The board applies it only when its hash differs from the one it holds, and keeps it in
  memory only: after a reboot it connects to nothing until the next one arrives.
- **Persistent connections.** One link per listed switch (at most 5). It connects and discovers
  at 15-30 ms (declining the switch's own early request for slow parameters, which would make
  discovery take seconds), then settles on the switch's 300-400 ms interval and latency 4. The
  board scans only while a listed switch is not connected, keeps no scan results (a pad full of
  phones would fill RAM), and reconnects by itself.
- **Status passes through untouched.** Each switch's 17-byte status (`lib/daq-protocol/src/SwitchStatus.h`)
  goes to the DAQ in `SWITCH_STATUS` with the link state, RSSI, its age and the held list's hash:
  on every notification, and at least once a second per switch. While a link is down the last
  status keeps going, older each time.
- **It never acts on its own.** Not on losing the DAQ, not on an abort, not after a reboot: it
  writes to a switch only when an operator's command says to. Closing a link never changes a
  switch's output.

The relay's logic is `lib/SwitchRelay` (no BLE, no network; host-tested). `src/switch_link.cpp`
is the NimBLE central around it, in its own task so a blocking connect never stalls Ethernet.

## Bench acceptance (before the pad)

Run with this board and at least two switches, with a phone on the switch web page as well. Check
every step against the switch's own LED and console (`status`), not only the DAQ. Record the date,
the boards' firmware hashes (Boards page; the switch console prints its own) and anything that
failed.

Setup: fill `[switch_roles.*]` with the switches' MACs (or bind them with **Find switches**), set
`[switch_service] enabled = true`, deploy, and start `sensor-switch`.

| # | Do | Expect |
|---|---|---|
| 1 | Open the Switches page | One card per switch, Connected, DISARMED, signal in dBm |
| 2 | Unlock control, Arm one, confirm | "Arming…" for up to ~2 s, then ARMED and "Armed: output live"; switch LED red |
| 3 | Disarm it | DISARMED; LED back to green blips |
| 4 | Arm one, then stop the DAQ (`sensor-switch`, then `sensor-daq`), then pull the env board's Ethernet | The switch stays armed (LED, console). Nothing changes on any switch |
| 5 | Reconnect, restart; power-cycle the env board with a switch armed | Links come back within seconds; the card says ARMED; the switch never disarmed |
| 6 | Power-cycle one switch | Its card goes Not connected, then reconnects DISARMED; the others don't flicker |
| 7 | Phone on the web page connected while the DAQ arms/disarms | Both show the same state |
| 8 | Walk a switch out of range | Card shows the lost link within ~6 s; Arm is disabled; a command sent anyway answers "not connected" |
| 9 | Switches on battery (no USB: light sleep) | Commands still land, within ~2 s |
| 10 | Unbound switch powered nearby, **Find switches** | It's listed with its MAC; nothing connects to it |
| 11 | Lock control (or a non-operator account) | Arm/Disarm disabled; the backend refuses a forced command |

Steps 4 and 5 are the "never on its own" promise; they can only be shown on hardware.
