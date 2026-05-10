#pragma once

/**
 * Stacklight Driver PCB — GPIO assignments.
 *
 * Stack segments and buzzer drive external loads that turn ON when the GPIO is
 * pulled LOW (active-low). Initialize as OUTPUT HIGH (all off).
 */

namespace stacklight_pins {

// Stacklight outputs (active-low: ON = LOW, OFF = HIGH)
constexpr int PIN_YELLOW = 10;  // ORNG
constexpr int PIN_RED = 11;
constexpr int PIN_GREEN = 18;
constexpr int PIN_BUZZ = 19;

// W5500 / Ethernet SPI (same usage as other DAQv2 boards)
constexpr int ETH_CS = 15;
constexpr int ETH_MOSI = 16;
constexpr int ETH_SCLK = 17;
constexpr int ETH_MISO = 3;
constexpr int ETH_INT = 23;
constexpr int ETH_RST = 2;

// Extra drivers — unused for now; keep defined and idle HIGH
constexpr int PIN_EX1 = 20;
constexpr int PIN_EX2 = 21;
constexpr int PIN_EX3 = 22;

} // namespace stacklight_pins
