// ADRF6755 I/Q modulator with fractional-N PLL and VCO (datasheet Rev. B),
// generic over the SPI transport (spi_bus_if, 4-wire: SDI in, SDO out).
//
// The part powers up in I2C mode (address 0x60 with CS high, 0x40 with CS
// low) and switches to SPI, until its power is cycled, on the third
// chip-select pulse: so again every time 5V_RF comes back. SPI write: 24 bits,
// D4 | register | data. Read: 16-bit D4 | register, then 16-bit D5 | data
// back on SDO.
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "spi_bus_if.h"

typedef struct {
    uint32_t pfd_hz;
    uint8_t  r;          // 5-bit R divider, 1..32 (32 is written as 0)
    bool     doubler, r_half, r_enable;
    uint16_t intg;       // 23..4095
    uint32_t frac;       // 25 bits
    uint8_t  rfdiv;      // CR28[2:0]: divide by 2^rfdiv
    bool     cr27_bit4;  // frequency range bit (Table 6)
    uint8_t  bscdiv;     // CR25: autocal timer for 70 us
    double   lo_hz;      // achieved
} adrf6755_plan_t;

// Pure: plan LO from REFIN. Reference path per Equation 1 (prefers no
// division, PFD <= 40 MHz); RFDIV per Table 6; INT/FRAC per Equations 4-5
// with FRAC rounded to the nearest 1/2^25.
bool adrf6755_plan(uint32_t refin_hz, uint64_t lo_hz, adrf6755_plan_t *p);
// The same, keeping the PFD at or below 40 MHz at REFIN + tol_ppm. The board
// uses tol_ppm 0: its 40 MHz TCXO undivided is the 40 MHz PFD the datasheet
// characterises (a few ppm over is within what the part tolerates). Any
// tolerance with a 40 MHz REFIN divides it by 2: a 20 MHz PFD, outside the
// characterised point.
bool adrf6755_plan_tol(uint32_t refin_hz, uint32_t tol_ppm, uint64_t lo_hz, adrf6755_plan_t *p);

// Pure: the datasheet's initial register write sequence (Suggested
// Power-Up Sequence, steps 1-32) for a plan: n (register, value) pairs.
// The modulator stays powered down (CR29 = 0x80); power it up with
// adrf6755_modulator_on once the PLL has locked (step 34).
int adrf6755_init_sequence(const adrf6755_plan_t *p, uint8_t atten_db, uint8_t seq[][2], int max);

typedef struct {
    const spi_bus_if_t *bus;
    int dev;
} adrf6755_t;

esp_err_t adrf6755_lock_spi(const adrf6755_t *d);                // 3 CS pulses
esp_err_t adrf6755_write(const adrf6755_t *d, uint8_t reg, uint8_t val);
esp_err_t adrf6755_read(const adrf6755_t *d, uint8_t reg, uint8_t *val);
esp_err_t adrf6755_init(const adrf6755_t *d, const adrf6755_plan_t *p, uint8_t atten_db);
esp_err_t adrf6755_modulator_on(const adrf6755_t *d, bool on);  // CR29 = 0x81 / 0x80
