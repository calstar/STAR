#ifndef STAR_HEALTH_H
#define STAR_HEALTH_H
#include <stdbool.h>
#include <stdint.h>

/* Portable progress monitor. All times are monotonic milliseconds modulo
 * 2^32; callers serialize access. Sensor failures are not task stalls.
 * A worker the mode has stopped (sensors and GNSS in Idle) is inactive and
 * not checked; every worker starts active, so one that never runs faults. */
typedef enum {
    HEALTH_SENSORS,
    HEALTH_GNSS,
    HEALTH_LOG,
    HEALTH_COUNT
} health_id_t;
#define HEALTH_ALL ((1U << HEALTH_COUNT) - 1U)
#define HEALTH_STALE_MS 5000U
#define HEALTH_MAX_SLEEP_MS 10000U
#define HEALTH_WAKE_MARGIN_MS 1000U

typedef struct {
    uint32_t last[HEALTH_COUNT];
    uint32_t sleep_started, sleep_budget;
    uint32_t active; /* bit per worker that must check in */
    uint32_t faults;
    bool sleeping;
} health_t;
void health_init(health_t* h, uint32_t now);
void health_beat(health_t* h, health_id_t id, uint32_t now);
/* on: the worker runs from now and must check in. off: it is parked on a
 * mode change and is not checked until it is turned on again. */
void health_set_active(health_t* h, health_id_t id, bool on, uint32_t now);
/* Faults latch until reboot. False also while sleeping. */
bool health_check(health_t* h, uint32_t now);
/* Only after all workers are quiescent; must check before suspending ticks.
 * Caller must program a reliable RTC wake and refresh IWDG on success. */
bool health_prepare_sleep(health_t* h, uint32_t now, uint32_t duration_ms);
/* now must include ACTUAL elapsed RTC time, even on an early interrupt wake.
 * Excludes only the sleep interval from worker age; no wake-time blanket beat.
 */
bool health_resume(health_t* h, uint32_t now);
#endif
