#pragma once

// I2C pins (match other IC_Testing boards; change if your wiring differs)
#define LPS28DFW_SDA_PIN 0
#define LPS28DFW_SCL_PIN 1

// 7-bit I2C: 0x5C default, 0x5D if address pin high (matches SparkFun LPS28DFW_I2C_ADDRESS_*)
#define LPS28DFW_I2C_ADDR 0x5C

// Reference sea-level pressure (hPa) for barometric altitude; set to local QNH for better accuracy
#define LPS28DFW_SEA_LEVEL_HPA 1013.25f
