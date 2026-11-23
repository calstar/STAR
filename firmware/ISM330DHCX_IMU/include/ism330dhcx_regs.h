/**
 * @file ism330dhcx_regs.h
 * @brief STMicroelectronics ISM330DHCX 6-DOF IMU Register Map & Bit Definitions.
 * 
 * Target: ISM330DHCX / ISM330DHCXTR (iNEMO 3D Accelerometer + 3D Gyroscope with MLC)
 * Reference: ST Datasheet DS13012 Rev 7 (November 2020)
 */

#ifndef ISM330DHCX_REGS_H
#define ISM330DHCX_REGS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================= */
/* I2C Device Addresses & Device Identification                              */
/* ========================================================================= */
#define ISM330DHCX_I2C_ADD_L            0x6A    /**< SA0 pad connected to GND (7-bit) */
#define ISM330DHCX_I2C_ADD_H            0x6B    /**< SA0 pad connected to VDD_IO (7-bit) */
#define ISM330DHCX_WHO_AM_I_VAL         0x6B    /**< Fixed WHO_AM_I response */

/* ========================================================================= */
/* Main Register Map (Page 0)                                                */
/* ========================================================================= */
#define ISM330DHCX_REG_FUNC_CFG_ACCESS  0x01
#define ISM330DHCX_REG_PIN_CTRL         0x02
#define ISM330DHCX_REG_FIFO_CTRL1       0x07
#define ISM330DHCX_REG_FIFO_CTRL2       0x08
#define ISM330DHCX_REG_FIFO_CTRL3       0x09
#define ISM330DHCX_REG_FIFO_CTRL4       0x0A
#define ISM330DHCX_REG_COUNTER_BDR_REG1 0x0B
#define ISM330DHCX_REG_COUNTER_BDR_REG2 0x0C
#define ISM330DHCX_REG_INT1_CTRL        0x0D
#define ISM330DHCX_REG_INT2_CTRL        0x0E
#define ISM330DHCX_REG_WHO_AM_I         0x0F
#define ISM330DHCX_REG_CTRL1_XL         0x10
#define ISM330DHCX_REG_CTRL2_G          0x11
#define ISM330DHCX_REG_CTRL3_C          0x12
#define ISM330DHCX_REG_CTRL4_C          0x13
#define ISM330DHCX_REG_CTRL5_C          0x14
#define ISM330DHCX_REG_CTRL6_C          0x15
#define ISM330DHCX_REG_CTRL7_G          0x16
#define ISM330DHCX_REG_CTRL8_XL         0x17
#define ISM330DHCX_REG_CTRL9_XL         0x18
#define ISM330DHCX_REG_CTRL10_C         0x19
#define ISM330DHCX_REG_ALL_INT_SRC      0x1A
#define ISM330DHCX_REG_WAKE_UP_SRC      0x1B
#define ISM330DHCX_REG_TAP_SRC          0x1C
#define ISM330DHCX_REG_D6D_SRC          0x1D
#define ISM330DHCX_REG_STATUS_REG       0x1E
#define ISM330DHCX_REG_OUT_TEMP_L       0x20
#define ISM330DHCX_REG_OUT_TEMP_H       0x21
#define ISM330DHCX_REG_OUTX_L_G         0x22
#define ISM330DHCX_REG_OUTX_H_G         0x23
#define ISM330DHCX_REG_OUTY_L_G         0x24
#define ISM330DHCX_REG_OUTY_H_G         0x25
#define ISM330DHCX_REG_OUTZ_L_G         0x26
#define ISM330DHCX_REG_OUTZ_H_G         0x27
#define ISM330DHCX_REG_OUTX_L_A         0x28
#define ISM330DHCX_REG_OUTX_H_A         0x29
#define ISM330DHCX_REG_OUTY_L_A         0x2A
#define ISM330DHCX_REG_OUTY_H_A         0x2B
#define ISM330DHCX_REG_OUTZ_L_A         0x2C
#define ISM330DHCX_REG_OUTZ_H_A         0x2D

#define ISM330DHCX_REG_EMB_FUNC_STATUS_MP 0x35
#define ISM330DHCX_REG_FSM_STATUS_A_MP    0x36
#define ISM330DHCX_REG_FSM_STATUS_B_MP    0x37
#define ISM330DHCX_REG_MLC_STATUS_MP      0x38
#define ISM330DHCX_REG_STATUS_MASTER_MP   0x39
#define ISM330DHCX_REG_FIFO_STATUS1       0x3A
#define ISM330DHCX_REG_FIFO_STATUS2       0x3B

#define ISM330DHCX_REG_TIMESTAMP0       0x40
#define ISM330DHCX_REG_TIMESTAMP1       0x41
#define ISM330DHCX_REG_TIMESTAMP2       0x42
#define ISM330DHCX_REG_TIMESTAMP3       0x43

#define ISM330DHCX_REG_TAP_CFG0         0x56
#define ISM330DHCX_REG_TAP_CFG1         0x57
#define ISM330DHCX_REG_TAP_CFG2         0x58
#define ISM330DHCX_REG_TAP_THS_6D       0x59
#define ISM330DHCX_REG_INT_DUR2         0x5A
#define ISM330DHCX_REG_WAKE_UP_THS      0x5B
#define ISM330DHCX_REG_WAKE_UP_DUR      0x5C
#define ISM330DHCX_REG_FREE_FALL        0x5D
#define ISM330DHCX_REG_MD1_CFG          0x5E
#define ISM330DHCX_REG_MD2_CFG          0x5F
#define ISM330DHCX_REG_INTERNAL_FREQ_FINE 0x63

#define ISM330DHCX_REG_INT_OIS          0x6F
#define ISM330DHCX_REG_CTRL1_OIS        0x70
#define ISM330DHCX_REG_CTRL2_OIS        0x71
#define ISM330DHCX_REG_CTRL3_OIS        0x72
#define ISM330DHCX_REG_X_OFS_USR        0x73
#define ISM330DHCX_REG_Y_OFS_USR        0x74
#define ISM330DHCX_REG_Z_OFS_USR        0x75

#define ISM330DHCX_REG_FIFO_DATA_OUT_TAG 0x78
#define ISM330DHCX_REG_FIFO_DATA_OUT_X_L 0x79
#define ISM330DHCX_REG_FIFO_DATA_OUT_X_H 0x7A
#define ISM330DHCX_REG_FIFO_DATA_OUT_Y_L 0x7B
#define ISM330DHCX_REG_FIFO_DATA_OUT_Y_H 0x7C
#define ISM330DHCX_REG_FIFO_DATA_OUT_Z_L 0x7D
#define ISM330DHCX_REG_FIFO_DATA_OUT_Z_H 0x7E

/* ========================================================================= */
/* Embedded Functions Registers (accessed via FUNC_CFG_ACCESS bit 7 = 1)     */
/* ========================================================================= */
#define ISM330DHCX_EMB_PAGE_SEL         0x02
#define ISM330DHCX_EMB_FUNC_EN_A        0x04
#define ISM330DHCX_EMB_FUNC_EN_B        0x05
#define ISM330DHCX_EMB_PAGE_ADDRESS     0x08
#define ISM330DHCX_EMB_PAGE_VALUE       0x09
#define ISM330DHCX_EMB_FUNC_INT1        0x0A
#define ISM330DHCX_EMB_FSM_INT1_A       0x0B
#define ISM330DHCX_EMB_FSM_INT1_B       0x0C
#define ISM330DHCX_EMB_MLC_INT1         0x0D
#define ISM330DHCX_EMB_FUNC_INT2        0x0E
#define ISM330DHCX_EMB_FSM_INT2_A       0x0F
#define ISM330DHCX_EMB_FSM_INT2_B       0x10
#define ISM330DHCX_EMB_MLC_INT2         0x11
#define ISM330DHCX_EMB_FUNC_STATUS      0x12
#define ISM330DHCX_EMB_FSM_STATUS_A     0x13
#define ISM330DHCX_EMB_FSM_STATUS_B     0x14
#define ISM330DHCX_EMB_MLC_STATUS       0x15
#define ISM330DHCX_EMB_PAGE_RW          0x17
#define ISM330DHCX_EMB_FUNC_FIFO_CFG    0x44
#define ISM330DHCX_EMB_FSM_ENABLE_A     0x46
#define ISM330DHCX_EMB_FSM_ENABLE_B     0x47
#define ISM330DHCX_EMB_ODR_CFG_B        0x5F
#define ISM330DHCX_EMB_ODR_CFG_C        0x60
#define ISM330DHCX_EMB_FUNC_SRC         0x64
#define ISM330DHCX_EMB_FUNC_INIT_A      0x66
#define ISM330DHCX_EMB_FUNC_INIT_B      0x67

/* MLC Decision Tree Output Registers (in Embedded Functions bank) */
#define ISM330DHCX_EMB_MLC0_SRC         0x70
#define ISM330DHCX_EMB_MLC1_SRC         0x71
#define ISM330DHCX_EMB_MLC2_SRC         0x72
#define ISM330DHCX_EMB_MLC3_SRC         0x73
#define ISM330DHCX_EMB_MLC4_SRC         0x74
#define ISM330DHCX_EMB_MLC5_SRC         0x75
#define ISM330DHCX_EMB_MLC6_SRC         0x76
#define ISM330DHCX_EMB_MLC7_SRC         0x77

/* ========================================================================= */
/* Register Bitfields & Masks                                                */
/* ========================================================================= */

/* FUNC_CFG_ACCESS (01h) */
#define ISM330DHCX_FUNC_CFG_EN_BIT      (1U << 7)
#define ISM330DHCX_SHUB_REG_ACCESS_BIT  (1U << 6)

/* CTRL3_C (12h) */
#define ISM330DHCX_BOOT_BIT             (1U << 7)
#define ISM330DHCX_BDU_BIT              (1U << 6)
#define ISM330DHCX_H_LACTIVE_BIT        (1U << 5)
#define ISM330DHCX_PP_OD_BIT            (1U << 4)
#define ISM330DHCX_SIM_3WIRE_BIT        (1U << 3)
#define ISM330DHCX_IF_INC_BIT           (1U << 2)
#define ISM330DHCX_SW_RESET_BIT         (1U << 0)

/* CTRL4_C (13h) */
#define ISM330DHCX_SLEEP_G_BIT          (1U << 6)
#define ISM330DHCX_INT2_ON_INT1_BIT     (1U << 5)
#define ISM330DHCX_DRDY_MASK_BIT        (1U << 3)
#define ISM330DHCX_I2C_DISABLE_BIT      (1U << 2)
#define ISM330DHCX_LPF1_SEL_G_BIT       (1U << 1)

/* CTRL9_XL (18h) */
#define ISM330DHCX_DEVICE_CONF_BIT      (1U << 1)

/* STATUS_REG (1Eh) */
#define ISM330DHCX_TDA_BIT              (1U << 2)   /**< Temperature data available */
#define ISM330DHCX_GDA_BIT              (1U << 1)   /**< Gyroscope data available */
#define ISM330DHCX_XLDA_BIT             (1U << 0)   /**< Accelerometer data available */

/* MD1_CFG / MD2_CFG (5Eh / 5Fh) Routing */
#define ISM330DHCX_MD_EMB_FUNC_BIT      (1U << 1)   /**< Route embedded function interrupt */
#define ISM330DHCX_MD_6D_BIT            (1U << 2)
#define ISM330DHCX_MD_DOUBLE_TAP_BIT    (1U << 3)
#define ISM330DHCX_MD_FREE_FALL_BIT     (1U << 4)
#define ISM330DHCX_MD_WAKE_UP_BIT       (1U << 5)
#define ISM330DHCX_MD_SINGLE_TAP_BIT    (1U << 6)
#define ISM330DHCX_MD_SLEEP_CHANGE_BIT  (1U << 7)

/* EMB_FUNC_EN_B (05h) */
#define ISM330DHCX_MLC_EN_BIT           (1U << 4)   /**< Machine Learning Core enable */
#define ISM330DHCX_FIFO_COMPR_EN_BIT    (1U << 3)   /**< FIFO compression enable */
#define ISM330DHCX_FSM_EN_BIT           (1U << 0)   /**< Finite State Machine enable */

/* EMB_FUNC_INIT_B (67h) */
#define ISM330DHCX_MLC_INIT_BIT         (1U << 4)
#define ISM330DHCX_FIFO_COMPR_INIT_BIT  (1U << 3)
#define ISM330DHCX_FSM_INIT_BIT         (1U << 0)

/* PAGE_RW (17h) */
#define ISM330DHCX_EMB_FUNC_LIR_BIT     (1U << 7)
#define ISM330DHCX_PAGE_WRITE_BIT       (1U << 6)
#define ISM330DHCX_PAGE_READ_BIT        (1U << 5)

/* FIFO Data Tags (78h) */
typedef enum {
    ISM330DHCX_TAG_GYRO_NC       = 0x01,
    ISM330DHCX_TAG_ACCEL_NC      = 0x02,
    ISM330DHCX_TAG_TEMPERATURE   = 0x03,
    ISM330DHCX_TAG_TIMESTAMP     = 0x04,
    ISM330DHCX_TAG_CFG_CHANGE    = 0x05,
    ISM330DHCX_TAG_ACCEL_2XC     = 0x08,
    ISM330DHCX_TAG_ACCEL_3XC     = 0x09,
    ISM330DHCX_TAG_GYRO_2XC      = 0x0C,
    ISM330DHCX_TAG_GYRO_3XC      = 0x0D,
    ISM330DHCX_TAG_SENSOR_HUB_0  = 0x0E,
    ISM330DHCX_TAG_SENSOR_HUB_1  = 0x0F,
    ISM330DHCX_TAG_SENSOR_HUB_2  = 0x10,
    ISM330DHCX_TAG_SENSOR_HUB_3  = 0x11,
    ISM330DHCX_TAG_STEP_COUNTER  = 0x12
} ism330dhcx_fifo_tag_t;

/* ========================================================================= */
/* Enums & Configurations                                                    */
/* ========================================================================= */

/**
 * @brief Accelerometer Full Scale selection (CTRL1_XL[3:2])
 */
typedef enum {
    ISM330DHCX_XL_FS_2G  = 0x00,    /**< +/- 2 g  (0.061 mg/LSB) */
    ISM330DHCX_XL_FS_16G = 0x01,    /**< +/- 16 g (0.488 mg/LSB) */
    ISM330DHCX_XL_FS_4G  = 0x02,    /**< +/- 4 g  (0.122 mg/LSB) */
    ISM330DHCX_XL_FS_8G  = 0x03     /**< +/- 8 g  (0.244 mg/LSB) */
} ism330dhcx_xl_fs_t;

/**
 * @brief Gyroscope Full Scale selection (CTRL2_G[3:0])
 */
typedef enum {
    ISM330DHCX_GY_FS_250DPS  = 0x00, /**< +/- 250 dps  (8.75 mdps/LSB) */
    ISM330DHCX_GY_FS_500DPS  = 0x01, /**< +/- 500 dps  (17.5 mdps/LSB) */
    ISM330DHCX_GY_FS_1000DPS = 0x02, /**< +/- 1000 dps (35.0 mdps/LSB) */
    ISM330DHCX_GY_FS_2000DPS = 0x03, /**< +/- 2000 dps (70.0 mdps/LSB) */
    ISM330DHCX_GY_FS_125DPS  = 0x04, /**< +/- 125 dps  (4.375 mdps/LSB, FS_125 bit) */
    ISM330DHCX_GY_FS_4000DPS = 0x08  /**< +/- 4000 dps (140.0 mdps/LSB, FS_4000 bit) */
} ism330dhcx_gy_fs_t;

/**
 * @brief Accelerometer Output Data Rate (CTRL1_XL[7:4])
 */
typedef enum {
    ISM330DHCX_XL_ODR_OFF     = 0x00,
    ISM330DHCX_XL_ODR_12Hz5   = 0x01,
    ISM330DHCX_XL_ODR_26Hz    = 0x02,
    ISM330DHCX_XL_ODR_52Hz    = 0x03,
    ISM330DHCX_XL_ODR_104Hz   = 0x04,
    ISM330DHCX_XL_ODR_208Hz   = 0x05,
    ISM330DHCX_XL_ODR_416Hz   = 0x06,
    ISM330DHCX_XL_ODR_833Hz   = 0x07,
    ISM330DHCX_XL_ODR_1666Hz  = 0x08,
    ISM330DHCX_XL_ODR_3332Hz  = 0x09,
    ISM330DHCX_XL_ODR_6667Hz  = 0x0A,
    ISM330DHCX_XL_ODR_1Hz6_LP = 0x0B
} ism330dhcx_xl_odr_t;

/**
 * @brief Gyroscope Output Data Rate (CTRL2_G[7:4])
 */
typedef enum {
    ISM330DHCX_GY_ODR_OFF    = 0x00,
    ISM330DHCX_GY_ODR_12Hz5  = 0x01,
    ISM330DHCX_GY_ODR_26Hz   = 0x02,
    ISM330DHCX_GY_ODR_52Hz   = 0x03,
    ISM330DHCX_GY_ODR_104Hz  = 0x04,
    ISM330DHCX_GY_ODR_208Hz  = 0x05,
    ISM330DHCX_GY_ODR_416Hz  = 0x06,
    ISM330DHCX_GY_ODR_833Hz  = 0x07,
    ISM330DHCX_GY_ODR_1666Hz = 0x08,
    ISM330DHCX_GY_ODR_3332Hz = 0x09,
    ISM330DHCX_GY_ODR_6667Hz = 0x0A
} ism330dhcx_gy_odr_t;

/**
 * @brief Machine Learning Core ODR (EMB_FUNC_ODR_CFG_C[5:4])
 */
typedef enum {
    ISM330DHCX_MLC_ODR_12Hz5 = 0x00,
    ISM330DHCX_MLC_ODR_26Hz  = 0x01,
    ISM330DHCX_MLC_ODR_52Hz  = 0x02,
    ISM330DHCX_MLC_ODR_104Hz = 0x03
} ism330dhcx_mlc_odr_t;

/**
 * @brief FIFO Modes (FIFO_CTRL4[2:0])
 */
typedef enum {
    ISM330DHCX_FIFO_BYPASS       = 0x00,
    ISM330DHCX_FIFO_MODE         = 0x01,
    ISM330DHCX_FIFO_CONT_TO_FIFO = 0x03,
    ISM330DHCX_FIFO_BYPASS_CONT  = 0x04,
    ISM330DHCX_FIFO_CONTINUOUS   = 0x06,
    ISM330DHCX_FIFO_BYPASS_FIFO  = 0x07
} ism330dhcx_fifo_mode_t;

/* ========================================================================= */
/* Sensitivity Scale Conversion Multipliers                                  */
/* ========================================================================= */
#define ISM330DHCX_SENSITIVITY_FS_2G       0.061e-3f    /**< g/LSB */
#define ISM330DHCX_SENSITIVITY_FS_4G       0.122e-3f    /**< g/LSB */
#define ISM330DHCX_SENSITIVITY_FS_8G       0.244e-3f    /**< g/LSB */
#define ISM330DHCX_SENSITIVITY_FS_16G      0.488e-3f    /**< g/LSB */

#define ISM330DHCX_SENSITIVITY_FS_125DPS   4.375e-3f    /**< dps/LSB */
#define ISM330DHCX_SENSITIVITY_FS_250DPS   8.750e-3f    /**< dps/LSB */
#define ISM330DHCX_SENSITIVITY_FS_500DPS   17.50e-3f    /**< dps/LSB */
#define ISM330DHCX_SENSITIVITY_FS_1000DPS  35.00e-3f    /**< dps/LSB */
#define ISM330DHCX_SENSITIVITY_FS_2000DPS  70.00e-3f    /**< dps/LSB */
#define ISM330DHCX_SENSITIVITY_FS_4000DPS  140.0e-3f    /**< dps/LSB */

#define ISM330DHCX_TEMP_OFFSET_DEG_C       25.0f        /**< DegC at 0 LSB */
#define ISM330DHCX_TEMP_SENSITIVITY        256.0f       /**< LSB / DegC */

#ifdef __cplusplus
}
#endif

#endif /* ISM330DHCX_REGS_H */
