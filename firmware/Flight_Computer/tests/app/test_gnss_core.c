/* gnss_core against a simulated MAX-M10S, 1 ms virtual-time steps. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fake_gnss.h"
#include "gnss_core.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void truth(uint32_t t, ubx_pvt_t* v) {
    v->itow_ms = 100000U + t / 1000U;
    v->fix_type = 3;
    v->flags = 1;
    v->num_sv = 9;
    v->lat_e7 = 378719000 + (int32_t)(t / 1000U);
    v->lon_e7 = -1222585000;
    v->hmsl_mm = 120000 + (int32_t)(t / 100U);
    v->vel_d_mms = -(int32_t)(t / 10000U);
    v->hacc_mm = 1500;
    v->vacc_mm = 2200;
    v->pdop_e2 = 120;
}

typedef struct {
    unsigned n;
    rec_gnss_t last;
    unsigned bad;
} sink_t;

static void record(void* ctx, uint8_t type, const void* data, uint8_t len) {
    sink_t* s = ctx;
    if (type != REC_GNSS || len != sizeof(rec_gnss_t)) {
        s->bad++;
        return;
    }
    memcpy(&s->last, data, len);
    s->n++;
}

typedef struct {
    fake_gnss_t module;
    gnss_core_t core;
    sink_t sink;
    uint32_t now;
} rig_t;

static void rig(rig_t* r, uint32_t module_baud) {
    memset(r, 0, sizeof(*r));
    fake_gnss_init(&r->module, module_baud, truth);
    r->core.io = fake_gnss_io(&r->module);
    r->core.sink.record = record;
    r->core.sink.ctx = &r->sink;
    gnss_core_init(&r->core, 0);
}

static void run(rig_t* r, uint32_t until) {
    uint8_t buf[512];
    for (; r->now < until; r->now += 1000U) {
        size_t n = fake_gnss_emit(&r->module, r->now, buf, sizeof(buf));
        gnss_core_feed(&r->core, buf, n, r->now);
        gnss_core_poll(&r->core, r->now);
    }
}

static void test_cold_start_at_9600_reaches_10hz(void) {
    static rig_t r;
    rig(&r, 9600); /* data sheet p.13 default */
    run(&r, 10000000U);
    CHECK(r.core.state == GNSS_RUN);
    CHECK(r.core.detected_baud == 9600);
    CHECK(r.core.baud == 115200 && r.module.module_baud == 115200);
    CHECK(r.module.baud_changes == 1 && r.module.acks == 1);
    CHECK(!r.module.nmea_on && r.module.pvt_on);
    CHECK(r.module.rate_ms == 100 && r.module.dynmodel == 8);
    CHECK(r.sink.n >= 95 && r.sink.n <= 100); /* ~10 Hz once configured */
    CHECK(r.sink.bad == 0);
    ubx_pvt_t want;
    truth(r.sink.last.t_us, &want);
    CHECK(r.sink.last.fix_type == 3 && r.sink.last.num_sv == 9);
    CHECK(r.sink.last.lat_e7 == want.lat_e7);
    CHECK(r.sink.last.lon_e7 == want.lon_e7);
    CHECK(r.sink.last.hmsl_mm == want.hmsl_mm);
    CHECK(r.sink.last.vel_d_mms == want.vel_d_mms);
}

static void test_warm_module_at_115200_needs_no_baud_change(void) {
    static rig_t r;
    rig(&r, 115200);
    run(&r, 8000000U); /* 9600 and 38400 windows are silent first */
    CHECK(r.core.state == GNSS_RUN);
    CHECK(r.core.detected_baud == 115200);
    CHECK(r.module.baud_changes == 0);
    CHECK(r.sink.n > 30);
}

static void test_nak_restarts_and_recovers(void) {
    static rig_t r;
    rig(&r, 9600);
    r.module.nak_next = true;
    run(&r, 15000000U);
    CHECK(r.core.naks == 1);
    CHECK(r.core.state == GNSS_RUN && r.core.configs == 1);
}

static void test_silence_then_power_cycle_reconfigures(void) {
    static rig_t r;
    rig(&r, 9600);
    run(&r, 5000000U);
    CHECK(r.core.state == GNSS_RUN);
    unsigned before = r.sink.n;
    r.module.mute = true;
    run(&r, 8000000U);
    CHECK(r.core.state != GNSS_RUN && r.core.resets == 1);
    fake_gnss_power_cycle(&r.module, r.now); /* back to 9600, NMEA */
    run(&r, 20000000U);
    CHECK(r.core.state == GNSS_RUN && r.core.configs == 2);
    CHECK(r.sink.n > before + 50);
}

static void test_pps_is_stamped(void) {
    static rig_t r;
    rig(&r, 9600);
    run(&r, 6000000U);
    gnss_core_set_pps(&r.core, 5999123U);
    run(&r, 6500000U);
    CHECK(r.sink.last.pps_us == 5999123U);
}

int main(void) {
    test_cold_start_at_9600_reaches_10hz();
    test_warm_module_at_115200_needs_no_baud_change();
    test_nak_restarts_and_recovers();
    test_silence_then_power_cycle_reconfigures();
    test_pps_is_stamped();
    puts("gnss_core: all tests passed");
    return 0;
}
