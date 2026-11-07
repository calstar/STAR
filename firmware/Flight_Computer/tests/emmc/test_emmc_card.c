/* CID / EXT_CSD parsing against the THGBMTG5D1LBAIL datasheet values. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "emmc_card.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

/* CID as the datasheet's p. 5 table lays it out, serial 0x12345678. */
static void datasheet_cid(uint32_t cid[4]) {
    cid[0] = 0x11u << 24 | 0x01u << 16 | 0x00u << 8 | '0'; /* MID CBX OID */
    cid[1] = (uint32_t)'0' << 24 | (uint32_t)'4' << 16 | 'G' << 8 | 'A';
    cid[2] = (uint32_t)'1' << 24 | 0x02u << 16 | 0x1234u; /* PRV, PSN hi */
    cid[3] = 0x5678u << 16 | 0x5Au << 8 | 0x01u;          /* PSN lo, MDT */
}

/* EXT_CSD with the datasheet's shipped values (pp. 7-11). */
static void datasheet_ext_csd(uint8_t e[512]) {
    memset(e, 0, 512);
    e[EMMC_EXT_CSD_SEC_COUNT + 0] = 0x00;
    e[EMMC_EXT_CSD_SEC_COUNT + 1] = 0x00;
    e[EMMC_EXT_CSD_SEC_COUNT + 2] = 0x76;
    e[EMMC_EXT_CSD_SEC_COUNT + 3] = 0x00;
    e[EMMC_EXT_CSD_REV] = 0x07;
    e[EMMC_EXT_CSD_DEVICE_TYPE] = 0x57;
    e[EMMC_EXT_CSD_PRE_EOL_INFO] = 0x01;
    e[EMMC_EXT_CSD_LIFE_TIME_A] = 0x01;
    e[EMMC_EXT_CSD_LIFE_TIME_B] = 0x00;
    e[EMMC_EXT_CSD_RST_N_FUNCTION] = 0x00;
    e[EMMC_EXT_CSD_CACHE_CTRL] = 0x00;
    e[EMMC_EXT_CSD_WR_REL_SET] = 0x1F;
}

static void test_datasheet_part(void) {
    uint32_t cid[4];
    uint8_t e[512];
    emmc_card_info_t info;
    datasheet_cid(cid);
    datasheet_ext_csd(e);
    emmc_card_parse(cid, e, &info);
    CHECK(info.mid == 0x11);
    CHECK(strcmp(info.pnm, "004GA1") == 0);
    CHECK(info.prv == 0x02);
    CHECK(info.psn == 0x12345678u);
    CHECK(info.sec_count == 0x00760000u);
    CHECK((uint64_t)info.sec_count * 512u == 3959422976u);
    CHECK(info.ext_csd_rev == 7 && info.device_type == 0x57);
    CHECK(info.rst_n_function == 0); /* RST_n ignored as shipped */
    CHECK(emmc_card_check(&info) == EMMC_CARD_OK);
}

static void test_each_issue(void) {
    uint32_t cid[4];
    uint8_t e[512];
    emmc_card_info_t info;

    datasheet_cid(cid);
    datasheet_ext_csd(e);
    cid[0] = (cid[0] & 0x00FFFFFFu) | 0x15u << 24; /* Samsung */
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_WRONG_MAKER);

    datasheet_cid(cid);
    cid[1] ^= 0x01u; /* "004GA0"... */
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_WRONG_PART);

    datasheet_cid(cid);
    e[EMMC_EXT_CSD_SEC_COUNT + 2] = 0xEC; /* an 8 GB part */
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_WRONG_SIZE);

    datasheet_ext_csd(e);
    e[EMMC_EXT_CSD_REV] = 6;
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_OLD_REVISION);

    datasheet_ext_csd(e);
    e[EMMC_EXT_CSD_PRE_EOL_INFO] = 2;
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_WEAR_WARNING);
    datasheet_ext_csd(e);
    e[EMMC_EXT_CSD_LIFE_TIME_B] = 0x09;
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_WEAR_WARNING);
    e[EMMC_EXT_CSD_LIFE_TIME_B] = 0x08;
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_OK);

    datasheet_ext_csd(e);
    e[EMMC_EXT_CSD_WR_REL_SET] = 0x1E;
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_NO_RELIABLE_WRITE);

    datasheet_ext_csd(e);
    e[EMMC_EXT_CSD_CACHE_CTRL] = 1;
    emmc_card_parse(cid, e, &info);
    CHECK(emmc_card_check(&info) == EMMC_CARD_CACHE_ON);
}

int main(void) {
    test_datasheet_part();
    test_each_issue();
    puts("2 emmc card test groups passed");
    return 0;
}
