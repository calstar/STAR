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

bool gnss_task_start(void);

/* Read-only view for telemetry (counters, latest fix). */
const gnss_core_t* gnss_task_core(void);

#ifdef __cplusplus
}
#endif
#endif
