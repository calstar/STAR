#ifndef STAR_FLIGHT_STATE_H
#define STAR_FLIGHT_STATE_H

/*
 * The flight computer's top-level states, as drawn in Flight_computer.drawio:
 *
 *   power on -> SELF_TEST -(done)-> IDLE -(Arm)-> ARMED -(launch)-> LAUNCHED
 *                                     ^             |                  |
 *                                     +--(Un-arm)---+            (apogee)
 *                                                                      v
 *                                                                  RECOVERY
 *
 * This file is only the transition table: which event moves which state
 * where. It does no I/O and owns no timers, so it runs unchanged on a laptop
 * (tests/emmc) and on the board. Launch and apogee detection do not exist
 * yet; nothing raises those events today.
 */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    FLIGHT_SELF_TEST = 0,
    FLIGHT_IDLE,
    FLIGHT_ARMED,
    FLIGHT_LAUNCHED,
    FLIGHT_RECOVERY,
    FLIGHT_STATE_COUNT
} flight_state_t;

typedef enum {
    FLIGHT_EV_SELF_TEST_DONE = 0,
    FLIGHT_EV_ARM,
    FLIGHT_EV_UNARM,
    FLIGHT_EV_LAUNCH_DETECTED,
    FLIGHT_EV_APOGEE_DETECTED,
    FLIGHT_EVENT_COUNT
} flight_event_t;

/*
 * The state after `event` arrives in `state`. An event the diagram does not
 * draw from that state leaves it unchanged: Un-arm after launch is ignored,
 * Arm while armed is ignored. An out-of-range state or event also returns
 * `state` unchanged.
 */
flight_state_t flight_state_next(flight_state_t state, flight_event_t event);

/*
 * Whether the eMMC flight log records in this state. At this stage it starts
 * at ARMED, not LAUNCHED, because launch detection is not implemented: a log
 * that waited for "launch detected" would never start. ARMED, LAUNCHED and
 * RECOVERY record; SELF_TEST and IDLE leave the eMMC untouched.
 */
bool flight_state_logs_to_emmc(flight_state_t state);

/* Upper-case name for logs and the ground station ("ARMED"); "?" if bad. */
const char* flight_state_name(flight_state_t state);

#ifdef __cplusplus
}
#endif
#endif
