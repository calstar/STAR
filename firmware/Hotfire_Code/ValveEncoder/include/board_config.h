#pragma once

#include <stdint.h>

#ifdef VALVE_BENCH_DEVKIT
#define PINS_ACTIVE_LAYOUT Devkit_Breadboard
#endif
#include "valve_encoder_board_pins.h"

#ifndef VALVE_ID
#define VALVE_ID 1
#endif

#ifndef RS485_BAUD
#define RS485_BAUD 115200
#endif

// STREAM: one cable per valve, send every STATUS_SEND_PERIOD_MS.
// POLLED: shared bus, send only when polled. Both modes answer POLLs.
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

// The PCB uses UART0's pins (43/44) but we drive them from UART1 so ESP-IDF
// log and panic output on UART0 can't land in our frames.
constexpr int RS485_UART_NUM = 1;

constexpr uint32_t I2C_CLOCK_HZ = 400000;

constexpr uint32_t ENCODER_READ_PERIOD_MS = 10;
constexpr uint32_t STATUS_SEND_PERIOD_MS = 20;
constexpr uint32_t CONSOLE_PRINT_PERIOD_MS = 200;

constexpr float DEFAULT_TOLERANCE_DEG = 5.0f;

}  // namespace cfg
