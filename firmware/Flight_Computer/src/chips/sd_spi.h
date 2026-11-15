#ifndef STAR_SD_SPI_H
#define STAR_SD_SPI_H

/*
 * Portable pieces of the SD-card SPI protocol (SD Physical Layer Simplified
 * Specification, SPI mode), used to probe the ZDSD01GLGEAG SD NAND (U10).
 * No HAL: the board layer moves the bytes, these build and check them.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SD_CMD0_GO_IDLE 0U
#define SD_CMD9_SEND_CSD 9U
#define SD_CMD12_STOP_TRANSMISSION 12U
#define SD_CMD13_SEND_STATUS 13U
#define SD_CMD16_SET_BLOCKLEN 16U
#define SD_CMD17_READ_SINGLE_BLOCK 17U
#define SD_CMD18_READ_MULTIPLE_BLOCK 18U
#define SD_CMD24_WRITE_BLOCK 24U
#define SD_CMD25_WRITE_MULTIPLE_BLOCK 25U
#define SD_CMD8_SEND_IF_COND 8U
#define SD_CMD10_SEND_CID 10U
#define SD_CMD55_APP_CMD 55U
#define SD_CMD58_READ_OCR 58U
#define SD_ACMD41_SD_SEND_OP_COND 41U

#define SD_CMD8_ARG 0x000001AAU   /* 2.7-3.6 V, check pattern 0xAA */
#define SD_ACMD41_HCS 0x40000000U /* host supports high capacity */

#define SD_R1_IDLE 0x01U
#define SD_R1_ILLEGAL_COMMAND 0x04U
#define SD_DATA_TOKEN 0xFEU        /* single-block write, every read block */
#define SD_MULTI_WRITE_TOKEN 0xFCU /* each block of CMD25 */
#define SD_STOP_TRAN_TOKEN 0xFDU   /* ends CMD25 */
#define SD_OCR_CCS 0x40000000U     /* card capacity status: SDHC/SDXC */

/* CRC7 (x^7 + x^3 + 1) over len bytes, as used by commands and the CID. */
uint8_t sd_crc7(const uint8_t* data, uint8_t len);

/* 6-byte command frame: 01 index, 32-bit argument, CRC7, end bit. */
void sd_command_frame(uint8_t out[6], uint8_t index, uint32_t argument);

/* R1 is the first byte with bit 7 clear; 0xFF means "not yet". */
static inline bool sd_is_r1(uint8_t byte) {
    return (byte & 0x80U) == 0U;
}

/* CMD8 R7 trailer (4 bytes after R1): voltage accepted and pattern echoed. */
bool sd_r7_ok(const uint8_t r7[4]);

/* CID register (16 bytes): byte 15 must be CRC7(bytes 0..14) << 1 | 1, and
 * the contents must not be uniform 0xFF/0x00 (a dead bus). */
bool sd_cid_ok(const uint8_t cid[16]);

/* CRC16-CCITT (x^16 + x^12 + x^5 + 1, init 0), as on SD data blocks. */
uint16_t sd_crc16(const uint8_t* data, uint32_t len);

/* Data response token after each written block: xxx0 sss1, sss = 010
 * accepted, 101 CRC error, 110 write error. */
static inline bool sd_data_accepted(uint8_t token) {
    return (token & 0x1FU) == 0x05U;
}

/* CSD (16 bytes) to 512-byte blocks: version 2.0 (SDHC: (C_SIZE + 1) x
 * 1024) or 1.0 (C_SIZE, C_SIZE_MULT, READ_BL_LEN). 0 for an unknown
 * structure. */
uint32_t sd_csd_blocks(const uint8_t csd[16]);

#ifdef __cplusplus
}
#endif
#endif
