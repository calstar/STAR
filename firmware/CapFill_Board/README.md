# CapFill board firmware (ESP-IDF 5.3, ESP32-S3)

Reads the FDC1004's four capacitive channels (GX12 connectors 1–4) and streams them to the Diablo DAQ server over the W5500 Ethernet breakout. The protocol matches the club's other sense boards (`calstar/DAQv2-Comms` + `DiabloAvionics/Hotfire_Code/common/SensorHotfireCore.h`).

Builds cleanly against ESP-IDF v5.3.2. Pin map checked against the CapFill_3 schematic. Host tests (below) pass. **Not yet run on hardware.**

> ## ⚠️ TODO(BOARD_ID) — set before using the DAQ network
> `BOARD_ID` in `main/daq_config.h` is a **placeholder (99)**. It is also the last number of the board's IP (`192.168.2.<BOARD_ID>`). Get CapFill's real ID from the DAQ lead, change it there, and set `CAPFILL_BOARD_ID_IS_PLACEHOLDER` to 0. Until then every build prints a warning and the board logs one at boot. `grep -rn "TODO(BOARD_ID)" main/` finds every spot.

## Build and flash

```bash
. $IDF_PATH/export.sh
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyACM0 flash monitor     # native USB-C port
```

If flashing fails to connect: hold BOOT (SW1), tap RESET (SW2), release BOOT.

After the first USB flash, the board can also be updated over Ethernet on TCP 3232, using the same protocol as the club's `ota_upload.py` / test GUI (`build/capfill-fw.bin` is the image to send).

## DAQ protocol (what CapFill does on the network)

| | |
|---|---|
| Transport | UDP. Board listens on **5005**, sends to server **192.168.2.20:5006** |
| Board IP | Static **192.168.2.<BOARD_ID>**, /24, no gateway |
| Byte order | Little-endian, packed (same as the ESP32 structs and the GUI's `'<'` formats) |
| Header | type(1), version(1) = 0, timestamp(4) = ms since boot |
| Heartbeat | Every 1 s: SHA-256 of running firmware, board ID, engine state, board state |
| Sensor data | One chunk per FDC1004 cycle (~25 Hz), 9 chunks per packet (~2.8 packets/s) |
| Data value | Raw FDC1004 counts **including the CAPDAC offset**, as int32 in the uint32 field. **pF = (int32)data / 524288** |

**States** (same as the PT/TC/LC/RTD boards):

```
WaitingForServer --SENSOR_CONFIG--> SelfTest --sends SELF_TEST--> Active
Active --NO_CONNECTION_ABORT (only if config.necessary_for_abort)--> StandaloneAbort
StandaloneAbort --CLEAR_ABORT--> Active
```

- **SENSOR_CONFIG**: the listed sensor IDs pick which connectors to stream. IDs other than 1–4 are ignored (with a log warning). `reference_voltage` doesn't apply to the FDC1004 and is ignored. `enable_serial_printing` = 0 drops USB logs to warnings only.
- **SELF_TEST**: `adc_good` = FDC1004 responding. Each requested channel passes if it has a recent, unsaturated reading (and ≥ `SELFTEST_MIN_PF`, which is 0/off until tuned on the bench). IDs CapFill doesn't have report as failed.
- **StandaloneAbort**: data and heartbeats also go to the abort controller IP from the config, port 5006 (same as the club core).
- **ABORT / actuator / stacklight packets**: ignored, like the other sense boards.
- **Engine state**: stored from server heartbeats and echoed in the board heartbeat. (The club's core always sends SAFE; the doc says boards should report the server's state, so CapFill does that.)

## Local outputs (bench use)

- **Serial**: one line per second: smoothed pF per channel, IP, DAQ state.
- **HTTP** `http://192.168.2.<BOARD_ID>/`: live table. `/readings` returns JSON with `board_id`, `daq_state`, `engine_state` and per-channel `pf`, `pf_avg`, `capdac`, `saturated`, `valid`, `samples`, `age_ms`. The DAQ server doesn't use this.

## Status LED (D6, yellow, IO16)

Same as the club boards: every 2.5 s it blinks N times, N = state.

| Blinks | Meaning |
|---|---|
| 1 | Waiting for server (no SENSOR_CONFIG yet) |
| 2 | Active, streaming |
| 9 | Standalone abort |
| 10 | Self test |
| Fast continuous flicker | FDC1004 not responding (CapFill only) |

## Sensor

- FDC1004 at 0x50 on I2C (SDA IO4, SCL IO5, 400 kHz), single-ended CIN1–CIN4 vs. CAPDAC, 100 S/s repeat mode.
- Auto-ranging: the chip measures ±15 pF around its CAPDAC offset; the driver moves CAPDAC (3.125 pF steps) when a reading passes ±10 pF. Usable range ≈ 0–110 pF per channel.
- If the sensor stops answering, the firmware retries every 2 s; the board keeps running without the Ethernet breakout.

## Pin map (from CapFill_3 schematics)

| Function | GPIO |
|---|---|
| I2C SDA / SCL | 4 / 5 |
| W5500 SCLK / MOSI / MISO | 39 / 40 / 41 |
| W5500 CS / INT / RST | 38 / 37 / 42 |
| Status LED | 16 |
| BOOT button | 0 |

All pins are in `main/board.h`.

## Check on the bench

- W5500 `MOSI`/`MISO` labels on J9 are assumed to be from the ESP32's side. If Ethernet init says "not responding", check this first.
- Set your laptop to 192.168.2.20/24 to act as the server (same as the club GUIs).
- Tune `SELFTEST_MIN_PF` in `daq_config.h`: read an empty connector and one with a probe, pick a value between them.
- Confirm with the server/GUI owners that raw counts (pF = value / 524288) is what they want for CapFill.

## Host tests (no board needed)

```bash
./test/run_host_tests.sh      # Linux (needs gcc, g++, python3, git; clones calstar repos into test/.ref)
```

1. **Packet compatibility**: CapFill's encoder vs. the club's DAQv2-Comms library compiled from source: heartbeat, sensor data and self test are byte-identical, and club-built SENSOR_CONFIG packets parse correctly.
2. **DAQ link**: the real `daq_link.c` runs against a fake server that decodes with the club GUI's own parser. Covers boot heartbeats, config → self test → active, channel selection, engine state, abort rules, abort-controller copies, clear abort, and garbage packets (23 checks).
3. **Sensor driver**: the real `fdc1004.c` vs. a simulated FDC1004: ID check, 0→105→0 pF sweep (worst error 0.002 pF), jumps, negative values, saturation and recovery.
4. **OTA**: the club's `ota_upload.py` sends `build/capfill-fw.bin` to the real `ota.c`; the received image is byte-identical.

What these can't prove: real I2C/SPI timing, the W5500 driver, the real FDC1004's behavior (the simulator follows the datasheet, so it shares any misreading of it), and flashing to a real OTA slot.

## Files

```
main/daq_config.h     BOARD_ID (placeholder!), IPs, ports, timing
main/diablo_proto.c/.h  packet encode/decode, byte-compatible with DAQv2-Comms
main/daq_link.c/.h    UDP socket, state machine, heartbeat, sensor data, self test
main/ota.c/.h         Ethernet firmware update (TCP 3232)
main/board.h          pin map
main/fdc1004.c/.h     sensor driver (repeat mode, auto CAPDAC)
main/eth.c/.h         W5500 + static IP
main/http_api.c/.h    bench web page and JSON
main/readings.c/.h    shared readings
main/status_led.c/.h  LED blink pattern
main/main.c           startup, sampling and logging tasks
partitions.csv        two 3 MB OTA slots
test/                 host test suite (run_host_tests.sh)
```
