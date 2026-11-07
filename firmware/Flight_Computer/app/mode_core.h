#ifndef STAR_MODE_CORE_H
#define STAR_MODE_CORE_H

/*
 * What runs in each flight state, and what a ground command does there.
 * Portable: app/mode.c applies it on the board, the tests check it here.
 *
 *   SELF_TEST      bring-up checks; nothing sampling yet
 *   IDLE           only the radio (Inez): IMU/high-g powered down, baro
 *                  idle, GPS rail off (REG_3V6_EN feeds only the GPS,
 *                  schematic p.10/p.12), W5500 held in reset; the Idle
 *                  loop (PR #162) sleeps in Stop between heartbeats
 *   ARMED onwards  everything on; the eMMC log records
 *                  (flight_state_logs_to_emmc)
 * ARMED means "record", never pyro: no pyro output is driven anywhere.
 */

#include <stdbool.h>

#include "flight_state.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool sensors;   /* IMU, high-g, baro sampling */
    bool gps;       /* GPS rail on, GNSS task running */
    bool ethernet;  /* W5500 out of reset */
    bool idle_loop; /* heartbeats + Stop between them */
} mode_outputs_t;

mode_outputs_t mode_outputs(flight_state_t state);

typedef enum { MODE_CMD_ARM = 1, MODE_CMD_DISARM } mode_command_t;

typedef enum {
    MODE_TO_IDLE_LOOP, /* IDLE: the Idle loop decides (Arm -> ARM_REQUESTED) */
    MODE_TRANSITION,   /* go to *next now */
    MODE_IGNORE        /* the state table does not move on it */
} mode_route_t;

/* Where a confirmed ground command goes in `state`. */
mode_route_t mode_route_command(flight_state_t state, mode_command_t command,
                                flight_state_t* next);

#ifdef __cplusplus
}
#endif
#endif
