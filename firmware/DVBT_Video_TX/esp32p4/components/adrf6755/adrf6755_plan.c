#include <stddef.h>
#include "adrf6755.h"

#define PFD_MAX 40000000u
#define PFD_MIN 10000000u

bool adrf6755_plan(uint32_t refin_hz, uint64_t lo_hz, adrf6755_plan_t *p)
{
    if (refin_hz < 10000000u || refin_hz > 165000000u) return false;   // ÷2 path not used
    if (lo_hz <= 100000000ull || lo_hz > 2400000000ull) return false;
    // Reference path (Equation 1): no division if REFIN is a usable PFD
    // (then the R-divider and ÷2 are disabled, CR5[4] = 0, as recommended);
    // else the smallest total division r with REFIN / r <= 40 MHz -- even r
    // as ÷2 times R = r/2, odd r all in R, as the datasheet recommends.
    uint32_t r = 1;
    while (refin_hz / r > PFD_MAX || (refin_hz / r == PFD_MAX && refin_hz % r)) r++;
    p->doubler = false;
    p->r_half = (r % 2 == 0);
    p->r = (uint8_t)(p->r_half ? r / 2 : r);
    if (p->r > 32) return false;
    p->r_enable = (r != 1);
    p->pfd_hz = refin_hz / r;
    if (p->pfd_hz < PFD_MIN) return false;
    // Table 6
    static const struct { uint64_t lo_gt; uint8_t rfdiv; } t6[] = {
        {1155000000ull, 0}, {577500000ull, 1}, {288750000ull, 2}, {144375000ull, 3}, {100000000ull, 4},
    };
    size_t i = 0;
    while (!(lo_hz > t6[i].lo_gt)) i++;
    p->rfdiv = t6[i].rfdiv;
    p->cr27_bit4 = (p->rfdiv == 0);
    // N = 2^RFDIV LO / fPFD = INT + FRAC / 2^25 (Equations 4, 5)
    uint64_t num = (lo_hz << p->rfdiv) * r, den = refin_hz;   // N = num / den, exactly
    uint64_t intg = num / den;
    uint64_t rem = num % den;
    uint64_t frac = ((rem << 25) + den / 2) / den;
    if (frac == (1ull << 25)) { intg++; frac = 0; }
    if (intg < 23 || intg > 4095) return false;
    p->intg = (uint16_t)intg;
    p->frac = (uint32_t)frac;
    // CR25: autocal time = BSCDIV x 28 / PFD = 70 us (Equation 3)
    uint64_t b = ((uint64_t)p->pfd_hz * 70 + 28 * 1000000 / 2) / (28 * 1000000ull);
    p->bscdiv = (uint8_t)(b > 255 ? 255 : b);
    p->lo_hz = (double)p->pfd_hz * ((double)p->intg + (double)p->frac / 33554432.0) / (1u << p->rfdiv);
    return true;
}

int adrf6755_init_sequence(const adrf6755_plan_t *p, uint8_t atten_db, uint8_t seq[][2], int max)
{
    // Attenuator code (Table 27): 0..31 dB direct, 32..47 dB as 0b11xxxx.
    uint8_t att = atten_db > 47 ? 47 : atten_db;
    uint8_t att_code = att < 32 ? att : (uint8_t)(0x30 | (att - 32));
    uint8_t r5 = p->r == 32 ? 0 : p->r;
    const uint8_t s[][2] = {
        {30, att_code},                             //  1 attenuator
        {29, 0x80},                                 //  2 modulator powered down
        {28, (uint8_t)(0x08 | p->rfdiv)},           //  3 RFDIV, bit 3 set
        {27, (uint8_t)(p->cr27_bit4 ? 0x10 : 0)},   //  4 frequency range bit
        {26, 0x00},                                 //  5
        {25, p->bscdiv},                            //  6 autocal timer (0x64 at 40 MHz)
        {24, 0x18},                                 //  7 autocal enabled
        {23, 0x70},                                 //  8 lock detector (40 MHz PFD setting)
        {22, 0x80}, {21, 0x00}, {20, 0x00}, {19, 0x80}, {18, 0x60},
        {17, 0x00}, {16, 0x00}, {15, 0x00},         //  9-16 reserved values
        {14, 0x80},                                 // 17 stop LO when TXDIS = 1
        {13, 0xE8},                                 // 18 lock detector 2 (40 MHz PFD setting)
        {12, 0x18},                                 // 19 PLL powered up
        {11, 0x00},                                 // 20
        {10, (uint8_t)((p->r_half ? 0x40 : 0) | (p->doubler ? 0x20 : 0) | (r5 & 0x1F))},  // 21
        {9, 0xF0},                                  // 22 charge pump 5 mA (RSET 4.7k)
        {8, 0x00},                                  // 23
        {7, (uint8_t)((p->intg >> 8) & 0x0F)},      // 24 INT[11:8], MUXOUT tristate
        {6, (uint8_t)(p->intg & 0xFF)},             // 25 INT[7:0]
        {5, (uint8_t)(p->r_enable ? 0x10 : 0x00)},  // 26 R-divider enable
        {4, 0x01},                                  // 27
        {3, (uint8_t)(0x04 | ((p->frac >> 24) & 1))},  // 28 FRAC[24]
        {2, (uint8_t)(p->frac >> 16)},              // 29
        {1, (uint8_t)(p->frac >> 8)},               // 30
        {0, (uint8_t)p->frac},                      // 31 CR0 last: loads, starts acquisition
        {27, (uint8_t)(p->cr27_bit4 ? 0x10 : 0)},   // 32
    };
    int n = (int)(sizeof s / sizeof s[0]);
    if (n > max) return -1;
    for (int i = 0; i < n; i++) { seq[i][0] = s[i][0]; seq[i][1] = s[i][1]; }
    return n;
}
