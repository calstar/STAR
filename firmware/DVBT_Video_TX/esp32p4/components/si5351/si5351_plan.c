#include "si5351.h"

#define VCO_MIN 600000000.0
#define VCO_MAX 900000000.0
#define C_MAX   1048575u

static uint64_t gcd64(uint64_t a, uint64_t b)
{
    while (b) { uint64_t t = a % b; a = b; b = t; }
    return a;
}

// Best rational approximation of x/y with denominator <= C_MAX (continued fractions).
static void best_frac(uint64_t x, uint64_t y, uint32_t *num, uint32_t *den)
{
    uint64_t p0 = 0, q0 = 1, p1 = 1, q1 = 0;
    while (y) {
        uint64_t a = x / y, t = x % y;
        uint64_t q2 = q0 + a * q1;
        if (q2 > C_MAX) break;
        uint64_t p2 = p0 + a * p1;
        p0 = p1; q0 = q1; p1 = p2; q1 = q2;
        x = y; y = t;
    }
    *num = (uint32_t)p1; *den = (uint32_t)q1;
}

bool si5351_plan(uint32_t xtal_hz, uint64_t fout_num, uint64_t fout_den, si5351_plan_t *p)
{
    double fout = (double)fout_num / (double)fout_den;
    uint32_t r = 0;
    // R divider so the multisynth can stay <= 900 at VCO >= 600 MHz (and its
    // output >= 500 kHz): small outputs come from MS / 2^r.
    while (fout * (1u << r) * 900.0 < VCO_MIN && r < 7) r++;
    double fms = fout * (1u << r);
    // Smallest even divider >= VCO_MIN/fms (MS dividers 4, 6, 8, ... 900).
    uint32_t d = (uint32_t)(VCO_MIN / fms);
    while ((double)d * fms < VCO_MIN) d++;
    if (d & 1) d++;
    if (d < 4 || d > 900 || (double)d * fms > VCO_MAX) return false;
    // VCO / xtal = d 2^r fout_num / (fout_den xtal), exactly when possible.
    uint64_t num = (uint64_t)d * (1u << r) * fout_num, den = fout_den * xtal_hz;
    uint64_t g = gcd64(num, den);
    num /= g; den /= g;
    uint32_t a = (uint32_t)(num / den);
    uint64_t rem = num % den;
    uint32_t b, c;
    if (rem == 0) { b = 0; c = 1; }
    else if (den <= C_MAX) { b = (uint32_t)rem; c = (uint32_t)den; }
    else best_frac(rem, den, &b, &c);
    if (a < 15 || a > 90) return false;
    p->pll_a = a; p->pll_b = b; p->pll_c = c;
    p->ms_div = d; p->r_div_log2 = r;
    p->vco_hz = xtal_hz * (a + (double)b / c);
    p->out_hz = p->vco_hz / d / (1u << r);
    return true;
}

si5351_params_t si5351_encode(uint32_t a, uint32_t b, uint32_t c)
{
    uint32_t f = (uint32_t)((128ull * b) / c);
    si5351_params_t pp = { 128 * a + f - 512, 128 * b - c * f, c };
    return pp;
}

void si5351_pack(const si5351_params_t *pp, uint32_t r_div_log2, uint8_t o[8])
{
    o[0] = (pp->p3 >> 8) & 0xFF;
    o[1] = pp->p3 & 0xFF;
    o[2] = ((r_div_log2 & 7) << 4) | ((pp->p1 >> 16) & 0x03);
    o[3] = (pp->p1 >> 8) & 0xFF;
    o[4] = pp->p1 & 0xFF;
    o[5] = (((pp->p3 >> 16) & 0x0F) << 4) | ((pp->p2 >> 16) & 0x0F);
    o[6] = (pp->p2 >> 8) & 0xFF;
    o[7] = pp->p2 & 0xFF;
}
