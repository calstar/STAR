#include <math.h>
#include <stdio.h>
#include "fdc1004.h"
extern double g_true_pf[4];
extern uint16_t g_dev_id;
int g_test_log_level = 1;
static int fails;
#define CHECK(name, cond, ...) do { int _ok = (cond); printf("  [%s] " name "\n", _ok ? "PASS" : "FAIL", ##__VA_ARGS__); if (!_ok) fails++; } while (0)

static fdc1004_t fdc;
static fdc1004_sample_t last[4];
static int polls_to_settle(int ch, double target, int max)
{
    fdc1004_sample_t s[4];
    for (int i = 1; i <= max; i++) {
        fdc1004_poll(&fdc, s);
        for (int c = 0; c < 4; c++) if (s[c].fresh) last[c] = s[c];
        if (s[ch].fresh && !s[ch].saturated && fabs(s[ch].pf - target) < 0.01) return i;
    }
    return -1;
}
static void run(int n) { fdc1004_sample_t s[4]; for (int i = 0; i < n; i++) { fdc1004_poll(&fdc, s); for (int c = 0; c < 4; c++) if (s[c].fresh) last[c] = s[c]; } }

int main(void)
{
    printf("Init\n");
    g_dev_id = 0x1234;
    CHECK("wrong device ID is rejected", fdc1004_init(&fdc, NULL, 0x50, FDC1004_RATE_100) == ESP_ERR_NOT_FOUND);
    g_dev_id = 0x1004;
    CHECK("real IDs accepted", fdc1004_init(&fdc, NULL, 0x50, FDC1004_RATE_100) == ESP_OK);

    printf("Steady values on all 4 channels\n");
    g_true_pf[0] = 0.0; g_true_pf[1] = 4.7; g_true_pf[2] = 12.0; g_true_pf[3] = 33.0;
    run(400);
    for (int c = 0; c < 4; c++)
        CHECK("CIN%d true %.3f -> %.4f pF (capdac %u), counts/2^19 = %.4f", fabs(last[c].pf - g_true_pf[c]) < 0.01 && fabs(last[c].counts / 524288.0 - last[c].pf) < 1e-4,
              c + 1, g_true_pf[c], last[c].pf, last[c].capdac, last[c].counts / 524288.0);

    printf("Slow fill sweep CIN1: 0 -> 105 pF -> 0, 0.05 pF per sample\n");
    double maxerr = 0; int bad = 0, n = 0, maxcap = 0;
    for (int dir = 0; dir < 2; dir++)
        for (int k = 0; k <= 2100; k++) {
            g_true_pf[0] = dir == 0 ? k * 0.05 : 105 - k * 0.05;
            fdc1004_sample_t s[4];
            for (int j = 0; j < 4; j++) {   // 4 polls = one CIN1 sample
                fdc1004_poll(&fdc, s);
                if (s[0].fresh) { double e = fabs(s[0].pf - g_true_pf[0]); n++; if (e > maxerr) maxerr = e; if (e > 0.1 || s[0].saturated) bad++; if (s[0].capdac > maxcap) maxcap = s[0].capdac; }
            }
        }
    CHECK("tracks within 0.1 pF across full range (%d samples, worst %.4f pF, %d bad)", bad == 0, n, maxerr, bad);
    CHECK("CAPDAC climbed to %d and came back to %u", maxcap >= 29 && last[0].capdac <= 1, maxcap, (run(40), last[0].capdac));

    printf("Sudden jump CIN2: 4.7 -> 80 pF (e.g. probe plugged in)\n");
    g_true_pf[1] = 80.0;
    int p = polls_to_settle(1, 80.0, 400);
    CHECK("re-ranges and reads 80 pF after %d polls (~%d ms)", p > 0 && p < 100, p, p * 10);

    printf("Negative / over-range\n");
    g_true_pf[2] = -0.8; run(400);
    CHECK("slightly negative reads %.3f pF, counts %ld < 0", last[2].pf < -0.79 && last[2].counts < 0 && last[2].capdac == 0, last[2].pf, (long)last[2].counts);
    g_true_pf[3] = 130.0; run(400);
    CHECK("130 pF (past 96.875+15) flags saturated, CAPDAC pinned at %u", last[3].saturated && last[3].capdac == 31, last[3].capdac);
    g_true_pf[3] = 50.0; p = polls_to_settle(3, 50.0, 400);
    CHECK("recovers to 50 pF after %d polls", p > 0, p);

    printf(fails ? "\n%d FAILED\n" : "\nALL PASS\n", fails);
    return fails;
}
