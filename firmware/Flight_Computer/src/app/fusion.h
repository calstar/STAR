#ifndef STAR_FUSION_H
#define STAR_FUSION_H

#include <stdbool.h>
#include <stdint.h>

#include "records.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FUSION_READY (1U << 0)
#define FUSION_HIGH_G (1U << 1)
#define FUSION_NO_ACCEL (1U << 2)
#define FUSION_GAP (1U << 3)
#define FUSION_BARO_REJECT (1U << 4)
#define FUSION_GNSS_REJECT (1U << 5)
#define FUSION_ATTITUDE_LOST (1U << 6)
#define FUSION_RELATIVE_YAW (1U << 7)
#define FUSION_HIGHG_UNALIGNED (1U << 8)

/* Single-owner state. Body axes are the IMU axes; high-g axes must have
 * the same mounting. q (w,x,y,z) rotates body to a z-up launch frame.
 * Yaw zero is arbitrary. This estimator never commands a flight event. */
typedef struct {
    double x[3]; /* retain millimetre increments at kilometre altitude */
    float p[3][3], q[4];
    float accel_scale, gyro_scale, gyro_bias[3];
    float acc_sum[3], gyro_sum[3], p0, highg[3], gnss_origin;
    float acceleration;
    uint32_t n, pn, last_us, last_out_us, highg_us, itow_ms;
    uint32_t flags, dropped;
    uint32_t baro_us;
    bool has_baro;
    int8_t highg_axes[3];
    bool has_time, has_highg, has_itow, has_origin, on_pad;
} fusion_t;

/* Reset before each sensor activation; ranges come from this arming's
 * fc_config_t, since raw records do not carry sensor range metadata. */
void fusion_init(fusion_t* f, uint8_t accel_fs_g, uint16_t gyro_fs_dps);

/* Signed permutation: each output IMU axis selects +/- high-g axis 1..3.
 * Invalid/zero mapping disables high-g use and sets HIGHG_UNALIGNED. */
bool fusion_set_highg_axes(fusion_t* f, const int8_t axes[3]);

/* No allocation, I/O, HAL or RTOS. Feed original record payloads in arrival
 * order. Malformed inputs are counted and ignored. Return one 50 Hz output
 * when available. The caller serializes calls; output may not alias data. */
bool fusion_feed(fusion_t* f, uint8_t type, const void* data, uint8_t len,
                 rec_fusion_t* out);

#ifdef __cplusplus
}
#endif
#endif
