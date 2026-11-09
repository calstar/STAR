#ifndef STAR_SENSORS_CORE_H
#define STAR_SENSORS_CORE_H

/*
 * The SPI3 sensors (IMU, high-g, barometer) as one state machine. Portable:
 * no HAL, no RTOS; time and events are passed in, so the same code runs in
 * sensors_task on the board and in the host tests on a laptop.
 *
 *   IMU     read on its data-ready edge (EV_IMU), stamped with the edge time
 *   high-g  read on its data-ready edge (EV_HIGHG); its DRDY is a level, so
 *           if no edge for 2 periods it is read anyway (missed_drdy++)
 *   baro    D1 -> 10 ms -> D2 -> 10 ms -> compensate -> D1 ... (no DRDY pin)
 *
 * A sensor whose init fails, or that fails SENSORS_MAX_ERRORS reads in a
 * row, is re-initialized every SENSORS_RETRY_US until it answers.
 */

#include <stdbool.h>
#include <stdint.h>

#include "dev_bus.h"
#include "dev_ms5611.h"
#include "fc_config.h"
#include "records.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SENSORS_EV_IMU (1U << 0)
#define SENSORS_EV_HIGHG (1U << 1)

#define SENSORS_IMU_PERIOD_US 1200U   /* 833 Hz (ISM330DHCX ODR) */
#define SENSORS_HIGHG_PERIOD_US 2500U /* 400 Hz (H3LIS100DL ODR) */
#define SENSORS_BARO_STEP_US (MS5611_CONVERSION_MS * 1000U)
#define SENSORS_RETRY_US 1000000U
#define SENSORS_MAX_ERRORS 3U

typedef record_sink_t sensors_sink_t;

typedef struct {
    bool ok;
    int last_error;        /* DEV_* of the last failure */
    uint32_t samples;      /* records produced */
    uint32_t missed_drdy;  /* reads done on timeout, not on an edge */
    uint32_t errors;       /* failed reads */
    uint32_t inits;        /* init attempts */
    uint32_t error_streak; /* consecutive failed reads */
    uint32_t retry_at_us;
} sensors_device_t;

/* Register values and periods from the settings (sensors_settings). */
typedef struct {
    uint8_t imu_ctrl1_xl, imu_ctrl2_g, highg_ctrl1, baro_osr_step;
    uint32_t imu_period_us, highg_period_us, baro_step_us;
} sensors_settings_t;

sensors_settings_t sensors_settings(const fc_config_t* c);

typedef struct {
    /* Set before sensors_core_init; all zero = the defaults. */
    sensors_settings_t settings;
    dev_bus_t imu_bus, highg_bus, baro_bus;
    sensors_sink_t sink;
    sensors_device_t imu, highg, baro;
    uint32_t imu_last_us, highg_last_us;
    ms5611_prom_t prom;
    uint8_t baro_phase; /* 0 start D1, 1 D1 converting, 2 D2 converting */
    uint32_t baro_due_us;
    uint32_t baro_d1;
    uint32_t baro_d1_us;
    /* Latest sample of each, for low-rate readers (telemetry). */
    rec_imu_t imu_latest;
    rec_highg_t highg_latest;
    rec_baro_t baro_latest;
} sensors_core_t;

/* Buses and sink must be set before init. Initializes all three sensors. */
void sensors_core_init(sensors_core_t* core, uint32_t now_us);

/* Idle: power the IMU and high-g down (DRDY stops) and drop any barometer
 * conversion; the MS5611 is in standby whenever it is not converting.
 * sensors_core_init() starts everything again. */
void sensors_core_stop(sensors_core_t* core);

/* Handle events (SENSORS_EV_*) with their edge times, then any timeouts. */
void sensors_core_step(sensors_core_t* core, uint32_t events,
                       uint32_t imu_edge_us, uint32_t highg_edge_us,
                       uint32_t now_us);

/* Microseconds until the next deadline (baro step, DRDY timeout, retry). */
uint32_t sensors_core_wait_us(const sensors_core_t* core, uint32_t now_us);

#ifdef __cplusplus
}
#endif
#endif
