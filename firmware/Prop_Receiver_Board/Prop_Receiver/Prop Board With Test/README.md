# STAR Prop Receiver firmware (ESP-IDF)

Target: ESP32-S3-WROOM-1-N16R2, ESP-IDF **v5.3 or newer** (build-verified on v5.5.3).
Board: `../STAR_Prop_Reciever` (Altium project; the routed layout is **PCB3.PcbDoc**).
Datasheets: `../Prop Receiver/` (DAC80508, ESP32-S3-WROOM-1, USB4105). Not yet run on hardware.

## Datasheet check
| Part | What was checked | Result |
|---|---|---|
| DAC80508 (SLASEL1D) | register addresses, 24-bit frame (R/W bit 23, address 19:16), SPI mode 1 (SDI on falling edge), soft-reset code 1010, GAIN/CONFIG bits, DEVICE_ID layout | matches `main.c` |
| DAC80508 | output range table, reference headroom | **changed**: 0-5 V (DIV 1, GAIN 2) needs VDD >= 5.00 V, which this board can't guarantee; now DIV 2, GAIN 2 = 0-2.5 V |
| DAC80508**ZC** | variant table: "C" parts have **CLR instead of SDO** on pin 15 | **changed**: pin 15 is on MISO, so firmware sets the CLR masks and skips readback |
| ESP32-S3-WROOM-1 | pad numbers (Table 3-1), ADC1 channels, strapping pins, IO35-37 on N16R2, EN RC (10k/1 uF) | all match `pins.h` and the board |
| USB4105 | contact ratings, A/B pin use | board matches (D+ A6/B6, D- A7/B7, CC A5/B5 via 5.1k) |

## Folder layout
```
Prop Board With Test/
  CMakeLists.txt         ESP-IDF project file           } firmware: what gets
  sdkconfig.defaults     target, flash size, console,   } built and flashed
                         W5500 driver                   }
  main/
    main.c               ESP-IDF glue: SPI, DAC80508, W5500, ADC, UART, NVS, tasks
    prop_core.c/.h       protocol, sequencing, failsafe (pure C, unit-tested)
    pins.h               pin map + electrical constants (from the PCB3 netlist)
    CMakeLists.txt
  tools/
    prop_ctl.py          command-line client (UDP)
  test/                  host-side tests only; never built into the firmware
    Makefile, run_tests.sh, test_protocol.py
    host/  test_core.c  test_pins.c  sim_udp.c
```

## Build / flash
    idf.py set-target esp32s3
    idf.py build
    idf.py -p <PORT> flash monitor      # USB-C port (IO19/IO20); hold BOOT + tap EN if needed

## Pin map (from PCB3.PcbDoc)
| Function | GPIO | Notes |
|---|---|---|
| SPI SCLK / MOSI / MISO | 39 / 40 / 41 | shared by DAC80508 and W5500 (R10/R46/R47 are 0 ohm) |
| W5500 CS / INT / RST | 38 / 37 / 42 | J3 breakout header |
| DAC80508 /SYNC | 16 | |
| RS-485 TX / RX | 43 / 44 | UART0 pins, driven by UART1; console is on USB |
| RS-485 DE / /RE | 17 / 18 | **not routed on PCB3**; free pins picked for a bodge wire |
| OD_CRTL1..5 | 7, 8, 9, 10, 11 | reach only R33 pull-downs (see board issues) |
| MOTOR_ADC_1..5 | 1, 2, 4, 5, 6 | ADC1, on the 20mA_1..5 nets |

Channel n = DAC VOUT(n-1) → XTR111 copy n → 20mA_n. I checked this against each sheet instance in the PCB.

## Before first power-up
1. Fix the board issues below. The analog outputs cannot work on PCB3 as it is.
2. `pins.h`: `LOOP_RS_OHMS` = R35 (2 k), `FB_SENSE_OHMS` = R40-R44 (150 ohm by schematic value).
   The DAC runs at 0-2.5 V (REF-DIV 2, gain 2, in spec at VDD below 5 V). With R35 = 2 k that is
   **0-12.5 mA** (`LOOP_MA_MAX` 12.5). **For 0-20 mA, fit R35 = 1.24 k**, then set `LOOP_RS_OHMS 1240.0f`
   and `LOOP_MA_MAX 20.0f`. The tests follow these values automatically.
3. `OD_CRTL_ENABLE_LEVEL` is 0: XTR111 OD high = disabled.
4. First bring-up: use a dummy load and a meter, not a real actuator.

## Board issues found in the Altium files (PCB3.PcbDoc + schematics)
Firmware cannot work around these.
1. **The 24V net has no source.** It reaches only XTR111 pin 1 (VSP). The board's only inputs are the
   5.5 V XT30 (J18) and USB. The XTR111 needs 7 V or more, so all five current outputs are unpowered.
   Also check the R34 (15 ohm) / P-FET source wiring against the XTR111 typical application.
2. **DAC VDD is unconnected.** U13 pin 7 is on net `+5V`, but the Power sheet makes net `5V`. The names differ,
   so they never join. `+5V` touches only C11/C12.
3. **The DAC filter caps are in series.** C13-C17 sit between the R28-R32 node and XTR111 VIN, with no pin on GND.
   That blocks DC, so VIN never sees the DAC voltage. Fix: cap pin 2 to GND, and take `DAC_CHn` from the R/C node.
4. **XTR111 OD (pin 9) is tied to GND**, so the outputs are always enabled. OD_CRTL (IO7-11) reaches only R33.
   When you route OD, swap R33 to a **pull-up**: with a pull-down, the outputs come up enabled at reset.
5. **The RS-485 transceiver (CR1, ST3485) is not on PCB3.** It is in the schematic but was never pushed to the PCB.
   IO43/IO44 end on single-pad nets. In Compute.SchDoc, the DRIVER_EN/RECEIVER_EN ports are not wired to any
   GPIO. They sit just next to the GPIO01/GPIO02 labels, which are ADC pins, so do not connect them there.
   Run Design > Update PCB, and wire DE and /RE (default IO17/IO18 in `pins.h`). Add a pull-down on DE so the
   bus stays quiet during boot.
6. **No connector carries the 20mA_n outputs.** J1 and J5-J12 are all RS-485 taps (each leg through a resistor).
   MOTOR_ADC_n is merged with 20mA_n, so each ADC pin sits on the output node with only the 3.6 V Zener
   protecting it. 3.6 V is at the ESP32 absolute maximum, so add a series resistor.
7. **BOM part numbers do not match the schematic values.** Assembly from the BOM would fit the wrong parts:
   - R40-R44: value 150, part 316KR2F (316 k). The feedback would just clamp.
   - C24-C28: value 100 nF, part 82 pF.
   - C11/C18 (100 nF), C22 (1 uF), C23 (100 nF, on the loop output): part is 15 uF.
   - RS-485 sheet: all 21 resistors use the 750R part. The values say 10 (series), 120 (R21 termination)
     and 1k (R17/R27 bias).
8. **Power path.** U16 (USB load switch) has its ON pin on `5V_INTER`, so USB power only passes when the XT30
   input is present. The board cannot run or be flashed from USB alone. With both inputs present, U4 and U16
   both drive `5V`.
9. **XTR111 REGF (pin 5) of all five channels are tied together** on `+5` (a power port merged across
   instances), along with the REF3040 input.
10. **DAC CLR pin on the MISO bus.** U13 is a DAC80508**ZC**: pin 15 is the CLR input, not SDO, but it is
   wired to MISO. Firmware masks CLR (GAIN bits 9/10) right after reset, so W5500 traffic can't zero the
   outputs. DAC registers can't be read back. If you want readback, fit a DAC80508Z (no C).
11. **ACTUAL.PcbDoc is empty** (board outline only) and is not part of the project. PCB3.PcbDoc is the real layout.

Fixed since the earlier review: the USB-C CC resistors (R8/R9) are now 5.1 k, and XTR111 VIN is no longer on the GND net.

## What the firmware does
- Outputs start DISABLED and at 0 mA. A channel drives only after `enable` and `set`.
- Failsafe: if no valid command arrives for `timeout` ms (default 2000) while any channel is enabled,
  all channels go to 0 mA and disabled. `timeout 0` turns it off.
- Ethernet: W5500 via `esp_eth`, DHCP (or static IP via `USE_STATIC_IP`), UDP server on port 5005.
- RS-485: UART1, 115200 8N1, same protocol. DE and /RE are driven together around each transmit.
- USB-C: log output and flashing through USB Serial/JTAG.
- Per-channel calibration (`gain`, `offset_mA`) is stored in NVS.

## Frame format (UDP datagram or RS-485 stream)
    0xA5 | addr | cmd | len | payload[len] | crc16 (lo, hi)
CRC16 is Modbus (poly 0xA001, init 0xFFFF) over addr..payload. The node address is 0x01. 0xFF is broadcast
(executed, never answered). Replies use `cmd | 0x80`, and payload[0] is the status (0 = OK).

| cmd  | name        | payload                          |
|------|-------------|----------------------------------|
| 0x01 | PING        | none                             |
| 0x02 | SET_MA      | ch u8 (0-4), mA f32              |
| 0x03 | SET_ALL_MA  | 5 x f32                          |
| 0x04 | SET_ENABLE  | mask u8                          |
| 0x05 | GET_STATUS  | none (reply: mask, 5 targets, 5 fb mV u16, 5 fb mA f32) |
| 0x06 | ESTOP       | none                             |
| 0x07 | SET_CAL     | ch u8, gain f32, offset mA f32   |
| 0x08 | SET_TIMEOUT | ms u16                           |

## CLI (channels are 1-5 here, like the board nets)
    python3 tools/prop_ctl.py <board-ip> ping
    python3 tools/prop_ctl.py <board-ip> enable 0x01
    python3 tools/prop_ctl.py <board-ip> set 1 12.0
    python3 tools/prop_ctl.py <board-ip> status
    python3 tools/prop_ctl.py <board-ip> estop
The board prints its IP on the USB console after DHCP.

## Tests (no hardware needed)
Requirements: gcc, make, python3 (standard library only). On Windows, run them in WSL.

    cd test
    make test          # or ./run_tests.sh

1. `host/test_core.c`: about 400-480 checks (depends on the output range) on the real `prop_core.c`, using a mock DAC/GPIO/NVS. Built with ASan + UBSan.
2. `host/test_pins.c`: sanity checks on `pins.h`: duplicate pins, pins that don't exist on the module,
   USB/BOOT pins, ADC1-only feedback pins, and DAC/R_SET/feedback scale consistency. It also checks the DAC80508
   datasheet rules: no DIV 1/GAIN 1, and VREF headroom at the worst-case VDD (`DAC_VDD_MIN_V`).
3. `test_protocol.py`: starts `host/sim_udp.c` (the same core behind a UDP socket, with a simulated
   DAC → current → feedback chain). It sends real packets and also exercises `tools/prop_ctl.py`.

Against the real board: `BOARD_IP=192.168.1.50 python3 test_protocol.py -v`. This adds a latency test and an
idle-ADC test. Build output goes to `test/build/` (override with `make BUILD=/some/dir`).

Not covered: `main.c` (the ESP-IDF glue). It compiles, but it needs a first-boot check on the board.
