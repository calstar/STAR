// Si5351A clock generator: generic frequency planning (pure, host-tested)
// and register writes over the ESP-IDF I2C master driver.
//
// Plan per Silicon Labs AN619: PLL (VCO 600-900 MHz) = xtal * (a + b/c),
// output multisynth an even integer (integer mode, lowest jitter) chosen
// to put the VCO in range, PLL fraction the exact rational where c fits in
// 20 bits (else the best approximation with c <= 1048575).
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint32_t pll_a, pll_b, pll_c;   // VCO = xtal (a + b/c)
    uint32_t ms_div;                // output divider (integer)
    uint32_t r_div_log2;            // final R divider, 2^n (for outputs < 500 kHz)
    double   vco_hz, out_hz;        // achieved
} si5351_plan_t;

typedef struct {
    uint32_t p1, p2, p3;            // AN619 encoded parameters
} si5351_params_t;

// fout: wanted output, as a ratio num/den Hz (27.428571 MHz = 192e6/7).
bool si5351_plan(uint32_t xtal_hz, uint64_t fout_num, uint64_t fout_den, si5351_plan_t *p);
si5351_params_t si5351_encode(uint32_t a, uint32_t b, uint32_t c);   // AN619 eqs 2-4
// The 8 register bytes of a PLL (MSNA, regs 26-33) or a multisynth (MS0,
// regs 42-49, with R divider and integer bit handled by the caller).
void si5351_pack(const si5351_params_t *pp, uint32_t r_div_log2, uint8_t out[8]);

#ifdef ESP_PLATFORM
#include "esp_err.h"
#include "driver/i2c_master.h"
// Program CLK0 from PLLA with the plan, crystal load in pF (6, 8 or 10).
esp_err_t si5351_start_clk0(i2c_master_bus_handle_t bus, uint32_t xtal_hz, int load_pf,
                            uint64_t fout_num, uint64_t fout_den, si5351_plan_t *plan);
#endif
