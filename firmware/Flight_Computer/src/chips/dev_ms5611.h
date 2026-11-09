#ifndef STAR_DEV_MS5611_H
#define STAR_DEV_MS5611_H

/*
 * MS5611-01BA03 barometer (U5), SPI mode 3. Datasheet MS5611-01BA03 (06/2017)
 * and application note AN520.
 *
 * Commands (p.10, Figure 4): reset 0x1E, convert D1 (pressure) 0x48 and
 * D2 (temperature) 0x58 at OSR 4096, ADC read 0x00, PROM read 0xA0..0xAE.
 * OSR 4096 conversion takes at most 9.04 ms (p.3), so results are read
 * MS5611_CONVERSION_MS after the start command. Reading the ADC before the
 * conversion ends returns 0, which the driver reports as DEV_ERR_DATA.
 *
 * The power-on reset (0x1E with CSB held low through the 2.8 ms PROM reload,
 * p.10 Figure 5) is done once by board_bringup, not here.
 *
 * Compensation (p.8 first order, p.9 second order) in integer arithmetic,
 * exactly as the datasheet; checked against its worked example (p.8).
 */

#include <stdint.h>

#include "dev_bus.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MS5611_CONVERSION_MS 10U /* >= 9.04 ms max at OSR 4096 */

typedef struct {
    uint16_t word[8]; /* word[1..6] = C1..C6; word[7] low nibble = CRC4 */
} ms5611_prom_t;

typedef enum {
    MS5611_D1_PRESSURE = 0x48,
    MS5611_D2_TEMPERATURE = 0x58,
} ms5611_conversion_t;

/* AN520 CRC4 over the 8 PROM words (low byte of word 7 cleared). */
uint8_t ms5611_crc4(const ms5611_prom_t* prom);

/* Read all 8 PROM words; DEV_ERR_DATA if blank (all 0 / all 1) or the CRC4
 * does not match. */
int ms5611_read_prom(const dev_bus_t* bus, ms5611_prom_t* prom);

/* Start a conversion; read it with ms5611_read_adc() >= 10 ms later. */
int ms5611_start(const dev_bus_t* bus, ms5611_conversion_t which);
/* The same at OSR 256 << osr_step (0..4; ms5611_start: 4 = OSR 4096). */
int ms5611_start_osr(const dev_bus_t* bus, ms5611_conversion_t which,
                     uint8_t osr_step);

/* 24-bit result of the last conversion. */
int ms5611_read_adc(const dev_bus_t* bus, uint32_t* raw);

/* Temperature in 0.01 degC and pressure in Pa (= 0.01 mbar), with
 * second-order compensation below 20 degC. */
void ms5611_compensate(const ms5611_prom_t* prom, uint32_t d1, uint32_t d2,
                       int32_t* temp_c100, int32_t* pressure_pa);

#ifdef __cplusplus
}
#endif
#endif
