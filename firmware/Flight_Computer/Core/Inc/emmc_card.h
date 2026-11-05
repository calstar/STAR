#ifndef STAR_EMMC_CARD_H
#define STAR_EMMC_CARD_H

/*
 * Reads the eMMC's identity registers (CID, EXT_CSD) and checks them against
 * the THGBMTG5D1LBAIL datasheet (KIOXIA, rev 1.0, 2021-10-07). Pure parsing,
 * no I/O: the board adapter reads the registers, this decides what they
 * mean. Values quoted are the datasheet's (pp. 5-11).
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define EMMC_CARD_MID_KIOXIA 0x11U       /* CID MID */
#define EMMC_CARD_PNM "004GA1"           /* CID PNM */
#define EMMC_CARD_SEC_COUNT 0x00760000UL /* 3,959,422,976 B */
#define EMMC_CARD_EXT_CSD_REV_MIN 7U     /* eMMC 5.0 */

/* EXT_CSD byte offsets used here (JEDEC JESD84-B50). */
#define EMMC_EXT_CSD_CACHE_CTRL 33U
#define EMMC_EXT_CSD_RST_N_FUNCTION 162U
#define EMMC_EXT_CSD_WR_REL_SET 167U
#define EMMC_EXT_CSD_BUS_WIDTH 183U
#define EMMC_EXT_CSD_HS_TIMING 185U
#define EMMC_EXT_CSD_REV 192U
#define EMMC_EXT_CSD_DEVICE_TYPE 196U
#define EMMC_EXT_CSD_SEC_COUNT 212U /* 4 bytes, little-endian */
#define EMMC_EXT_CSD_PRE_EOL_INFO 267U
#define EMMC_EXT_CSD_LIFE_TIME_A 268U
#define EMMC_EXT_CSD_LIFE_TIME_B 269U

typedef struct {
    uint8_t mid;
    char pnm[7]; /* six characters + NUL */
    uint8_t prv;
    uint32_t psn; /* serial number: worth logging with each session */
    uint8_t ext_csd_rev;
    uint32_t sec_count;
    uint8_t device_type;
    uint8_t pre_eol; /* 1 normal, 2 warning (80 % reserve used), 3 urgent */
    uint8_t life_a;  /* 1 = 0-10 % of rated life used ... 0x0B exceeded */
    uint8_t life_b;
    uint8_t rst_n_function; /* 0: RST_n pin ignored (shipped value) */
    uint8_t cache_ctrl;     /* 0: volatile cache off (shipped value) */
    uint8_t wr_rel_set;     /* bit 0: reliable writes in the user area */
} emmc_card_info_t;

/* Why a card is not the one the datasheet describes, or is wearing out. */
typedef enum {
    EMMC_CARD_OK = 0,
    EMMC_CARD_WRONG_MAKER = 1U << 0,       /* MID != 0x11 */
    EMMC_CARD_WRONG_PART = 1U << 1,        /* PNM != "004GA1" */
    EMMC_CARD_WRONG_SIZE = 1U << 2,        /* SEC_COUNT != 0x760000 */
    EMMC_CARD_OLD_REVISION = 1U << 3,      /* EXT_CSD_REV < 7 */
    EMMC_CARD_WEAR_WARNING = 1U << 4,      /* PRE_EOL >= 2 or life >= 0x09 */
    EMMC_CARD_NO_RELIABLE_WRITE = 1U << 5, /* WR_REL_SET bit 0 clear */
    EMMC_CARD_CACHE_ON = 1U << 6 /* a power cut can lose cached data */
} emmc_card_issue_t;

/*
 * `cid` is the CID as four 32-bit words, cid[0] = bits 127..96 (the order
 * the STM32 SDMMC response registers and HAL's hmmc->CID use). `ext_csd` is
 * the 512-byte EXT_CSD.
 */
void emmc_card_parse(const uint32_t cid[4], const uint8_t ext_csd[512],
                     emmc_card_info_t* out);

/*
 * Bitwise OR of emmc_card_issue_t; EMMC_CARD_OK (0) when nothing is off.
 * None of these stops the log (it works on any eMMC 4.4+ with 512 B
 * sectors); they are reported. Whether one blocks Arm is the open failure
 * policy question (#137 section 7).
 */
uint32_t emmc_card_check(const emmc_card_info_t* info);

#ifdef __cplusplus
}
#endif
#endif
