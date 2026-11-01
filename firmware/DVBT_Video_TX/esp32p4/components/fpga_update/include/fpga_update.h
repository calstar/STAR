// FPGA image updates over a byte stream (the P4's USB serial port), so a
// new bitstream goes into the "fpga" partition without reflashing the
// firmware. The stream is just the image file make_fpga_image.py writes
// (36-byte "DVBTFPGA" header, then the bitstream): bytes before the magic
// are ignored, the header is checked (version, length within the
// partition), the partition erased, the data written as it arrives with a
// running CRC, and the CRC checked at the end. A failed or cut-short
// update leaves a header whose CRC does not match, which the loader
// rejects at boot: the FPGA then boots from its W25Q32, so a bad update
// cannot brick the transmitter. tools/fpga_update.py is the host side.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "ecp5_cfg.h"

typedef struct {
    esp_err_t (*erase)(void *ctx, size_t len);                          // from offset 0
    esp_err_t (*write)(void *ctx, size_t off, const uint8_t *p, size_t n);
    void *ctx;
    size_t part_size;
    // state
    uint8_t hdr[ECP5_IMG_HDR];
    size_t hn, off;
    ecp5_image_t img;
    uint32_t crc;
    int state;
} fpga_update_t;

typedef enum { FU_IDLE, FU_BUSY, FU_DONE, FU_ERROR } fu_status_t;

void fpga_update_init(fpga_update_t *u);
// Feed received bytes. FU_DONE: the image is written and its CRC checked.
// FU_ERROR: *msg says why; the parser goes back to hunting for a header.
fu_status_t fpga_update_feed(fpga_update_t *u, const uint8_t *p, size_t n, const char **msg);

#ifdef ESP_PLATFORM
// A task on the USB Serial/JTAG port: on success prints
// "FPGA-UPDATE OK <length> <crc32>" and restarts; on failure
// "FPGA-UPDATE ERR <reason>". before_write is called once, before the
// partition is erased (main turns the RF off there).
esp_err_t fpga_update_usb_start(const char *partition, void (*before_write)(void));
#endif
