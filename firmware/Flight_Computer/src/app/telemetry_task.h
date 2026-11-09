#ifndef STAR_TELEMETRY_TASK_H
#define STAR_TELEMETRY_TASK_H

/*
 * Once armed (ARMED, LAUNCHED, RECOVERY), the latest IMU, high-g, baro and
 * GNSS readings go to the ground in one Telemetry frame (status_report.h)
 * every hb_flight_ms (fc_config, >= 500 ms: a 57-byte frame is ~350 ms on
 * air at SF9/125 kHz, which leaves the radio time to hear an Un-arm). Full
 * rate goes to the eMMC; this is a look at the rocket, not the record.
 */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

bool telemetry_task_start(void);

#ifdef __cplusplus
}
#endif
#endif
