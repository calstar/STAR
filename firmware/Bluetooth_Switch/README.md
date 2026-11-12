# Bluetooth Switch

Latched high-side power switch for commercial altimeters, on the WifiSwitch
board (ESP32-C3FH4, TPS22810 switch, INA260 on the supply input). Controlled
and monitored over BLE; the "are you sure" confirmation lives in the web client.

```bash
pio run                 # build
pio run -t upload       # flash over the USB-C port
pio device monitor      # console: on | off | status
```

## Output policy

- **Latched.** ON stays on until an explicit OFF (disable). Nothing times it out.
- **A BLE disconnect changes nothing.** Losing the phone at the pad keeps the altimeters powered.
- **MCU reset keeps the output.** The EN pad is held with `gpio_hold`, and the state is
  re-applied from RTC memory after a watchdog, panic or brownout reset (`FLAG_RESTORED`).
- **Power cycle comes up OFF.**

## BLE

Advertises as `STAR-Switch-XXXX` (last two bytes of the BT MAC), every 1 s.
Open link: no pairing or encryption, anyone in range can connect and switch it.
Up to 4 phones can be connected at once (`CONFIG_BT_NIMBLE_MAX_CONNECTIONS`): the
switch keeps advertising while a slot is free, every connected phone gets the
notifications, and the last write wins.

| | UUID | Access |
|---|---|---|
| Service | `53544152-0001-4b8a-9d3e-7a1c2f6b0e10` | |
| Output | `53544152-0002-4b8a-9d3e-7a1c2f6b0e10` | read, write, notify. `0x01` = ON, `0x00` = OFF (disable) |
| Status | `53544152-0003-4b8a-9d3e-7a1c2f6b0e10` | read, notify (every 2 s while connected, and after every switch) |

Status is 17 bytes, little-endian (`include/status.h`):

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | version (1) |
| 1 | u8 | output, 0/1 |
| 2 | u8 | sense: 0 unknown, 1 load present, 2 open, 3 live |
| 3 | u8 | flags: bit0 INA260 ok, bit1 reading valid, bit2 restored after reset |
| 4 | u16 | supply voltage, mV (J1-3) |
| 6 | i16 | supply current, mA (load + board draw when not on USB) |
| 8 | u16 | power, mW |
| 10 | u16 | raw sense ADC, mV |
| 12 | u32 | uptime, s |
| 16 | u8 | reset reason (`esp_reset_reason_t`) |

**Sense** reads VOUT through the continuity divider. With the output off, CONT_EN
pulls VOUT up through 1 MΩ, so a connected altimeter reads "load present" and nothing
connected reads "open". With the output on it should read "live". If it reads anything
else, the switch or the supply has failed. The thresholds in `main.cpp` still need
bench calibration.

## Web client (`web/`)

A static page with no build step: `index.html` plus `protocol.js` (the UUIDs and the
status decoder). It uses Web Bluetooth, so:

- **Android / laptop:** Chrome or Edge.
- **iPhone / iPad:** Safari has no Web Bluetooth. Install
  [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) and open the page in it.
- It must be served over **HTTPS** (or `localhost`). Any static host works.

```bash
cd web && python3 -m http.server 8000     # then open http://localhost:8000 on this machine
node web/test/protocol.test.mjs            # decoder vs the C StatusPacket (needs c++)
```

Several switches can be connected on one page, each on its own card. ON and OFF
both ask for confirmation. If the link drops, the page reconnects by itself. The card
shows the last known state and marks it stale; the output is not touched. The
card cross-checks the output against the sense line ("Output ON but sense reads
open" means the switch or the supply has failed).

When the status layout changes, bump `STATUS_VERSION` in `include/status.h` *and*
`web/protocol.js`. The page refuses a version it doesn't know, and the test fails
until both match.

## Not done yet

- SK6805 status LED (GPIO5).
- Light sleep. The prebuilt Arduino core doesn't enable power management or the
  32 kHz crystal clock source. The current savings are an 80 MHz CPU, 1 s
  advertising, a 300–400 ms connection interval and the INA260 in triggered mode.
