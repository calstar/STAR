// CapFill board pin map, taken from CapFill_3 schematics (Main / Compute / Capacit_Sensing sheets).
#pragma once

#include "driver/gpio.h"
#include "driver/spi_common.h"

// ---- FDC1004 capacitive sensor (Capacit_Sensing sheet, U6) ----
// Main sheet: GPIO04 -> I2C_SDA, GPIO05 -> I2C_SCL. 4.7k pull-ups (R1, R2) are on the board.
#define PIN_I2C_SDA         GPIO_NUM_4
#define PIN_I2C_SCL         GPIO_NUM_5
#define I2C_FREQ_HZ         400000
#define FDC1004_I2C_ADDR    0x50      // fixed address

// Only GX12 connectors 1-4 are wired (CIN1..CIN4). Connectors 5-10 are not connected.
#define CAPFILL_NUM_CHANNELS 4

// ---- W5500 Ethernet breakout (Compute sheet, J9) ----
// IO39 -> R34 -> SCLK, IO40 -> R36 -> MOSI, IO41 <- R37 <- MISO
#define ETH_SPI_HOST        SPI2_HOST
#define ETH_SPI_CLOCK_MHZ   20        // breakout over headers; raise to 33 if the wiring is short and clean
#define PIN_ETH_SCLK        GPIO_NUM_39
#define PIN_ETH_MOSI        GPIO_NUM_40
#define PIN_ETH_MISO        GPIO_NUM_41
#define PIN_ETH_CS          GPIO_NUM_38
#define PIN_ETH_INT         GPIO_NUM_37
#define PIN_ETH_RST         GPIO_NUM_42

// ---- Misc ----
#define PIN_STATUS_LED      GPIO_NUM_16   // D6 yellow, via R10 470R to GND -> active high
#define PIN_BOOT_BTN        GPIO_NUM_0    // SW1, active low (not used by firmware yet)
