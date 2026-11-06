#ifndef STAR_HEALTH_TASK_H
#define STAR_HEALTH_TASK_H
#include "health.h"
/* Initialize BEFORE creating monitored tasks, start AFTER creating them. */
void health_task_init(void);
bool health_task_start(void);
void health_task_beat(health_id_t id);
uint32_t health_task_faults(void);
/* Future Stop owner: quiesce workers, call prepare, suspend scheduler/ticks,
 * enter Stop, restore clocks, then resume BEFORE releasing the workers.
 * elapsed_ms is ACTUAL RTC elapsed time; the adapter accounts for any HAL
 * tick advancement during that interval. Never call
 * prepare as a substitute for a worker's progress report. */
bool health_task_prepare_sleep(uint32_t duration_ms);
bool health_task_resume(uint32_t elapsed_ms);
#endif
