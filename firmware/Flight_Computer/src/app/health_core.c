#include "health_core.h"

#include <string.h>

#include "battery.h"

/* board_adc_input_t order (src/board/board_adc.h). */
enum { IN_VBAT = 0, IN_CURR = 6 };

void health_core_init(health_core_t* c, record_sink_t sink) {
    memset(c, 0, sizeof(*c));
    c->sink = sink;
}

bool health_core_due(const health_core_t* c, uint32_t now_ms,
                     uint32_t interval_ms) {
    return c->samples == 0U || (uint32_t)(now_ms - c->last_ms) >= interval_ms;
}

uint16_t health_current_ma(uint16_t counts) {
    /* 1 V/A: mA = mV = counts x 3320 / 65535, rounded. */
    return (uint16_t)(((uint32_t)counts * 3320U + 32767U) / 65535U);
}

void health_core_sample(health_core_t* c, const health_inputs_t* in,
                        uint32_t task_faults, uint32_t now_ms, uint32_t t_us) {
    rec_health_t r;
    memset(&r, 0, sizeof r);
    r.t_us = t_us;
    for (unsigned i = 0; i < REC_HEALTH_INPUTS; ++i) {
        if (in->valid[i]) {
            r.counts[i] = in->counts[i];
            r.valid |= (uint8_t)(1U << i);
        }
    }
    battery_t b =
        battery_assess(in->valid[IN_VBAT], in->counts[IN_VBAT], in->on_usb);
    r.battery_mv = b.mv;
    r.battery = (uint8_t)b.state;
    r.current_ma =
        in->valid[IN_CURR] ? health_current_ma(in->counts[IN_CURR]) : 0U;
    r.task_faults = (uint8_t)task_faults;
    c->latest = r;
    c->last_ms = now_ms;
    c->samples++;
    if (c->sink.record) {
        c->sink.record(c->sink.ctx, REC_HEALTH, &r, (uint8_t)sizeof r);
    }
}
