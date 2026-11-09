#ifndef STAR_DEV_H3LIS100DL_H
#define STAR_DEV_H3LIS100DL_H

/*
 * H3LIS100DL high-g accelerometer (U3), SPI mode 3. Datasheet DocID027504
 * Rev 2. Note: the rev 1 schematic/BOM say H3LIS331DLTR; the assembled board
 * carries the H3LIS100DLTR (Inez, 2026-11-04).
 *
 * Configuration (page numbers in DocID027504):
 *   CTRL_REG1 0x37  PM = 001 normal mode, DR = 10 400 Hz, X/Y/Z on (p.25-26)
 *   CTRL_REG3 0x02  INT1 = data ready, active high, push-pull (p.28)
 *   CTRL_REG4 0x00  4-wire SPI (p.28)
 * Output: 8-bit two's complement OUT_X/Y/Z at 29h/2Bh/2Dh (p.30),
 * 780 mg/digit, fixed +-100 g (p.9).
 *
 * The data-ready line is a level, not a pulse: it stays high until the data
 * is read, so a missed read would leave a rising-edge interrupt silent. The
 * caller must also read on a timeout (see sensors_core).
 */

#include <stdint.h>

#include "dev_bus.h"

#ifdef __cplusplus
extern "C" {
#endif

#define H3LIS_WHO_AM_I_VALUE 0x32U
#define H3LIS_MG_PER_DIGIT 780

typedef struct {
    int8_t accel[3]; /* raw x, y, z; g = raw * 0.78 */
} h3lis_sample_t;

/* Identify, configure and verify. */
int h3lis_init(const dev_bus_t* bus);
/* The same, with CTRL_REG1 from the settings (h3lis_init: 0x37). */
int h3lis_init_with(const dev_bus_t* bus, uint8_t ctrl_reg1);

/* Power-down (Idle): CTRL_REG1 PM = 000 (Table 18 p.25), axes left on:
 * 0x07, the power-on value (p.24). h3lis_init() wakes it again. */
int h3lis_power_down(const dev_bus_t* bus);

/* One 5-byte burst from OUT_X (29h) with auto-increment. */
int h3lis_read(const dev_bus_t* bus, h3lis_sample_t* out);

#ifdef __cplusplus
}
#endif
#endif
