#ifndef STAR_RECORDS_H
#define STAR_RECORDS_H

/*
 * Record types and payloads: the flight computer's data, as it goes into the
 * eMMC log (emmc_log_append: types >= 0x10; 0x01-0x0F belong to the log) and
 * the SD NAND mirror. Fixed little-endian layouts (Cortex-M7 and the host
 * test machines are little-endian); sizes are pinned so a change is a
 * deliberate format change. Every payload starts with t_us, the board_time
 * microsecond stamp of the sample (TIM2, wraps every ~71.6 min).
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#define REC_STATIC_ASSERT static_assert /* C++ tests include this too */
#else
#define REC_STATIC_ASSERT _Static_assert
#endif

enum {
    REC_IMU = 0x10,    /* rec_imu_t */
    REC_HIGHG = 0x11,  /* rec_highg_t */
    REC_BARO = 0x12,   /* rec_baro_t */
    REC_GNSS = 0x13,   /* rec_gnss_t (gnss_core) */
    REC_HEALTH = 0x14, /* rec_health_t (health_core) */
    REC_EVENT = 0x15,
};

/* Where a task core hands its records (eMMC log on the board, a list in
 * tests). Called from task context only. */
typedef struct {
    void (*record)(void* ctx, uint8_t type, const void* data, uint8_t len);
    void* ctx;
} record_sink_t;

typedef struct __attribute__((packed)) {
    uint32_t t_us;
    int16_t temp;     /* ISM330DHCX raw: degC = 25 + temp / 256 */
    int16_t gyro[3];  /* raw, 140 mdps/LSB */
    int16_t accel[3]; /* raw, 0.488 mg/LSB */
} rec_imu_t;

typedef struct __attribute__((packed)) {
    uint32_t t_us;
    int8_t accel[3]; /* H3LIS100DL raw, 780 mg/digit */
} rec_highg_t;

typedef struct __attribute__((packed)) {
    uint32_t t_us; /* end of the D1 (pressure) conversion */
    int32_t temp_c100;
    int32_t pressure_pa;
} rec_baro_t;

typedef struct __attribute__((packed)) {
    uint32_t t_us;   /* arrival of the NAV-PVT frame (UART9 RX) */
    uint32_t pps_us; /* latest GPS TIMEPULSE edge before it (0: none yet) */
    uint32_t itow_ms;
    int32_t lat_e7, lon_e7; /* 1e-7 deg */
    int32_t hmsl_mm;
    int32_t vel_n_mms, vel_e_mms, vel_d_mms;
    uint32_t hacc_mm, vacc_mm;
    uint16_t pdop_e2;
    uint8_t fix_type, num_sv, flags;
} rec_gnss_t;

/* The analog inputs, raw, in board_adc_input_t order: VBAT (PA0), EXT_SENSE_1
 * (PA1), PYRO_1_CONT (PA2), PYRO_2_CONT (PA3), EXT_SENSE_2 (PA4), ALT_CURR
 * (PC0), CURR (PC1). Continuity is read only: nothing here drives a pyro. */
#define REC_HEALTH_INPUTS 7U

typedef struct __attribute__((packed)) {
    uint32_t t_us;
    uint16_t battery_mv; /* PA0 through battery.c (USB's supply on USB) */
    uint16_t current_ma; /* PC1, 1 V/A */
    uint16_t counts[REC_HEALTH_INPUTS];
    uint8_t valid;       /* bit per input: the conversion returned */
    uint8_t battery;     /* battery_state_t */
    uint8_t task_faults; /* health_t faults: bit per stalled worker */
} rec_health_t;

REC_STATIC_ASSERT(sizeof(rec_imu_t) == 18, "rec_imu_t layout");
REC_STATIC_ASSERT(sizeof(rec_gnss_t) == 49, "rec_gnss_t layout");
REC_STATIC_ASSERT(sizeof(rec_highg_t) == 7, "rec_highg_t layout");
REC_STATIC_ASSERT(sizeof(rec_baro_t) == 12, "rec_baro_t layout");
REC_STATIC_ASSERT(sizeof(rec_health_t) == 25, "rec_health_t layout");

#ifdef __cplusplus
}
#endif
#endif
