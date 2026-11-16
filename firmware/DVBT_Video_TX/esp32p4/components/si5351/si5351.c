#include "si5351.h"

#define TRY(x) do { esp_err_t e_ = (x); if (e_ != ESP_OK) return e_; } while (0)

static esp_err_t wr(const i2c_bus_if_t *b, uint8_t reg, const uint8_t *v, size_t n)
{
    uint8_t buf[9];
    buf[0] = reg;
    for (size_t i = 0; i < n; i++) buf[1 + i] = v[i];
    return b->write(b->ctx, SI5351_ADDR, buf, n + 1);
}

static esp_err_t wr1(const i2c_bus_if_t *b, uint8_t reg, uint8_t v)
{
    return wr(b, reg, &v, 1);
}

esp_err_t si5351_start(const i2c_bus_if_t *b, uint32_t xtal_hz, int load_pf,
                       uint64_t fout_num, uint64_t fout_den, int n_out, si5351_plan_t *plan)
{
    if (n_out < 1 || n_out > 3) return ESP_ERR_INVALID_ARG;
    if (!si5351_plan(xtal_hz, fout_num, fout_den, plan)) return ESP_ERR_INVALID_ARG;

    // Wait for SYS_INIT to clear (reg 0 bit 7) after power-up.
    uint8_t reg0 = 0, st = 0x80;
    for (int i = 0; i < 100 && (st & 0x80); i++) {
        TRY(b->write_read(b->ctx, SI5351_ADDR, &reg0, 1, &st, 1));
        if (st & 0x80) b->delay_us(b->ctx, 1000);
    }
    if (st & 0x80) return ESP_ERR_TIMEOUT;

    TRY(wr1(b, 3, 0xFF));                                   // outputs off
    for (uint8_t r = 16; r <= 23; r++) TRY(wr1(b, r, 0x80)); // all CLKn powered down
    uint8_t load = load_pf <= 6 ? 0x40 : load_pf <= 8 ? 0x80 : 0xC0;
    TRY(wr1(b, 183, load | 0x12));                          // crystal load
    TRY(wr1(b, 149, 0x00));                                 // spread spectrum off

    uint8_t v[8];
    si5351_params_t pll = si5351_encode(plan->pll_a, plan->pll_b, plan->pll_c);
    si5351_pack(&pll, 0, v);
    TRY(wr(b, 26, v, 8));                                   // PLLA (MSNA)
    si5351_params_t ms = si5351_encode(plan->ms_div, 0, 1);
    si5351_pack(&ms, plan->r_div_log2, v);
    for (int i = 0; i < n_out; i++)                         // MS0 at 42, MS1 at 50, MS2 at 58
        TRY(wr(b, 42 + 8 * i, v, 8));
    TRY(wr1(b, 177, 0x20));                                 // PLLA reset
    // CLKn: powered up, MSn integer mode, from PLLA, not inverted, from MSn, 8 mA.
    for (int i = 0; i < n_out; i++) TRY(wr1(b, 16 + i, 0x4F));
    TRY(wr1(b, 3, (uint8_t)~((1u << n_out) - 1)));          // outputs on
    return ESP_OK;
}
