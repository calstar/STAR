#ifndef STAR_IDLE_H
#define STAR_IDLE_H

/*
 * Idle state logic: portable, no HAL, no RTOS, no heap.
 *
 * The state machine calls idle_enter() once on entry from self-test, then
 * idle_on_wake() every time the MCU wakes (RTC wakeup or radio DIO1). Idle
 * answers with what the state machine should do next; it never sleeps,
 * schedules the RTC, changes state or touches pyro outputs itself.
 */

#include "idle_port.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Upper bound on commands drained per wake, so a noisy link cannot keep the
 * MCU awake indefinitely. */
#define IDLE_MAX_COMMANDS_PER_WAKE 4U

typedef struct {
    uint32_t heartbeat_interval_ms; /* proposed 10000 */
    /* A wake this early is still treated as on time, to absorb LSI drift. */
    uint32_t wake_tolerance_ms; /* proposed 500; must be < interval */
    uint32_t callback_budget_ms;
    uint16_t battery_warn_mv;       /* proposed 7000 (not yet approved) */
    uint16_t battery_fail_mv;       /* proposed 6600 (not yet approved) */
    uint16_t battery_hysteresis_mv; /* proposed 100 */
} idle_config_t;

typedef enum {
    /* Sleep for sleep_s seconds (RTC wakeup), radio stays in RX. */
    IDLE_EVENT_SLEEP = 0,
    /* A valid Arm command arrived. The state machine applies the arm policy;
     * Idle has not transitioned and has not touched any output. */
    IDLE_EVENT_ARM_REQUESTED,
    /* idle_on_wake() was called on an invalid instance, or before
     * idle_enter(). */
    IDLE_EVENT_ERROR
} idle_event_t;

typedef struct {
    idle_event_t event;
    uint32_t sleep_s; /* valid for IDLE_EVENT_SLEEP; at least 1 */
    bool heartbeat_sent; /* a heartbeat was attempted on this wake */
} idle_result_t;

/* Fixed caller-owned storage. Zero-initialize; treat fields as private. */
typedef struct {
    idle_config_t config;
    idle_port_t port;
    void* context;
    idle_heartbeat_t last; /* most recent heartbeat contents */
    idle_battery_state_t battery_band; /* OK/WARN/FAIL memory for hysteresis */
    uint32_t next_heartbeat_ms;
    bool initialized;
    bool entered; /* idle_enter() has set the heartbeat schedule */
} idle_t;

/* Validates config and requires every port callback. Inputs are copied.
 * Returns false and leaves the instance disabled on invalid input. */
bool idle_init(idle_t* idle, const idle_config_t* config,
               const idle_port_t* port, void* context);
/* Call on entry to Idle. The first wake after entry sends a heartbeat. */
bool idle_enter(idle_t* idle, uint32_t now_ms);
/* Call on every wake. now_ms must come from a clock that keeps counting
 * through Stop mode (see Core/IDLE.md). Modular milliseconds; gaps < 2^31. */
idle_result_t idle_on_wake(idle_t* idle, uint32_t now_ms);
/* Most recent heartbeat contents; NULL for an invalid instance. */
const idle_heartbeat_t* idle_last_heartbeat(const idle_t* idle);

/* Exposed for tests: PA0 counts to supply millivolts (22k/10k divider,
 * 3.32 V reference). Returns 0 for counts above the 16-bit range. */
uint16_t idle_counts_to_mv(uint32_t raw_counts);

#ifdef __cplusplus
}
#endif
#endif
