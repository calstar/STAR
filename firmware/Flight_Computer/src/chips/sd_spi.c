#include "sd_spi.h"

uint8_t sd_crc7(const uint8_t* data, uint8_t len) {
    uint8_t crc = 0;
    for (uint8_t i = 0; i < len; ++i) {
        for (int bit = 7; bit >= 0; --bit) {
            uint8_t in = (uint8_t)(((data[i] >> bit) & 1U) ^ ((crc >> 6) & 1U));
            crc = (uint8_t)((crc << 1) & 0x7FU);
            if (in) {
                crc ^= 0x09U;
            }
        }
    }
    return crc;
}

void sd_command_frame(uint8_t out[6], uint8_t index, uint32_t argument) {
    out[0] = (uint8_t)(0x40U | (index & 0x3FU));
    out[1] = (uint8_t)(argument >> 24);
    out[2] = (uint8_t)(argument >> 16);
    out[3] = (uint8_t)(argument >> 8);
    out[4] = (uint8_t)argument;
    out[5] = (uint8_t)((sd_crc7(out, 5) << 1) | 1U);
}

bool sd_r7_ok(const uint8_t r7[4]) {
    return (r7[2] & 0x0FU) == ((SD_CMD8_ARG >> 8) & 0x0FU) &&
           r7[3] == (SD_CMD8_ARG & 0xFFU);
}

bool sd_cid_ok(const uint8_t cid[16]) {
    /* A floating MISO reads all 0xFF, and 16 x 0xFF happens to satisfy the
     * CRC7 (CRC7 of 15 x 0xFF is 0x7F). Reject uniform contents first. */
    bool all_ff = true, all_00 = true;
    for (uint8_t i = 0; i < 16; ++i) {
        all_ff = all_ff && cid[i] == 0xFFU;
        all_00 = all_00 && cid[i] == 0x00U;
    }
    if (all_ff || all_00) {
        return false;
    }
    return cid[15] == (uint8_t)((sd_crc7(cid, 15) << 1) | 1U);
}

uint16_t sd_crc16(const uint8_t* data, uint32_t len) {
    uint16_t crc = 0;
    for (uint32_t i = 0; i < len; ++i) {
        crc = (uint16_t)(crc ^ ((uint16_t)data[i] << 8));
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc & 0x8000U) ? (uint16_t)((crc << 1) ^ 0x1021U)
                                  : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

/* Bits [hi:lo] of the 128-bit register, bit 127 the MSB of byte 0. */
static uint32_t csd_bits(const uint8_t csd[16], unsigned hi, unsigned lo) {
    uint32_t v = 0;
    for (unsigned b = hi + 1U; b-- > lo;) {
        unsigned byte = 15U - b / 8U;
        v = (v << 1) | ((csd[byte] >> (b % 8U)) & 1U);
    }
    return v;
}

uint32_t sd_csd_blocks(const uint8_t csd[16]) {
    switch (csd_bits(csd, 127, 126)) {
        case 1: /* CSD 2.0 */
            return (csd_bits(csd, 69, 48) + 1U) * 1024U;
        case 0: { /* CSD 1.0 */
            uint32_t c_size = csd_bits(csd, 73, 62);
            uint32_t mult = csd_bits(csd, 49, 47);
            uint32_t bl_len = csd_bits(csd, 83, 80);
            uint64_t bytes = (uint64_t)(c_size + 1U) << (mult + 2U + bl_len);
            return (uint32_t)(bytes / 512U);
        }
        default:
            return 0;
    }
}
