/**
 * @file ism330dhcx.h
 * @brief High-Performance C/C++ Driver for STMicroelectronics ISM330DHCX IMU
 *        with Embedded Machine Learning Core (MLC).
 * 
 * Features:
 * - 6-DOF Kinematic Sensing: Accel (+/-2g to +/-16g), Gyro (+/-125dps to +/-4000dps)
 * - Ultra-low latency burst reads with atomic Block Data Update (BDU)
 * - On-chip FIFO streaming (3 KB - up to 9 KB compressed) with Tag parsing
 * - Embedded Functions & Machine Learning Core (MLC) loader and real-time evaluator
 * - Flexible HAL: Platform agnostic I2C/SPI bus abstraction
 */

#ifndef ISM330DHCX_H
#define ISM330DHCX_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#include "ism330dhcx_regs.h"
#include "ism330dhcx_mlc.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Return error codes */
#define ISM330DHCX_OK                 0
#define ISM330DHCX_ERROR             -1
#define ISM330DHCX_ERR_COMM          -2
#define ISM330DHCX_ERR_CHIP_ID       -3
#define ISM330DHCX_ERR_TIMEOUT       -4
#define ISM330DHCX_ERR_INVALID_PARAM -5

/**
 * @brief HAL IO Function Pointer Signatures
 */
typedef int32_t (*ism330dhcx_write_fn)(void *handle, uint8_t reg_addr, const uint8_t *data, uint16_t len);
typedef int32_t (*ism330dhcx_read_fn)(void *handle, uint8_t reg_addr, uint8_t *data, uint16_t len);
typedef void    (*ism330dhcx_delay_fn)(uint32_t ms);

/**
 * @brief Triaxial 16-bit raw integer readings
 */
typedef struct {
    int16_t x;
    int16_t y;
    int16_t z;
} ism330dhcx_raw_axes_t;

/**
 * @brief Triaxial engineering units
 */
typedef struct {
    float x;
    float y;
    float z;
} ism330dhcx_axes_t;

/**
 * @brief Driver Context Instance
 */
typedef struct {
    void                  *handle;        /**< Platform bus handle (e.g. SPI or I2C peripheral) */
    ism330dhcx_write_fn   write_reg;      /**< Low-level bus write function */
    ism330dhcx_read_fn    read_reg;       /**< Low-level bus read function */
    ism330dhcx_delay_fn   delay_ms;       /**< Millisecond delay function */

    uint8_t               i2c_addr;       /**< Current I2C device address (0 if SPI) */
    ism330dhcx_xl_fs_t    xl_fs;          /**< Configured accelerometer full scale */
    ism330dhcx_gy_fs_t    gy_fs;          /**< Configured gyroscope full scale */
    float                 xl_sensitivity; /**< Accel scale in g/LSB */
    float                 gy_sensitivity; /**< Gyro scale in dps/LSB */
    bool                  mlc_enabled;    /**< True if MLC flow is currently active */
} ism330dhcx_ctx_t;

/**
 * @brief Status register flags
 */
typedef struct {
    bool accel_data_ready;
    bool gyro_data_ready;
    bool temp_data_ready;
} ism330dhcx_status_t;

/* ========================================================================= */
/* Core IMU Driver API                                                       */
/* ========================================================================= */

/**
 * @brief Initialize the ISM330DHCX sensor, verify ID, apply recommended setup.
 * 
 * Verifies WHO_AM_I == 0x6B, performs software reset, sets Block Data Update (BDU = 1),
 * auto-increment (IF_INC = 1), and DEVICE_CONF = 1 (CTRL9_XL).
 * 
 * @param ctx Pointer to driver context initialized with bus function pointers.
 * @return 0 on success, negative error code on failure.
 */
int32_t ism330dhcx_init(ism330dhcx_ctx_t *ctx);

/**
 * @brief Perform software reset of device memory and registers.
 */
int32_t ism330dhcx_software_reset(ism330dhcx_ctx_t *ctx);

/**
 * @brief Configure Accelerometer ODR and Full Scale.
 */
int32_t ism330dhcx_set_accel_config(ism330dhcx_ctx_t *ctx, ism330dhcx_xl_odr_t odr, ism330dhcx_xl_fs_t fs);

/**
 * @brief Configure Gyroscope ODR and Full Scale.
 */
int32_t ism330dhcx_set_gyro_config(ism330dhcx_ctx_t *ctx, ism330dhcx_gy_odr_t odr, ism330dhcx_gy_fs_t fs);

/**
 * @brief Read data ready status flags.
 */
int32_t ism330dhcx_get_status(ism330dhcx_ctx_t *ctx, ism330dhcx_status_t *status);

/**
 * @brief Read raw accelerometer measurements (X, Y, Z in LSBs).
 */
int32_t ism330dhcx_read_accel_raw(ism330dhcx_ctx_t *ctx, ism330dhcx_raw_axes_t *raw);

/**
 * @brief Read calibrated accelerometer measurements in g (gravity units).
 */
int32_t ism330dhcx_read_accel_g(ism330dhcx_ctx_t *ctx, ism330dhcx_axes_t *accel);

/**
 * @brief Read raw gyroscope measurements (X, Y, Z in LSBs).
 */
int32_t ism330dhcx_read_gyro_raw(ism330dhcx_ctx_t *ctx, ism330dhcx_raw_axes_t *raw);

/**
 * @brief Read calibrated gyroscope measurements in dps (degrees per second).
 */
int32_t ism330dhcx_read_gyro_dps(ism330dhcx_ctx_t *ctx, ism330dhcx_axes_t *gyro);

/**
 * @brief Read on-die temperature sensor in degrees Celsius.
 */
int32_t ism330dhcx_read_temp_c(ism330dhcx_ctx_t *ctx, float *temp_c);

/**
 * @brief Synchronized 6-DOF + Temperature burst read in a single bus transaction.
 */
int32_t ism330dhcx_read_sync_all(ism330dhcx_ctx_t *ctx,
                                 ism330dhcx_axes_t *accel_g,
                                 ism330dhcx_axes_t *gyro_dps,
                                 float *temp_c);

/* ========================================================================= */
/* FIFO Buffer Management                                                    */
/* ========================================================================= */

/**
 * @brief Configure FIFO mode, watermark, and batching data rates.
 */
int32_t ism330dhcx_fifo_init(ism330dhcx_ctx_t *ctx,
                             ism330dhcx_fifo_mode_t mode,
                             uint16_t watermark_samples,
                             ism330dhcx_xl_odr_t bdr_xl,
                             ism330dhcx_gy_odr_t bdr_gy);

/**
 * @brief Get count of unread words (1 Tag + 6 bytes Data) available in FIFO.
 */
int32_t ism330dhcx_fifo_get_count(ism330dhcx_ctx_t *ctx, uint16_t *num_samples);

/**
 * @brief Pop a single tagged word out of the FIFO.
 */
int32_t ism330dhcx_fifo_pop_word(ism330dhcx_ctx_t *ctx,
                                 ism330dhcx_fifo_tag_t *tag,
                                 ism330dhcx_raw_axes_t *raw_axes);

/* ========================================================================= */
/* Machine Learning Core (MLC) API                                           */
/* ========================================================================= */

/**
 * @brief Load a compiled MLC / FSM configuration (UCF stream) into the IMU memory.
 * 
 * Writes register and embedded page settings to program features and decision trees.
 * 
 * @param ctx Pointer to driver context.
 * @param ucf_config Array of {address, data} tuples.
 * @param num_lines Number of lines in the configuration table.
 * @return 0 on success, negative error code on failure.
 */
int32_t ism330dhcx_mlc_load_config(ism330dhcx_ctx_t *ctx,
                                   const ism330dhcx_ucf_line_t *ucf_config,
                                   size_t num_lines);

/**
 * @brief Enable or disable the Machine Learning Core and set execution rate.
 */
int32_t ism330dhcx_mlc_enable(ism330dhcx_ctx_t *ctx, bool enable, ism330dhcx_mlc_odr_t odr);

/**
 * @brief Read event status of MLC decision trees from main register page.
 */
int32_t ism330dhcx_mlc_get_status(ism330dhcx_ctx_t *ctx, ism330dhcx_mlc_status_t *status);

/**
 * @brief Read real-time classification results from all 8 Decision Trees.
 * 
 * Reads MLC0_SRC through MLC7_SRC.
 * 
 * @param ctx Pointer to driver context.
 * @param results Pointer to structure receiving 8 tree outputs.
 * @return 0 on success.
 */
int32_t ism330dhcx_mlc_get_results(ism330dhcx_ctx_t *ctx, ism330dhcx_mlc_results_t *results);

/**
 * @brief Route MLC decision tree interrupts to INT1 or INT2 hardware pins.
 * 
 * @param ctx Pointer to driver context.
 * @param int_pin 1 for INT1 pin, 2 for INT2 pin.
 * @param mlc_tree_mask Bitmask of trees to trigger interrupt (bit 0 = Tree1 ... bit 7 = Tree8).
 */
int32_t ism330dhcx_mlc_route_interrupt(ism330dhcx_ctx_t *ctx, uint8_t int_pin, uint8_t mlc_tree_mask);

/* ========================================================================= */
/* Built-in Hardware Self-Test                                               */
/* ========================================================================= */

/**
 * @brief Run embedded accelerometer and gyroscope self-tests.
 * 
 * @param ctx Pointer to driver context.
 * @param accel_passed Output bool, true if accelerometer self-test delta is within datasheet spec.
 * @param gyro_passed Output bool, true if gyroscope self-test delta is within datasheet spec.
 */
int32_t ism330dhcx_self_test(ism330dhcx_ctx_t *ctx, bool *accel_passed, bool *gyro_passed);

#ifdef __cplusplus
}
#endif

#endif /* ISM330DHCX_H */
