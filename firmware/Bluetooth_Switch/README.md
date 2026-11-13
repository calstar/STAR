# Bluetooth Switch

Latched high-side power switch for commercial altimeters, on the WifiSwitch
board (ESP32-C3FH4, TPS22810 switch, INA260 on the supply input). Controlled
and monitored over BLE; the "are you sure" confirmation lives in the web client.

```bash
pio run                 # build
pio run -t upload       # flash over the USB-C port
pio device monitor      # console: arm | disarm | status
```

## Output policy

- **Latched.** ARMED (output on) stays armed until an explicit DISARM. Nothing times it out.
- **A BLE disconnect changes nothing.** Losing the phone at the pad keeps the altimeters powered.
- **MCU reset keeps the output.** The EN pad is held with `gpio_hold`, and the state is
  re-applied from RTC memory after a watchdog, panic or brownout reset (`FLAG_RESTORED`).
- **Power cycle comes up DISARMED.**

## BLE

Advertises as `STAR-Switch-XXXX` (last two bytes of the BT MAC), every 1 s.
Open link: no pairing or encryption, anyone in range can connect and switch it.
Up to 4 phones can be connected at once (`CONFIG_BT_NIMBLE_MAX_CONNECTIONS`): the
switch keeps advertising while a slot is free, every connected phone gets the
notifications, and the last write wins.

| | UUID | Access |
|---|---|---|
| Service | `53544152-0001-4b8a-9d3e-7a1c2f6b0e10` | |
| Output | `53544152-0002-4b8a-9d3e-7a1c2f6b0e10` | read, write, notify. `0x01` = ARM (output on), `0x00` = DISARM (output off) |
| Status | `53544152-0003-4b8a-9d3e-7a1c2f6b0e10` | read, notify (every 2 s while connected, and after every switch) |
| Firmware | `53544152-0004-4b8a-9d3e-7a1c2f6b0e10` | read. 32 bytes: the SHA-256 ESP-IDF appended to the running image |

Status is 17 bytes, little-endian (`include/status.h`):

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | version (1) |
| 1 | u8 | output, 0/1 |
| 2 | u8 | sense: 0 unknown, 1 load present, 2 open, 3 live |
| 3 | u8 | flags: bit0 INA260 ok, bit1 reading valid, bit2 restored after reset, bit3 no battery (J1-3 < 2.5 V) |
| 4 | u16 | supply voltage, mV (J1-3) |
| 6 | i16 | supply current, mA (load + board draw when not on USB) |
| 8 | u16 | power, mW |
| 10 | u16 | raw sense ADC, mV |
| 12 | u32 | uptime, s |
| 16 | u8 | reset reason (`esp_reset_reason_t`) |

**Sense** reads VOUT through the continuity divider. With the output on it should
read "live"; anything else means the switch or the supply has failed, and disarmed
but live means the switch is stuck on. The firmware still reports load/open while
disarmed, but neither the LED nor the web page shows it: the 1 MΩ continuity drive
holds VOUT near 0.47 V, which can't push current through the bridge board's body
diodes, so an altimeter behind it reads the same as nothing at all.

## Firmware hash

The board reports the SHA-256 that ESP-IDF appended to its image (`firmware_hash.h`,
shared with the hotfire boards): on the Firmware characteristic, at boot on the
console, and with `status`. The build runs `firmware/tools/reproducible_build.py`, so
the same commit hashes the same on every machine. Firmware CI builds it in the same
matrix as the hotfire boards, and every push to `main` records the image on the
`firmware-registry` branch under `Bluetooth_Switch/<digest>.json`. The web page looks
the hash up there and shows the commit. To do it by hand:

```bash
firmware/tools/firmware_digest.py .pio/build/bluetooth_switch/firmware.bin   # what a board running this build reports
firmware/tools/which_firmware.py <digest> --registry <firmware-registry checkout>  # which commit built it
```

A hash that isn't in the registry is a local or PR build.

## Status LED (SK6805, GPIO5)

Pure red, green or blue only. The SK6805 mixes colours badly (amber reads as red
and green at once), so states differ by pattern.

| State | LED |
|---|---|
| Disarmed, **no battery** on J1-3 (below 2.5 V) | one long (400 ms) dim blue pulse every 3 s |
| Disarmed | one dim green blip every 3 s |
| **Armed**, output live | red blink, 1 Hz |
| Armed, restored after an MCU reset | red blink plus a short red blip between, until the next arm/disarm |
| **Fault**: armed but VOUT not live, or disarmed but live | red flicker, 5 Hz |
| INA260 missing | blue double blip every 3 s, on top of the above |
| Phone connects | one blue blip |
| Arm / disarm command | one bright flash, red for armed, green for disarmed |

The pattern is a pure function in `include/led_pattern.h`, tested on the host:

```bash
c++ -std=c++17 -Iinclude test/host/led_pattern_test.cpp -o /tmp/led && /tmp/led
```

The SK6805 draws roughly 1 mA even when dark. That's comparable to the other
power savings below, so it's the first thing to cut if a pad sit runs the battery down.

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

Several switches can be connected on one page, each on its own card. Arm and Disarm
both ask for confirmation. If the link drops, the page reconnects by itself. The card
shows the last known state and marks it stale; the output is not touched. The
card cross-checks the output against the sense line ("ARMED but sense reads
open" means the switch or the supply has failed).

When the status layout changes, bump `STATUS_VERSION` in `include/status.h` *and*
`web/protocol.js`. The page refuses a version it doesn't know, and the test fails
until both match.

## Power

Built as ESP-IDF 4.4 with Arduino as a component (`framework = arduino, espidf`),
because the prebuilt Arduino core has power management and BLE modem sleep off,
which held the radio on at ~80 mA. `sdkconfig.defaults` is arduino-esp32 2.0.17's
own C3 config with the overrides at the end: automatic light sleep, BLE modem
sleep clocked from the main crystal, and a fixed app version so the digest doesn't
follow `git describe`. IDF floats every pin during light sleep on the C3, so
`main.cpp` exempts the pins it drives; GPIO4 is the arm line.

The first build downloads IDF and takes ~10 minutes. After editing
`sdkconfig.defaults`, delete the generated `sdkconfig.bluetooth_switch`: an
existing sdkconfig wins over the defaults.

The chip only light-sleeps on battery: while USB is plugged in it holds itself
awake so the console and flashing work. The console's `status` line says which
(`power=light sleep` / `awake for USB`). Other savings: 80 MHz CPU, 1 s
advertising, 300–400 ms connection interval, INA260 in triggered mode.
