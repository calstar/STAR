#include "health.h"

#include <string.h>

void health_init(health_t* h, uint32_t now) {
    memset(h, 0, sizeof(*h));
    for (unsigned i = 0; i < HEALTH_COUNT; ++i)
        h->last[i] = now;
    h->active = HEALTH_ALL;
}
void health_beat(health_t* h, health_id_t id, uint32_t now) {
    if ((unsigned)id < HEALTH_COUNT && !h->sleeping) {
        if ((h->active & (1U << id)) &&
            (uint32_t)(now - h->last[id]) >= HEALTH_STALE_MS)
            h->faults |= 1U << id;
        h->last[id] = now;
    }
}
void health_set_active(health_t* h, health_id_t id, bool on, uint32_t now) {
    if ((unsigned)id >= HEALTH_COUNT)
        return;
    if (on) {
        /* A worker parked longer than the threshold is not stale on start. */
        if (!(h->active & (1U << id)))
            h->last[id] = now;
        h->active |= 1U << id;
    } else {
        h->active &= ~(1U << id);
    }
}
bool health_check(health_t* h, uint32_t now) {
    if (h->sleeping)
        return false;
    for (unsigned i = 0; i < HEALTH_COUNT; ++i) {
        if ((h->active & (1U << i)) &&
            (uint32_t)(now - h->last[i]) >= HEALTH_STALE_MS)
            h->faults |= 1U << i;
    }
    return h->faults == 0;
}
bool health_prepare_sleep(health_t* h, uint32_t now, uint32_t duration_ms) {
    if (!duration_ms || duration_ms > HEALTH_MAX_SLEEP_MS ||
        !health_check(h, now))
        return false;
    h->sleeping = true;
    h->sleep_started = now;
    h->sleep_budget = duration_ms;
    return true;
}
bool health_resume(health_t* h, uint32_t now) {
    if (!h->sleeping)
        return false;
    uint32_t elapsed = now - h->sleep_started;
    if (elapsed > h->sleep_budget + HEALTH_WAKE_MARGIN_MS)
        h->faults |= HEALTH_ALL;
    for (unsigned i = 0; i < HEALTH_COUNT; ++i)
        h->last[i] += elapsed;
    h->sleeping = false;
    return health_check(h, now);
}
