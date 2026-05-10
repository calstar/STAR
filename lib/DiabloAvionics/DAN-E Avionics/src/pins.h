#pragma once

// DAN-E Avionics — ESP32-C6 PCB net names (single source of truth)

// Shared SPI (SCLK / MOSI / MISO)
#define PIN_SCLK        2
#define PIN_MOSI        3
#define PIN_MISO        16

// SPI chip selects
#define PIN_MX25_CS     0
#define PIN_ADC_CS      1
#define PIN_ACCEL_CS    17
#define PIN_IMU_CS      20

// I2C — LPS28DFW
#define PIN_SDA         4
#define PIN_SCL         5

#define PIN_BARO_INT    6
#define PIN_MX25_RESET  7

// Solenoid drivers (HIGH = valve on)
#define PIN_DRIVE_1     9
#define PIN_DRIVE_2     18
#define PIN_DRIVE_3     19
#define PIN_DRIVE_4     8
#define PIN_DRIVE_5     10
#define PIN_DRIVE_6     11

#define PIN_ACCEL_INT2  15
#define PIN_IMU_INT1    21
#define PIN_IMU_INT2    22
#define PIN_ACCEL_INT1  23
