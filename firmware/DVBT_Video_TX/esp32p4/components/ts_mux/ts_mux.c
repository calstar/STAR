#include <string.h>
#include "ts_mux.h"

#define PID_PAT 0x0000
#define PID_SDT 0x0011
#define PID_NULL 0x1FFF
#define T27 27000000ull

uint32_t ts_crc32_mpeg(const uint8_t *p, size_t n)
{
    uint32_t crc = 0xFFFFFFFFu;
    while (n--) {
        crc ^= (uint32_t)*p++ << 24;
        for (int k = 0; k < 8; k++) crc = (crc << 1) ^ (0x04C11DB7u & -(crc >> 31));
    }
    return crc;
}

static uint64_t gcd64(uint64_t a, uint64_t b) { while (b) { uint64_t t = a % b; a = b; b = t; } return a; }

void ts_dvbt_rate(int bw_mhz, int mod, int rate, int guard, uint64_t *num, uint64_t *den)
{
    static const int cr_n[] = {1, 2, 3, 5, 7}, cr_d[] = {2, 3, 4, 6, 8};
    // R = 1512 carriers * bits * CR * 188/204 / Ts,  Ts = 2048 (1 + 1/G) / fs,
    // fs = 64/7 MHz * bw/8  (2K figures; 8K is 4x of both, same rate)
    uint64_t bits = 2u * (mod + 1);
    uint64_t gdiv = 32u >> guard;                 // 1/32 .. 1/4
    *num = 1512ull * bits * cr_n[rate] * 188 * 64000000ull * bw_mhz * gdiv;
    *den = (uint64_t)cr_d[rate] * 204 * 7 * 8 * 2048 * (gdiv + 1);
    uint64_t g = gcd64(*num, *den);
    *num /= g; *den /= g;
}

// 27 MHz time of byte `b` of the stream: b * 8 * 27e6 * den / num, exactly
// (split so it cannot overflow 64 bits).
static uint64_t t27_of_byte(const ts_mux_t *m, uint64_t b)
{
    uint64_t q = b / m->pcr_k_den, r = b % m->pcr_k_den;
    return q * m->pcr_k_num + (r * m->pcr_k_num) / m->pcr_k_den;
}

void ts_mux_init(ts_mux_t *m, const ts_mux_config_t *c)
{
    memset(m, 0, sizeof *m);
    m->c = *c;
    if (!m->c.pat_ms) m->c.pat_ms = 100;
    if (!m->c.sdt_ms) m->c.sdt_ms = 1000;
    if (!m->c.pcr_ms) m->c.pcr_ms = 20;
    if (!m->c.chan_ms) m->c.chan_ms = 100;
    uint64_t kn = 8 * T27 * c->rate_den, kd = c->rate_num;
    uint64_t g = gcd64(kn, kd);
    m->pcr_k_num = kn / g;
    m->pcr_k_den = kd / g;
}

uint64_t ts_mux_now_90k(const ts_mux_t *m) { return t27_of_byte(m, m->pkt * TS_PKT) / 300; }
uint64_t ts_mux_now_27(const ts_mux_t *m) { return t27_of_byte(m, m->pkt * TS_PKT); }

void ts_mux_set_chan(ts_mux_t *m, const ts_mux_chan_t *c)
{
    m->chan = *c;
    m->chan_ver = (m->chan_ver + 1) & 0x1F;
    m->next_chan = 0;                                 // the next slot
}

void ts_mux_skip(ts_mux_t *m, uint64_t n) { m->pkt += n; }
size_t ts_mux_backlog(const ts_mux_t *m) { return m->ring_used; }

bool ts_mux_put(ts_mux_t *m, const uint8_t *au, size_t n, uint64_t pts_90k, bool key)
{
    static const uint8_t aud[6] = {0, 0, 0, 1, 0x09, 0xF0};
    bool has_aud = n >= 5 && au[0] == 0 && au[1] == 0 &&
                   ((au[2] == 1 && (au[3] & 0x1F) == 9) || (au[2] == 0 && au[3] == 1 && (au[4] & 0x1F) == 9));
    size_t total = n + (has_aud ? 0 : sizeof aud);
    if (m->qn == TS_MUX_MAX_AU || m->ring_used + total > m->c.buf_size) return false;
    ts_mux_au_t *a = &m->q[(m->qh + m->qn) % TS_MUX_MAX_AU];
    a->off = m->ring_w; a->len = total; a->pts = pts_90k & 0x1FFFFFFFFull; a->key = key;
    for (size_t i = 0; i < total; i++) {
        m->c.buf[m->ring_w] = has_aud ? au[i] : (i < sizeof aud ? aud[i] : au[i - sizeof aud]);
        m->ring_w = (m->ring_w + 1) % m->c.buf_size;
    }
    m->ring_used += total;
    m->qn++;
    return true;
}

static void hdr(uint8_t *p, uint16_t pid, bool pusi, int afc, uint8_t cc)
{
    p[0] = 0x47;
    p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1F);
    p[2] = pid & 0xFF;
    p[3] = (uint8_t)((afc << 4) | (cc & 0x0F));
}

static void psi_packet(uint8_t *out, uint16_t pid, uint8_t *cc, const uint8_t *sec, size_t n)
{
    hdr(out, pid, true, 1, (*cc)++);
    out[4] = 0;                                   // pointer_field
    memcpy(out + 5, sec, n);
    memset(out + 5 + n, 0xFF, TS_PKT - 5 - n);
}

static size_t finish_section(uint8_t *s, size_t n)    // n: bytes so far incl. 3-byte header
{
    size_t len = n + 4 - 3;                           // section_length counts after it, + CRC
    s[1] = (s[1] & 0xF0) | ((len >> 8) & 0x0F);
    s[2] = len & 0xFF;
    uint32_t crc = ts_crc32_mpeg(s, n);
    s[n] = crc >> 24; s[n + 1] = crc >> 16; s[n + 2] = crc >> 8; s[n + 3] = crc;
    return n + 4;
}

static void pat(ts_mux_t *m, uint8_t *out)
{
    uint8_t s[32];
    size_t n = 0;
    s[n++] = 0x00; s[n++] = 0xB0; s[n++] = 0;
    s[n++] = m->c.tsid >> 8; s[n++] = m->c.tsid;
    s[n++] = 0xC1;                                    // version 0, current
    s[n++] = 0; s[n++] = 0;
    s[n++] = m->c.program >> 8; s[n++] = m->c.program;
    s[n++] = 0xE0 | (m->c.pmt_pid >> 8); s[n++] = m->c.pmt_pid;
    psi_packet(out, PID_PAT, &m->cc_pat, s, finish_section(s, n));
}

static void pmt(ts_mux_t *m, uint8_t *out)
{
    uint8_t s[40];
    size_t n = 0;
    s[n++] = 0x02; s[n++] = 0xB0; s[n++] = 0;
    s[n++] = m->c.program >> 8; s[n++] = m->c.program;
    s[n++] = 0xC1; s[n++] = 0; s[n++] = 0;
    s[n++] = 0xE0 | (m->c.video_pid >> 8); s[n++] = m->c.video_pid;    // PCR PID
    s[n++] = 0xF0; s[n++] = 0;                                         // program_info_length 0
    s[n++] = 0x1B;                                                     // H.264
    s[n++] = 0xE0 | (m->c.video_pid >> 8); s[n++] = m->c.video_pid;
    s[n++] = 0xF0; s[n++] = 0;
    psi_packet(out, m->c.pmt_pid, &m->cc_pmt, s, finish_section(s, n));
}

static void sdt(ts_mux_t *m, uint8_t *out)
{
    uint8_t s[180];
    size_t n = 0, pl = strlen(m->c.provider), sl = strlen(m->c.service);
    if (pl > 40) pl = 40;
    if (sl > 40) sl = 40;
    s[n++] = 0x42; s[n++] = 0xF0; s[n++] = 0;
    s[n++] = m->c.tsid >> 8; s[n++] = m->c.tsid;
    s[n++] = 0xC1; s[n++] = 0; s[n++] = 0;
    s[n++] = m->c.onid >> 8; s[n++] = m->c.onid;
    s[n++] = 0xFF;
    s[n++] = m->c.program >> 8; s[n++] = m->c.program;
    s[n++] = 0xFC;                                    // no EIT
    size_t dl = 2 + 3 + pl + sl;
    s[n++] = 0x80 | ((dl >> 8) & 0x0F);               // running, not scrambled
    s[n++] = dl & 0xFF;
    s[n++] = 0x48; s[n++] = (uint8_t)(dl - 2);        // service_descriptor
    s[n++] = 0x19;                                    // H.264 HD digital television
    s[n++] = (uint8_t)pl; memcpy(s + n, m->c.provider, pl); n += pl;
    s[n++] = (uint8_t)sl; memcpy(s + n, m->c.service, sl); n += sl;
    psi_packet(out, PID_SDT, &m->cc_sdt, s, finish_section(s, n));
}

static void put_pcr(uint8_t *p, uint64_t t27);

static void chan_table(ts_mux_t *m, uint8_t *out)
{
    uint8_t s[40];
    size_t n = 0;
    const ts_mux_chan_t *c = &m->chan;
    s[n++] = 0xF0; s[n++] = 0xB0; s[n++] = 0;
    s[n++] = 0x48; s[n++] = 0x50;                     // "HP"
    s[n++] = (uint8_t)(0xC1 | (m->chan_ver << 1));    // version, current
    s[n++] = 0; s[n++] = 0;
    s[n++] = 1;                                       // format
    s[n++] = c->pending ? 1 : 0;
    s[n++] = c->seq >> 8; s[n++] = (uint8_t)c->seq;
    uint32_t nx = c->pending ? c->next_khz : c->cur_khz;
    for (int k = 3; k >= 0; k--) s[n++] = (uint8_t)(c->cur_khz >> (8 * k));
    for (int k = 3; k >= 0; k--) s[n++] = (uint8_t)(nx >> (8 * k));
    put_pcr(s + n, c->pending ? c->hop_t27 : 0);
    n += 6;
    psi_packet(out, m->c.hop_pid, &m->cc_chan, s, finish_section(s, n));
}

static void null_pkt(uint8_t *out)
{
    memset(out, 0xFF, TS_PKT);
    out[0] = 0x47; out[1] = 0x1F; out[2] = 0xFF; out[3] = 0x10;
}

static void put_pcr(uint8_t *p, uint64_t t27)
{
    uint64_t base = (t27 / 300) & 0x1FFFFFFFFull, ext = t27 % 300;
    p[0] = base >> 25; p[1] = base >> 17; p[2] = base >> 9; p[3] = base >> 1;
    p[4] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
    p[5] = ext & 0xFF;
}

static void build_pes_header(ts_mux_t *m, const ts_mux_au_t *a)
{
    uint8_t *h = m->pes_hdr;
    uint64_t p = a->pts;
    h[0] = 0; h[1] = 0; h[2] = 1; h[3] = 0xE0;
    h[4] = 0; h[5] = 0;                               // unbounded (video in TS)
    h[6] = 0x84;                                      // data_alignment
    h[7] = 0x80;                                      // PTS only
    h[8] = 5;
    h[9] = (uint8_t)(0x21 | ((p >> 29) & 0x0E));
    h[10] = (uint8_t)(p >> 22);
    h[11] = (uint8_t)(0x01 | ((p >> 14) & 0xFE));
    h[12] = (uint8_t)(p >> 7);
    h[13] = (uint8_t)(0x01 | ((p << 1) & 0xFE));
    m->pes_hdr_len = 14;
}

// One video packet: PES bytes from the head AU, optionally with a PCR.
static void video_packet(ts_mux_t *m, uint8_t *out, bool with_pcr, uint64_t pcr27)
{
    bool have = m->qn > 0;
    if (!have) {                                      // PCR only: adaptation field, no payload
        // No payload: the CC repeats the previous packet's (ISO 13818-1 2.4.3.3).
        hdr(out, m->c.video_pid, false, 2, (uint8_t)(m->cc_vid - 1));
        out[4] = 183; out[5] = 0x10;
        put_pcr(out + 6, pcr27);
        memset(out + 12, 0xFF, TS_PKT - 12);
        return;
    }
    ts_mux_au_t *a = &m->q[m->qh];
    bool start = m->cur_sent == 0;
    if (start) build_pes_header(m, a);
    size_t pes_total = m->pes_hdr_len + a->len;
    size_t left = pes_total - m->cur_sent;
    size_t af = 0;                                    // adaptation field bytes incl. its length byte
    uint8_t flags = 0;
    if (with_pcr) { af = 8; flags |= 0x10; }
    if (start && a->key) { if (!af) af = 2; flags |= 0x40; }   // random_access_indicator
    size_t room = TS_PKT - 4 - af;
    if (left < room) {                                // last packet: stuff in the adaptation field
        size_t need = TS_PKT - 4 - left;
        if (af == 0 && need == 1) af = 1; else if (need > af) af = need;
        if (af >= 2 || need > 1) m->stuffed++;
        room = left;
    }
    hdr(out, m->c.video_pid, start, af ? 3 : 1, m->cc_vid++);
    size_t o = 4;
    if (af) {
        out[o] = (uint8_t)(af - 1);
        if (af >= 2) {
            out[o + 1] = flags;
            size_t k = o + 2;
            if (flags & 0x10) { put_pcr(out + k, pcr27); k += 6; }
            memset(out + k, 0xFF, o + af - k);
        }
        o += af;
    }
    for (size_t i = 0; i < room; i++, m->cur_sent++) {
        size_t s = m->cur_sent;
        out[o + i] = s < m->pes_hdr_len ? m->pes_hdr[s]
                   : m->c.buf[(a->off + s - m->pes_hdr_len) % m->c.buf_size];
    }
    if (m->cur_sent == pes_total) {                   // AU done
        m->ring_used -= a->len;
        m->qh = (m->qh + 1) % TS_MUX_MAX_AU;
        m->qn--;
        m->cur_sent = 0;
    }
}

void ts_mux_next(ts_mux_t *m, uint8_t out[TS_PKT])
{
    uint64_t t = t27_of_byte(m, m->pkt * TS_PKT);
    if (t >= m->next_pat) {
        if (m->next_pat & 1) {                        // odd marker: PMT half of the pair
            pmt(m, out);
            m->next_pat = (m->next_pat & ~1ull) + (uint64_t)m->c.pat_ms * (T27 / 1000);
        } else {
            pat(m, out);
            m->next_pat |= 1;
        }
    } else if (m->c.hop_pid && t >= m->next_chan) {
        chan_table(m, out);
        m->next_chan = t + (uint64_t)m->c.chan_ms * (T27 / 1000);
    } else if (t >= m->next_sdt) {
        sdt(m, out);
        m->next_sdt += (uint64_t)m->c.sdt_ms * (T27 / 1000);
    } else if (t >= m->next_pcr) {
        // PCR: the time the byte holding the base's last bit arrives (byte 10).
        video_packet(m, out, true, t27_of_byte(m, m->pkt * TS_PKT + 10));
        m->next_pcr += (uint64_t)m->c.pcr_ms * (T27 / 1000);
    } else if (m->qn) {
        video_packet(m, out, false, 0);
    } else {
        null_pkt(out);
        m->nulls++;
    }
    m->pkt++;
}
