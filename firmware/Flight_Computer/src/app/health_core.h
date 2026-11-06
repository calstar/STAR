#ifndef STAR_HEALTH_CORE_H
#define STAR_HEALTH_CORE_H

/*
 * The health task's sampling, portable (time passed in, no HAL): the analog
 * inputs (board_adc.h) -> one REC_HEALTH record -> the sink (eMMC log on the
 * board), and a "latest" copy for the radio and Ethernet to read.
 *
 * Rate is the caller's: about 10 Hz in ARMED and later, once per wake in
 * Idle (the board is in Stop between heartbeats). Battery thresholds are
 * battery.h's and change with the 4S rework (#510). The altimeter-battery
 * current (PC0) scale is not known yet, so it stays raw counts.
 */

#include <stdbool.h>
#include <stdint.h>

#include "records.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Scheduled on a millisecond clock that keeps counting through Stop (the
 * kernel tick); the record's t_us is board time, which does not. */
#define HEALTH_CORE_ARMED_MS 100U /* 10 Hz in ARMED and later */
#define HEALTH_CORE_IDLE_MS 5000U /* longer than a wake: one per wake */

typedef struct {
    bool valid[REC_HEALTH_INPUTS];
    uint16_t counts[REC_HEALTH_INPUTS];
    bool on_usb; /* SW_ST: the PA0 reading is USB's supply, not the pack */
} health_inputs_t;

typedef struct {
    record_sink_t sink;
    uint32_t last_ms;
    uint32_t samples;
    rec_health_t latest; /* valid once samples > 0 */
} health_core_t;

void health_core_init(health_core_t* c, record_sink_t sink);

/* True when nothing was sampled yet or interval_ms has passed. */
bool health_core_due(const health_core_t* c, uint32_t now_ms,
                     uint32_t interval_ms);

/* One record from one set of readings; task_faults is health_t.faults. */
void health_core_sample(health_core_t* c, const health_inputs_t* in,
                        uint32_t task_faults, uint32_t now_ms, uint32_t t_us);

/* PC1 counts -> mA. The sense amplifier gives 1 V/A, VREF+ = 3.32 V. */
uint16_t health_current_ma(uint16_t counts);

#ifdef __cplusplus
}
#endif
#endif
