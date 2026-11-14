// Thread-safe store of the latest per-channel readings, shared by the sampler, HTTP API and serial log.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "board.h"

typedef struct {
    float    pf;          // latest total capacitance, pF
    float    pf_avg;      // exponential moving average, pF
    uint8_t  capdac;      // current CAPDAC step (x 3.125 pF offset)
    bool     saturated;
    bool     valid;       // at least one good sample received
    uint32_t samples;
    int64_t  updated_us;  // esp_timer time of last sample
} channel_reading_t;

typedef struct {
    channel_reading_t ch[CAPFILL_NUM_CHANNELS];
    bool sensor_ok;
} readings_t;

void readings_init(void);
void readings_set_sensor_ok(bool ok);
void readings_update(int ch, float pf, uint8_t capdac, bool saturated);
void readings_get(readings_t *out);   // copies a consistent snapshot
