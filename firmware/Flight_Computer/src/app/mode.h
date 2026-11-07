#ifndef STAR_MODE_H
#define STAR_MODE_H

/*
 * The board's flight state, applied (mode_core.h decides what runs):
 * sensors and GNSS tasks started/stopped, the W5500 held in reset or not,
 * the Idle loop on/off, and the eMMC log told (emmc_log_on_state), so it
 * records from ARMED. Any task; one lock.
 */

#include "flight_state.h"
#include "mode_core.h"

#ifdef __cplusplus
extern "C" {
#endif

void app_set_state(flight_state_t to);
flight_state_t app_state(void);

/* A confirmed ground command (radio task's ARM gate). In IDLE it goes to
 * the Idle loop; elsewhere it moves the state table directly. */
void app_command(mode_command_t command);

#ifdef __cplusplus
}
#endif
#endif
