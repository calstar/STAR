#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "fusion.h"

static rec_fusion_t out;
static void push_imu(fusion_t* f, uint32_t t, int16_t ax, int16_t ay,
                     int16_t az) {
    rec_imu_t r = {.t_us = t, .accel = {ax, ay, az}};
    fusion_feed(f, REC_IMU, &r, sizeof r, &out);
}
static void align(fusion_t* f, uint32_t start, int16_t ax, int16_t ay,
                  int16_t az) {
    fusion_init(f, 16, 4000);
    for (unsigned i = 0; i < 1000; ++i) {
        uint32_t t = start + i * 1200;
        if (i % 10 == 0) {
            rec_baro_t b = {t, 2000, 101325};
            fusion_feed(f, REC_BARO, &b, sizeof b, &out);
        }
        push_imu(f, t, ax, ay, az);
    }
    assert(f->flags & FUSION_READY);
}
static void covariance(const fusion_t* f) {
    const float (*p)[3] = f->p;
    for (int i = 0; i < 3; ++i) {
        assert(p[i][i] >= 0 && isfinite(p[i][i]));
        for (int j = 0; j < 3; ++j)
            assert(fabs(p[i][j] - p[j][i]) < 1.e-4f);
    }
    assert(p[0][0] * p[1][1] - p[0][1] * p[1][0] >= -1.e-5f);
    float determinant = p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) -
                        p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) +
                        p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0]);
    assert(determinant >= -1.e-5f);
}
static void stationary_and_rotation(void) {
    fusion_t f;
    align(&f, 0, 0, 0, 2049);
    assert(fabs(f.x[0]) < .01f && fabs(f.x[1]) < .01f);
    assert(fabs(f.q[0] - 1) < 1.e-5f);
    covariance(&f);
    align(&f, 0, 2049, 0, 0);
    assert(fabs(f.acceleration) < .01f && fabs(f.q[2] + sqrtf(.5f)) < .001f);
    align(&f, 0, 0, 0, -2049);
    assert(fabs(f.q[1] - 1) < .001f && fabs(f.acceleration) < .01f);
    align(&f, 0, 0, 0, 2049);
    for (int i = 0; i < 1000; ++i) {
        rec_imu_t r = {.t_us = f.last_us + 1000,
                       .gyro = {0, 0, 643},
                       .accel = {0, 0, 2049}};
        fusion_feed(&f, REC_IMU, &r, sizeof r, &out);
    }
    assert(fabs(f.q[0] - sqrtf(.5f)) < .002f &&
           fabs(f.q[3] - sqrtf(.5f)) < .002f);
    assert(fabs(f.x[0]) < .01f);
}
static void motion_and_faults(void) {
    fusion_t f;
    align(&f, 0, 0, 0, 2049);
    float a = 2049 * f.accel_scale;
    for (int i = 0; i < 1000; ++i)
        push_imu(&f, f.last_us + 1000, 0, 0, 4098);
    assert(fabs(f.x[0] - .5f * a) < .002f && fabs(f.x[1] - a) < .002f);
    assert(!f.on_pad);
    covariance(&f);
    rec_baro_t b = {f.last_us, 2000, 50000};
    double old = f.x[0];
    fusion_feed(&f, REC_BARO, &b, sizeof b, &out);
    assert(f.flags & FUSION_BARO_REJECT);
    assert(f.x[0] == old);
    rec_highg_t h = {f.last_us + 1000, {0, 0, 30}};
    fusion_feed(&f, REC_HIGHG, &h, sizeof h, &out);
    push_imu(&f, h.t_us, 0, 0, 32767);
    assert(f.flags & FUSION_HIGH_G);
    assert(f.acceleration > 200);
    push_imu(&f, h.t_us + 20000, 0, 0, 32767);
    assert(f.flags & FUSION_NO_ACCEL);
    assert(!(f.flags & FUSION_HIGH_G));
    uint32_t t = f.last_us;
    old = f.x[0];
    push_imu(&f, t, 0, 0, 2049);
    push_imu(&f, t - 1, 0, 0, 2049);
    assert(f.x[0] == old && f.last_us == t && f.dropped == 2);
    push_imu(&f, t + 100000, 0, 0, 2049);
    assert(f.flags & FUSION_GAP);
    assert(f.flags & FUSION_ATTITUDE_LOST);
    assert(f.x[0] == old);
    covariance(&f);
    align(&f, UINT32_MAX - 500000, 0, 0, 2049);
    assert(!(f.flags & FUSION_GAP));
    assert(fabs(f.x[0]) < .01f);
}
static void gps_and_validation(void) {
    fusion_t f;
    align(&f, 0, 0, 0, 2049);
    rec_gnss_t r = {.t_us = f.last_us,
                    .itow_ms = 1000,
                    .hmsl_mm = 1000000,
                    .vacc_mm = 3000,
                    .fix_type = 3,
                    .num_sv = 10,
                    .flags = 1};
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    assert(f.has_origin && fabs(f.gnss_origin - 1000) < .01f);
    float before = f.p[0][0];
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    assert(f.flags & FUSION_GNSS_REJECT);
    assert(f.p[0][0] == before);
    r.itow_ms += 100;
    r.fix_type = 2;
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    assert(f.p[0][0] == before);
    align(&f, 0, 0, 0, 2049);
    push_imu(&f, f.last_us + 1200, 0, 0, 4098);
    r.fix_type = 3;
    r.t_us = f.last_us;
    r.itow_ms += 100;
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    assert(!f.has_origin);
    uint8_t bytes[3] = {0};
    fusion_feed(&f, REC_IMU, bytes, sizeof bytes, &out);
    assert(f.dropped == 1);
    fusion_init(&f, 2, 125);
    assert(fabs(f.accel_scale - .000061f * 9.80665f) < 1.e-7f);
    assert(fabs(f.gyro_scale - .004375f * 3.14159265f / 180) < 1.e-8f);
    for (int i = 0; i < 1000; ++i)
        push_imu(&f, (uint32_t)i * 1200, 0, 0, 32767);
    assert(!(f.flags & FUSION_READY));
}
static void stale_measurements(void) {
    fusion_t f;
    align(&f, 0, 0, 0, 2049);
    rec_baro_t b = {f.last_us, 2000, 101325};
    fusion_feed(&f, REC_BARO, &b, sizeof b, &out);
    float p = f.p[0][0];
    fusion_feed(&f, REC_BARO, &b, sizeof b, &out);
    assert(f.p[0][0] == p && f.dropped == 1);
    --b.t_us;
    fusion_feed(&f, REC_BARO, &b, sizeof b, &out);
    assert(f.p[0][0] == p && f.dropped == 2);
    rec_gnss_t r = {.t_us = f.last_us,
                    .itow_ms = 604799900,
                    .hmsl_mm = 1000000,
                    .vacc_mm = 3000,
                    .fix_type = 3,
                    .num_sv = 10,
                    .flags = 1};
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    r.itow_ms = 0;
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    assert(!(f.flags & FUSION_GNSS_REJECT));
    p = f.p[0][0];
    r.itow_ms = 604799900;
    fusion_feed(&f, REC_GNSS, &r, sizeof r, &out);
    assert(f.p[0][0] == p && (f.flags & FUSION_GNSS_REJECT));
    rec_imu_t imu = {
        .t_us = f.last_us + 1200, .gyro = {0, 28000, 0}, .accel = {0, 0, 2049}};
    fusion_feed(&f, REC_IMU, &imu, sizeof imu, &out);
    assert(f.flags & FUSION_ATTITUDE_LOST);
}

static void mounting(void) {
    fusion_t f;
    align(&f, 0, 0, 0, 2049);
    const int8_t bad[3] = {0, 0, 0}, axes[3] = {2, 3, -1};
    assert(!fusion_set_highg_axes(&f, bad));
    rec_highg_t h = {f.last_us + 1200, {-30, 0, 0}};
    fusion_feed(&f, REC_HIGHG, &h, sizeof h, &out);
    push_imu(&f, h.t_us, 0, 0, 32767);
    assert((f.flags & FUSION_NO_ACCEL) && !(f.flags & FUSION_HIGH_G));
    assert(fusion_set_highg_axes(&f, axes));
    h.t_us += 1200;
    fusion_feed(&f, REC_HIGHG, &h, sizeof h, &out);
    push_imu(&f, h.t_us, 0, 0, 32767);
    assert(f.flags & FUSION_HIGH_G);
    assert(f.acceleration > 200);
}

int main(void) {
    mounting();
    stale_measurements();
    stationary_and_rotation();
    motion_and_faults();
    gps_and_validation();
    puts(
        "fusion: alignment, physics, quaternion, saturation, gaps, wrap, GPS, "
        "validation PASS");
    return 0;
}
