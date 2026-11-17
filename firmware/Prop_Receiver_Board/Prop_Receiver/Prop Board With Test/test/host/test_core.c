/* Unit tests for prop_core.c. No hardware, no ESP-IDF. Build: see test/Makefile */
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "prop_core.h"

static int g_fail = 0, g_checks = 0;
#define CHECK(c) do { g_checks++; if (!(c)) { g_fail++; printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } } while (0)
#define CHECK_INT(a, b) do { long _a=(long)(a), _b=(long)(b); g_checks++; if (_a!=_b) { g_fail++; printf("  FAIL %s:%d  %s == %ld, expected %ld\n", __FILE__, __LINE__, #a, _a, _b); } } while (0)
#define CHECK_NEAR(a, b, tol) do { double _a=(a), _b=(b); g_checks++; if (fabs(_a-_b)>(tol)) { g_fail++; printf("  FAIL %s:%d  %s = %g, expected %g\n", __FILE__, __LINE__, #a, _a, _b); } } while (0)
#define RUN(t) do { int _f=g_fail; t(); printf("[%s] %s\n", g_fail==_f?" ok ":"FAIL", #t); } while (0)

/* ---------------- mock HAL ---------------- */
typedef struct { int kind; int ch; int val; } ev_t;     /* kind 0 = DAC, 1 = OD */
static ev_t ev[512]; static int nev;
static int64_t g_now;
static int g_dac_fail, g_cal_fail, g_cal_saves;
static float g_saved_gain[PROP_NUM_CH], g_saved_off[PROP_NUM_CH];
static int g_locks, g_unlocks;

static int  m_dac(int ch, uint16_t code) { if (nev < 512) ev[nev++] = (ev_t){0, ch, code}; return g_dac_fail ? -1 : 0; }
static void m_od(int ch, bool en)        { if (nev < 512) ev[nev++] = (ev_t){1, ch, en}; }
static int  m_cal(const float *g, const float *o) { g_cal_saves++; memcpy(g_saved_gain, g, sizeof g_saved_gain); memcpy(g_saved_off, o, sizeof g_saved_off); return g_cal_fail ? -1 : 0; }
static int64_t m_now(void) { return g_now; }
static void m_lock(void) { g_locks++; }
static void m_unlock(void) { g_unlocks++; }
static const prop_hal_t HAL = { m_dac, m_od, m_cal, m_now, m_lock, m_unlock };

static prop_t P;
static void reset(void)
{
    nev = 0; g_now = 1000; g_dac_fail = g_cal_fail = g_cal_saves = 0; g_locks = g_unlocks = 0;
    prop_init(&P, &HAL, 0x01);
    nev = 0;
}
/* send a request, return status byte of reply (or -1 if no reply); copy reply payload */
static int xfer(uint8_t addr, uint8_t cmd, const void *pl, uint8_t len, uint8_t *rpl, size_t *rlen)
{
    uint8_t req[300], out[96]; size_t ol = 0;
    size_t n = prop_build_frame(addr, cmd, (const uint8_t *)pl, len, req);
    bool ok = prop_process_frame(&P, req, n, out, sizeof out, &ol);
    CHECK(ok);
    if (!ol) return -1;
    CHECK(out[0] == PROP_SOF && out[1] == 0x01 && out[2] == (uint8_t)(cmd | 0x80));
    CHECK(prop_crc16(&out[1], 3 + out[3]) == (uint16_t)(out[4 + out[3]] | (out[5 + out[3]] << 8)));
    if (rpl) memcpy(rpl, &out[4], out[3]);
    if (rlen) *rlen = out[3];
    return out[4];
}
static int set_ma(int ch, float ma) { uint8_t pl[5]; pl[0] = (uint8_t)ch; memcpy(&pl[1], &ma, 4); return xfer(1, PROP_CMD_SET_MA, pl, 5, NULL, NULL); }
static int set_en(uint8_t m) { return xfer(1, PROP_CMD_SET_ENABLE, &m, 1, NULL, NULL); }
static int last_dac(int ch) { for (int i = nev - 1; i >= 0; i--) if (ev[i].kind == 0 && ev[i].ch == ch) return ev[i].val; return -1; }
static int last_od(int ch)  { for (int i = nev - 1; i >= 0; i--) if (ev[i].kind == 1 && ev[i].ch == ch) return ev[i].val; return -1; }

/* ---------------- tests ---------------- */
static void test_crc16_vector(void)
{
    CHECK_INT(prop_crc16((const uint8_t *)"123456789", 9), 0x4B37);   /* Modbus check value */
    CHECK_INT(prop_crc16((const uint8_t *)"", 0), 0xFFFF);
}

static void test_build_frame(void)
{
    uint8_t out[16]; uint8_t pl[2] = { 0x11, 0x22 };
    size_t n = prop_build_frame(0x01, 0x04, pl, 2, out);
    CHECK_INT(n, 8);
    CHECK_INT(out[0], 0xA5); CHECK_INT(out[1], 1); CHECK_INT(out[2], 4); CHECK_INT(out[3], 2);
    uint16_t c = prop_crc16(&out[1], 5);
    CHECK_INT(out[6], c & 0xFF); CHECK_INT(out[7], c >> 8);
}

static void test_ma_to_code_math(void)
{
    reset();
    CHECK_INT(prop_ma_to_code(&P, 0, 0.0f), 0);
    /* full scale = DAC_FULL_SCALE_V * XTR111_GAIN / LOOP_RS_OHMS amps */
    float fs_ma = DAC_FULL_SCALE_V * XTR111_GAIN / LOOP_RS_OHMS * 1000.0f;
    CHECK_INT(prop_ma_to_code(&P, 0, fs_ma), 65535);
    CHECK_INT(prop_ma_to_code(&P, 0, fs_ma * 2), 65535);               /* clamps, never wraps */
    CHECK_INT(prop_ma_to_code(&P, 0, -3.0f), 0);                       /* never negative */
    CHECK_NEAR(prop_ma_to_code(&P, 0, fs_ma / 2), 32768, 1);
    /* monotonic */
    int prev = -1; for (float m = 0; m <= fs_ma; m += 0.1f) { int c = prop_ma_to_code(&P, 0, m); CHECK(c >= prev); prev = c; }
    /* gain / offset calibration */
    P.cal_gain[2] = 1.1f; P.cal_off[2] = 0.5f;
    CHECK_NEAR(prop_ma_to_code(&P, 2, 10.0f), prop_ma_to_code(&P, 0, 11.5f), 1);
}

static void test_ping(void)
{
    reset(); g_now = 5000 * 1000LL + 7;
    uint8_t pl[32]; size_t rl = 0;
    CHECK_INT(xfer(1, PROP_CMD_PING, NULL, 0, pl, &rl), PROP_ST_OK);
    CHECK_INT(rl, 7); CHECK_INT(pl[1], PROP_FW_VERSION); CHECK_INT(pl[2], 1);
    uint32_t up; memcpy(&up, &pl[3], 4); CHECK_INT(up, 5000);
}

static void test_frame_validation(void)
{
    reset();
    uint8_t req[32], out[96]; size_t ol;
    size_t n = prop_build_frame(1, PROP_CMD_PING, NULL, 0, req);
    CHECK(prop_process_frame(&P, req, n, out, sizeof out, &ol) && ol > 0);
    uint8_t bad[32];
    memcpy(bad, req, n); bad[n - 1] ^= 0x01;                         /* bad CRC */
    CHECK(!prop_process_frame(&P, bad, n, out, sizeof out, &ol)); CHECK_INT(ol, 0);
    memcpy(bad, req, n); bad[0] = 0x5A;                              /* bad SOF */
    CHECK(!prop_process_frame(&P, bad, n, out, sizeof out, &ol));
    CHECK(!prop_process_frame(&P, req, n - 1, out, sizeof out, &ol)); /* truncated */
    CHECK(!prop_process_frame(&P, req, n + 1, out, sizeof out, &ol)); /* extra byte */
    CHECK(!prop_process_frame(&P, req, 3, out, sizeof out, &ol));     /* too short */
    CHECK(prop_process_frame(&P, req, n, out, 4, &ol) && ol == 0);    /* tiny reply buffer: no overrun */
}

static void test_address_filtering(void)
{
    reset();
    uint8_t m = 0x01, req[32], out[96]; size_t ol;
    size_t n = prop_build_frame(0x07, PROP_CMD_SET_ENABLE, &m, 1, req);   /* someone else's address */
    CHECK(prop_process_frame(&P, req, n, out, sizeof out, &ol)); CHECK_INT(ol, 0);
    CHECK_INT(P.enable_mask, 0);                                          /* and it must not execute */
    n = prop_build_frame(PROP_ADDR_BROADCAST, PROP_CMD_SET_ENABLE, &m, 1, req);
    CHECK(prop_process_frame(&P, req, n, out, sizeof out, &ol)); CHECK_INT(ol, 0);
    CHECK_INT(P.enable_mask, 1);                                          /* broadcast executes silently */
}

static void test_set_ma_and_enable_ordering(void)
{
    reset();
    CHECK_INT(set_ma(0, 10.0f), PROP_ST_OK);
    CHECK_INT(last_dac(0), 0);                       /* not enabled yet: DAC stays 0 */
    CHECK_INT(last_od(0), 0);
    nev = 0;
    CHECK_INT(set_en(0x01), PROP_ST_OK);
    CHECK(last_dac(0) > 0);
    /* for channel 0: DAC write must come BEFORE OD enable */
    int i_dac = -1, i_od = -1;
    for (int i = 0; i < nev; i++) { if (ev[i].ch == 0 && ev[i].kind == 0 && ev[i].val > 0) i_dac = i; if (ev[i].ch == 0 && ev[i].kind == 1 && ev[i].val == 1) i_od = i; }
    CHECK(i_dac >= 0 && i_od >= 0 && i_dac < i_od);
    CHECK_INT(last_od(0), 1);
    nev = 0;
    CHECK_INT(set_en(0x00), PROP_ST_OK);
    /* turning off: OD disable must come BEFORE DAC drops to 0 */
    int j_od = -1, j_dac = -1;
    for (int i = 0; i < nev; i++) { if (ev[i].ch == 0 && ev[i].kind == 1 && j_od < 0) j_od = i; if (ev[i].ch == 0 && ev[i].kind == 0 && j_dac < 0) j_dac = i; }
    CHECK(j_od >= 0 && j_dac >= 0 && j_od < j_dac);
    CHECK_INT(last_dac(0), 0);
    CHECK_INT(last_od(0), 0);
}

static void test_set_ma_validation(void)
{
    reset();
    nev = 0;
    CHECK_INT(set_ma(5, 1.0f), PROP_ST_BAD_ARG);                 /* channel out of range */
    CHECK_INT(set_ma(0, -0.1f), PROP_ST_BAD_ARG);
    CHECK_INT(set_ma(0, LOOP_MA_MAX + 0.01f), PROP_ST_BAD_ARG);
    CHECK_INT(set_ma(0, NAN), PROP_ST_BAD_ARG);
    CHECK_INT(set_ma(0, INFINITY), PROP_ST_BAD_ARG);
    CHECK_INT(nev, 0);                                           /* nothing touched hardware */
    CHECK_INT(set_ma(0, LOOP_MA_MAX), PROP_ST_OK);               /* boundary accepted */
    CHECK_INT(set_ma(0, 0.0f), PROP_ST_OK);
    uint8_t pl[4] = { 0 };
    CHECK_INT(xfer(1, PROP_CMD_SET_MA, pl, 4, NULL, NULL), PROP_ST_BAD_LEN);
}

static void test_set_all_is_atomic(void)
{
    reset();
    float v[5] = { 1, 2, 3, 4, 5 };
    CHECK_INT(xfer(1, PROP_CMD_SET_ALL_MA, v, 20, NULL, NULL), PROP_ST_OK);
    for (int i = 0; i < 5; i++) CHECK_NEAR(P.target_ma[i], v[i], 1e-6);
    float bad[5] = { 9, 9, 9, 99, 9 };                            /* one invalid value */
    nev = 0;
    CHECK_INT(xfer(1, PROP_CMD_SET_ALL_MA, bad, 20, NULL, NULL), PROP_ST_BAD_ARG);
    for (int i = 0; i < 5; i++) CHECK_NEAR(P.target_ma[i], v[i], 1e-6);   /* nothing changed */
    CHECK_INT(nev, 0);
    CHECK_INT(xfer(1, PROP_CMD_SET_ALL_MA, v, 16, NULL, NULL), PROP_ST_BAD_LEN);
}

static void test_enable_mask(void)
{
    reset();
    CHECK_INT(set_en(0xFF), PROP_ST_OK);
    CHECK_INT(P.enable_mask, 0x1F);                               /* only 5 channels exist */
    CHECK_INT(set_en(0x05), PROP_ST_OK);
    CHECK_INT(last_od(0), 1); CHECK_INT(last_od(1), 0); CHECK_INT(last_od(2), 1); CHECK_INT(last_od(3), 0);
    uint8_t two[2] = { 1, 2 };
    CHECK_INT(xfer(1, PROP_CMD_SET_ENABLE, two, 2, NULL, NULL), PROP_ST_BAD_LEN);
}

static void test_estop(void)
{
    reset();
    float v[5] = { 5, 6, 7, 8, 9 };
    xfer(1, PROP_CMD_SET_ALL_MA, v, 20, NULL, NULL); set_en(0x1F);
    nev = 0;
    CHECK_INT(xfer(1, PROP_CMD_ESTOP, NULL, 0, NULL, NULL), PROP_ST_OK);
    CHECK_INT(P.enable_mask, 0);
    for (int i = 0; i < 5; i++) { CHECK_NEAR(P.target_ma[i], 0, 1e-9); CHECK_INT(last_dac(i), 0); CHECK_INT(last_od(i), 0); }
}

static void test_failsafe(void)
{
    reset();
    set_ma(0, 10.0f); set_en(0x01);
    g_now += 1999; CHECK(!prop_failsafe_poll(&P));               /* just inside the window */
    CHECK_INT(P.enable_mask, 1);
    g_now += 2;    CHECK(prop_failsafe_poll(&P));                /* just outside */
    CHECK_INT(P.enable_mask, 0); CHECK_INT(last_dac(0), 0); CHECK_INT(last_od(0), 0);
    CHECK(!prop_failsafe_poll(&P));                              /* nothing enabled: does not re-trip */

    reset(); set_en(0x01);
    g_now += 1500; xfer(1, PROP_CMD_PING, NULL, 0, NULL, NULL);  /* any valid command refreshes it */
    g_now += 1500; CHECK(!prop_failsafe_poll(&P));
    g_now += 600;  CHECK(prop_failsafe_poll(&P));

    reset(); set_en(0x01);
    uint16_t ms = 0; CHECK_INT(xfer(1, PROP_CMD_SET_TIMEOUT, &ms, 2, NULL, NULL), PROP_ST_OK);
    g_now += 3600 * 1000; CHECK(!prop_failsafe_poll(&P));        /* timeout 0 disables failsafe */
    ms = 100; xfer(1, PROP_CMD_SET_TIMEOUT, &ms, 2, NULL, NULL);
    g_now += 101; CHECK(prop_failsafe_poll(&P));

    /* a corrupt or foreign frame must NOT refresh the watchdog */
    reset(); set_en(0x01);
    uint8_t m = 0, req[16], out[96]; size_t ol;
    size_t n = prop_build_frame(0x09, PROP_CMD_PING, &m, 0, req);
    g_now += 1500; prop_process_frame(&P, req, n, out, sizeof out, &ol);
    g_now += 600;  CHECK(prop_failsafe_poll(&P));
}

static void test_calibration(void)
{
    reset();
    uint8_t pl[9]; float g = 1.05f, o = -0.2f; pl[0] = 1; memcpy(&pl[1], &g, 4); memcpy(&pl[5], &o, 4);
    CHECK_INT(xfer(1, PROP_CMD_SET_CAL, pl, 9, NULL, NULL), PROP_ST_OK);
    CHECK_INT(g_cal_saves, 1);
    CHECK_NEAR(g_saved_gain[1], 1.05, 1e-6); CHECK_NEAR(g_saved_off[1], -0.2, 1e-6);
    CHECK_NEAR(g_saved_gain[0], 1.0, 1e-6);                      /* other channels untouched */
    /* rejected values */
    float bad_g[] = { 0.4f, 2.1f, NAN };
    for (int i = 0; i < 3; i++) { memcpy(&pl[1], &bad_g[i], 4); CHECK_INT(xfer(1, PROP_CMD_SET_CAL, pl, 9, NULL, NULL), PROP_ST_BAD_ARG); }
    g = 1.0f; o = 6.0f; memcpy(&pl[1], &g, 4); memcpy(&pl[5], &o, 4);
    CHECK_INT(xfer(1, PROP_CMD_SET_CAL, pl, 9, NULL, NULL), PROP_ST_BAD_ARG);
    pl[0] = 9; o = 0; memcpy(&pl[5], &o, 4);
    CHECK_INT(xfer(1, PROP_CMD_SET_CAL, pl, 9, NULL, NULL), PROP_ST_BAD_ARG);
    CHECK_INT(g_cal_saves, 1);                                   /* rejected cals are never persisted */
    CHECK_INT(xfer(1, PROP_CMD_SET_CAL, pl, 8, NULL, NULL), PROP_ST_BAD_LEN);
    /* NVS failure is reported */
    pl[0] = 0; g = 1.0f; memcpy(&pl[1], &g, 4); g_cal_fail = 1;
    CHECK_INT(xfer(1, PROP_CMD_SET_CAL, pl, 9, NULL, NULL), PROP_ST_HW);
}

static void test_status_layout(void)
{
    reset();
    float v[5] = { 1.5f, 2.5f, 3.5f, 4.5f, 5.5f };
    xfer(1, PROP_CMD_SET_ALL_MA, v, 20, NULL, NULL); set_en(0x15);
    int mv[5] = { 100, 200, -1, 400, 3000 }; prop_set_feedback(&P, mv);
    uint8_t pl[64]; size_t rl = 0;
    CHECK_INT(xfer(1, PROP_CMD_GET_STATUS, NULL, 0, pl, &rl), PROP_ST_OK);
    CHECK_INT(rl, 52);                                           /* st + mask + 5*4 + 5*2 + 5*4 */
    CHECK_INT(pl[1], 0x15);
    float t; memcpy(&t, &pl[2 + 4 * 3], 4); CHECK_NEAR(t, 4.5, 1e-6);
    uint16_t u; memcpy(&u, &pl[22], 2); CHECK_INT(u, 100);
    memcpy(&u, &pl[22 + 4], 2); CHECK_INT(u, 0xFFFF);           /* unavailable reading */
    float f; memcpy(&f, &pl[32 + 4 * 4], 4); CHECK_NEAR(f, 3.0 / 1.0 * FB_MA_PER_V + FB_OFFSET_MA, 1e-4);
    memcpy(&f, &pl[32 + 4 * 2], 4); CHECK_NEAR(f, -1.0, 1e-6);
}

static void test_unknown_and_hw_errors(void)
{
    reset();
    CHECK_INT(xfer(1, 0x55, NULL, 0, NULL, NULL), PROP_ST_BAD_CMD);
    g_dac_fail = 1;
    CHECK_INT(set_ma(0, 5.0f), PROP_ST_HW);                      /* DAC SPI failure surfaces to the host */
    g_dac_fail = 0;
    uint8_t one = 0; CHECK_INT(xfer(1, PROP_CMD_PING, &one, 1, NULL, NULL), PROP_ST_OK);  /* extra payload on ping is harmless */
}

static void test_locking_balanced(void)
{
    reset();
    set_ma(0, 1.0f); set_en(1); prop_failsafe_poll(&P); int mv[5] = { 1, 2, 3, 4, 5 }; prop_set_feedback(&P, mv);
    CHECK(g_locks > 0); CHECK_INT(g_locks, g_unlocks);
    prop_t Q; prop_hal_t nohal = HAL; nohal.lock = NULL; nohal.unlock = NULL;   /* NULL lock hooks allowed */
    prop_init(&Q, &nohal, 1); uint8_t out[96]; size_t ol; uint8_t req[16];
    size_t n = prop_build_frame(1, PROP_CMD_PING, NULL, 0, req);
    CHECK(prop_process_frame(&Q, req, n, out, sizeof out, &ol) && ol);
}

/* ---- RS-485 stream framing ---- */
typedef struct { int count; uint8_t last_cmd; uint8_t st; } cbctx_t;
static void cb(const uint8_t *r, size_t len, void *ctx)
{
    cbctx_t *c = ctx; c->count++; c->last_cmd = r[2]; c->st = r[4]; (void)len;
}
static void test_stream_framing(void)
{
    reset();
    prop_stream_t s; memset(&s, 0, sizeof s); cbctx_t c = { 0 };
    uint8_t a[16], b[16]; size_t na = prop_build_frame(1, PROP_CMD_PING, NULL, 0, a);
    uint8_t en = 1; size_t nb = prop_build_frame(1, PROP_CMD_SET_ENABLE, &en, 1, b);

    /* byte-at-a-time delivery */
    for (size_t i = 0; i < na; i++) prop_stream_feed(&P, &s, &a[i], 1, cb, &c);
    CHECK_INT(c.count, 1); CHECK_INT(c.last_cmd, 0x81);

    /* two frames in one chunk */
    uint8_t both[32]; memcpy(both, a, na); memcpy(both + na, b, nb);
    prop_stream_feed(&P, &s, both, na + nb, cb, &c);
    CHECK_INT(c.count, 3); CHECK_INT(c.last_cmd, 0x84); CHECK_INT(P.enable_mask, 1);

    /* leading garbage then a frame */
    uint8_t junk[40]; memset(junk, 0x00, 7); junk[3] = 0x77; memcpy(junk + 7, a, na);
    prop_stream_feed(&P, &s, junk, 7 + na, cb, &c);
    CHECK_INT(c.count, 4);

    /* corrupt frame followed by good frame: resyncs and still answers the good one */
    uint8_t bad[16]; memcpy(bad, a, na); bad[na - 1] ^= 0xFF;
    uint8_t mix[40]; memcpy(mix, bad, na); memcpy(mix + na, a, na);
    prop_stream_feed(&P, &s, mix, 2 * na, cb, &c);
    CHECK_INT(c.count, 5);

    /* a fake SOF inside noise must not swallow the next real frame */
    uint8_t fake[40] = { 0xA5, 0x01, 0x01, 0x00 };                 /* looks like a header, CRC missing */
    memcpy(fake + 4, a, na);
    prop_stream_feed(&P, &s, fake, 4 + na, cb, &c);
    CHECK(c.count >= 6);

    /* gap drops a partial frame */
    int before = c.count;
    prop_stream_feed(&P, &s, a, 3, cb, &c); prop_stream_gap(&s);
    prop_stream_feed(&P, &s, a, na, cb, &c);
    CHECK_INT(c.count, before + 1);

    /* other node's frame: consumed, no reply */
    before = c.count;
    uint8_t other[16]; size_t no = prop_build_frame(0x33, PROP_CMD_PING, NULL, 0, other);
    prop_stream_feed(&P, &s, other, no, cb, &c);
    CHECK_INT(c.count, before);

    /* large garbage flood never overflows or wedges the parser */
    uint8_t flood[1000]; for (int i = 0; i < 1000; i++) flood[i] = (uint8_t)(i * 7); flood[0] = 0xA5; flood[3] = 0xFF;
    prop_stream_feed(&P, &s, flood, sizeof flood, cb, &c);
    before = c.count;
    prop_stream_feed(&P, &s, a, na, cb, &c);
    CHECK(c.count >= before + 0);                                  /* no crash; recovery checked below */
    prop_stream_gap(&s);
    prop_stream_feed(&P, &s, a, na, cb, &c);
    CHECK(c.count >= before + 1);
}

int main(void)
{
    RUN(test_crc16_vector); RUN(test_build_frame); RUN(test_ma_to_code_math); RUN(test_ping);
    RUN(test_frame_validation); RUN(test_address_filtering); RUN(test_set_ma_and_enable_ordering);
    RUN(test_set_ma_validation); RUN(test_set_all_is_atomic); RUN(test_enable_mask); RUN(test_estop);
    RUN(test_failsafe); RUN(test_calibration); RUN(test_status_layout); RUN(test_unknown_and_hw_errors);
    RUN(test_locking_balanced); RUN(test_stream_framing);
    printf("\n%d checks, %d failed\n", g_checks, g_fail);
    return g_fail ? 1 : 0;
}
