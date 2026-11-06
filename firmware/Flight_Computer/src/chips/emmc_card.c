#include "emmc_card.h"

#include <string.h>

void emmc_card_parse(const uint32_t cid[4], const uint8_t ext_csd[512],
                     emmc_card_info_t* out) {
    memset(out, 0, sizeof *out);
    /* CID bit fields, datasheet p. 5. */
    out->mid = (uint8_t)(cid[0] >> 24);           /* [127:120] */
    out->pnm[0] = (char)(cid[0] & 0xFFU);         /* [103:96] */
    out->pnm[1] = (char)(cid[1] >> 24);           /* [95:88] */
    out->pnm[2] = (char)((cid[1] >> 16) & 0xFFU); /* [87:80] */
    out->pnm[3] = (char)((cid[1] >> 8) & 0xFFU);  /* [79:72] */
    out->pnm[4] = (char)(cid[1] & 0xFFU);         /* [71:64] */
    out->pnm[5] = (char)(cid[2] >> 24);           /* [63:56] */
    out->pnm[6] = '\0';
    out->prv = (uint8_t)((cid[2] >> 16) & 0xFFU); /* [55:48] */
    out->psn = (cid[2] << 16) | (cid[3] >> 16);   /* [47:16] */

    out->ext_csd_rev = ext_csd[EMMC_EXT_CSD_REV];
    out->sec_count = (uint32_t)ext_csd[EMMC_EXT_CSD_SEC_COUNT] |
                     ((uint32_t)ext_csd[EMMC_EXT_CSD_SEC_COUNT + 1U] << 8) |
                     ((uint32_t)ext_csd[EMMC_EXT_CSD_SEC_COUNT + 2U] << 16) |
                     ((uint32_t)ext_csd[EMMC_EXT_CSD_SEC_COUNT + 3U] << 24);
    out->device_type = ext_csd[EMMC_EXT_CSD_DEVICE_TYPE];
    out->pre_eol = ext_csd[EMMC_EXT_CSD_PRE_EOL_INFO];
    out->life_a = ext_csd[EMMC_EXT_CSD_LIFE_TIME_A];
    out->life_b = ext_csd[EMMC_EXT_CSD_LIFE_TIME_B];
    out->rst_n_function = ext_csd[EMMC_EXT_CSD_RST_N_FUNCTION];
    out->cache_ctrl = ext_csd[EMMC_EXT_CSD_CACHE_CTRL];
    out->wr_rel_set = ext_csd[EMMC_EXT_CSD_WR_REL_SET];
}

uint32_t emmc_card_check(const emmc_card_info_t* info) {
    uint32_t issues = EMMC_CARD_OK;
    if (info->mid != EMMC_CARD_MID_KIOXIA) {
        issues |= EMMC_CARD_WRONG_MAKER;
    }
    if (strcmp(info->pnm, EMMC_CARD_PNM) != 0) {
        issues |= EMMC_CARD_WRONG_PART;
    }
    if (info->sec_count != EMMC_CARD_SEC_COUNT) {
        issues |= EMMC_CARD_WRONG_SIZE;
    }
    if (info->ext_csd_rev < EMMC_CARD_EXT_CSD_REV_MIN) {
        issues |= EMMC_CARD_OLD_REVISION;
    }
    /* Life-time estimates: 0x09 = 80-90 % used. PRE_EOL 2 = warning. */
    if (info->pre_eol >= 2U || info->life_a >= 0x09U || info->life_b >= 0x09U) {
        issues |= EMMC_CARD_WEAR_WARNING;
    }
    if ((info->wr_rel_set & 0x01U) == 0U) {
        issues |= EMMC_CARD_NO_RELIABLE_WRITE;
    }
    if (info->cache_ctrl != 0U) {
        issues |= EMMC_CARD_CACHE_ON;
    }
    return issues;
}
