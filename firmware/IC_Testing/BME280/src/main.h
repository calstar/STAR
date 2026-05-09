#pragma once

// =============================================================================
// USER CONFIG
// =============================================================================

// I2C pins
#define BME280_SDA_PIN  0
#define BME280_SCL_PIN  1

// BME280 I2C address: 0x76 (SDO tied low) or 0x77 (SDO tied high)
#define BME280_I2C_ADDR 0x76
