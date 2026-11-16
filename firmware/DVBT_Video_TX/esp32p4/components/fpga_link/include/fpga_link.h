// The ESP32-P4's link to the FPGA: one SPI bus (P4 master, mode 0) for
// registers and the transport stream, plus the FPGA's DREQ line. Generic
// over the transport (a frame callback and DREQ), so the same code runs on
// the P4 (fpga_link_esp.h) and against the RTL in the end-to-end test.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "dvbt_regs.h"

#define FPGA_FRAME_MAX (1 + 2 * TS_PACKET)

typedef struct {
    // One frame: CS low, n bytes out on MOSI and in on MISO, CS high.
    esp_err_t (*frame)(void *ctx, const uint8_t *tx, uint8_t *rx, size_t n);
    // Wait until DREQ is high; false on timeout (0: just read the pin).
    bool (*wait_dreq)(void *ctx, uint32_t timeout_ms);
    void *ctx;
    uint8_t *tx, *rx;           // FPGA_FRAME_MAX bytes each (DMA-capable on the P4)
} fpga_link_t;

esp_err_t fpga_reg_write(const fpga_link_t *l, unsigned addr, uint32_t val);
esp_err_t fpga_reg_read(const fpga_link_t *l, unsigned addr, uint32_t *val);
// Read the ID register: ESP_ERR_INVALID_VERSION if it is not DVBT_ID
// (no bitstream, the wrong one, or a dead link).
esp_err_t fpga_link_check(const fpga_link_t *l, uint32_t *id);

// Send TS packets (n whole 188-byte packets), waiting for DREQ before each
// burst. DREQ guarantees room for two packets, so bursts are of at most 2.
// Returns the last status byte seen in *status (may be NULL).
esp_err_t fpga_ts_send(const fpga_link_t *l, const uint8_t *pkts, size_t n, uint32_t timeout_ms,
                       uint8_t *status);
