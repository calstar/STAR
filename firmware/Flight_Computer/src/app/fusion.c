#include "fusion.h"

#include <math.h>
#include <string.h>

#define GRAVITY 9.80665f
#define PI 3.14159265358979323846f

static float norm3(const float a[3]) {
    return sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

void fusion_init(fusion_t* f, uint8_t accel_fs_g, uint16_t gyro_fs_dps) {
    memset(f, 0, sizeof(*f));
    f->p[0][0] = 4.0f;
    f->p[1][1] = 1.0f;
    f->p[2][2] = 0.25f;
    f->q[0] = 1.0f;
    f->accel_scale = (float)accel_fs_g * 0.0000305f * GRAVITY;
    f->gyro_scale = (float)gyro_fs_dps * 0.000035f * PI / 180.0f;
    f->on_pad = true;
    f->flags = FUSION_RELATIVE_YAW;
    for (int i = 0; i < 3; ++i)
        f->highg_axes[i] = (int8_t)(i + 1);
}

bool fusion_set_highg_axes(fusion_t* f, const int8_t axes[3]) {
    unsigned used = 0;
    f->has_highg = false;
    f->flags |= FUSION_HIGHG_UNALIGNED;
    if (!axes)
        return false;
    for (int i = 0; i < 3; ++i) {
        int axis = axes[i] < 0 ? -axes[i] : axes[i];
        if (axis < 1 || axis > 3 || (used & (1U << axis)))
            return false;
        used |= 1U << axis;
    }
    memcpy(f->highg_axes, axes, sizeof f->highg_axes);
    f->flags &= ~FUSION_HIGHG_UNALIGNED;
    return true;
}

static void output(const fusion_t* f, uint32_t t, rec_fusion_t* out) {
    out->t_us = t;
    out->altitude_m = f->x[0];
    out->velocity_mps = f->x[1];
    out->acceleration_mps2 = f->acceleration;
    out->bias_mps2 = f->x[2];
    for (int i = 0; i < 4; ++i)
        out->q[i] = f->q[i];
    out->sigma_altitude_m = sqrtf(fmaxf(0.0f, f->p[0][0]));
    out->sigma_velocity_mps = sqrtf(fmaxf(0.0f, f->p[1][1]));
    out->flags = f->flags;
    out->dropped = f->dropped;
}

static bool correct(fusion_t* f, float z, const float h[3], float r,
                    float gate) {
    float ph[3] = {0}, s = r, residual = z;
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j)
            ph[i] += f->p[i][j] * h[j];
        residual -= h[i] * f->x[i];
        s += h[i] * ph[i];
    }
    if (!isfinite(s) || s <= 0.0f || residual * residual > 25.0f * s ||
        fabsf(residual) > gate)
        return false;
    float k[3], m[3][3], mp[3][3] = {{0}}, p[3][3] = {{0}};
    for (int i = 0; i < 3; ++i) {
        k[i] = ph[i] / s;
        f->x[i] += k[i] * residual;
        for (int j = 0; j < 3; ++j)
            m[i][j] = (i == j ? 1.0f : 0.0f) - k[i] * h[j];
    }
    /* Joseph form retains a positive covariance under float rounding. */
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int l = 0; l < 3; ++l)
                mp[i][j] += m[i][l] * f->p[l][j];
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) {
            p[i][j] = r * k[i] * k[j];
            for (int l = 0; l < 3; ++l)
                p[i][j] += mp[i][l] * m[j][l];
        }
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            f->p[i][j] = 0.5f * (p[i][j] + p[j][i]);
    return true;
}

static void baro(fusion_t* f, const rec_baro_t* r) {
    uint32_t elapsed = r->t_us - f->baro_us;
    if (f->has_baro && (elapsed == 0U || elapsed >= 0x80000000U)) {
        f->flags |= FUSION_BARO_REJECT;
        ++f->dropped;
        return;
    }
    f->has_baro = true;
    f->baro_us = r->t_us;
    if (r->pressure_pa < 1000 || r->pressure_pa > 120000) {
        f->flags |= FUSION_BARO_REJECT;
        return;
    }
    if (!(f->flags & FUSION_READY)) {
        ++f->pn;
        f->p0 += ((float)r->pressure_pa - f->p0) / (float)f->pn;
        return;
    }
    float age = (float)(uint32_t)(f->last_us - r->t_us) * 1.e-6f;
    if (age > 0.1f) {
        f->flags |= FUSION_BARO_REJECT;
        return;
    }
    float height =
        44330.0f * (1.0f - powf((float)r->pressure_pa / f->p0, 0.19029495f));
    float h[3] = {1.0f, -age, 0.0f};
    if (correct(f, height - 0.5f * f->acceleration * age * age, h, 2.25f,
                30.0f))
        f->flags &= ~FUSION_BARO_REJECT;
    else
        f->flags |= FUSION_BARO_REJECT;
}

static void gnss(fusion_t* f, const rec_gnss_t* r) {
    if (r->fix_type < 3 || !(r->flags & 1U) || r->num_sv < 4 ||
        r->vacc_mm == 0 || r->vacc_mm > 50000 || r->itow_ms >= 604800000U ||
        (f->has_itow &&
         ((r->itow_ms + 604800000U - f->itow_ms) % 604800000U == 0U ||
          (r->itow_ms + 604800000U - f->itow_ms) % 604800000U >= 302400000U))) {
        f->flags |= FUSION_GNSS_REJECT;
        return;
    }
    f->itow_ms = r->itow_ms;
    f->has_itow = true;
    if (!(f->flags & FUSION_READY)) {
        f->gnss_origin = (float)r->hmsl_mm * 0.001f;
        f->has_origin = true;
        return;
    }
    int32_t lag = (int32_t)(f->last_us - r->t_us);
    if (lag < -5000 || lag > 200000) {
        f->flags |= FUSION_GNSS_REJECT;
        return;
    }
    if (!f->has_origin && f->on_pad) {
        f->gnss_origin = (float)r->hmsl_mm * 0.001f - f->x[0];
        f->has_origin = true;
    }
    if (!f->has_origin) {
        f->flags |= FUSION_GNSS_REJECT;
        return;
    }
    float age = fmaxf(0.0f, (float)lag * 1.e-6f),
          sd = (float)r->vacc_mm * 0.001f;
    float variance = fmaxf(9.0f, sd * sd) + 0.01f * f->x[1] * f->x[1];
    float h[3] = {1.0f, -age, 0.0f};
    float z = (float)r->hmsl_mm * 0.001f - f->gnss_origin -
              0.5f * f->acceleration * age * age;
    if (correct(f, z, h, variance, 100.0f))
        f->flags &= ~FUSION_GNSS_REJECT;
    else
        f->flags |= FUSION_GNSS_REJECT;
}

static void attitude(fusion_t* f, const float gyro[3], float dt) {
    float w[3];
    for (int i = 0; i < 3; ++i)
        w[i] = gyro[i] - f->gyro_bias[i];
    float angle = norm3(w) * dt;
    float scale = angle > 1.e-12f ? sinf(angle * 0.5f) * dt / angle : dt * 0.5f;
    float a = cosf(angle * 0.5f), b = w[0] * scale, c = w[1] * scale,
          d = w[2] * scale;
    float qw = f->q[0], x = f->q[1], y = f->q[2], z = f->q[3];
    f->q[0] = qw * a - x * b - y * c - z * d;
    f->q[1] = qw * b + x * a + y * d - z * c;
    f->q[2] = qw * c - x * d + y * a + z * b;
    f->q[3] = qw * d + x * c - y * b + z * a;
    float norm = sqrtf(f->q[0] * f->q[0] + f->q[1] * f->q[1] +
                       f->q[2] * f->q[2] + f->q[3] * f->q[3]);
    for (int i = 0; i < 4; ++i)
        f->q[i] /= norm;
}

static void predict(fusion_t* f, float a, float dt, float qa) {
    float dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt, dt5 = dt4 * dt;
    f->acceleration = a - f->x[2];
    if (fabsf(f->acceleration) > 3.0f || fabs(f->x[1]) > 3.0f || f->x[0] > 5.0f)
        f->on_pad = false;
    f->x[0] += dt * f->x[1] + 0.5f * dt2 * f->acceleration;
    f->x[1] += dt * f->acceleration;
    const float b = 0.0001f;
    float m[3][3] = {
        {1.0f, dt, -0.5f * dt2}, {0.0f, 1.0f, -dt}, {0.0f, 0.0f, 1.0f}};
    float mp[3][3] = {{0}},
          p[3][3] = {{qa * dt3 / 3.0f + b * dt5 / 20.0f,
                      qa * dt2 / 2.0f + b * dt4 / 8.0f, -b * dt3 / 6.0f},
                     {qa * dt2 / 2.0f + b * dt4 / 8.0f,
                      qa * dt + b * dt3 / 3.0f, -b * dt2 / 2.0f},
                     {-b * dt3 / 6.0f, -b * dt2 / 2.0f, b * dt}};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int l = 0; l < 3; ++l)
                mp[i][j] += m[i][l] * f->p[l][j];
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int l = 0; l < 3; ++l)
                p[i][j] += mp[i][l] * m[j][l];
    memcpy(f->p, p, sizeof p);
}

static bool imu(fusion_t* f, const rec_imu_t* r, rec_fusion_t* out) {
    uint32_t delta = r->t_us - f->last_us;
    if (f->has_time && (delta == 0 || delta >= 0x80000000U)) {
        ++f->dropped;
        return false;
    }
    bool had_time = f->has_time;
    f->has_time = true;
    f->last_us = r->t_us;
    float gyro[3], accel[3];
    for (int i = 0; i < 3; ++i) {
        gyro[i] = (float)r->gyro[i] * f->gyro_scale;
        accel[i] = (float)r->accel[i] * f->accel_scale;
    }
    if (!(f->flags & FUSION_READY)) {
        float norm = norm3(accel);
        if ((had_time && delta > 50000U) || norm <= 0.8f * GRAVITY ||
            norm >= 1.2f * GRAVITY || norm3(gyro) > 0.05f) {
            f->n = 0;
            f->pn = 0;
            f->p0 = 0.0f;
            f->has_origin = false;
            memset(f->acc_sum, 0, sizeof f->acc_sum);
            memset(f->gyro_sum, 0, sizeof f->gyro_sum);
            return false;
        }
        for (int i = 0; i < 3; ++i) {
            f->acc_sum[i] += accel[i];
            f->gyro_sum[i] += gyro[i];
        }
        ++f->n;
        if (f->n < 256U || f->pn < 8U)
            return false;
        float a[3];
        for (int i = 0; i < 3; ++i) {
            a[i] = f->acc_sum[i] / (float)f->n;
            f->gyro_bias[i] = f->gyro_sum[i] / (float)f->n;
        }
        norm = norm3(a);
        if (a[2] / norm > -0.99999f) {
            f->q[0] = 1.0f + a[2] / norm;
            f->q[1] = a[1] / norm;
            f->q[2] = -a[0] / norm;
            f->q[3] = 0.0f;
            float qn = sqrtf(f->q[0] * f->q[0] + f->q[1] * f->q[1] +
                             f->q[2] * f->q[2]);
            for (int i = 0; i < 4; ++i)
                f->q[i] /= qn;
        } else {
            f->q[0] = 0.0f;
            f->q[1] = 1.0f;
            f->q[2] = 0.0f;
            f->q[3] = 0.0f;
        }
        f->x[2] = norm - GRAVITY;
        f->flags |= FUSION_READY;
        f->last_out_us = r->t_us;
        output(f, r->t_us, out);
        return true;
    }
    f->flags &= ~(FUSION_HIGH_G | FUSION_NO_ACCEL);
    if (delta > 50000U) {
        f->flags |= FUSION_GAP | FUSION_ATTITUDE_LOST | FUSION_NO_ACCEL;
        f->p[0][0] += 100.0f;
        f->p[1][1] += 100.0f;
        f->p[2][2] += 1.0f;
        f->acceleration = 0.0f;
        ++f->dropped;
        output(f, r->t_us, out);
        return true;
    }
    bool saturated = false;
    for (int i = 0; i < 3; ++i) {
        if (r->gyro[i] >= 28000 || r->gyro[i] <= -28000)
            f->flags |= FUSION_ATTITUDE_LOST;
        if (r->accel[i] >= 32000 || r->accel[i] <= -32000)
            saturated = true;
    }
    float dt = (float)delta * 1.e-6f;
    attitude(f, gyro, dt);
    float qa = 0.64f;
    if (saturated) {
        bool valid =
            f->has_highg && (uint32_t)(r->t_us - f->highg_us) <= 10000U;
        for (int i = 0; i < 3; ++i)
            if (fabsf(f->highg[i]) >= 127.0f * 0.780f * GRAVITY)
                valid = false;
        if (valid) {
            memcpy(accel, f->highg, sizeof accel);
            f->flags |= FUSION_HIGH_G;
            qa = 64.0f;
        } else {
            f->flags |= FUSION_NO_ACCEL;
            qa = 2500.0f;
        }
    }
    if (f->flags & FUSION_ATTITUDE_LOST) {
        f->flags |= FUSION_NO_ACCEL;
        qa = 2500.0f;
    }
    float w = f->q[0], x = f->q[1], y = f->q[2], z = f->q[3];
    float a = 2.0f * (x * z - w * y) * accel[0] +
              2.0f * (y * z + w * x) * accel[1] +
              (1.0f - 2.0f * (x * x + y * y)) * accel[2] - GRAVITY;
    if (f->flags & FUSION_NO_ACCEL)
        a = f->x[2];
    predict(f, a, dt, qa);
    if ((uint32_t)(r->t_us - f->last_out_us) >= 20000U) {
        f->last_out_us = r->t_us;
        output(f, r->t_us, out);
        return true;
    }
    return false;
}

bool fusion_feed(fusion_t* f, uint8_t type, const void* data, uint8_t len,
                 rec_fusion_t* out) {
    if (!data || !out) {
        ++f->dropped;
        return false;
    }
    /* memcpy accepts unaligned log payloads without casting their storage. */
    if (type == REC_IMU && len == sizeof(rec_imu_t)) {
        rec_imu_t r;
        memcpy(&r, data, sizeof r);
        return imu(f, &r, out);
    }
    if (type == REC_HIGHG && len == sizeof(rec_highg_t)) {
        rec_highg_t r;
        memcpy(&r, data, sizeof r);
        uint32_t d = r.t_us - f->highg_us;
        if (!(f->flags & FUSION_HIGHG_UNALIGNED) &&
            (!f->has_highg || (d > 0U && d < 0x80000000U))) {
            f->has_highg = true;
            f->highg_us = r.t_us;
            for (int i = 0; i < 3; ++i) {
                int axis = f->highg_axes[i];
                int index = axis < 0 ? -axis - 1 : axis - 1;
                f->highg[i] = (axis < 0 ? -1.0f : 1.0f) *
                              (float)r.accel[index] * 0.780f * GRAVITY;
            }
        }
        return false;
    }
    if (type == REC_BARO && len == sizeof(rec_baro_t)) {
        rec_baro_t r;
        memcpy(&r, data, sizeof r);
        baro(f, &r);
        return false;
    }
    if (type == REC_GNSS && len == sizeof(rec_gnss_t)) {
        rec_gnss_t r;
        memcpy(&r, data, sizeof r);
        gnss(f, &r);
        return false;
    }
    ++f->dropped;
    return false;
}
