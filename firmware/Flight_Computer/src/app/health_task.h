#ifndef STAR_HEALTH_TASK_H
#define STAR_HEALTH_TASK_H

/*
 * The health task (HEALTH-RADIO.md): every 100 ms it checks that each
 * running worker (sensors, GNSS, eMMC writer) has checked in, and only then
 * refreshes IWDG1; and it samples the analog inputs into a REC_HEALTH record
 * (10 Hz in ARMED and later, once per wake in Idle) for the eMMC log, with
 * the latest one kept for the radio and Ethernet.
 */

#include <stdbool.h>
#include <stdint.h>

#include "health.h"
#include "health_core.h"
#include "records.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Initialize BEFORE creating monitored tasks, start AFTER creating them. */
void health_task_init(void);
bool health_task_start(void);
void health_task_beat(health_id_t id);
/* A worker the mode starts or parks (health_set_active). */
void health_task_set_active(health_id_t id, bool on);
uint32_t health_task_faults(void);
/* The latest REC_HEALTH sample; false before the first one. */
bool health_task_latest(rec_health_t* out);
/* Around a Stop sleep (idle_task.c): prepare before board_sleep(), resume
 * after it with the ACTUAL elapsed time, HAL-tick time included. The
 * adapter adds only the time the HAL tick missed. Never call prepare as a
 * substitute for a worker's progress report. */
bool health_task_prepare_sleep(uint32_t duration_ms);
bool health_task_resume(uint32_t elapsed_ms);

/* Board glue (health_board.c); faked in the host tests. */
bool health_board_read(health_inputs_t* in);
void health_board_record(void* ctx, uint8_t type, const void* data,
                         uint8_t len);
uint32_t health_board_interval_ms(void);
uint32_t health_board_clock_ms(void); /* counts through Stop */

#ifdef __cplusplus
}
#endif
#endif
