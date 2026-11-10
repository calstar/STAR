#ifndef STAR_BENCH_TASK_H
#define STAR_BENCH_TASK_H

/* Bench build only (pio run -e bench): prints the sensors and GPS over RTT. */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

bool bench_task_start(void);

#ifdef __cplusplus
}
#endif
#endif
