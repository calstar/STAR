# Ethernet OTA Testing

Test environment for Over-The-Air (OTA) firmware updates on ESP32-S3 boards over Ethernet (W5500).

## What This Does

1. The ESP32 runs a firmware that prints a configurable message to Serial every 2 seconds
2. It also listens on a TCP socket for incoming firmware updates
3. A Python script recompiles the firmware with a **new message** baked in, then pushes the binary to the ESP32 over Ethernet
4. The ESP32 receives the firmware, writes it to the alternate flash partition, and reboots — now printing the new message

This validates that OTA updates work over the W5500 Ethernet module before deploying OTA to production hotfire boards.

## Folder Structure

```
Ethernet OTA Testing/
├── ota_upload.py              # Python script to compile + upload firmware
├── README.md                  # This file
└── OTA_Test_Firmware/         # PlatformIO project (ESP32-S3 firmware)
    ├── platformio.ini
    └── src/
        ├── main.h             # Config (pins from sense_board_pins.h, network, OTA params)
        └── main.cpp           # Firmware (Ethernet init, TCP OTA listener, serial print loop)
```

## Prerequisites

- **PlatformIO CLI** installed and in PATH (`pip install platformio`)
- **Python 3** (no extra pip packages needed)
- ESP32-S3 board with W5500 Ethernet module wired per DAQv2 pin assignments
- Computer and ESP32 on the same `192.168.2.x` subnet

## Quick Start

### 1. Initial Flash (USB)

```bash
cd "Ethernet OTA Testing/OTA_Test_Firmware"
pio run -t upload          # Flash via USB
pio device monitor -b 115200   # Watch serial output
```

You should see:
```
[MSG] Default OTA firmware -- not yet updated  |  uptime 0m 2s  |  IP 192.168.2.5
```

### 2. OTA Update (Ethernet)

```bash
cd "Ethernet OTA Testing"
python ota_upload.py --message "Hello from OTA!"
```

The script will:
1. **Compile** the firmware with your message baked in
2. **Connect** to the ESP32 at `192.168.2.5:3232`
3. **Upload** the binary with a progress display
4. The ESP32 **reboots** and starts printing the new message

### 3. CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--message` / `-m` | `"OTA update at <timestamp>"` | Message to bake into firmware |
| `--ip` | `192.168.2.5` | ESP32 IP address |
| `--port` / `-p` | `3232` | OTA TCP port |
| `--skip-compile` | off | Upload existing binary without recompiling |

## Configuration

- **Board type**: Defaults to PT board pin mapping. Change via `-DPINS_ACTIVE_LAYOUT=LC_Board` in `platformio.ini` build_flags
- **IP address**: Set in `main.h` → `OTA_STATIC_IP` (default `192.168.2.5`)
- **Ethernet pins**: Pulled from `common/sense_board_pins.h` (shared with hotfire code)
