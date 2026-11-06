#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sd_spi.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

/* CMD0 ...95 and CMD8 ...87 are the published constants every SD driver
 * hard-codes; the rest were computed with an independent CRC7 in Python. */
static void test_command_frames(void) {
    static const struct {
        uint8_t index;
        uint32_t arg;
        uint8_t frame[6];
    } cases[] = {
        {SD_CMD0_GO_IDLE, 0, {0x40, 0x00, 0x00, 0x00, 0x00, 0x95}},
        {SD_CMD8_SEND_IF_COND,
         SD_CMD8_ARG,
         {0x48, 0x00, 0x00, 0x01, 0xAA, 0x87}},
        {SD_CMD55_APP_CMD, 0, {0x77, 0x00, 0x00, 0x00, 0x00, 0x65}},
        {SD_ACMD41_SD_SEND_OP_COND,
         SD_ACMD41_HCS,
         {0x69, 0x40, 0x00, 0x00, 0x00, 0x77}},
        {SD_CMD58_READ_OCR, 0, {0x7A, 0x00, 0x00, 0x00, 0x00, 0xFD}},
        {SD_CMD10_SEND_CID, 0, {0x4A, 0x00, 0x00, 0x00, 0x00, 0x1B}},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        uint8_t out[6];
        sd_command_frame(out, cases[i].index, cases[i].arg);
        CHECK(memcmp(out, cases[i].frame, 6) == 0);
    }
}

static void test_r1(void) {
    CHECK(!sd_is_r1(0xFF));
    CHECK(sd_is_r1(SD_R1_IDLE));
    CHECK(sd_is_r1(0x00));
    CHECK(sd_is_r1(SD_R1_IDLE | SD_R1_ILLEGAL_COMMAND));
}

static void test_r7(void) {
    const uint8_t good[4] = {0x00, 0x00, 0x01, 0xAA};
    const uint8_t wrong_pattern[4] = {0x00, 0x00, 0x01, 0x55};
    const uint8_t wrong_voltage[4] = {0x00, 0x00, 0x02, 0xAA};
    CHECK(sd_r7_ok(good));
    CHECK(!sd_r7_ok(wrong_pattern));
    CHECK(!sd_r7_ok(wrong_voltage));
}

static void test_cid(void) {
    /* Well-formed CID body; last byte B7 computed independently. */
    uint8_t cid[16] = {0x03, 0x53, 0x44, 0x53, 0x55, 0x31, 0x36, 0x47,
                       0x80, 0x12, 0x34, 0x56, 0x78, 0x01, 0x4A, 0xB7};
    CHECK(sd_cid_ok(cid));
    for (int i = 0; i < 16; ++i) {
        uint8_t bad[16];
        memcpy(bad, cid, 16);
        bad[i] ^= 0x10;
        CHECK(!sd_cid_ok(bad));
    }
    /* A dead bus reads all 0xFF or all 0x00: neither is a valid CID. All
     * 0xFF satisfies the CRC7 by coincidence, so this needs its own rule. */
    uint8_t ff[16], zero[16];
    memset(ff, 0xFF, 16);
    memset(zero, 0x00, 16);
    CHECK(!sd_cid_ok(ff));
    CHECK(!sd_cid_ok(zero));
}

int main(void) {
    test_command_frames();
    test_r1();
    test_r7();
    test_cid();
    puts("sd_spi: all tests passed");
    return 0;
}
