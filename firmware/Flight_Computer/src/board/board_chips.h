#ifndef STAR_BOARD_CHIPS_H
#define STAR_BOARD_CHIPS_H

/*
 * "Is each chip there", checked again for every Idle report (status_report.h),
 * each with the value it read back:
 *   IMU, high-g    WHO_AM_I over SPI3 (0x6B, 0x32): they answer in power-down
 *   barometer      PROM CRC4 recomputed from a fresh PROM read (0..15)
 *   radio          the radio task's start-up step (0 = OK) and device errors
 *   eMMC           card state from CMD13 (4 = transfer), via the writer task
 * The W5500 (held in reset), GPS (rail off) and SD NAND are not touched in
 * Idle: their boot result is reported and their live bit stays clear.
 * Idle task only (it owns the bring-up probes and the ADC after boot).
 */

#include "status_report.h"

#ifdef __cplusplus
extern "C" {
#endif

void board_chips_check(status_report_t* r);

#ifdef __cplusplus
}
#endif
#endif
