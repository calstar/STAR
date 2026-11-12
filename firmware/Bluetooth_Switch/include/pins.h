#pragma once

// WifiSwitch.SchDoc (ESP32-C3FH4)
constexpr int PIN_OUT_EN   = 4;   // MTMS -> TPS22810 EN/UVLO, high = VOUT live
constexpr int PIN_LED      = 5;   // SK6805 DIN (include/led_pattern.h)
constexpr int PIN_I2C_SDA  = 6;   // INA260 SDA (MTCK)
constexpr int PIN_I2C_SCL  = 7;   // INA260 SCL (MTDO)
constexpr int PIN_BUTTON   = 9;   // SW2, 10k pull-up, active low (also boot strap)
constexpr int PIN_CONT_EN  = 10;  // continuity drive: D1 + 1M onto VOUT
constexpr int PIN_CONT_ADC = 3;   // continuity sense: VOUT -> D2 -> 1M/1M divider, 2.5V zener clamp

constexpr uint8_t INA260_ADDR = 0x40;  // A0 = A1 = GND
