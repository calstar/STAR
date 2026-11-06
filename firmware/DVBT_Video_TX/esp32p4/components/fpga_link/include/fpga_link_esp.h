// fpga_link on an ESP32-P4 SPI host (DMA) with DREQ on a GPIO interrupt.
#pragma once
#include "esp_err.h"
#include "fpga_link.h"

typedef struct {
    int spi_host;           // spi_host_device_t, e.g. SPI2_HOST
    int pin_sck, pin_mosi, pin_miso, pin_cs, pin_dreq;
    int clock_hz;           // up to 20 MHz (the FPGA's SCK domain)
} fpga_link_esp_config_t;

esp_err_t fpga_link_esp_init(const fpga_link_esp_config_t *cfg, fpga_link_t *link);
// Free the SPI host (the ECP5 loader borrows it for a reconfiguration).
void fpga_link_esp_deinit(void);
