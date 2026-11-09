#ifndef STAR_GROUND_TASK_H
#define STAR_GROUND_TASK_H

/*
 * Role RECEIVER (fc_config role, read at boot): the ground station. The radio
 * listens all the time and every frame it hears goes to the laptop over USB
 * (usb_link RADIO_RX); the laptop's RADIO_ARM / RADIO_UNARM send Arm / Un-arm
 * (radio_task_ground_command). Nothing else runs: no Idle loop, sensors,
 * GPS, eMMC or telemetry, and it never arms itself.
 */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

bool ground_start(void);

#ifdef __cplusplus
}
#endif
#endif
