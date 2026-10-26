#pragma once

/**
 * Motor Testing bench board (ESP32-WROOM-32) — GPIO assignments.
 *
 * PIN_MOTOR_ENABLE drives the gate of an N-channel MOSFET that pulls the 4-20 mA
 * driver's enable input to GND; a 10k pull-up to 5 V holds the input HIGH
 * otherwise. So the output is active-low: ON = LOW, OFF = HIGH.
 *
 * GPIO25 has no boot strapping role. A 10k pull-up from the gate to 3.3 V
 * holds it HIGH, i.e. the driver OFF, from power-up through boot, USB uploads
 * and whenever the firmware is not running. (GPIO0 held the board in download
 * mode; GPIO2 needed a pull-down that ran the motor during boot.)
 */

namespace motor_testing_pins {

// 4-20 mA driver enable (active-low: ON = LOW, OFF = HIGH)
constexpr int PIN_MOTOR_ENABLE = 25;

// W5500 / Ethernet SPI on the default VSPI pins
constexpr int ETH_CS = 5;
constexpr int ETH_MOSI = 23;
constexpr int ETH_SCLK = 18;
constexpr int ETH_MISO = 19;

}  // namespace motor_testing_pins
