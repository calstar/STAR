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
#endif

enum {
    REC_IMU = 0x10,   /* rec_imu_t */
    REC_HIGHG = 0x11, /* rec_highg_t */
    REC_BARO = 0x12,  /* rec_baro_t */
    REC_GNSS = 0x13,  /* rec_gnss_t (gnss_core) */
    REC_HEALTH = 0x14,
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

_Static_assert(sizeof(rec_imu_t) == 18, "rec_imu_t layout");
_Static_assert(sizeof(rec_gnss_t) == 49, "rec_gnss_t layout");
_Static_assert(sizeof(rec_highg_t) == 7, "rec_highg_t layout");
_Static_assert(sizeof(rec_baro_t) == 12, "rec_baro_t layout");

#ifdef __cplusplus
}
#endif
#endif
