/**
 * @file ism330dhcx.c
 * @brief STMicroelectronics ISM330DHCX 6-DOF IMU + MLC Driver Implementation.
 */

#include "ism330dhcx.h"
#include <string.h>

/* Helper static read/write wrappers */
static inline int32_t reg_read(ism330dhcx_ctx_t *ctx, uint8_t reg, uint8_t *val, uint16_t len) {
    if (!ctx || !ctx->read_reg) return ISM330DHCX_ERR_INVALID_PARAM;
    return ctx->read_reg(ctx->handle, reg, val, len);
}

static inline int32_t reg_write(ism330dhcx_ctx_t *ctx, uint8_t reg, const uint8_t *val, uint16_t len) {
    if (!ctx || !ctx->write_reg) return ISM330DHCX_ERR_INVALID_PARAM;
    return ctx->write_reg(ctx->handle, reg, val, len);
}

static inline int32_t reg_write_byte(ism330dhcx_ctx_t *ctx, uint8_t reg, uint8_t val) {
    return reg_write(ctx, reg, &val, 1);
}

static inline int32_t reg_read_byte(ism330dhcx_ctx_t *ctx, uint8_t reg, uint8_t *val) {
    return reg_read(ctx, reg, val, 1);
}

static inline void delay_ms(ism330dhcx_ctx_t *ctx, uint32_t ms) {
    if (ctx && ctx->delay_ms) {
        ctx->delay_ms(ms);
    }
}

/* ========================================================================= */
/* Initialization & Basic Configuration                                      */
/* ========================================================================= */

int32_t ism330dhcx_init(ism330dhcx_ctx_t *ctx) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t chip_id = 0;
    int32_t ret = reg_read_byte(ctx, ISM330DHCX_REG_WHO_AM_I, &chip_id);
    if (ret != ISM330DHCX_OK) return ret;

    if (chip_id != ISM330DHCX_WHO_AM_I_VAL) {
        return ISM330DHCX_ERR_CHIP_ID;
    }

    /* Perform Software Reset */
    ret = ism330dhcx_software_reset(ctx);
    if (ret != ISM330DHCX_OK) return ret;

    /* Configure CTRL3_C: Block Data Update (BDU = 1), Auto Address Increment (IF_INC = 1) */
    uint8_t ctrl3 = 0;
    ret = reg_read_byte(ctx, ISM330DHCX_REG_CTRL3_C, &ctrl3);
    if (ret != ISM330DHCX_OK) return ret;
    ctrl3 |= (ISM330DHCX_BDU_BIT | ISM330DHCX_IF_INC_BIT);
    ret = reg_write_byte(ctx, ISM330DHCX_REG_CTRL3_C, ctrl3);
    if (ret != ISM330DHCX_OK) return ret;

    /* Configure CTRL9_XL: Set DEVICE_CONF = 1 (required per DS13012 Table 63 / page 37) */
    uint8_t ctrl9 = 0;
    reg_read_byte(ctx, ISM330DHCX_REG_CTRL9_XL, &ctrl9);
    ctrl9 |= ISM330DHCX_DEVICE_CONF_BIT;
    ret = reg_write_byte(ctx, ISM330DHCX_REG_CTRL9_XL, ctrl9);
    if (ret != ISM330DHCX_OK) return ret;

    /* Default sensitivities (default FS: +/-16g, +/-4000dps for high dynamics avionics) */
    ctx->xl_fs = ISM330DHCX_XL_FS_16G;
    ctx->gy_fs = ISM330DHCX_GY_FS_4000DPS;
    ctx->xl_sensitivity = ISM330DHCX_SENSITIVITY_FS_16G;
    ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_4000DPS;
    ctx->mlc_enabled = false;

    return ISM330DHCX_OK;
}

int32_t ism330dhcx_software_reset(ism330dhcx_ctx_t *ctx) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    int32_t ret = reg_write_byte(ctx, ISM330DHCX_REG_CTRL3_C, ISM330DHCX_SW_RESET_BIT);
    if (ret != ISM330DHCX_OK) return ret;

    /* Poll SW_RESET bit until cleared (timeout ~50ms) */
    uint8_t ctrl3 = 0xFF;
    uint32_t timeout = 50;
    while (timeout--) {
        delay_ms(ctx, 1);
        reg_read_byte(ctx, ISM330DHCX_REG_CTRL3_C, &ctrl3);
        if ((ctrl3 & ISM330DHCX_SW_RESET_BIT) == 0) {
            break;
        }
    }

    if (timeout == 0) return ISM330DHCX_ERR_TIMEOUT;
    delay_ms(ctx, 10);
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_set_accel_config(ism330dhcx_ctx_t *ctx, ism330dhcx_xl_odr_t odr, ism330dhcx_xl_fs_t fs) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t ctrl1 = 0;
    reg_read_byte(ctx, ISM330DHCX_REG_CTRL1_XL, &ctrl1);

    ctrl1 &= 0x03; /* Preserve LPF2 and reserved bits */
    ctrl1 |= ((uint8_t)odr << 4) | (((uint8_t)fs & 0x03) << 2);

    int32_t ret = reg_write_byte(ctx, ISM330DHCX_REG_CTRL1_XL, ctrl1);
    if (ret != ISM330DHCX_OK) return ret;

    ctx->xl_fs = fs;
    switch (fs) {
        case ISM330DHCX_XL_FS_2G:  ctx->xl_sensitivity = ISM330DHCX_SENSITIVITY_FS_2G; break;
        case ISM330DHCX_XL_FS_4G:  ctx->xl_sensitivity = ISM330DHCX_SENSITIVITY_FS_4G; break;
        case ISM330DHCX_XL_FS_8G:  ctx->xl_sensitivity = ISM330DHCX_SENSITIVITY_FS_8G; break;
        case ISM330DHCX_XL_FS_16G: ctx->xl_sensitivity = ISM330DHCX_SENSITIVITY_FS_16G; break;
    }
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_set_gyro_config(ism330dhcx_ctx_t *ctx, ism330dhcx_gy_odr_t odr, ism330dhcx_gy_fs_t fs) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t ctrl2 = 0;
    reg_read_byte(ctx, ISM330DHCX_REG_CTRL2_G, &ctrl2);

    ctrl2 &= 0x00; /* Clear bits */
    ctrl2 |= ((uint8_t)odr << 4);

    if (fs == ISM330DHCX_GY_FS_125DPS) {
        ctrl2 |= (1U << 1); /* FS_125 bit */
        ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_125DPS;
    } else if (fs == ISM330DHCX_GY_FS_4000DPS) {
        ctrl2 |= (1U << 0); /* FS_4000 bit */
        ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_4000DPS;
    } else {
        ctrl2 |= (((uint8_t)fs & 0x03) << 2);
        switch (fs) {
            case ISM330DHCX_GY_FS_250DPS:  ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_250DPS; break;
            case ISM330DHCX_GY_FS_500DPS:  ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_500DPS; break;
            case ISM330DHCX_GY_FS_1000DPS: ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_1000DPS; break;
            case ISM330DHCX_GY_FS_2000DPS: ctx->gy_sensitivity = ISM330DHCX_SENSITIVITY_FS_2000DPS; break;
            default: break;
        }
    }

    int32_t ret = reg_write_byte(ctx, ISM330DHCX_REG_CTRL2_G, ctrl2);
    if (ret != ISM330DHCX_OK) return ret;

    ctx->gy_fs = fs;
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_get_status(ism330dhcx_ctx_t *ctx, ism330dhcx_status_t *status) {
    if (!ctx || !status) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t status_reg = 0;
    int32_t ret = reg_read_byte(ctx, ISM330DHCX_REG_STATUS_REG, &status_reg);
    if (ret != ISM330DHCX_OK) return ret;

    status->accel_data_ready = (status_reg & ISM330DHCX_XLDA_BIT) != 0;
    status->gyro_data_ready  = (status_reg & ISM330DHCX_GDA_BIT)  != 0;
    status->temp_data_ready  = (status_reg & ISM330DHCX_TDA_BIT)  != 0;
    return ISM330DHCX_OK;
}

/* ========================================================================= */
/* Data Acquisition                                                          */
/* ========================================================================= */

int32_t ism330dhcx_read_accel_raw(ism330dhcx_ctx_t *ctx, ism330dhcx_raw_axes_t *raw) {
    if (!ctx || !raw) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t buff[6];
    int32_t ret = reg_read(ctx, ISM330DHCX_REG_OUTX_L_A, buff, 6);
    if (ret != ISM330DHCX_OK) return ret;

    raw->x = (int16_t)(((uint16_t)buff[1] << 8) | buff[0]);
    raw->y = (int16_t)(((uint16_t)buff[3] << 8) | buff[2]);
    raw->z = (int16_t)(((uint16_t)buff[5] << 8) | buff[4]);
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_read_accel_g(ism330dhcx_ctx_t *ctx, ism330dhcx_axes_t *accel) {
    if (!ctx || !accel) return ISM330DHCX_ERR_INVALID_PARAM;

    ism330dhcx_raw_axes_t raw;
    int32_t ret = ism330dhcx_read_accel_raw(ctx, &raw);
    if (ret != ISM330DHCX_OK) return ret;

    accel->x = (float)raw.x * ctx->xl_sensitivity;
    accel->y = (float)raw.y * ctx->xl_sensitivity;
    accel->z = (float)raw.z * ctx->xl_sensitivity;
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_read_gyro_raw(ism330dhcx_ctx_t *ctx, ism330dhcx_raw_axes_t *raw) {
    if (!ctx || !raw) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t buff[6];
    int32_t ret = reg_read(ctx, ISM330DHCX_REG_OUTX_L_G, buff, 6);
    if (ret != ISM330DHCX_OK) return ret;

    raw->x = (int16_t)(((uint16_t)buff[1] << 8) | buff[0]);
    raw->y = (int16_t)(((uint16_t)buff[3] << 8) | buff[2]);
    raw->z = (int16_t)(((uint16_t)buff[5] << 8) | buff[4]);
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_read_gyro_dps(ism330dhcx_ctx_t *ctx, ism330dhcx_axes_t *gyro) {
    if (!ctx || !gyro) return ISM330DHCX_ERR_INVALID_PARAM;

    ism330dhcx_raw_axes_t raw;
    int32_t ret = ism330dhcx_read_gyro_raw(ctx, &raw);
    if (ret != ISM330DHCX_OK) return ret;

    gyro->x = (float)raw.x * ctx->gy_sensitivity;
    gyro->y = (float)raw.y * ctx->gy_sensitivity;
    gyro->z = (float)raw.z * ctx->gy_sensitivity;
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_read_temp_c(ism330dhcx_ctx_t *ctx, float *temp_c) {
    if (!ctx || !temp_c) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t buff[2];
    int32_t ret = reg_read(ctx, ISM330DHCX_REG_OUT_TEMP_L, buff, 2);
    if (ret != ISM330DHCX_OK) return ret;

    int16_t raw_temp = (int16_t)(((uint16_t)buff[1] << 8) | buff[0]);
    *temp_c = ISM330DHCX_TEMP_OFFSET_DEG_C + ((float)raw_temp / ISM330DHCX_TEMP_SENSITIVITY);
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_read_sync_all(ism330dhcx_ctx_t *ctx,
                                 ism330dhcx_axes_t *accel_g,
                                 ism330dhcx_axes_t *gyro_dps,
                                 float *temp_c) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    /* Burst read 14 contiguous bytes:
     * 0x20-0x21: Temperature L/H
     * 0x22-0x27: Gyroscope X/Y/Z L/H
     * 0x28-0x2D: Accelerometer X/Y/Z L/H
     */
    uint8_t data[14];
    int32_t ret = reg_read(ctx, ISM330DHCX_REG_OUT_TEMP_L, data, sizeof(data));
    if (ret != ISM330DHCX_OK) return ret;

    if (temp_c) {
        int16_t raw_t = (int16_t)(((uint16_t)data[1] << 8) | data[0]);
        *temp_c = ISM330DHCX_TEMP_OFFSET_DEG_C + ((float)raw_t / ISM330DHCX_TEMP_SENSITIVITY);
    }

    if (gyro_dps) {
        int16_t gx = (int16_t)(((uint16_t)data[3] << 8) | data[2]);
        int16_t gy = (int16_t)(((uint16_t)data[5] << 8) | data[4]);
        int16_t gz = (int16_t)(((uint16_t)data[7] << 8) | data[6]);
        gyro_dps->x = (float)gx * ctx->gy_sensitivity;
        gyro_dps->y = (float)gy * ctx->gy_sensitivity;
        gyro_dps->z = (float)gz * ctx->gy_sensitivity;
    }

    if (accel_g) {
        int16_t ax = (int16_t)(((uint16_t)data[9] << 8) | data[8]);
        int16_t ay = (int16_t)(((uint16_t)data[11] << 8) | data[10]);
        int16_t az = (int16_t)(((uint16_t)data[13] << 8) | data[12]);
        accel_g->x = (float)ax * ctx->xl_sensitivity;
        accel_g->y = (float)ay * ctx->xl_sensitivity;
        accel_g->z = (float)az * ctx->xl_sensitivity;
    }

    return ISM330DHCX_OK;
}

/* ========================================================================= */
/* FIFO Buffer Management                                                    */
/* ========================================================================= */

int32_t ism330dhcx_fifo_init(ism330dhcx_ctx_t *ctx,
                             ism330dhcx_fifo_mode_t mode,
                             uint16_t watermark_samples,
                             ism330dhcx_xl_odr_t bdr_xl,
                             ism330dhcx_gy_odr_t bdr_gy) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    /* 1. Reset FIFO to Bypass mode first */
    reg_write_byte(ctx, ISM330DHCX_REG_FIFO_CTRL4, ISM330DHCX_FIFO_BYPASS);

    /* 2. Set Watermark threshold (WTM[8:0]) */
    uint8_t wtm_l = (uint8_t)(watermark_samples & 0xFF);
    uint8_t wtm_h = (uint8_t)((watermark_samples >> 8) & 0x01);
    reg_write_byte(ctx, ISM330DHCX_REG_FIFO_CTRL1, wtm_l);
    reg_write_byte(ctx, ISM330DHCX_REG_FIFO_CTRL2, wtm_h);

    /* 3. Configure Batch Data Rates (BDR_XL and BDR_GY) */
    uint8_t fifo_ctrl3 = (((uint8_t)bdr_gy & 0x0F) << 4) | ((uint8_t)bdr_xl & 0x0F);
    reg_write_byte(ctx, ISM330DHCX_REG_FIFO_CTRL3, fifo_ctrl3);

    /* 4. Set Target FIFO Mode */
    reg_write_byte(ctx, ISM330DHCX_REG_FIFO_CTRL4, (uint8_t)mode & 0x07);

    return ISM330DHCX_OK;
}

int32_t ism330dhcx_fifo_get_count(ism330dhcx_ctx_t *ctx, uint16_t *num_samples) {
    if (!ctx || !num_samples) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t status[2];
    int32_t ret = reg_read(ctx, ISM330DHCX_REG_FIFO_STATUS1, status, 2);
    if (ret != ISM330DHCX_OK) return ret;

    /* DIFF_FIFO[9:0]: DIFF_FIFO[7:0] in STATUS1, DIFF_FIFO[9:8] in STATUS2[1:0] */
    *num_samples = (uint16_t)status[0] | ((uint16_t)(status[1] & 0x03) << 8);
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_fifo_pop_word(ism330dhcx_ctx_t *ctx,
                                 ism330dhcx_fifo_tag_t *tag,
                                 ism330dhcx_raw_axes_t *raw_axes) {
    if (!ctx || !tag || !raw_axes) return ISM330DHCX_ERR_INVALID_PARAM;

    uint8_t fifo_word[7];
    int32_t ret = reg_read(ctx, ISM330DHCX_REG_FIFO_DATA_OUT_TAG, fifo_word, 7);
    if (ret != ISM330DHCX_OK) return ret;

    /* Extract TAG (bits 7:3) */
    *tag = (ism330dhcx_fifo_tag_t)((fifo_word[0] >> 3) & 0x1F);

    raw_axes->x = (int16_t)(((uint16_t)fifo_word[2] << 8) | fifo_word[1]);
    raw_axes->y = (int16_t)(((uint16_t)fifo_word[4] << 8) | fifo_word[3]);
    raw_axes->z = (int16_t)(((uint16_t)fifo_word[6] << 8) | fifo_word[5]);

    return ISM330DHCX_OK;
}

/* ========================================================================= */
/* Machine Learning Core (MLC) Integration                                   */
/* ========================================================================= */

int32_t ism330dhcx_mlc_load_config(ism330dhcx_ctx_t *ctx,
                                   const ism330dhcx_ucf_line_t *ucf_config,
                                   size_t num_lines) {
    if (!ctx || !ucf_config || num_lines == 0) return ISM330DHCX_ERR_INVALID_PARAM;

    for (size_t i = 0; i < num_lines; i++) {
        int32_t ret = reg_write_byte(ctx, ucf_config[i].address, ucf_config[i].data);
        if (ret != ISM330DHCX_OK) {
            return ret;
        }
    }

    return ISM330DHCX_OK;
}

int32_t ism330dhcx_mlc_enable(ism330dhcx_ctx_t *ctx, bool enable, ism330dhcx_mlc_odr_t odr) {
    if (!ctx) return ISM330DHCX_ERR_INVALID_PARAM;

    /* 1. Enter Embedded Functions configuration bank */
    int32_t ret = reg_write_byte(ctx, ISM330DHCX_REG_FUNC_CFG_ACCESS, ISM330DHCX_FUNC_CFG_EN_BIT);
    if (ret != ISM330DHCX_OK) return ret;

    /* 2. Configure MLC ODR in EMB_FUNC_ODR_CFG_C (0x60) */
    uint8_t odr_cfg = 0;
    reg_read_byte(ctx, ISM330DHCX_EMB_ODR_CFG_C, &odr_cfg);
    odr_cfg &= ~(0x03 << 4);
    odr_cfg |= ((uint8_t)odr & 0x03) << 4;
    reg_write_byte(ctx, ISM330DHCX_EMB_ODR_CFG_C, odr_cfg);

    /* 3. Set or Clear MLC_EN in EMB_FUNC_EN_B (0x05) */
    uint8_t emb_en_b = 0;
    reg_read_byte(ctx, ISM330DHCX_EMB_FUNC_EN_B, &emb_en_b);
    if (enable) {
        emb_en_b |= ISM330DHCX_MLC_EN_BIT;
    } else {
        emb_en_b &= ~ISM330DHCX_MLC_EN_BIT;
    }
    reg_write_byte(ctx, ISM330DHCX_EMB_FUNC_EN_B, emb_en_b);

    /* 4. Request MLC Initialization if enabling */
    if (enable) {
        uint8_t emb_init_b = 0;
        reg_read_byte(ctx, ISM330DHCX_EMB_FUNC_INIT_B, &emb_init_b);
        emb_init_b |= ISM330DHCX_MLC_INIT_BIT;
        reg_write_byte(ctx, ISM330DHCX_EMB_FUNC_INIT_B, emb_init_b);
    }

    /* 5. Exit Embedded Functions configuration bank back to normal registers */
    ret = reg_write_byte(ctx, ISM330DHCX_REG_FUNC_CFG_ACCESS, 0x00);
    if (ret != ISM330DHCX_OK) return ret;

    ctx->mlc_enabled = enable;
    return ISM330DHCX_OK;
}

int32_t ism330dhcx_mlc_get_status(ism330dhcx_ctx_t *ctx, ism330dhcx_mlc_status_t *status) {
    if (!ctx || !status) return ISM330DHCX_ERR_INVALID_PARAM;

    /* Read MLC status from main page register 0x38 (MLC_STATUS_MAINPAGE) */
    uint8_t val = 0;
    int32_t ret = reg_read_byte(ctx, ISM330DHCX_REG_MLC_STATUS_MP, &val);
    if (ret != ISM330DHCX_OK) return ret;

    status->mlc1_event = (val & (1U << 0)) != 0;
    status->mlc2_event = (val & (1U << 1)) != 0;
    status->mlc3_event = (val & (1U << 2)) != 0;
    status->mlc4_event = (val & (1U << 3)) != 0;
    status->mlc5_event = (val & (1U << 4)) != 0;
    status->mlc6_event = (val & (1U << 5)) != 0;
    status->mlc7_event = (val & (1U << 6)) != 0;
    status->mlc8_event = (val & (1U << 7)) != 0;

    return ISM330DHCX_OK;
}

int32_t ism330dhcx_mlc_get_results(ism330dhcx_ctx_t *ctx, ism330dhcx_mlc_results_t *results) {
    if (!ctx || !results) return ISM330DHCX_ERR_INVALID_PARAM;

    /* 1. Enter Embedded Functions configuration bank */
    int32_t ret = reg_write_byte(ctx, ISM330DHCX_REG_FUNC_CFG_ACCESS, ISM330DHCX_FUNC_CFG_EN_BIT);
    if (ret != ISM330DHCX_OK) return ret;

    /* 2. Burst read all 8 decision tree output registers (0x70 to 0x77) */
    uint8_t mlc_out[8];
    ret = reg_read(ctx, ISM330DHCX_EMB_MLC0_SRC, mlc_out, 8);

    /* 3. Exit Embedded Functions bank */
    reg_write_byte(ctx, ISM330DHCX_REG_FUNC_CFG_ACCESS, 0x00);

    if (ret != ISM330DHCX_OK) return ret;

    results->tree0_out = mlc_out[0];
    results->tree1_out = mlc_out[1];
    results->tree2_out = mlc_out[2];
    results->tree3_out = mlc_out[3];
    results->tree4_out = mlc_out[4];
    results->tree5_out = mlc_out[5];
    results->tree6_out = mlc_out[6];
    results->tree7_out = mlc_out[7];

    return ISM330DHCX_OK;
}

int32_t ism330dhcx_mlc_route_interrupt(ism330dhcx_ctx_t *ctx, uint8_t int_pin, uint8_t mlc_tree_mask) {
    if (!ctx || (int_pin != 1 && int_pin != 2)) return ISM330DHCX_ERR_INVALID_PARAM;

    /* 1. Enter Embedded Functions bank */
    int32_t ret = reg_write_byte(ctx, ISM330DHCX_REG_FUNC_CFG_ACCESS, ISM330DHCX_FUNC_CFG_EN_BIT);
    if (ret != ISM330DHCX_OK) return ret;

    /* 2. Configure MLC interrupt routing register */
    if (int_pin == 1) {
        ret = reg_write_byte(ctx, ISM330DHCX_EMB_MLC_INT1, mlc_tree_mask);
    } else {
        ret = reg_write_byte(ctx, ISM330DHCX_EMB_MLC_INT2, mlc_tree_mask);
    }

    /* 3. Exit Embedded Functions bank */
    reg_write_byte(ctx, ISM330DHCX_REG_FUNC_CFG_ACCESS, 0x00);
    if (ret != ISM330DHCX_OK) return ret;

    /* 4. Enable Embedded Functions interrupt on physical pin (MD1_CFG or MD2_CFG) */
    uint8_t md_cfg_reg = (int_pin == 1) ? ISM330DHCX_REG_MD1_CFG : ISM330DHCX_REG_MD2_CFG;
    uint8_t md_val = 0;
    reg_read_byte(ctx, md_cfg_reg, &md_val);
    md_val |= ISM330DHCX_MD_EMB_FUNC_BIT;
    return reg_write_byte(ctx, md_cfg_reg, md_val);
}

/* ========================================================================= */
/* Hardware Self-Test Verification                                           */
/* ========================================================================= */

int32_t ism330dhcx_self_test(ism330dhcx_ctx_t *ctx, bool *accel_passed, bool *gyro_passed) {
    if (!ctx || !accel_passed || !gyro_passed) return ISM330DHCX_ERR_INVALID_PARAM;

    *accel_passed = false;
    *gyro_passed = false;

    /* Configure test regime: Accel +/-2g @ 52Hz, Gyro +/-2000dps @ 208Hz */
    ism330dhcx_set_accel_config(ctx, ISM330DHCX_XL_ODR_52Hz, ISM330DHCX_XL_FS_2G);
    ism330dhcx_set_gyro_config(ctx, ISM330DHCX_GY_ODR_208Hz, ISM330DHCX_GY_FS_2000DPS);
    delay_ms(ctx, 100);

    /* 1. Read baseline (normal mode) average over 5 samples */
    int32_t ax_base = 0, ay_base = 0, az_base = 0;
    int32_t gx_base = 0, gy_base = 0, gz_base = 0;
    ism330dhcx_raw_axes_t raw;

    for (int i = 0; i < 5; i++) {
        delay_ms(ctx, 20);
        ism330dhcx_read_accel_raw(ctx, &raw);
        ax_base += raw.x; ay_base += raw.y; az_base += raw.z;
        ism330dhcx_read_gyro_raw(ctx, &raw);
        gx_base += raw.x; gy_base += raw.y; gz_base += raw.z;
    }
    ax_base /= 5; ay_base /= 5; az_base /= 5;
    gx_base /= 5; gy_base /= 5; gz_base /= 5;

    /* 2. Enable positive self-test (ST[1:0]_XL = 01, ST[1:0]_G = 01 in CTRL5_C) */
    uint8_t ctrl5 = (0x01 << 2) | 0x01; /* ST_G = 01, ST_XL = 01 */
    reg_write_byte(ctx, ISM330DHCX_REG_CTRL5_C, ctrl5);
    delay_ms(ctx, 100);

    /* 3. Read self-test average */
    int32_t ax_st = 0, ay_st = 0, az_st = 0;
    int32_t gx_st = 0, gy_st = 0, gz_st = 0;

    for (int i = 0; i < 5; i++) {
        delay_ms(ctx, 20);
        ism330dhcx_read_accel_raw(ctx, &raw);
        ax_st += raw.x; ay_st += raw.y; az_st += raw.z;
        ism330dhcx_read_gyro_raw(ctx, &raw);
        gx_st += raw.x; gy_st += raw.y; gz_st += raw.z;
    }
    ax_st /= 5; ay_st /= 5; az_st /= 5;
    gx_st /= 5; gy_st /= 5; gz_st /= 5;

    /* 4. Disable self-test (restore normal mode) */
    reg_write_byte(ctx, ISM330DHCX_REG_CTRL5_C, 0x00);
    delay_ms(ctx, 20);

    /* 5. Compute absolute deltas in mg and dps per datasheet Table 2 */
    /* Accel: 1 LSB = 0.061 mg @ +/-2g */
    float d_ax = (float)(ax_st - ax_base) * 0.061f; if (d_ax < 0) d_ax = -d_ax;
    float d_ay = (float)(ay_st - ay_base) * 0.061f; if (d_ay < 0) d_ay = -d_ay;
    float d_az = (float)(az_st - az_base) * 0.061f; if (d_az < 0) d_az = -d_az;

    /* Gyro: 1 LSB = 70 mdps = 0.070 dps @ +/-2000 dps */
    float d_gx = (float)(gx_st - gx_base) * 0.070f; if (d_gx < 0) d_gx = -d_gx;
    float d_gy = (float)(gy_st - gy_base) * 0.070f; if (d_gy < 0) d_gy = -d_gy;
    float d_gz = (float)(gz_st - gz_base) * 0.070f; if (d_gz < 0) d_gz = -d_gz;

    /* Limits per Table 2 (pages 11-12):
     * Accel self-test output change: 40 mg <= delta <= 1700 mg
     * Gyro self-test output change (@ +/-2000 dps): 150 dps <= delta <= 700 dps
     */
    bool ax_ok = (d_ax >= 40.0f && d_ax <= 1700.0f);
    bool ay_ok = (d_ay >= 40.0f && d_ay <= 1700.0f);
    bool az_ok = (d_az >= 40.0f && d_az <= 1700.0f);
    *accel_passed = (ax_ok && ay_ok && az_ok);

    bool gx_ok = (d_gx >= 150.0f && d_gx <= 700.0f);
    bool gy_ok = (d_gy >= 150.0f && d_gy <= 700.0f);
    bool gz_ok = (d_gz >= 150.0f && d_gz <= 700.0f);
    *gyro_passed = (gx_ok && gy_ok && gz_ok);

    return ISM330DHCX_OK;
}
