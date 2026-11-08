#ifndef STAR_GNSS_TASK_H
#define STAR_GNSS_TASK_H

/*
 * Owns UART9 (MAX-M10S). Wakes on received bytes (board_uart9) or on
 * gnss_core's next deadline; stamps fixes with the latest GPS TIMEPULSE
 * (TIM2 CH4, board_time). Records go to the eMMC log.
 */

#include <stdbool.h>

#include "gnss_core.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts stopped: the GPS rail is switched by gnss_task_set_active. */
bool gnss_task_start(void);

/* true: GPS rail on, detect + configure, 10 Hz fixes; false: rail off
 * (Idle). Any task. */
void gnss_task_set_active(bool on);

/* true: once a second while running, ask the module for its antenna and
 * satellite status (core->rf, core->sats). Off at start; the bench build
 * turns it on. Any task. */
void gnss_task_poll_status(bool on);

/* Read-only view for telemetry (counters, latest fix). */
const gnss_core_t* gnss_task_core(void);

#ifdef __cplusplus
}
#endif
#endif
