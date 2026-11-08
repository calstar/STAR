#ifndef STAR_BOARD_TIME_H
#define STAR_BOARD_TIME_H

/*
 * Microsecond timebase: TIM2, a 32-bit counter at 1 MHz (prescaler 63 in the
 * .ioc at today's 64 MHz timer clock), free running, wrapping every ~71.6 min.
 * Every sample is stamped with it. TIM2 CH4 captures the GPS TIMEPULSE (PB11)
 * on the same counter, so samples can be placed on GPS time.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Start the counter and the CH4 capture interrupt. Returns false if TIM2 does
 * not actually tick at 1 MHz (e.g. the clock tree changed but the .ioc
 * prescaler did not), in which case timestamps are not trustworthy. */
bool board_time_start(void);

/* Microseconds since board_time_start(), modulo 2^32. ISR-safe. */
uint32_t board_time_us(void);

/* Most recent GPS TIMEPULSE edge (rising), in board_time_us() units, and how
 * many have been captured. count == 0 means none yet. */
typedef struct {
    uint32_t edge_us;
    uint32_t count;
} board_pps_t;

board_pps_t board_time_last_pps(void);

#ifdef __cplusplus
}
#endif
#endif
