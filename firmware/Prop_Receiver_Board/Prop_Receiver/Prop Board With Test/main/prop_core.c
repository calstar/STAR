#include "prop_core.h"
#include <string.h>
#include <math.h>

#define LOCK(p)   do { if ((p)->hal->lock)   (p)->hal->lock();   } while (0)
#define UNLOCK(p) do { if ((p)->hal->unlock) (p)->hal->unlock(); } while (0)

uint16_t prop_crc16(const uint8_t *d, size_t n)
{
    uint16_t c = 0xFFFF;
    while (n--) {
        c ^= *d++;
        for (int i = 0; i < 8; i++) c = (c & 1) ? (c >> 1) ^ 0xA001 : (c >> 1);
    }
    return c;
}

static void put_f32(uint8_t *p, float v) { memcpy(p, &v, 4); }
static float get_f32(const uint8_t *p) { float v; memcpy(&v, p, 4); return v; }
static bool ma_ok(float v) { return isfinite(v) && v >= 0.0f && v <= LOOP_MA_MAX; }

uint16_t prop_ma_to_code(const prop_t *p, int ch, float ma)
{
    float adj = ma * p->cal_gain[ch] + p->cal_off[ch];
    if (adj < 0.0f) adj = 0.0f;
    float v = adj * 1e-3f * (LOOP_RS_OHMS / XTR111_GAIN);
    float code = v / DAC_FULL_SCALE_V * 65535.0f + 0.5f;
    if (code < 0.0f) code = 0.0f;
    if (code > 65535.0f) code = 65535.0f;
    return (uint16_t)code;
}

/* caller holds lock. Order matters: disable first when turning off, enable last when turning on. */
static int apply_locked(prop_t *p, int ch)
{
    bool en = (p->enable_mask >> ch) & 1;
    uint16_t code = en ? prop_ma_to_code(p, ch, p->target_ma[ch]) : 0;
    if (!en) p->hal->od_set(ch, false);
    int e = p->hal->dac_write_code(ch, code);
    if (en) p->hal->od_set(ch, true);
    return e;
}

static void safe_locked(prop_t *p)
{
    p->enable_mask = 0;
    for (int i = 0; i < PROP_NUM_CH; i++) {
        p->target_ma[i] = 0.0f;
        apply_locked(p, i);
    }
}

void prop_init(prop_t *p, const prop_hal_t *hal, uint8_t node_addr)
{
    memset(p, 0, sizeof *p);
    p->hal = hal;
    p->node_addr = node_addr;
    p->timeout_ms = PROP_DEFAULT_TIMEOUT_MS;
    p->last_cmd_ms = hal->now_ms();
    for (int i = 0; i < PROP_NUM_CH; i++) { p->cal_gain[i] = 1.0f; p->fb_mv[i] = -1; }
}

size_t prop_build_frame(uint8_t addr, uint8_t cmd, const uint8_t *payload, uint8_t len, uint8_t *out)
{
    out[0] = PROP_SOF; out[1] = addr; out[2] = cmd; out[3] = len;
    if (len) memcpy(&out[4], payload, len);
    uint16_t c = prop_crc16(&out[1], 3 + len);
    out[4 + len] = c & 0xFF;
    out[5 + len] = c >> 8;
    return (size_t)len + 6;
}

bool prop_failsafe_poll(prop_t *p)
{
    bool tripped = false;
    LOCK(p);
    if (p->enable_mask && p->timeout_ms &&
        (p->hal->now_ms() - p->last_cmd_ms) > (int64_t)p->timeout_ms) {
        safe_locked(p);
        tripped = true;
    }
    UNLOCK(p);
    return tripped;
}

void prop_set_feedback(prop_t *p, const int mv[PROP_NUM_CH])
{
    LOCK(p);
    for (int i = 0; i < PROP_NUM_CH; i++) {
        p->fb_mv[i] = mv[i];
        p->fb_ma[i] = mv[i] < 0 ? -1.0f : ((float)mv[i] / 1000.0f) * FB_MA_PER_V + FB_OFFSET_MA;
    }
    UNLOCK(p);
}

bool prop_process_frame(prop_t *p, const uint8_t *f, size_t flen,
                        uint8_t *out, size_t out_max, size_t *olen)
{
    *olen = 0;
    if (flen < 6 || f[0] != PROP_SOF) return false;
    uint8_t addr = f[1], cmd = f[2], plen = f[3];
    if (flen != (size_t)plen + 6) return false;
    uint16_t rx = f[4 + plen] | ((uint16_t)f[5 + plen] << 8);
    if (prop_crc16(&f[1], 3 + plen) != rx) return false;
    if (addr != p->node_addr && addr != PROP_ADDR_BROADCAST) return true;

    const uint8_t *pl = &f[4];
    uint8_t rp[64];
    size_t rl = 1;
    uint8_t st = PROP_ST_OK;

    LOCK(p);
    p->last_cmd_ms = p->hal->now_ms();

    switch (cmd) {
    case PROP_CMD_PING:
        rp[rl++] = PROP_FW_VERSION;
        rp[rl++] = p->node_addr;
        { uint32_t up = (uint32_t)(p->hal->now_ms() / 1000); memcpy(&rp[rl], &up, 4); rl += 4; }
        break;

    case PROP_CMD_SET_MA:
        if (plen != 5) { st = PROP_ST_BAD_LEN; break; }
        { uint8_t ch = pl[0]; float ma = get_f32(&pl[1]);
          if (ch >= PROP_NUM_CH || !ma_ok(ma)) { st = PROP_ST_BAD_ARG; break; }
          p->target_ma[ch] = ma;
          if (apply_locked(p, ch) != 0) st = PROP_ST_HW; }
        break;

    case PROP_CMD_SET_ALL_MA:
        if (plen != 4 * PROP_NUM_CH) { st = PROP_ST_BAD_LEN; break; }
        for (int i = 0; i < PROP_NUM_CH; i++) if (!ma_ok(get_f32(&pl[4 * i]))) st = PROP_ST_BAD_ARG;
        if (st != PROP_ST_OK) break;
        for (int i = 0; i < PROP_NUM_CH; i++) {
            p->target_ma[i] = get_f32(&pl[4 * i]);
            if (apply_locked(p, i) != 0) st = PROP_ST_HW;
        }
        break;

    case PROP_CMD_SET_ENABLE:
        if (plen != 1) { st = PROP_ST_BAD_LEN; break; }
        p->enable_mask = pl[0] & ((1u << PROP_NUM_CH) - 1);
        for (int i = 0; i < PROP_NUM_CH; i++) if (apply_locked(p, i) != 0) st = PROP_ST_HW;
        break;

    case PROP_CMD_GET_STATUS:
        rp[rl++] = p->enable_mask;
        for (int i = 0; i < PROP_NUM_CH; i++) { put_f32(&rp[rl], p->target_ma[i]); rl += 4; }
        for (int i = 0; i < PROP_NUM_CH; i++) {
            uint16_t mv = p->fb_mv[i] < 0 ? 0xFFFF : (uint16_t)p->fb_mv[i];
            memcpy(&rp[rl], &mv, 2); rl += 2;
        }
        for (int i = 0; i < PROP_NUM_CH; i++) { put_f32(&rp[rl], p->fb_ma[i]); rl += 4; }
        break;

    case PROP_CMD_ESTOP:
        safe_locked(p);
        break;

    case PROP_CMD_SET_CAL:
        if (plen != 9) { st = PROP_ST_BAD_LEN; break; }
        { uint8_t ch = pl[0]; float g = get_f32(&pl[1]), o = get_f32(&pl[5]);
          if (ch >= PROP_NUM_CH || !isfinite(g) || !isfinite(o) || g < 0.5f || g > 2.0f || fabsf(o) > 5.0f) {
              st = PROP_ST_BAD_ARG; break;
          }
          p->cal_gain[ch] = g; p->cal_off[ch] = o;
          apply_locked(p, ch);
          if (p->hal->cal_save && p->hal->cal_save(p->cal_gain, p->cal_off) != 0) st = PROP_ST_HW; }
        break;

    case PROP_CMD_SET_TIMEOUT:
        if (plen != 2) { st = PROP_ST_BAD_LEN; break; }
        { uint16_t ms; memcpy(&ms, pl, 2); p->timeout_ms = ms; }
        break;

    default:
        st = PROP_ST_BAD_CMD;
        break;
    }
    UNLOCK(p);

    if (addr == PROP_ADDR_BROADCAST) return true;     /* never reply to broadcast */
    if (st != PROP_ST_OK) rl = 1;
    rp[0] = st;
    if (out_max < rl + 6) return true;                /* caller buffer too small: no reply */
    *olen = prop_build_frame(p->node_addr, cmd | 0x80, rp, (uint8_t)rl, out);
    return true;
}

void prop_stream_gap(prop_stream_t *s) { s->n = 0; }

void prop_stream_feed(prop_t *p, prop_stream_t *s, const uint8_t *d, size_t n,
                      prop_reply_cb cb, void *ctx)
{
    while (n) {
        size_t room = sizeof s->buf - s->n;
        if (!room) { s->n = 0; continue; }
        size_t k = n < room ? n : room;
        memcpy(s->buf + s->n, d, k);
        s->n += k; d += k; n -= k;
        for (;;) {
            size_t i = 0;
            while (i < s->n && s->buf[i] != PROP_SOF) i++;
            if (i) { memmove(s->buf, s->buf + i, s->n - i); s->n -= i; }
            if (s->n < 6) break;
            size_t flen = (size_t)s->buf[3] + 6;
            if (s->n < flen) break;
            uint8_t out[96]; size_t ol = 0;
            if (prop_process_frame(p, s->buf, flen, out, sizeof out, &ol)) {
                memmove(s->buf, s->buf + flen, s->n - flen); s->n -= flen;
                if (ol && cb) cb(out, ol, ctx);
            } else {
                memmove(s->buf, s->buf + 1, s->n - 1); s->n -= 1;   /* bad frame: resync */
            }
        }
    }
}
