#pragma once

// Per-build settings for the Valve Encoder firmware. Most of these are set
// from platformio.ini build_flags so each valve can get its own ID without
// editing code.

#include <stdint.h>

// Which pin layout from firmware/common/valve_encoder_board_pins.h.
// The devkit env in platformio.ini sets VALVE_BENCH_DEVKIT.
#ifdef VALVE_BENCH_DEVKIT
#define PINS_ACTIVE_LAYOUT Devkit_Breadboard
#endif
#include "valve_encoder_board_pins.h"

// This valve's address on the RS-485 link (1..254). Two valves on the same
// Receiver Board must not share an ID.
#ifndef VALVE_ID
#define VALVE_ID 1
#endif

// Must match the Receiver Board. 8 data bits, no parity, 1 stop bit.
#ifndef RS485_BAUD
#define RS485_BAUD 115200
#endif

// How the board talks (ask the Receiver Board owner which one):
//   RS485_MODE_STREAM - one cable per valve: send status every
//                       STATUS_SEND_PERIOD_MS without being asked.
//   RS485_MODE_POLLED - several valves on one bus: send only in reply to a
//                       POLL addressed to VALVE_ID.
// Stream mode also answers POLLs, so a Receiver can ask either kind.
#if !defined(RS485_MODE_STREAM) && !defined(RS485_MODE_POLLED)
#define RS485_MODE_STREAM
#endif
#if defined(RS485_MODE_STREAM) && defined(RS485_MODE_POLLED)
#error "Define only one of RS485_MODE_STREAM / RS485_MODE_POLLED"
#endif

namespace cfg {

namespace pins = valve_encoder_board_pins;

constexpr uint8_t VALVE_ADDR = VALVE_ID;
static_assert(VALVE_ID >= 1 && VALVE_ID <= 254, "VALVE_ID must be 1..254");

constexpr uint32_t RS485_BAUD_RATE = RS485_BAUD;

// The ESP32-S3 has three UARTs. UART0 is the chip's boot/debug UART (its
// default pins are GPIO43/44, the ones the PCB uses). We drive those pins
// from UART1 instead, so ESP-IDF log or crash text written to UART0 can never
// mix into our packets. The USB port (Serial) is the human console.
constexpr int RS485_UART_NUM = 1;

constexpr uint32_t I2C_CLOCK_HZ = 400000;  // AS5600 supports up to 1 MHz

constexpr uint32_t ENCODER_READ_PERIOD_MS = 10;  // 100 Hz
constexpr uint32_t STATUS_SEND_PERIOD_MS = 20;   // 50 Hz (stream mode)
constexpr uint32_t CONSOLE_PRINT_PERIOD_MS = 200;

// Default "close enough to the end stop" window, used until one is saved.
constexpr float DEFAULT_TOLERANCE_DEG = 5.0f;

}  // namespace cfg
