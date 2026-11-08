# ValveEncoder

Firmware for the Valve Encoder Board: an AS5600 magnetic encoder on a ball
valve stem, read by an ESP32-S3, reported to the Receiver Board over RS-485
(MAX3485).

- `src/as5600.cpp` reads the encoder
- `include/valve_state.h` turns the angle into CLOSED / OPEN / MOVING / FAULT / UNKNOWN
- `src/rs485_link.cpp` sends it; frame format in `include/valve_protocol.h`
  (draft, not yet agreed with the Receiver Board)

Pins are in [`../../common/valve_encoder_board_pins.h`](../../common/valve_encoder_board_pins.h)
as GPIO numbers, not the module pad numbers on the schematic.

## Build, test, flash

```bash
cd firmware/Hotfire_Code/ValveEncoder
pio test -e native                  # host unit tests
pio run                             # PCB build (env valve_encoder)
pio run -e valve_encoder -t upload  # flash over USB-C
pio device monitor -b 115200        # console, type h
pio run -e valve_encoder_devkit     # breadboard pin layout
```

If upload can't find the board: hold BOOT, tap RESET, release BOOT, retry.

## Settings (`platformio.ini` build_flags)

| Flag | Default | Meaning |
|---|---|---|
| `VALVE_ID` | 1 | 1..254, unique per Receiver Board |
| `RS485_BAUD` | 115200 | Must match the Receiver Board |
| `RS485_MODE_STREAM` / `RS485_MODE_POLLED` | STREAM | One cable per valve (send at 50 Hz) or shared bus (answer POLLs only) |
| `VALVE_BENCH_DEVKIT` | off | Breadboard pin layout |

## Calibrate (once per valve)

Stored in NVS, survives reflashing.

1. `pio device monitor`, check `magnet=yes` and no TOO-WEAK / TOO-STRONG.
2. Turn the valve fully closed, type `c` Enter.
3. Turn it fully open, type `o` Enter.
4. Sweep it: state should read CLOSED -> MOVING -> OPEN.

## Watch the RS-485 output from a laptop

USB-to-RS-485 adapter: A to J2 pin 1, B to J2 pin 2, GND to board GND.

```bash
pip install pyserial
python3 tools/rs485_monitor.py --list
python3 tools/rs485_monitor.py --port /dev/ttyUSB0            # stream mode
python3 tools/rs485_monitor.py --port /dev/ttyUSB0 --poll 1   # polled mode
```

Only bad frames? Swap A and B.
