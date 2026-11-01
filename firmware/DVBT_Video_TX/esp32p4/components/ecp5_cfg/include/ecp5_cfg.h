// ECP5 configuration from the ESP32-P4: load the bitstream over the
// FPGA's slave-SPI port (sysCONFIG), and fall back to the FPGA booting by
// itself from its W25Q32 (master SPI) when there is no valid image or the
// load fails.
//
// Command sequence (opcode + 3 operand bytes, MSB first, as Lattice's
// open-source loaders use it: ecpprog for the ECP5 opcodes, openFPGALoader
// for the slave-SPI framing and the ECP5 SRAM-erase operand):
//   PROGRAMN pulse, wait INITN high
//   E0 000000 + 4 bytes in      READ_ID (LFE5U-25F: 0x41111043)
//   C6 000000                   ISC_ENABLE
//   0E 010000                   ISC_ERASE (SRAM)
//   3B 000000                   LSC_RESET_CRC
//   7A 000000 + bitstream       LSC_BITSTREAM_BURST, CS held low throughout
//   26 000000                   ISC_DISABLE
//   FF FF FF FF                 NOPs, then DONE must go high
//   3C 000000 + 4 bytes in      LSC_READ_STATUS: bit 8 DONE, bit 13 FAIL
// To verify against Lattice TN1260 on the first board.
//
// The core is pure (HAL callbacks) so it runs in host tests; ecp5_cfg_esp.c
// binds it to ESP-IDF GPIO, SPI and the "fpga" flash partition.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define ECP5_ID_LFE5U_25F 0x41111043u

// Bitstream image as stored in the P4's "fpga" partition:
//   "DVBTFPGA" | u32 version (1) | u32 length | u32 crc32 (IEEE, of the
//   bitstream) | u32 idcode | 12 reserved bytes = 36-byte header, then the
//   .bit file from ecppack. scripts/make_fpga_image.py writes it.
#define ECP5_IMG_HDR 36

typedef struct {
    uint32_t length, crc32, idcode;
} ecp5_image_t;

uint32_t ecp5_crc32(uint32_t crc, const uint8_t *p, size_t n);
// Header check only (length within the partition). Data CRC: ecp5_image_verify.
bool ecp5_image_parse(const uint8_t hdr[ECP5_IMG_HDR], size_t part_size, ecp5_image_t *img);

typedef struct {
    void *ctx;
    void (*set_cfg_sspi)(void *ctx, bool sspi);   // false: release to the master-SPI straps
    void (*set_programn)(void *ctx, bool high);
    bool (*get_initn)(void *ctx);
    bool (*get_done)(void *ctx);
    void (*set_cs)(void *ctx, bool low);          // slave select (SN)
    esp_err_t (*spi)(void *ctx, const uint8_t *tx, uint8_t *rx, size_t n);   // CS untouched
    esp_err_t (*read)(void *ctx, size_t offset, uint8_t *buf, size_t n);     // image partition
    void (*delay_us)(void *ctx, uint32_t us);
} ecp5_hal_t;

esp_err_t ecp5_image_verify(const ecp5_hal_t *h, const ecp5_image_t *img);

typedef enum { ECP5_VIA_NONE = 0, ECP5_VIA_SSPI, ECP5_VIA_FLASH } ecp5_via_t;

typedef struct {
    ecp5_via_t via;
    esp_err_t sspi_err;       // why slave SPI was not used / failed (ESP_OK if it worked)
    uint32_t idcode, status;
} ecp5_result_t;

esp_err_t ecp5_load_sspi(const ecp5_hal_t *h, const ecp5_image_t *img, uint32_t *idcode, uint32_t *status);
esp_err_t ecp5_boot_flash(const ecp5_hal_t *h);
// Slave SPI from the partition if it holds a valid image, else (or on any
// failure) the W25Q32. ESP_OK if the FPGA ended up configured either way.
esp_err_t ecp5_configure(const ecp5_hal_t *h, size_t part_size, ecp5_result_t *res);

#ifdef ESP_PLATFORM
typedef struct {
    int spi_host;                 // taken for the load and freed again (SPI2 is fine)
    int pin_cclk, pin_mosi, pin_miso, pin_sn;
    int pin_programn, pin_initn, pin_done, pin_cfg0, pin_cfg1;
    int cfg_sspi;                 // CFG[1:0] value to drive for slave SPI (TN1260: to confirm)
    int clock_hz;
    const char *partition;        // "fpga"
} ecp5_esp_config_t;

esp_err_t ecp5_configure_esp(const ecp5_esp_config_t *cfg, ecp5_result_t *res);
#endif
