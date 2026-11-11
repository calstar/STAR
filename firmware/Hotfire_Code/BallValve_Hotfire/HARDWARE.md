# STAR Prop Receiver v2: firmware notes

Everything you need from the hardware to write firmware for this board. Pin numbers,
values and designators come from the schematic in `schematica/generated/`
(`mcu.SchDoc`, `channel.SchDoc` (placed twice, as ch1 and ch2), `power.SchDoc`).

## What the board does

- An ESP32-S3 takes setpoints over Ethernet (W5500) and drives two 4–20 mA actuator command
  loops.
- Each loop runs from an MCP4728 DAC channel into an XTR111 voltage-to-current converter.
- For each channel it reads back:
  - the actuator's 4–20 mA feedback signal
  - the command loop's return current, which lets the firmware check that the commanded
    current is really flowing
  - the XTR111 error flag
- It also monitors the 24 V input.

## Module

| Item | Value |
|---|---|
| MCU | ESP32-S3-WROOM-1-**N16R2** (U3) |
| Flash | 16 MB, quad (QIO), 3.3 V |
| PSRAM | 2 MB **quad** (set `CONFIG_SPIRAM_MODE_QUAD`, not octal) |
| Antenna | Present on the module but not planned to be used (layout not kept clear for it). Treat Wi-Fi/BLE as best-effort. |

## GPIO map

| GPIO | Module pin | Net | Direction | Notes |
|---|---|---|---|---|
| IO0 | 27 | BOOT | in | 10 kΩ pull-up (R2), BOOT button SW2 to GND. Usable as a user button after boot (active low). |
| EN | 3 | EN | — | 10 kΩ pull-up (R1) + 1 µF (C4) RC delay, RESET button SW1 |
| IO1 | 39 | RET2 | ADC1_CH0 | ch2 command-return current sense |
| IO2 | 38 | FB2 | ADC1_CH1 | ch2 actuator feedback sense |
| IO5 | 5 | RET1 | ADC1_CH4 | ch1 command-return current sense |
| IO7 | 7 | FB1 | ADC1_CH6 | ch1 actuator feedback sense |
| IO9 | 17 | V24_MON | ADC1_CH8 | 24 V input monitor |
| IO10 | 18 | SPI_MOSI | out | W5500 |
| IO11 | 19 | SPI_SCLK | out | W5500 |
| IO12 | 20 | ETH_CS | out | W5500 chip select, active low |
| IO13 | 21 | ETH_INT | in | W5500 interrupt, active low (enable the internal pull-up; the breakout may not have one) |
| IO14 | 22 | ETH_RST | out | W5500 reset, active low |
| IO21 | 23 | SPI_MISO | in | W5500 |
| IO15 | 8 | FAULT1 | in | ch1 XTR111 EF, open drain, 10 kΩ pull-up (R12), **low = fault** |
| IO40 | 33 | FAULT2 | in | ch2 XTR111 EF, open drain, 10 kΩ pull-up (R19), **low = fault** |
| IO47 | 24 | I2C_SDA | i/o | MCP4728, 4.7 kΩ pull-up (R6) |
| IO48 | 25 | I2C_SCL | out | MCP4728, 4.7 kΩ pull-up (R5) |
| IO19 / IO20 | 13 / 14 | USB_DN / USB_DP | — | Native USB on USB-C (J3). Leave these alone. |

- **ADC unit:** every analog input is on ADC1, so readings keep working while Wi-Fi is on.
  ADC2 is shared with Wi-Fi and isn't used.
- **Unconnected pins:** IO3, IO4, IO6, IO8, IO16–18, IO35–39, IO41, IO42, IO45, IO46 and
  TXD0/RXD0 have no connection and no header. There is no spare I/O to bring out without
  rework.
- **Strapping pins:** IO3, IO45 and IO46 are left floating, so their internal default pulls
  apply. Don't drive them during boot.

## Programming and console

- **No USB-UART bridge.** Flashing and the console both go through the ESP32-S3's built-in
  USB-Serial-JTAG on the USB-C port. UART0 isn't brought out.
- **Firmware console:** use `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG`.
- **Auto-reset:** esptool can reset the chip into download mode over USB-Serial-JTAG. If the
  firmware takes over the USB peripheral with TinyUSB/OTG, auto-reset stops working.
- **Manual download mode:** hold BOOT, tap RESET, release BOOT.
- **JTAG debugging:** works over the same USB cable (OpenOCD `esp32s3-builtin.cfg`).

## Power and what is alive when

| Source | Powers |
|---|---|
| 24 V XT60 (J1) | Motor power (V_MOTOR on each GX12 through a 5 A blade fuse) and the XTR111s (VSP) |
| 5.5 V XT30 (J2) or USB VBUS | OR'd through Schottkys D3/D4 → 0.5 A PTC (F1) → TLV1117LV33 → 3.3 V logic |

- **24 V does not power the logic.** The ESP32, DAC and W5500 run from 5.5 V or USB only.
- **On USB power alone, the 24 V side is dead:**
  - the XTR111s are unpowered, so the loop outputs give nothing;
  - the EF pins are not meaningful;
  - the feedback inputs read about 0.
- **Gate the channel logic on 24 V:** check `V24_MON` before trusting EF or raising loop
  faults.
- **Grounds:** motor/24 V return (HVGND) joins logic GND at a single 0 Ω link (R28) by the
  XT60.

## 24 V monitor (IO9)

- **Divider:** 100 kΩ (R7) over 10 kΩ (R8), filtered by 100 nF (C16), about a 0.9 ms time
  constant.
- **Conversion:** `V24 = V_adc × 11.0`. 24 V reads as 2.18 V at the pin.
- **Range:** about 34 V full scale at 12 dB attenuation.
- **Accuracy:** resistors are 1 %, so expect about ±2 % before calibration.
- **Suggested thresholds:**
  - treat the 24 V as missing below about 18 V;
  - flag over-voltage above about 28 V (the input TVS, D1 SMBJ26A, starts conducting at
    about 29 V).

## Command output: MCP4728 → XTR111

- **DAC:** MCP4728-E/UN (U2) on I2C (SDA IO47, SCL IO48).
  - **Bus speed:** 400 kHz is fine.
  - **Address:** factory default `0x60` (A2..A0 = 000, stored in its EEPROM).
  - **LDAC:** tied to GND, so every write updates the output immediately. No LDAC pulse is
    needed. This also means the MCP4728 I2C address-change command can't be used.
  - **RDY/BSY:** not connected. After an EEPROM write, wait at least 50 ms, or poll the
    BSY bit over I2C.

| DAC channel | Drives | Board parts |
|---|---|---|
| A (VOUTA) | ch1 command | XTR111 U4, P-FET Q1, GX12 J5 |
| B (VOUTB) | ch2 command | XTR111 U5, P-FET Q3, GX12 J6 |
| C, D | not connected | — |

### Scaling

- **XTR111 transfer:** `I_out = 10 × V_in / R_SET`, with R_SET = 1.00 kΩ (0.1 %, R11 and
  R18), so **10 mA per volt**.
- **DAC setting:** use the **internal 2.048 V reference, gain ×1**. That gives 0.5 mV per
  code, or **5 µA per code**:

```
code = round(I_mA * 200)        // 4 mA -> 800, 12 mA -> 2400, 20 mA -> 4000
I_mA = code / 200.0             // full scale 4095 -> 20.475 mA
```

- **Output current limit:** the hardware limits output current to about 40 mA (Q2 with a
  15 Ω sense resistor). The DAC can't command above 20.475 mA, so this limit only acts on a
  fault.
- **XTR111 output:** the OD (output-disable) pin is tied to GND, so the output is always
  enabled. The only way to "turn off" a loop is to command 0 mA (code 0).
- **Input filter:** 1 kΩ + 10 nF (10 µs) on the XTR111 input, so steps settle in well under
  1 ms.

### Power-up and reset state (important)

- **On power-up the MCP4728 loads its EEPROM.** The board was designed assuming that
  EEPROM holds **internal reference, gain ×1, code 800 → 4 mA** on channels A and B, so
  the actuators see a valid "minimum" command before the firmware runs.
- **New chips come from the factory with VREF = VDD and code 0** (0 mA). Program each board
  once, using sequential write (`0x50`) or single write (`0x58`), the two commands that also
  write the EEPROM, with:
  - **VREF bit = 1** (internal reference);
  - **gain = ×1**;
  - **PD = 00** (normal operation);
  - **code = 800** (4 mA, or whatever safe value you choose).
- **Get the VREF bit right.** With VREF = VDD (3.3 V), code 800 would give about 6.4 mA
  instead of 4 mA.
- **An ESP32 reset does not reset the DAC.** On a crash or watchdog reset the loops hold
  the **last commanded current** until the firmware writes again.
  - Write a safe value as early in `app_main` as possible.
  - Add a comms-loss timeout that drives both channels to the safe value when no setpoint
    has arrived for N ms.
- **Fast writes:** use the "fast write" command (`0b00xx…`, both channels in one
  transaction) for setpoint updates. It writes only the DAC input registers, not the
  EEPROM.

## Analog read-back (per channel)

Both senses are 120 Ω 2512 resistors to GND, each followed by:
- a 10 kΩ series resistor;
- 100 nF to GND (about a 1 ms filter);
- a BAT54S clamp to GND and 3.3 V.

```
I_mA = V_adc / 0.120            // 4 mA -> 0.48 V, 20 mA -> 2.40 V
```

| Signal | GPIO (ch1 / ch2) | What it measures |
|---|---|---|
| FB | IO7 / IO2 | Current the actuator *sources* into GX12 pin 3 (its 4–20 mA position feedback) |
| RET | IO5 / IO1 | Command-loop current coming back on GX12 pin 5 after passing through the actuator's input. This is the **actual delivered command current**. |

- **ADC setup:** use `ADC_ATTEN_DB_12` (about 0–3.1 V usable), which gives about 25.8 mA
  full scale.
- **Calibration:** use the esp_adc calibration scheme (`adc_cali_create_scheme_curve_fitting`).
  Uncalibrated ESP32-S3 readings can be off by tens of mV, which is about 0.3 mA here.
- **Averaging:** average 16–64 samples per reading.
- **Board calibration:** if you need better than about ±1 % accuracy, store a per-board
  offset and gain for each input in NVS. Calibrate against a meter: command 4 and 20 mA and
  read RET.
- **Input protection:** each input has a 50 mA, 60 V PTC fuse (F2/F5 for FB, F6/F7 for RET)
  and a SMBJ26A TVS.
  - If a pin is shorted to 24 V, the PTC trips and the input then reads about 0 mA until the
    short is removed.
  - The PTCs reset by themselves. The firmware sees the trip as an open loop.

### Suggested fault logic

The thresholds follow the NAMUR NE43 convention.

| Condition | Detection |
|---|---|
| 24 V missing | `V24 < ~18 V`. Suppress every loop fault below while it holds. |
| Command loop open (cable unplugged, broken wire, actuator input dead, PTC tripped) | `RET < 3.6 mA` while commanding ≥ 4 mA, and/or `FAULT` low |
| Command loop not tracking | `abs(RET - setpoint) > ~0.5 mA` for longer than about 10 ms |
| Feedback lost | `FB < 3.6 mA` |
| Feedback over-range or short | `FB > 21 mA` |
| XTR111 error | `FAULT` GPIO low (EF goes low when the XTR111 can't regulate the current: open loop, or the load needs more voltage than the 24 V supply can provide). TI quotes about 650–700 µs from fault to flag, so debounce it about 1 ms. |

## GX12-5 motor connectors (J5 = ch1, J6 = ch2)

| Pin | Signal |
|---|---|
| 1 | +24 V motor power (through 5 A blade fuse F3 / F4) |
| 2 | 4–20 mA command out (XTR111 loop, sourced from 24 V) |
| 3 | 4–20 mA feedback in (actuator sources current, sensed on 120 Ω to GND) |
| 4 | GND / 24 V return (HVGND) |
| 5 | 4–20 mA command return (must be isolated from GND inside the actuator) |

## Ethernet: W5500 breakout (J4, HiLetgo module)

- **ESP-IDF driver:** the built-in W5500 driver works: `esp_eth_mac_new_w5500` +
  `esp_eth_phy_new_w5500` over SPI2 (`SPI2_HOST`).
  - `int_gpio_num = 13`
  - `phy_reset_gpio_num = 14`
  - CS = 12
- **SPI clock:** the SPI pins aren't SPI2's dedicated IO_MUX pins, so SPI is routed through
  the GPIO matrix, which caps the clock. **20 MHz** is safe and well above what 10/100 needs.
- **MAC address:** the W5500 doesn't have one. Use the ESP32's eFuse MAC
  (`esp_read_mac(mac, ESP_MAC_ETH)`) and set it on the driver.
- **Power and clock:** the breakout is powered from the board's 3.3 V and has its own
  25 MHz crystal and magnetics.

## Indicators and buttons

- **D5 (red):** hard-wired 3.3 V power LED. It is not on a GPIO, so there is **no
  firmware-controlled status LED**.
- **SW1:** RESET (EN).
- **SW2:** BOOT (IO0). It can be read as a button at runtime.

## Test points

| TP | Net |
|---|---|
| TP1 | +24 V |
| TP2 | 5V5_IN (after the PTC, LDO input) |
| TP3 | +3V3 |
| TP4 | GND |

## Bring-up checklist

1. **USB only:**
   - check 3.3 V on TP3;
   - flash a blink/console build over USB-C;
   - confirm the I2C scan shows `0x60`.
2. **Program the MCP4728 EEPROM:** internal VREF, gain ×1, code 800 on channels A and B.
   Read it back.
3. **Add 24 V:** check `V24_MON` reads correctly.
4. **Test each loop into a 250 Ω test load** between GX12 pins 2 and 5, with pin 5 not
   grounded:
   - command 4, 12 and 20 mA;
   - check RET reads the same current;
   - check the voltage across the 250 Ω (1, 3 and 5 V).
5. **Open the loop:** check FAULT goes low and RET drops to about 0.
6. **Check FB:** drive pin 3 from a 4–20 mA calibrator and verify the FB reading.
7. **Ethernet:** confirm link and DHCP, then check that comms-loss drops both outputs to
   the safe value.
