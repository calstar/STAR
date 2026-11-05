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

bool sensors_task_start(void);

/* Snapshot of the latest samples and per-sensor counters (any task). */
void sensors_task_snapshot(sensors_core_t* out);

#ifdef __cplusplus
}
#endif
#endif
