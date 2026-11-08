#pragma once

// Pin map for the Valve Encoder Board: AS5600 -> ESP32-S3-WROOM-1 -> MAX3485
// -> RS-485 to the Receiver Board. Source: BALL_VALVE schematic, 2026-10-20.
//
// GPIO numbers, not the module pad numbers printed next to U3 on compute sheet:
//
//
//   net          pad          GPIO
//   TX           37 (TXD0)    43
//   RX           36 (RXD0)    44
//   DRIVER_EN    38 (IO2)      2
//   RECEIVER_EN  39 (IO1)      1
//   SDA          12 (IO8)      8
//   SCL          17 (IO9)      9
//   BOOT         27 (IO0)      0
//
// -1 = not present on this board.

namespace valve_encoder_board_pins {

struct Layout {
    // MAX3485 (U4)
    int RS485_TX;    // -> DI
    int RS485_RX;    // <- RO
    int RS485_DE;    // active high: HIGH = transmit
    int RS485_RE_N;  // active low, despite the net name RECEIVER_EN: HIGH = receiver off

    // AS5600 (U6), I2C 0x36, 4.7k pull-ups R12/R13
    int ENC_SDA;
    int ENC_SCL;

    int BOOT_BUTTON;  // SW1, strapping pin, fine to read after boot
    int LED;          // rev A LED is hard-wired to 3.3 V, so none
};


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

// ESP32-S3 dev kit + MAX3485 and AS5600 breakouts. Avoids GPIO43/44, which
// most dev kits wire to their USB-UART chip.
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

// Rev A schematic error: GPIO17 (pad 10) is tied to GND. Never make it an
// OUTPUT on rev A; driving it HIGH shorts 3.3 V.
constexpr int REV_A_GPIO_TIED_TO_GND = 17;

#ifndef PINS_ACTIVE_LAYOUT
#define PINS_ACTIVE_LAYOUT Valve_Encoder_RevA
#endif

// static, or including this header from two .cpp files is a duplicate symbol.
static constexpr const Layout& Pins = PINS_ACTIVE_LAYOUT;

}  // namespace valve_encoder_board_pins
