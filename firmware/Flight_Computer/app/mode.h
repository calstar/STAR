#ifndef STAR_MODE_H
#define STAR_MODE_H

#include "flight_state.h"

#ifdef __cplusplus
extern "C" {
#endif

// Register the radio command callback and initialize the state machine.
// Call once after radio_task_start().
void mode_init(void);

flight_state_t mode_state(void);

#ifdef __cplusplus
}
#endif
#endif
