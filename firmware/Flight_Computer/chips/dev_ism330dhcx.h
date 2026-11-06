#ifndef STAR_DEV_ISM330DHCX_H
#define STAR_DEV_ISM330DHCX_H

/*
 * ISM330DHCX 6-axis IMU (U4), SPI mode 3. Datasheet DS13012 Rev 7.
 *
 * Configuration (page numbers in DS13012):
 *   CTRL3_C   0x44  BDU + IF_INC (p.51): halves of a sample never mix,
 *                   burst reads auto-increment
 *   CTRL4_C   0x04  I2C_disable (p.52): SPI3 is shared, never mistake
 *                   traffic for I2C
 *   CTRL1_XL  0x74  833 Hz, +-16 g (p.49, Tables 42-43)
 *   CTRL2_G   0x71  833 Hz, +-4000 dps (p.50, Tables 45-46)
 *   COUNTER_BDR_REG1 0x80  pulsed data-ready (p.46): a clean edge per sample
 *   INT1_CTRL 0x01  accelerometer data-ready on INT1 (p.47)
 *
 * Scale (p.10, Table 2): 0.488 mg/LSB, 140 mdps/LSB.
 * Temperature (p.13, Table 4): 256 LSB/degC, 0 LSB at 25 degC.
 */

#include <stdint.h>

#include "dev_bus.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ISM330_WHO_AM_I_VALUE 0x6BU
#define ISM330_ACCEL_UG_PER_LSB 488  /* micro-g */
#define ISM330_GYRO_MDPS_PER_LSB 140 /* milli-degrees per second */
#define ISM330_TEMP_LSB_PER_DEGC 256

typedef struct {
    int16_t temp;     /* raw; degC = 25 + temp / 256 */
    int16_t gyro[3];  /* raw x, y, z */
    int16_t accel[3]; /* raw x, y, z */
} ism330_sample_t;

/* Identify, software-reset, configure and verify every register. */
int ism330_init(const dev_bus_t* bus);

/* One 14-byte burst from OUT_TEMP_L (20h): temperature, gyro, accel. */
int ism330_read(const dev_bus_t* bus, ism330_sample_t* out);

#ifdef __cplusplus
}
#endif
#endif
