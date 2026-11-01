// AD9114/AD9115/AD9116/AD9117 dual DAC setup (datasheet Rev. F), generic
// over the SPI transport (spi_bus_if) and the RESET/PINMD pin (a callback).
// The SPI port is 3-wire: instruction byte R/W N1 N0 A4..A0, MSB first,
// read data driven on the same SDIO line.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "spi_bus_if.h"

// Registers (Table 14)
#define AD9116_SPI_CTRL   0x00
#define AD9116_POWER_DOWN 0x01
#define AD9116_DATA_CTRL  0x02
#define AD9116_I_GAIN     0x03
#define AD9116_IRSET      0x04
#define AD9116_Q_GAIN     0x06
#define AD9116_QRSET      0x07
#define AD9116_CLKMODE    0x14
#define AD9116_VERSION    0x1F

// DATA_CTRL bits
#define AD9116_TWOS       0x80   // two's complement input (default unsigned)
#define AD9116_IFIRST     0x20   // I first of each pair (default)
#define AD9116_IRISING    0x10   // I latched on DCLKIO rising (default)
#define AD9116_DCI_EN     0x04   // DCLKIO is the data clock input (default)
#define AD9116_CLKMODE_SEARCHING 0x10

typedef struct {
    const spi_bus_if_t *bus;
    int dev;                                // chip select index on that bus
    void (*set_reset)(void *ctx, bool high);  // drives RESET/PINMD
    void *reset_ctx;
} ad9116_t;

esp_err_t ad9116_write(const ad9116_t *d, uint8_t reg, uint8_t val);
esp_err_t ad9116_read(const ad9116_t *d, uint8_t reg, uint8_t *val);

// Reset (>= 50 ns pulse, then SPI mode), set the data format, read the
// version, and wait for the retimer to lock DCLKIO to CLKIN.
esp_err_t ad9116_init(const ad9116_t *d, bool twos_complement, uint8_t *version);
