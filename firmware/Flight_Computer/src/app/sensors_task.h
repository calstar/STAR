#ifndef STAR_SENSORS_TASK_H
#define STAR_SENSORS_TASK_H

/*
 * Owns SPI3 (IMU, high-g, baro). Wakes on the IMU and high-g data-ready
 * interrupts (board_exti) or on sensors_core's next deadline, runs
 * sensors_core_step, and hands each record to the eMMC log. Highest
 * priority of the application tasks.
 */

#include <stdbool.h>

#include "sensors_core.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts stopped: chips stay in power-down until sensors_task_set_active. */
bool sensors_task_start(void);

/* true: init the three chips and sample; false: power them down (Idle).
 * Any task; takes effect on the sensors task's next wake. */
void sensors_task_set_active(bool on);

/* Snapshot of the latest samples and per-sensor counters (any task). */
void sensors_task_snapshot(sensors_core_t* out);

/* Hold the sensor buses for a chip check (board_chips_check). On resume a
 * running sensors task starts its chips over: the check may have left them
 * in any mode. No-ops before the task starts. */
void sensors_task_pause(void);
void sensors_task_resume(void);

#ifdef __cplusplus
}
#endif
#endif
