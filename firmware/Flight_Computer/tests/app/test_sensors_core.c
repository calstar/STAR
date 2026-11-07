/*
 * sensors_core under a virtual clock: the test plays the RTOS task (wakes on
 * data-ready edges or on the core's next deadline) against fake chips.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fake_baro.h"
#include "fake_regs.h"
#include "sensors_core.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

typedef struct {
    unsigned n[3];
    rec_imu_t imu;
    rec_highg_t highg;
    rec_baro_t baro;
    uint32_t last_t[3];
    int non_monotonic;
} sink_t;

static void record(void* ctx, uint8_t type, const void* data, uint8_t len) {
    sink_t* s = ctx;
    int i = type - REC_IMU;
    if (i < 0 || i > 2) {
        return;
    }
    uint32_t t;
    memcpy(&t, data, sizeof(t));
    if (s->n[i] && (int32_t)(t - s->last_t[i]) <= 0) {
        s->non_monotonic++;
    }
    s->last_t[i] = t;
    s->n[i]++;
    if (type == REC_IMU && len == sizeof(rec_imu_t))
        memcpy(&s->imu, data, len);
    if (type == REC_HIGHG && len == sizeof(rec_highg_t))
        memcpy(&s->highg, data, len);
    if (type == REC_BARO && len == sizeof(rec_baro_t))
        memcpy(&s->baro, data, len);
}

typedef struct {
    fake_regs_t imu, highg;
    fake_baro_t baro;
    sensors_core_t core;
    sink_t sink;
    uint32_t now, next_imu, next_highg, edge_imu, edge_highg;
    int imu_edges, highg_edges;
} rig_t;

static void rig_init(rig_t* r, uint32_t start_us) {
    memset(r, 0, sizeof(*r));
    fake_regs_init(&r->imu, false);
    r->imu.regs[0x0F] = 0x6B;
    r->imu.self_clear_reg = 0x12;
    r->imu.self_clear_bits = 0x01;
    r->imu.clear_after_reads = 1;
    r->imu.self_clear_rearm = 1;
    static const uint8_t imu_out[14] = {0x00, 0x02, 1,    0, 2, 0, 3,
                                        0,    0x00, 0xF8, 0, 0, 0, 0x08};
    memcpy(&r->imu.regs[0x20], imu_out, sizeof(imu_out));
    fake_regs_init(&r->highg, true);
    r->highg.regs[0x0F] = 0x32;
    r->highg.regs[0x29] = (uint8_t)-13;
    r->highg.regs[0x2B] = 0;
    r->highg.regs[0x2D] = 64;
    memcpy(r->baro.prom, fake_baro_datasheet_prom, sizeof(r->baro.prom));
    r->baro.d1 = 9085466;
    r->baro.d2 = 8569150;
    r->core.imu_bus = fake_regs_bus(&r->imu);
    r->core.highg_bus = fake_regs_bus(&r->highg);
    r->core.baro_bus = fake_baro_bus(&r->baro);
    r->core.sink.record = record;
    r->core.sink.ctx = &r->sink;
    r->now = start_us;
    r->imu_edges = r->highg_edges = 1;
    sensors_core_init(&r->core, r->now);
    r->next_imu = r->now + SENSORS_IMU_PERIOD_US;
    r->next_highg = r->now + SENSORS_HIGHG_PERIOD_US;
}

#define kWakeLatencyUs 37U /* a real task runs a little after its IRQ */

static int32_t diff(uint32_t a, uint32_t b) {
    return (int32_t)(a - b);
}

/* Advance virtual time to `until`, as sensors_task does: sleep until the next
 * data-ready edge or the core's next deadline, wake kWakeLatencyUs after an
 * edge, and pass the edge times in. Time never runs backwards: an edge that
 * fell while the task was busy is handled on the next wake, late. */
static void run(rig_t* r, uint32_t until) {
    while (diff(until, r->now) > 0) {
        uint32_t wake = r->now + sensors_core_wait_us(&r->core, r->now);
        if (wake == r->now) {
            wake = r->now + 1; /* deadline due: step now, then move on */
        }
        if (r->imu_edges && diff(r->next_imu, wake) < 0)
            wake = r->next_imu;
        if (r->highg_edges && diff(r->next_highg, wake) < 0)
            wake = r->next_highg;
        if (diff(wake, until) > 0)
            wake = until;
        uint32_t ev = 0;
        if (r->imu_edges && diff(r->next_imu, wake) <= 0) {
            ev |= SENSORS_EV_IMU;
            r->edge_imu = r->next_imu;
            r->next_imu += SENSORS_IMU_PERIOD_US;
        }
        if (r->highg_edges && diff(r->next_highg, wake) <= 0) {
            ev |= SENSORS_EV_HIGHG;
            r->edge_highg = r->next_highg;
            r->next_highg += SENSORS_HIGHG_PERIOD_US;
        }
        uint32_t now = ev ? wake + kWakeLatencyUs : wake;
        if (diff(now, r->now) > 0)
            r->now = now;
        sensors_core_step(&r->core, ev, r->edge_imu, r->edge_highg, r->now);
    }
}

static void test_nominal_rates_values_and_timestamps(void) {
    static rig_t r;
    rig_init(&r, 1000);
    CHECK(r.core.imu.ok && r.core.highg.ok && r.core.baro.ok);
    run(&r, 1000 + 1000000);                         /* one second */
    CHECK(r.sink.n[0] >= 832 && r.sink.n[0] <= 834); /* 833 Hz */
    CHECK(r.sink.n[1] == 400);                       /* 400 Hz */
    CHECK(r.sink.n[2] >= 49 && r.sink.n[2] <= 50);   /* D1+D2 = 20 ms */
    CHECK(r.core.imu.missed_drdy == 0 && r.core.highg.missed_drdy == 0);
    CHECK(r.sink.non_monotonic == 0);
    /* Values decode from the fake chips' registers. */
    CHECK(r.sink.imu.temp == 0x0200);
    CHECK(r.sink.imu.gyro[0] == 1 && r.sink.imu.gyro[2] == 3);
    CHECK(r.sink.imu.accel[0] == -2048 && r.sink.imu.accel[2] == 2048);
    CHECK(r.sink.highg.accel[0] == -13 && r.sink.highg.accel[2] == 64);
    CHECK(r.sink.baro.temp_c100 == 2007 && r.sink.baro.pressure_pa == 100009);
    /* IMU samples carry the data-ready edge time, not the read time. */
    CHECK(r.sink.imu.t_us == r.edge_imu);
    CHECK(r.sink.highg.t_us == r.edge_highg);
    CHECK(r.now != r.edge_imu); /* the task ran after the edge */
}

static void test_highg_without_edges_is_read_on_timeout(void) {
    static rig_t r;
    rig_init(&r, 0);
    r.highg_edges = 0; /* DRDY level stuck high: no more rising edges */
    run(&r, 1000000);
    /* one read per 2 periods (5 ms) instead of none */
    CHECK(r.sink.n[1] >= 199 && r.sink.n[1] <= 200);
    CHECK(r.core.highg.missed_drdy == r.sink.n[1]);
    CHECK(r.sink.n[0] >= 832); /* the IMU is unaffected */
}

static void test_failing_imu_is_dropped_and_recovered(void) {
    static rig_t r;
    rig_init(&r, 0);
    run(&r, 100000);
    unsigned before = r.sink.n[0];
    r.imu.fail_after = (int)r.imu.transfers; /* every IMU transfer fails */
    run(&r, 200000);
    CHECK(r.sink.n[0] == before);
    CHECK(!r.core.imu.ok);
    CHECK(r.core.imu.errors == SENSORS_MAX_ERRORS);
    CHECK(r.core.imu.last_error == DEV_ERR_BUS);
    CHECK(r.sink.n[1] > 0 && r.core.highg.ok); /* others keep going */
    r.imu.fail_after = -1;                     /* the chip comes back */
    r.imu.self_clear_reg = 0x12;
    r.imu.clear_after_reads = 1;
    run(&r, 200000 + SENSORS_RETRY_US + 100000);
    CHECK(r.core.imu.ok);
    CHECK(r.core.imu.inits == 2);
    CHECK(r.sink.n[0] > before + 80); /* sampling again */
}

static void test_wrong_chip_never_produces_and_keeps_retrying(void) {
    static rig_t r;
    memset(&r, 0, sizeof(r));
    rig_init(&r, 0);
    r.highg.regs[0x0F] = 0x00; /* now answers the wrong ID */
    r.core.highg.ok = false;
    r.core.highg.retry_at_us = 0;
    run(&r, 3 * SENSORS_RETRY_US + 1);
    CHECK(!r.core.highg.ok);
    CHECK(r.core.highg.inits >= 4);
    CHECK(r.core.highg.last_error == DEV_ERR_ID);
}

static void test_dead_baro_bus_is_reported(void) {
    static rig_t r;
    rig_init(&r, 0);
    r.baro.fail = 1;
    run(&r, 200000);
    CHECK(!r.core.baro.ok);
    CHECK(r.core.baro.last_error == DEV_ERR_BUS);
}

/* Idle: both accelerometers in power-down by their datasheets' registers,
 * then a fresh init on Arm restores the full rates. */
static void test_stop_powers_down_and_init_restarts(void) {
    static rig_t r;
    rig_init(&r, 1000);
    run(&r, 101000);
    sensors_core_stop(&r.core);
    CHECK(r.imu.regs[0x10] == 0x00 && r.imu.regs[0x11] == 0x00); /* ODR 0 */
    CHECK(r.highg.regs[0x20] == 0x07); /* CTRL_REG1 PM = 000 */
    CHECK(!r.core.imu.ok && !r.core.highg.ok && !r.core.baro.ok);
    CHECK(r.core.baro_phase == 0);
    unsigned before = r.sink.n[0];
    r.now += 5000000U; /* 5 s of Idle: the task does not step the core */
    sensors_core_init(&r.core, r.now);
    CHECK(r.imu.regs[0x10] == 0x74 && r.highg.regs[0x20] == 0x37);
    r.next_imu = r.now + SENSORS_IMU_PERIOD_US;
    r.next_highg = r.now + SENSORS_HIGHG_PERIOD_US;
    uint32_t t = r.now;
    run(&r, t + 1000000U);
    CHECK(r.sink.n[0] - before >= 832 && r.sink.n[0] - before <= 834);
}

static void test_wait_never_overshoots_a_deadline(void) {
    static rig_t r;
    rig_init(&r, 0);
    CHECK(sensors_core_wait_us(&r.core, r.now) <= 2U * SENSORS_IMU_PERIOD_US);
    run(&r, 50000);
    CHECK(sensors_core_wait_us(&r.core, r.now) <= SENSORS_BARO_STEP_US);
}

static void test_clock_wrap_is_harmless(void) {
    static rig_t r;
    rig_init(&r, 0xFFFFFFFFU - 500000U); /* wraps half way through */
    run(&r, 500000U);
    CHECK(r.sink.n[0] >= 832 && r.sink.n[1] == 400);
    /* Timestamps compared modulo 2^32 stay in order across the wrap. */
    CHECK(r.sink.non_monotonic == 0);
}

int main(void) {
    test_nominal_rates_values_and_timestamps();
    test_highg_without_edges_is_read_on_timeout();
    test_failing_imu_is_dropped_and_recovered();
    test_wrong_chip_never_produces_and_keeps_retrying();
    test_dead_baro_bus_is_reported();
    test_stop_powers_down_and_init_restarts();
    test_wait_never_overshoots_a_deadline();
    test_clock_wrap_is_harmless();
    puts("sensors_core: all tests passed");
    return 0;
}
