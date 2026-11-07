#include "sensors_core.h"

#include "dev_h3lis100dl.h"
#include "dev_ism330dhcx.h"

/* Modular microsecond comparisons: a is at or after b. */
static bool reached(uint32_t now, uint32_t t) {
    return (int32_t)(now - t) >= 0;
}

static void emit(sensors_core_t* c, uint8_t type, const void* data,
                 uint8_t len) {
    if (c->sink.record) {
        c->sink.record(c->sink.ctx, type, data, len);
    }
}

static void failed(sensors_device_t* d, int err, uint32_t now_us) {
    d->errors++;
    d->last_error = err;
    if (++d->error_streak >= SENSORS_MAX_ERRORS) {
        d->ok = false;
        d->retry_at_us = now_us + SENSORS_RETRY_US;
    }
}

static void succeeded(sensors_device_t* d) {
    d->samples++;
    d->error_streak = 0;
}

static void init_imu(sensors_core_t* c, uint32_t now_us) {
    c->imu.inits++;
    int err = ism330_init(&c->imu_bus);
    c->imu.ok = err == DEV_OK;
    c->imu.last_error = err;
    c->imu.error_streak = 0;
    c->imu.retry_at_us = now_us + SENSORS_RETRY_US;
    c->imu_last_us = now_us;
}

static void init_highg(sensors_core_t* c, uint32_t now_us) {
    c->highg.inits++;
    int err = h3lis_init(&c->highg_bus);
    c->highg.ok = err == DEV_OK;
    c->highg.last_error = err;
    c->highg.error_streak = 0;
    c->highg.retry_at_us = now_us + SENSORS_RETRY_US;
    c->highg_last_us = now_us;
}

static void init_baro(sensors_core_t* c, uint32_t now_us) {
    c->baro.inits++;
    int err = ms5611_read_prom(&c->baro_bus, &c->prom);
    c->baro.ok = err == DEV_OK;
    c->baro.last_error = err;
    c->baro.error_streak = 0;
    c->baro.retry_at_us = now_us + SENSORS_RETRY_US;
    c->baro_phase = 0;
    c->baro_due_us = now_us;
}

void sensors_core_init(sensors_core_t* c, uint32_t now_us) {
    init_imu(c, now_us);
    init_highg(c, now_us);
    init_baro(c, now_us);
}

void sensors_core_stop(sensors_core_t* c) {
    (void)ism330_power_down(&c->imu_bus);
    (void)h3lis_power_down(&c->highg_bus);
    c->imu.ok = false;
    c->highg.ok = false;
    c->baro.ok = false;
    c->baro_phase = 0;
}

static void read_imu(sensors_core_t* c, uint32_t t_us, uint32_t now_us) {
    ism330_sample_t s;
    int err = ism330_read(&c->imu_bus, &s);
    c->imu_last_us = now_us;
    if (err != DEV_OK) {
        failed(&c->imu, err, now_us);
        return;
    }
    rec_imu_t r;
    r.t_us = t_us;
    r.temp = s.temp;
    for (int i = 0; i < 3; ++i) { /* packed record: no member pointers */
        r.gyro[i] = s.gyro[i];
        r.accel[i] = s.accel[i];
    }
    c->imu_latest = r;
    succeeded(&c->imu);
    emit(c, REC_IMU, &r, sizeof(r));
}

static void read_highg(sensors_core_t* c, uint32_t t_us, uint32_t now_us) {
    h3lis_sample_t s;
    int err = h3lis_read(&c->highg_bus, &s);
    c->highg_last_us = now_us;
    if (err != DEV_OK) {
        failed(&c->highg, err, now_us);
        return;
    }
    rec_highg_t r;
    r.t_us = t_us;
    for (int i = 0; i < 3; ++i) {
        r.accel[i] = s.accel[i];
    }
    c->highg_latest = r;
    succeeded(&c->highg);
    emit(c, REC_HIGHG, &r, sizeof(r));
}

static void step_baro(sensors_core_t* c, uint32_t now_us) {
    int err = DEV_OK;
    uint32_t raw = 0;
    switch (c->baro_phase) {
        case 0:
            err = ms5611_start(&c->baro_bus, MS5611_D1_PRESSURE);
            c->baro_phase = 1;
            break;
        case 1:
            err = ms5611_read_adc(&c->baro_bus, &raw);
            if (err == DEV_OK) {
                c->baro_d1 = raw;
                c->baro_d1_us = now_us;
                err = ms5611_start(&c->baro_bus, MS5611_D2_TEMPERATURE);
            }
            c->baro_phase = err == DEV_OK ? 2 : 0;
            break;
        default:
            err = ms5611_read_adc(&c->baro_bus, &raw);
            if (err == DEV_OK) {
                int32_t temp_c100, pressure_pa;
                ms5611_compensate(&c->prom, c->baro_d1, raw, &temp_c100,
                                  &pressure_pa);
                rec_baro_t r;
                r.t_us = c->baro_d1_us;
                r.temp_c100 = temp_c100;
                r.pressure_pa = pressure_pa;
                c->baro_latest = r;
                succeeded(&c->baro);
                emit(c, REC_BARO, &r, sizeof(r));
                err = ms5611_start(&c->baro_bus, MS5611_D1_PRESSURE);
            }
            c->baro_phase = err == DEV_OK ? 1 : 0;
            break;
    }
    if (err != DEV_OK) {
        failed(&c->baro, err, now_us);
    }
    c->baro_due_us = now_us + (c->baro_phase ? SENSORS_BARO_STEP_US : 0U);
}

void sensors_core_step(sensors_core_t* c, uint32_t events, uint32_t imu_edge_us,
                       uint32_t highg_edge_us, uint32_t now_us) {
    /* IMU */
    if (c->imu.ok) {
        if (events & SENSORS_EV_IMU) {
            read_imu(c, imu_edge_us, now_us);
        } else if (reached(now_us,
                           c->imu_last_us + 2U * SENSORS_IMU_PERIOD_US)) {
            c->imu.missed_drdy++;
            read_imu(c, now_us, now_us);
        }
    } else if (reached(now_us, c->imu.retry_at_us)) {
        init_imu(c, now_us);
    }
    /* High-g: level DRDY, so a timeout read also re-arms the edge. */
    if (c->highg.ok) {
        if (events & SENSORS_EV_HIGHG) {
            read_highg(c, highg_edge_us, now_us);
        } else if (reached(now_us,
                           c->highg_last_us + 2U * SENSORS_HIGHG_PERIOD_US)) {
            c->highg.missed_drdy++;
            read_highg(c, now_us, now_us);
        }
    } else if (reached(now_us, c->highg.retry_at_us)) {
        init_highg(c, now_us);
    }
    /* Barometer */
    if (c->baro.ok) {
        if (reached(now_us, c->baro_due_us)) {
            step_baro(c, now_us);
        }
    } else if (reached(now_us, c->baro.retry_at_us)) {
        init_baro(c, now_us);
    }
}

static uint32_t until(uint32_t now, uint32_t t) {
    int32_t d = (int32_t)(t - now);
    return d > 0 ? (uint32_t)d : 0U;
}

static uint32_t sooner(uint32_t a, uint32_t b) {
    return a < b ? a : b;
}

uint32_t sensors_core_wait_us(const sensors_core_t* c, uint32_t now_us) {
    uint32_t wait = SENSORS_RETRY_US;
    wait = sooner(
        wait, c->imu.ok
                  ? until(now_us, c->imu_last_us + 2U * SENSORS_IMU_PERIOD_US)
                  : until(now_us, c->imu.retry_at_us));
    wait = sooner(wait, c->highg.ok
                            ? until(now_us, c->highg_last_us +
                                                2U * SENSORS_HIGHG_PERIOD_US)
                            : until(now_us, c->highg.retry_at_us));
    wait = sooner(wait, c->baro.ok ? until(now_us, c->baro_due_us)
                                   : until(now_us, c->baro.retry_at_us));
    return wait;
}
