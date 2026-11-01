// The ESP32-P4's link to the FPGA: one SPI bus (ESP32 master, mode 0) for
// registers and the transport stream, plus the FPGA's DREQ line.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "spi_bus_if.h"

typedef struct {
    int spi_host;           // spi_host_device_t, e.g. SPI2_HOST
    int pin_sck, pin_mosi, pin_miso, pin_cs, pin_dreq;
    int clock_hz;           // up to 20 MHz (the FPGA's SCK domain)
} fpga_link_config_t;

esp_err_t fpga_link_init(const fpga_link_config_t *cfg);
esp_err_t fpga_reg_write(unsigned addr, uint32_t val);
esp_err_t fpga_reg_read(unsigned addr, uint32_t *val);

// Send TS packets (n whole 188-byte packets), waiting for DREQ before each
// burst. DREQ guarantees room for two packets, so bursts are of at most 2.
// Returns the last status byte seen in *status (may be NULL).
esp_err_t fpga_ts_send(const uint8_t *pkts, size_t n, uint32_t timeout_ms, uint8_t *status);

// The FPGA's setup-bus SPI master (dvbt_spi_master.v) as a generic bus for
// chip drivers. dev 0: AD9116, dev 1: ADRF6755. SCLK = 27.43 MHz / (2 (div+1)).
void fpga_setup_bus(spi_bus_if_t *bus, int div);
