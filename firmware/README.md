# Firmware

ESP32 firmware for every avionics board in the Diablo rocket — the code that
reads the sensors, talks to the ground DAQ server over Ethernet, and runs the
on-board abort logic during a hotfire. This directory is a subtree of
[`calstar/DiabloAvionics`](https://github.com/calstar/DiabloAvionics), vendored
into the STAR monorepo.

Built with [PlatformIO](https://platformio.org/); the boards are ESP32-S3
(and a few C6/C3) running the Arduino framework.

## Overview

Each board type runs a small state machine: it boots, self-tests its ADC and
sensors, waits for the server to send its configuration, then streams sensor
data and exchanges heartbeats. If it loses the server's heartbeat it can abort
autonomously. The packets it sends and receives are defined once, in
[`lib/DAQv2-Comms`](../lib/DAQv2-Comms/README.md) (reached here via the symlink
`libraries/DAQv2-Comms`), so the firmware and the
[`daq-server`](../daq-server/README.md) always agree on the wire format.

**The canonical flight code lives under [`Hotfire_Code/`](Hotfire_Code/).**
Everything else is either a shared library, a bench-test sketch, a calibration
tool, or archived hardware.

## Directory structure

```
firmware/
├── Hotfire_Code/              # flight firmware (canonical)
│   ├── PT_Hotfire/            #   pressure transducer board
│   ├── TC_Hotfire/            #   thermocouple board
│   ├── RTD_Hotfire/           #   RTD (temperature) board
│   ├── LC_Hotfire/            #   load cell board
│   ├── Actuator_Hotfire/      #   actuator/valve driver board
│   ├── ProtoEncoder/          #   encoder board prototype
│   ├── common/                #   shared flight headers (hotfire_config.h,
│   │                          #     SensorHotfireCore.h, firmware_hash.h, OTA)
│   └── Hotfire_Tests/         #   Unity unit tests (run on host, `-e native`)
├── common/                    # board pin maps + ADC mappings (sense/actuator)
├── libraries/                 # Arduino libraries (see "Libraries" below)
│   └── DAQv2-Comms -> ../../lib/DAQv2-Comms   # symlink to the wire protocol
├── platformio-common.ini      # shared PlatformIO env bases (esp32s3_base, ...)
├── ADC_Testing/               # standalone ADC bring-up / characterization sketches
├── Ethernet OTA Testing/      # over-the-air update validation
├── LC_Board/                  # load-cell calibration GUI + sketches
├── test_guis/                 # Python GUIs for bench-testing boards over the network
└── Archive/                   # deprecated boards & old DAQ versions — not built
```

> Top-level directories like `PT_Board/`, `RTD_Board/`, `Encoder_Board/`, and
> the `*_Testing/` trees are older bring-up code kept for reference. New flight
> work goes in `Hotfire_Code/`.

## Libraries

`libraries/` holds the Arduino libraries each board links against:

| Library | Origin | Notes |
|---|---|---|
| `DAQv2-Comms` | STAR (symlink) | wire protocol — see [`lib/DAQv2-Comms`](../lib/DAQv2-Comms/README.md) |
| `EthernetHandler` | STAR | W5500 Ethernet setup/config helper |
| `STAR_MCP3201` | STAR | MCP3201 SPI ADC driver |
| `STAR_ISM330DH` | STAR fork of SparkFun | IMU driver + STAR wake-up extensions |
| `STAR_LIS3DH` | Adafruit (upstream) | accelerometer driver, unmodified |
| `ads126X` | upstream (Molorius) | ADS126x precision ADC driver |

The STAR forks and upstream libraries keep their own licenses; don't reformat or
"clean up" the vendored ones.

## Build, test, flash

PlatformIO reads each project's `platformio.ini`. The shared environment bases
(board, platform, build flags) live in `platformio-common.ini`.

Install PlatformIO once:

```bash
pip3 install platformio --user      # provides the `pio` CLI
```

**Host unit tests (fast, no hardware):**

```bash
cd Hotfire_Code/Hotfire_Tests
pio test -e native
```

Covers the sensor/actuator state machines, ADS126X self-test, DAQv2-Comms packet
round-trips, and sensor data collection.

**Compile-check / build a flight project:**

```bash
cd Hotfire_Code/PT_Hotfire
pio run                              # build
pio run -t upload                    # flash over USB
pio device monitor -b 115200         # serial monitor
```

Each flight board sets its identity (`BOARD_ID`) at compile time via its
`platformio.ini` / `common/hotfire_config.h`; two boards must not share an ID
(they would collide on the same static IP). Updates can also be pushed
over Ethernet — see [`Ethernet OTA Testing/`](Ethernet%20OTA%20Testing/README.md).

## Documentation

- [`Hotfire_Code/common/FIRMWARE_HASH_VERIFICATION.md`](Hotfire_Code/common/FIRMWARE_HASH_VERIFICATION.md) — firmware SHA-256 hash verification (also reported in board heartbeats)
- [`Ethernet OTA Testing/README.md`](Ethernet%20OTA%20Testing/README.md) — OTA firmware update workflow
- [`test_guis/README.md`](test_guis/README.md) — Python bench-test GUIs
- [`LC_Board/LC_Calibration/LC_Calibration_Gui/README.md`](LC_Board/LC_Calibration/LC_Calibration_Gui/README.md) — load-cell calibration GUI
- [`ADC_Testing/`](ADC_Testing/) — ADC bring-up and noise-characterization sketches
- [`lib/DAQv2-Comms`](../lib/DAQv2-Comms/README.md) — the wire protocol both this firmware and the DAQ server speak
