#pragma once

#include <cstdint>

#include <STAR_ISM330DH.h>

// SPI bus pins (per board schematic)
#define ISM330_SCLK_PIN 2
#define ISM330_MOSI_PIN 3
#define ISM330_MISO_PIN 16
#define ISM330_CS_PIN   20

// IMU interrupt pins
#define ISM330_INT1_PIN 21
#define ISM330_INT2_PIN 22

// SPI clock for the IMU (datasheet allows up to 10 MHz)
#define ISM330_SPI_HZ 3000000

// Accelerometer full scale — keep ISM330_ACCEL_FS_G in sync for wake-up math
#define ISM330_ACCEL_FS ISM_16g
#define ISM330_ACCEL_FS_G 16.0f

// Wake-up threshold in g (similar role to LIS3DH INTERRUPT_THRESHOLD_G)
#define ISM330_WAKEUP_THRESHOLD_G 2.5f

// Wake duration field 0–3 (1 LSB = 1 / ODR)
#define ISM330_WAKEUP_DUR 2

// If true, XL/GYRO data-ready also pulse INT1 (very chatty at high ODR)
#define ISM330_ROUTE_DRDY_TO_INT1 false

// ST driver: wake LSB weight FS/64 → mg per threshold step
static constexpr uint8_t ISM330_WKUP_THS = []() -> uint8_t {
	constexpr float mgPerLsb = (ISM330_ACCEL_FS_G * 1000.0f) / 64.0f;
	float raw = (ISM330_WAKEUP_THRESHOLD_G * 1000.0f) / mgPerLsb;
	uint8_t v = (raw > 63.0f) ? 63 : static_cast<uint8_t>(raw);
	return (v < 1) ? 1 : v;
}();
