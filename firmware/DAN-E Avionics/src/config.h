#pragma once

#include <Arduino.h>
#include <Adafruit_LIS3DH.h>
#include <STAR_ISM330DH.h>

// -----------------------------------------------------------------------------
// MCP3201 — ratiometric pressure transducer
// -----------------------------------------------------------------------------
static constexpr float VREF = 3.3f;
static constexpr float ADC_COUNTS = 4095.0f;
static constexpr float PT_FULL_SCALE_PSI = 1000.0f;

// -----------------------------------------------------------------------------
// LPS28DFW
// -----------------------------------------------------------------------------
static constexpr float LPS28DFW_SEA_LEVEL_HPA = 1013.25f;
static constexpr uint8_t LPS28DFW_I2C_ADDR = 0x5C;

// Apogee — windowed barometric derivative
static constexpr unsigned ALT_BUF_N = 24;
static constexpr float ALT_TREND_THRESHOLD_M = 2.0f;
static constexpr unsigned ALT_TREND_CONFIRM_COUNT = 6;

// -----------------------------------------------------------------------------
// LIS3DH — launch / high-G (see IC_Testing/LIS3DH/main.h)
// -----------------------------------------------------------------------------
static constexpr lis3dh_range_t ACCEL_RANGE = LIS3DH_RANGE_16_G;
static constexpr float INTERRUPT_THRESHOLD_G = 2.5f;
static constexpr uint8_t INTERRUPT_DURATION_COUNTS = 10;
static constexpr lis3dh_dataRate_t ACCEL_ODR = LIS3DH_DATARATE_400_HZ;

static constexpr float lis3dh_lsb_mg(lis3dh_range_t range) {
	switch (range) {
		case LIS3DH_RANGE_2_G: return 16.0f;
		case LIS3DH_RANGE_4_G: return 32.0f;
		case LIS3DH_RANGE_8_G: return 62.0f;
		case LIS3DH_RANGE_16_G: return 186.0f;
		default: return 16.0f;
	}
}

static constexpr uint8_t INT1_THS_VALUE = []() -> uint8_t {
	float lsb = lis3dh_lsb_mg(ACCEL_RANGE);
	float raw = (INTERRUPT_THRESHOLD_G * 1000.0f) / lsb;
	uint8_t val = (raw > 127.0f) ? 127 : (uint8_t)raw;
	return (val == 0) ? 1 : val;
}();

static constexpr uint8_t INT1_DUR_VALUE =
	(INTERRUPT_DURATION_COUNTS > 127) ? 127 : (uint8_t)INTERRUPT_DURATION_COUNTS;

// -----------------------------------------------------------------------------
// ISM330DHCX — match IC_Testing/ISM330DH main.h
// -----------------------------------------------------------------------------
static constexpr uint8_t ISM330_ACCEL_FS = ISM_16g;
static constexpr float ISM330_ACCEL_FS_G = 16.0f;
static constexpr float ISM330_WAKEUP_THRESHOLD_G = 2.5f;
static constexpr uint8_t ISM330_WAKEUP_DUR = 2;
static constexpr bool ISM330_ROUTE_DRDY_TO_INT1 = false;

static constexpr uint8_t ISM330_WKUP_THS = []() -> uint8_t {
	constexpr float mgPerLsb = (ISM330_ACCEL_FS_G * 1000.0f) / 64.0f;
	float raw = (ISM330_WAKEUP_THRESHOLD_G * 1000.0f) / mgPerLsb;
	uint8_t v = (raw > 63.0f) ? 63 : static_cast<uint8_t>(raw);
	return (v < 1) ? 1 : v;
}();

// -----------------------------------------------------------------------------
// Flight state machine
// -----------------------------------------------------------------------------
static constexpr uint32_t ACTIVE_DURATION_MS = 120000UL;

// -----------------------------------------------------------------------------
// MX25 flight log region (bytes reserved from end of flash)
// -----------------------------------------------------------------------------
static constexpr uint32_t FLIGHT_LOG_REGION_BYTES = 512UL * 1024UL;

// -----------------------------------------------------------------------------
// Debug
// -----------------------------------------------------------------------------
#ifndef DEBUG_TELEMETRY
#define DEBUG_TELEMETRY 0
#endif

#ifndef FLIGHT_LOG_ENABLE
#define FLIGHT_LOG_ENABLE 1
#endif
