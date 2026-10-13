#pragma once

/**
 * Motor Testing bench board (ESP32-WROOM-32) — GPIO assignments.
 *
 * PIN_MOTOR_ENABLE drives the gate of an N-channel MOSFET that pulls the 4-20 mA
 * driver's enable input to GND; a 10k pull-up to 5 V holds the input HIGH
 * otherwise. So the output is active-low: ON = LOW, OFF = HIGH.
 *
 * GPIO2 is a strapping pin that must be LOW or floating to enter download mode,
 * so the MOSFET module's gate pull-down is fine here (on GPIO0 it held the
 * board in download mode). The cost: that pull-down holds the gate LOW, i.e.
 * the driver ON, from reset until setup() drives the pin, and for the whole of
 * a USB upload. GPIO2 is also the dev board's blue LED: lit = motor OFF.
 */

namespace motor_testing_pins {

// 4-20 mA driver enable (active-low: ON = LOW, OFF = HIGH)
constexpr int PIN_MOTOR_ENABLE = 2;

// W5500 / Ethernet SPI on the default VSPI pins
constexpr int ETH_CS = 5;
constexpr int ETH_MOSI = 23;
constexpr int ETH_SCLK = 18;
constexpr int ETH_MISO = 19;

}  // namespace motor_testing_pins
