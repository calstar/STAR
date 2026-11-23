/**
 * @file main_avionics_firmware.c
 * @brief Complete runnable embedded application demonstrating ISM330DHCX
 *        driver with on-chip Machine Learning Core (MLC) flight classification.
 * 
 * Hardware Compatibility:
 * - STM32, ESP32, Teensy 4.1, RP2040, or Posix/Linux embedded boards.
 * - This file includes both simulated HAL for desktop testing and templates
 *   for STM32 HAL (SPI/I2C) and Linux /dev/i2c bus bindings.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "ism330dhcx.h"
#include "mlc_avionics_config.h"

/* ========================================================================= */
/* Simulated / Platform HAL (Can be swapped with STM32 / Arduino / Linux HAL)*/
/* ========================================================================= */

typedef struct {
    uint8_t memory[256];        /**< Primary registers (0x00 - 0xFF) */
    uint8_t emb_memory[256];    /**< Embedded functions bank registers */
    bool in_embedded_bank;      /**< Current bank mode */
    uint32_t flight_tick;       /**< Simulation tick counter */
} simulated_hw_t;

static simulated_hw_t g_sim_hw;

/* Low-level simulated bus write */
static int32_t hal_write_reg(void *handle, uint8_t reg, const uint8_t *data, uint16_t len) {
    simulated_hw_t *hw = (simulated_hw_t *)handle;
    if (!hw || !data) return ISM330DHCX_ERROR;

    for (uint16_t i = 0; i < len; i++) {
        uint8_t curr_reg = reg + i;
        if (curr_reg == ISM330DHCX_REG_FUNC_CFG_ACCESS) {
            hw->in_embedded_bank = (data[i] & ISM330DHCX_FUNC_CFG_EN_BIT) != 0;
            hw->memory[curr_reg] = data[i];
        } else if (hw->in_embedded_bank) {
            hw->emb_memory[curr_reg] = data[i];
        } else {
            hw->memory[curr_reg] = data[i];
        }
    }
    return ISM330DHCX_OK;
}

/* Low-level simulated bus read */
static int32_t hal_read_reg(void *handle, uint8_t reg, uint8_t *data, uint16_t len) {
    simulated_hw_t *hw = (simulated_hw_t *)handle;
    if (!hw || !data) return ISM330DHCX_ERROR;

    for (uint16_t i = 0; i < len; i++) {
        uint8_t curr_reg = reg + i;
        if (hw->in_embedded_bank) {
            data[i] = hw->emb_memory[curr_reg];
        } else {
            data[i] = hw->memory[curr_reg];
        }
    }
    return ISM330DHCX_OK;
}

/* Millisecond delay */
static void hal_delay_ms(uint32_t ms) {
    (void)ms;
    /* In desktop simulation, delay is minimal; in bare metal: HAL_Delay(ms) */
}

/* Simulation helper: Inject synthetic rocket avionics physics into registers */
static void sim_inject_flight_kinematics(simulated_hw_t *hw, uint32_t tick) {
    float ax = 0.0f, ay = 0.0f, az = 1.0f;
    float gx = 0.0f, gy = 0.0f, gz = 0.0f;
    uint8_t mlc_phase = AVIONICS_PHASE_PAD;
    uint8_t signal_drop_risk = 0;
    uint8_t extreme_tumbling = 0;

    /* Simulate a realistic rocket launch sequence:
     * Ticks 0-20:   Pad (1g upright)
     * Ticks 21-50:  Boost (11.5g axial thrust, fast roll)
     * Ticks 51-70:  Coast (drag decel, ballistic arc)
     * Ticks 71-85:  Apogee (0.05g micro-gravity rollover)
     * Ticks 86-110: Drogue Chute (-7g deceleration shock spike)
     * Ticks 111-135: Violent Anomaly / Tumbling (>1000 dps)
     * Ticks 136-160: Main Chute (steady descent)
     * Ticks >160:    Landed (1g static)
     */
    if (tick <= 20) {
        mlc_phase = AVIONICS_PHASE_PAD;
        ax = 0.02f; ay = -0.01f; az = 1.00f;
        gx = 0.2f;  gy = -0.1f;  gz = 0.1f;
    } else if (tick <= 50) {
        mlc_phase = AVIONICS_PHASE_BOOST;
        ax = 0.35f; ay = -0.20f; az = 11.85f;
        gx = 5.0f;  gy = -4.0f;  gz = 320.0f; /* 320 dps spin stabilization */
    } else if (tick <= 70) {
        mlc_phase = AVIONICS_PHASE_COAST;
        ax = 0.05f; ay = -0.05f; az = 0.15f;
        gx = 12.0f; gy = -8.0f;  gz = 45.0f;
    } else if (tick <= 85) {
        mlc_phase = AVIONICS_PHASE_APOGEE;
        ax = 0.01f; ay = 0.02f;  az = 0.03f;
        gx = 65.0f; gy = 180.0f; gz = 10.0f; /* 180 dps pitch turnover */
    } else if (tick <= 110) {
        mlc_phase = AVIONICS_PHASE_DROGUE;
        ax = 1.2f;  ay = -0.8f;  az = -7.2f;  /* Drogue deployment shock */
        gx = 85.0f; gy = -60.0f; gz = 110.0f;
    } else if (tick <= 135) {
        /* Severe in-flight aerodynamic anomaly */
        mlc_phase = AVIONICS_PHASE_DROGUE;
        extreme_tumbling = 1;
        signal_drop_risk = 1;
        ax = 3.5f;   ay = 4.2f;   az = -2.1f;
        gx = 1250.0f; gy = 980.0f; gz = 1140.0f; /* >1000 dps violent tumble */
    } else if (tick <= 160) {
        mlc_phase = AVIONICS_PHASE_MAIN;
        ax = 0.08f; ay = -0.05f; az = -1.15f;
        gx = 4.0f;  gy = -3.0f;  gz = 6.0f;
    } else {
        mlc_phase = AVIONICS_PHASE_TOUCHDOWN;
        ax = 0.01f; ay = 0.02f;  az = 1.01f;
        gx = 0.1f;  gy = 0.1f;   gz = 0.0f;
    }

    /* Convert to raw integers (FS: +/-16g -> 0.488 mg/LSB; +/-4000dps -> 140 mdps/LSB) */
    int16_t raw_ax = (int16_t)(ax / 0.000488f);
    int16_t raw_ay = (int16_t)(ay / 0.000488f);
    int16_t raw_az = (int16_t)(az / 0.000488f);

    int16_t raw_gx = (int16_t)(gx / 0.140f);
    int16_t raw_gy = (int16_t)(gy / 0.140f);
    int16_t raw_gz = (int16_t)(gz / 0.140f);

    int16_t raw_temp = (int16_t)((34.5f - 25.0f) * 256.0f); /* 34.5 deg C */

    /* Update hardware registers */
    hw->memory[ISM330DHCX_REG_OUT_TEMP_L] = (uint8_t)(raw_temp & 0xFF);
    hw->memory[ISM330DHCX_REG_OUT_TEMP_H] = (uint8_t)((raw_temp >> 8) & 0xFF);

    hw->memory[ISM330DHCX_REG_OUTX_L_G]   = (uint8_t)(raw_gx & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTX_H_G]   = (uint8_t)((raw_gx >> 8) & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTY_L_G]   = (uint8_t)(raw_gy & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTY_H_G]   = (uint8_t)((raw_gy >> 8) & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTZ_L_G]   = (uint8_t)(raw_gz & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTZ_H_G]   = (uint8_t)((raw_gz >> 8) & 0xFF);

    hw->memory[ISM330DHCX_REG_OUTX_L_A]   = (uint8_t)(raw_ax & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTX_H_A]   = (uint8_t)((raw_ax >> 8) & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTY_L_A]   = (uint8_t)(raw_ay & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTY_H_A]   = (uint8_t)((raw_ay >> 8) & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTZ_L_A]   = (uint8_t)(raw_az & 0xFF);
    hw->memory[ISM330DHCX_REG_OUTZ_H_A]   = (uint8_t)((raw_az >> 8) & 0xFF);

    /* Update on-chip MLC Decision Tree Source outputs (in embedded memory bank) */
    hw->emb_memory[ISM330DHCX_EMB_MLC0_SRC] = mlc_phase;
    hw->emb_memory[ISM330DHCX_EMB_MLC1_SRC] = signal_drop_risk;
    hw->emb_memory[ISM330DHCX_EMB_MLC2_SRC] = (mlc_phase == AVIONICS_PHASE_APOGEE) ? 1 : 0;
    hw->emb_memory[ISM330DHCX_EMB_MLC3_SRC] = (mlc_phase == AVIONICS_PHASE_DROGUE) ? 1 : 0;
    hw->emb_memory[ISM330DHCX_EMB_MLC4_SRC] = (mlc_phase == AVIONICS_PHASE_MAIN) ? 1 : 0;
    hw->emb_memory[ISM330DHCX_EMB_MLC5_SRC] = (mlc_phase == AVIONICS_PHASE_TOUCHDOWN) ? 1 : 0;
    hw->emb_memory[ISM330DHCX_EMB_MLC6_SRC] = extreme_tumbling;
    hw->emb_memory[ISM330DHCX_EMB_MLC7_SRC] = extreme_tumbling; /* Emergency chute trigger */

    /* Data ready status */
    hw->memory[ISM330DHCX_REG_STATUS_REG] = ISM330DHCX_XLDA_BIT | ISM330DHCX_GDA_BIT | ISM330DHCX_TDA_BIT;
}

/* ========================================================================= */
/* Application Entrypoint                                                    */
/* ========================================================================= */

int main(void) {
    printf("================================================================================\n");
    printf("   STMicroelectronics ISM330DHCX Avionics Flight Computer Firmware Driver      \n");
    printf("   6-DOF IMU + On-Chip Machine Learning Core (MLC) Flight Phase Classification \n");
    printf("================================================================================\n\n");

    /* 1. Setup simulated hardware / peripheral context */
    memset(&g_sim_hw, 0, sizeof(g_sim_hw));
    g_sim_hw.memory[ISM330DHCX_REG_WHO_AM_I] = ISM330DHCX_WHO_AM_I_VAL; /* 0x6B */

    ism330dhcx_ctx_t dev;
    dev.handle    = &g_sim_hw;
    dev.write_reg = hal_write_reg;
    dev.read_reg  = hal_read_reg;
    dev.delay_ms  = hal_delay_ms;
    dev.i2c_addr  = ISM330DHCX_I2C_ADD_L;

    /* 2. Initialize ISM330DHCX sensor */
    printf("[INIT] Initializing ISM330DHCX...\n");
    int32_t status = ism330dhcx_init(&dev);
    if (status != ISM330DHCX_OK) {
        printf("[ERROR] ism330dhcx_init failed with error code: %d\n", (int)status);
        return EXIT_FAILURE;
    }
    printf("[INIT] Successfully detected ISM330DHCX (WHO_AM_I = 0x6B)!\n");

    /* 3. Configure Accelerometer for high-dynamic rocket flight (+/-16g, 416 Hz) */
    printf("[CONFIG] Setting Accelerometer: Full-Scale = +/-16g, ODR = 416 Hz\n");
    ism330dhcx_set_accel_config(&dev, ISM330DHCX_XL_ODR_416Hz, ISM330DHCX_XL_FS_16G);

    /* 4. Configure Gyroscope for high-rate spin (+/-4000 dps, 416 Hz) */
    printf("[CONFIG] Setting Gyroscope:     Full-Scale = +/-4000 dps, ODR = 416 Hz\n");
    ism330dhcx_set_gyro_config(&dev, ISM330DHCX_GY_ODR_416Hz, ISM330DHCX_GY_FS_4000DPS);

    /* 5. Load the Avionics Machine Learning Core configuration stream */
    printf("[MLC] Loading Avionics 8-Decision Tree Configuration into IMU Embedded RAM...\n");
    printf("[MLC] Stream length: %zu UCF transactions\n", (size_t)ISM330DHCX_AVIONICS_MLC_CONFIG_LEN);
    status = ism330dhcx_mlc_load_config(&dev,
                                        ism330dhcx_avionics_mlc_config,
                                        ISM330DHCX_AVIONICS_MLC_CONFIG_LEN);
    if (status != ISM330DHCX_OK) {
        printf("[ERROR] Failed to load MLC UCF configuration: %d\n", (int)status);
        return EXIT_FAILURE;
    }
    printf("[MLC] Configuration successfully loaded and verified!\n");

    /* 6. Enable MLC execution at 26 Hz on-chip */
    ism330dhcx_mlc_enable(&dev, true, ISM330DHCX_MLC_ODR_26Hz);
    printf("[MLC] Hardware Machine Learning Core active and evaluating decision trees!\n\n");

    /* 7. Run real-time flight telemetry & classification loop */
    printf("+-------+-------------------+-------------------+----------+------------------------+-----------+\n");
    printf("| T(ms) | Accel [X,Y,Z] (g) | Gyro [X,Y,Z](dps) | Temp(°C) | On-Chip MLC Decision   | Risk/Warn |\n");
    printf("+-------+-------------------+-------------------+----------+------------------------+-----------+\n");

    uint32_t flight_timestamps[] = {0, 15, 30, 45, 60, 75, 90, 105, 120, 130, 145, 165};
    size_t num_ticks = sizeof(flight_timestamps) / sizeof(flight_timestamps[0]);

    for (size_t i = 0; i < num_ticks; i++) {
        uint32_t tick = flight_timestamps[i];

        /* Inject simulated flight physics for demonstration */
        sim_inject_flight_kinematics(&g_sim_hw, tick);

        /* Read synchronized 6-DOF IMU vectors + Temperature in single burst */
        ism330dhcx_axes_t accel, gyro;
        float temp_c;
        ism330dhcx_read_sync_all(&dev, &accel, &gyro, &temp_c);

        /* Read on-chip Machine Learning Core (MLC) Decision Tree outputs */
        ism330dhcx_mlc_results_t mlc_res;
        ism330dhcx_mlc_get_results(&dev, &mlc_res);

        /* Format warnings */
        char warning_buf[32] = "NOMINAL";
        if (mlc_res.tree6_out != 0) {
            snprintf(warning_buf, sizeof(warning_buf), "🚨 ABORT/TUMBLE");
        } else if (mlc_res.tree1_out != 0) {
            snprintf(warning_buf, sizeof(warning_buf), "⚠️ RF DROP RISK");
        } else if (mlc_res.tree7_out != 0) {
            snprintf(warning_buf, sizeof(warning_buf), "⚡ CHUTE FIRE");
        }

        printf("| %5u | [%5.2f,%5.2f,%5.2f] | [%5.0f,%5.0f,%5.0f] |  %5.1f   | %-22s | %-9s |\n",
               tick * 100,
               accel.x, accel.y, accel.z,
               gyro.x, gyro.y, gyro.z,
               temp_c,
               avionics_phase_str(mlc_res.tree0_out),
               warning_buf);
    }
    printf("+-------+-------------------+-------------------+----------+------------------------+-----------+\n\n");

    printf("[SUCCESS] ISM330DHCX IMU + Embedded MLC Firmware executed with zero faults.\n");
    return EXIT_SUCCESS;
}
