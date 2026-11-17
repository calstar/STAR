/*
 * STAR Prop Receiver: pin map and electrical constants.
 * Module: ESP32-S3-WROOM-1-N16R2 (U3). Pin numbers below are GPIO numbers, not module pad numbers.
 *
 * Source: routed netlist of STAR_Prop_Reciever/PCB3.PcbDoc (the PCB listed in the .PrjPcb),
 * cross-checked against the schematic sheets. Module pad -> net shown for each pin.
 *
 * Macros only: this header is also included by the host-side tests (no ESP-IDF types here).
 */
#pragma once

/* ---- Shared SPI bus: DAC80508 (U13) + W5500 breakout (J3) ---- */
#define PIN_SPI_SCLK      39   /* pad 32 -> R10 (0R) -> SCLK  -> U13.13, J3.4 */
#define PIN_SPI_MOSI      40   /* pad 33 -> R46 (0R) -> MOSI  -> U13.14, J3.3 */
#define PIN_SPI_MISO      41   /* pad 34 -> MISO -> U13.15 (DAC SDO), R47 (0R) -> J3.7 (W5500 MISO) */

/* ---- W5500 Ethernet breakout (J3) ---- */
#define PIN_ETH_CS        38   /* pad 31 -> CS  -> J3.5 */
#define PIN_ETH_INT       37   /* pad 30 -> INT -> J3.6 */
#define PIN_ETH_RST       42   /* pad 35 -> RST -> J3.8 */

/* ---- DAC80508 (U13) ---- */
#define PIN_DAC_CS        16   /* pad 9  -> CS_N -> U13.12 (/SYNC) */

/* ---- RS-485 (ST3485, CR1) ----
 * TX/RX: U0TXD/U0RXD pads go to nets NetCR1_4 (DI) / NetCR1_1 (RO).
 * WARNING: CR1 is in the schematic but NOT placed on PCB3, and the DRIVER_EN / RECEIVER_EN
 * ports are not wired to any ESP32 pin. DE and /RE below are free GPIOs chosen for a bodge
 * wire (or the next board revision). Change them to whatever you actually wire. */
#define PIN_RS485_TX      43   /* pad 37 -> NetCR1_4 -> ST3485 DI (pin 4) */
#define PIN_RS485_RX      44   /* pad 36 -> NetCR1_1 -> ST3485 RO (pin 1) */
#define PIN_RS485_DE      17   /* NOT ROUTED on PCB3: wire to ST3485 DE  (pin 3) */
#define PIN_RS485_RE_N    18   /* NOT ROUTED on PCB3: wire to ST3485 /RE (pin 2) */

/* ---- XTR111 output-disable lines, one per channel (OD_CRTL1..5) ----
 * On PCB3 these nets (GPIO07..GPIO11) reach only the R33 10k pull-downs; the XTR111 OD pin (9)
 * is tied to GND, so the outputs are always enabled in hardware. Firmware still drives them so it
 * works once OD is routed. Channel mapping verified per sheet instance (R33 / U14 / R37 copies). */
#define PIN_OD_CRTL_1      7   /* pad 7  */
#define PIN_OD_CRTL_2      8   /* pad 12 */
#define PIN_OD_CRTL_3      9   /* pad 17 */
#define PIN_OD_CRTL_4     10   /* pad 18 */
#define PIN_OD_CRTL_5     11   /* pad 19 */

/* XTR111 OD: high = output disabled, low = enabled. So "enable" means drive the line LOW. */
#define OD_CRTL_ENABLE_LEVEL 0

/* ---- Loop feedback, ADC1 (MOTOR_ADC_1..5) ----
 * On PCB3 these pads sit directly on the 20mA_n output nets (MOSFET drain, R40-R44 sense resistor,
 * 3.6 V Zener D4-D8, C24-C28, C20, C23). */
#define PIN_MOTOR_ADC_1    1   /* pad 39 -> 20mA_1 */
#define PIN_MOTOR_ADC_2    2   /* pad 38 -> 20mA_2 */
#define PIN_MOTOR_ADC_3    4   /* pad 4  -> 20mA_3 */
#define PIN_MOTOR_ADC_4    5   /* pad 5  -> 20mA_4 */
#define PIN_MOTOR_ADC_5    6   /* pad 6  -> 20mA_5 */

/* ---- DAC80508ZC (U13) configuration, per TI datasheet SLASEL1D ----
 * VOUT0..4 -> 1k/10nF RC (R28-R32, C13-C17) -> XTR111 VIN (channel n uses DAC register 0x08+n-1).
 * Output range = VREF / DIV * GAIN (datasheet Table 1). Allowed combinations:
 *   DIV 2, GAIN 1: 0..1.25 V    DIV 2, GAIN 2: 0..2.5 V    DIV 1, GAIN 2: 0..5.0 V    (DIV 1, GAIN 1: "not recommended")
 * Reference headroom (Recommended Operating Conditions, VDD 3.3-5.5 V):
 *   divider disabled (DIV 1): VREF <= VDD/2   -> needs VDD >= 5.00 V for the 2.5 V internal reference
 *   divider enabled  (DIV 2): VREF <= VDD
 * Violating it raises a reference alarm and forces ALL outputs to 0 V. DAC VDD here comes from the 5.0 V LDO
 * (TPS7A2150, +/-1.5%) through a load switch, so it sits slightly below 5 V: DIV 1 is out of spec. Use DIV 2. */
#define DAC_VREF_V         2.5f       /* internal reference */
#define DAC_REF_DIV        2          /* 1 or 2 (REFDIV-EN) */
#define DAC_BUFF_GAIN      2          /* 1 or 2 (BUFFn-GAIN), applied to the 5 used channels */
#define DAC_VDD_MIN_V      4.85f      /* worst-case DAC VDD on this board, used by test_pins */
#define DAC_FULL_SCALE_V   (DAC_VREF_V / DAC_REF_DIV * DAC_BUFF_GAIN)
/* The "C" variant has a CLR input instead of SDO on pin 15, and PCB3 ties that pin to the shared MISO line.
 * main.c sets CLR-0TO3-MSK / CLR-4TO7-MSK so MISO traffic cannot clear the outputs, and skips SPI readback
 * (there is no SDO). Set to 0 only if you fit a DAC80508Z (SDO variant). */
#define DAC_HAS_CLR_PIN    1

/* ---- XTR111 (U14) ----
 * I_out = 10 * V_in / R_SET, R_SET = R35 = 2 kOhm (as built) -> full scale 2.5 V gives 12.5 mA.
 * For a 0-20 mA range: fit R35 = 1.24 kOhm (E96) and set LOOP_RS_OHMS 1240.0f, LOOP_MA_MAX 20.0f. */
#define XTR111_GAIN        10.0f
#define LOOP_RS_OHMS       2000.0f    /* R35 (R_SET). Change if you fit a different resistor. */
#define LOOP_MA_MAX        12.5f      /* highest accepted set-point; must not exceed the DAC/R_SET full scale */

/* Feedback: V_adc = I_loop * R_sense. Schematic value of R40-R44 is 150 ohm (1.9 V at 12.5 mA, 3.0 V at 20 mA).
 * NOTE: the BOM part for R40-R44 is 316KR2F (316 kOhm). Fit 150 ohm or the reading clamps at the Zener. */
#define FB_SENSE_OHMS      150.0f
#define FB_MA_PER_V        (1000.0f / FB_SENSE_OHMS)
#define FB_OFFSET_MA       0.0f
