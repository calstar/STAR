#pragma once

#include <Adafruit_LIS3DH.h>

// =============================================================================
// USER CONFIG — adjust these to change behavior
// =============================================================================

// Full-scale range: LIS3DH_RANGE_2_G, LIS3DH_RANGE_4_G, LIS3DH_RANGE_8_G, LIS3DH_RANGE_16_G
// For launch detection use _8_G or _16_G
#define ACCEL_RANGE               LIS3DH_RANGE_16_G

// Interrupt threshold in g (e.g., 2.5g distinguishes launch from handling)
#define INTERRUPT_THRESHOLD_G     2.5f

// Duration: number of ODR cycles the event must persist before triggering
// At 400 Hz, 1 count = 2.5 ms. 10 counts = 25 ms.
#define INTERRUPT_DURATION_COUNTS 10

// Output data rate
#define ACCEL_ODR                 LIS3DH_DATARATE_400_HZ

// ESP32 GPIO connected to LIS3DH INT1 pin
#define LIS3DH_INT1_PIN           23

// SPI pins
#define LIS3DH_CS_PIN             17
#define LIS3DH_MOSI_PIN           3
#define LIS3DH_MISO_PIN           16
#define LIS3DH_CLK_PIN            2

// =============================================================================
// DERIVED CONSTANTS — do not edit below unless you know what you're doing
// =============================================================================

// LSB size (mg) per full-scale range setting.
// ±2g  → 16 mg/LSB
// ±4g  → 32 mg/LSB
// ±8g  → 62 mg/LSB  (datasheet value)
// ±16g → 186 mg/LSB (datasheet value)
static constexpr float lis3dh_lsb_mg(lis3dh_range_t range) {
    switch (range) {
        case LIS3DH_RANGE_2_G:  return 16.0f;
        case LIS3DH_RANGE_4_G:  return 32.0f;
        case LIS3DH_RANGE_8_G:  return 62.0f;
        case LIS3DH_RANGE_16_G: return 186.0f;
        default:                return 16.0f;
    }
}

// INT1_THS: 7-bit register, clamped to 0x7F.
// Value = threshold_g * 1000 / lsb_mg, rounded and clamped.
static constexpr uint8_t INT1_THS_VALUE = []() -> uint8_t {
    float lsb = lis3dh_lsb_mg(ACCEL_RANGE);
    float raw = (INTERRUPT_THRESHOLD_G * 1000.0f) / lsb;
    uint8_t val = (raw > 127.0f) ? 127 : (uint8_t)raw;
    return (val == 0) ? 1 : val;  // minimum 1
}();

// INT1_DUR: 7-bit duration register value (ODR cycles)
static constexpr uint8_t INT1_DUR_VALUE = (INTERRUPT_DURATION_COUNTS > 127)
    ? 127
    : (uint8_t)INTERRUPT_DURATION_COUNTS;
