#include "readings.h"

#include <string.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define EMA_ALPHA 0.1f   // ~10-sample smoothing at 25 Hz per channel

static readings_t s_state;
static SemaphoreHandle_t s_lock;

void readings_init(void)
{
    memset(&s_state, 0, sizeof(s_state));
    s_lock = xSemaphoreCreateMutex();
}

void readings_set_sensor_ok(bool ok)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.sensor_ok = ok;
    xSemaphoreGive(s_lock);
}

void readings_update(int ch, float pf, uint8_t capdac, bool saturated)
{
    if (ch < 0 || ch >= CAPFILL_NUM_CHANNELS) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    channel_reading_t *c = &s_state.ch[ch];
    // Restart the average when the range changes so it doesn't smear across an offset jump.
    if (!c->valid || capdac != c->capdac) {
        c->pf_avg = pf;
    } else {
        c->pf_avg += EMA_ALPHA * (pf - c->pf_avg);
    }
    c->pf = pf;
    c->capdac = capdac;
    c->saturated = saturated;
    c->valid = true;
    c->samples++;
    c->updated_us = esp_timer_get_time();
    xSemaphoreGive(s_lock);
}

void readings_get(readings_t *out)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_state;
    xSemaphoreGive(s_lock);
}
