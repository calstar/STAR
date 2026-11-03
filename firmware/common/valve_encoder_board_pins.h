#pragma once

// Pin map for the Valve Encoder Board (ball valve position sensor).
// Not the motorized-valve board (BallValve_Hotfire, board 71, Ethernet):
// this one has no network port and reports to the Receiver Board over RS-485.
//
//   AS5600 encoder --I2C--> ESP32-S3-WROOM-1 --UART--> MAX3485 --RS-485-->
//   Receiver Board
//
// Source: BALL_VALVE schematic set dated 2026-10-20 (MainSheet, Compute,
// RS485 Transceiver, Magnetic Encoder, Power). Checked against the netlist
// embedded in the schematic PDF.
//
// EVERY NUMBER HERE IS AN ESP32-S3 GPIO NUMBER, NOT A MODULE PAD NUMBER.
// The numbers printed next to U3's pins on the Compute sheet are the
// ESP32-S3-WROOM-1 pad numbers. Code needs GPIO numbers:
//
//   net          module pad     GPIO
//   TX           37 (TXD0)  ->  43
//   RX           36 (RXD0)  ->  44
//   DRIVER_EN    38 (IO2)   ->   2
//   RECEIVER_EN  39 (IO1)   ->   1
//   SDA          12 (IO8)   ->   8
//   SCL          17 (IO9)   ->   9
//   BOOT         27 (IO0)   ->   0
//
// For any pin that is not present on a board, set it to -1.

namespace valve_encoder_board_pins {

struct Layout {
    // ---- RS-485 transceiver (MAX3485, U4) ----
    // ESP32 TX -> MAX3485 DI (pin 4). Net "TX".
    int RS485_TX;
    // MAX3485 RO (pin 1) -> ESP32 RX. Net "RX".
    int RS485_RX;
    // MAX3485 DE (pin 3), ACTIVE HIGH: HIGH = drive the bus (transmit).
    // Net "DRIVER_EN".
    int RS485_DE;
    // MAX3485 /RE (pin 2), ACTIVE LOW: LOW = receiver on (listen),
    // HIGH = receiver off. The schematic net is called "RECEIVER_EN", but
    // the pin it drives is inverted, so writing HIGH turns the receiver OFF.
    int RS485_RE_N;

    // ---- AS5600 magnetic encoder (U6), I2C address 0x36 ----
    // 4.7 k pull-ups on the board (R12, R13).
    int ENC_SDA;
    int ENC_SCL;

    // ---- Misc ----
    // BOOT button (SW1, 10 k pull-up). Strapping pin: held LOW during reset
    // it puts the chip in download mode. Safe to read as an input afterwards.
    int BOOT_BUTTON;
    // Status LED driven by firmware. -1 on rev A: the red LED on the Power
    // sheet is wired straight to 3.3 V, so it is a power light only.
    int LED;
};

// Order here MUST match the struct above.

// The real PCB, rev A (schematic dated 2026-10-20).
constexpr Layout Valve_Encoder_RevA{
    // RS485_TX, RS485_RX, RS485_DE, RS485_RE_N
    43,
    44,
    2,
    1,

    // ENC_SDA, ENC_SCL
    8,
    9,

    // BOOT_BUTTON
    0,

    // LED
    -1,
};

// Breadboard bench setup: an ESP32-S3 dev kit + MAX3485/MAX485 breakout +
// AS5600 breakout, for testing before the PCB exists. Not GPIO43/44: on most
// S3 dev kits those run to the onboard USB-to-UART chip, which would fight the
// transceiver's RO output. SDA/SCL match the older Encoder_Board breadboard.
constexpr Layout Devkit_Breadboard{
    // RS485_TX, RS485_RX, RS485_DE, RS485_RE_N
    10,
    11,
    12,
    13,

    // ENC_SDA, ENC_SCL
    4,
    5,

    // BOOT_BUTTON
    0,

    // LED
    -1,
};

// Rev A schematic error: GPIO17 (pad 10) is wired to the GND net. Never set
// it as an OUTPUT on rev A hardware; driving it HIGH shorts 3.3 V to ground.
constexpr int REV_A_GPIO_TIED_TO_GND = 17;

#ifndef PINS_ACTIVE_LAYOUT
#define PINS_ACTIVE_LAYOUT Valve_Encoder_RevA
#endif

constexpr const Layout& Pins = PINS_ACTIVE_LAYOUT;

}  // namespace valve_encoder_board_pins
