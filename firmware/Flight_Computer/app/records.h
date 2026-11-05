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

_Static_assert(sizeof(rec_imu_t) == 18, "rec_imu_t layout");
_Static_assert(sizeof(rec_highg_t) == 7, "rec_highg_t layout");
_Static_assert(sizeof(rec_baro_t) == 12, "rec_baro_t layout");

#ifdef __cplusplus
}
#endif
#endif
