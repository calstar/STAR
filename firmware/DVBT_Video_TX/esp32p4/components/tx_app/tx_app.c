#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "tx_app.h"

#define TRY(x) do { esp_err_t e_ = (x); if (e_ != ESP_OK) return e_; } while (0)

static void logf_(tx_app_t *a, char lvl, const char *fmt, ...)
{
    if (!a->b->log) return;
    char m[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(m, sizeof m, fmt, ap);
    va_end(ap);
    a->b->log(a->b->ctx, lvl, m);
}

static void lock(tx_app_t *a, bool take)
{
    if (a->b->mux_lock) a->b->mux_lock(a->b->ctx, take);
}

static void dac_reset(void *ctx, bool high)
{
    tx_app_t *a = ctx;
    a->b->gpio_set(a->b->ctx, TX_PIN_DAC_RESET, high);
}

static esp_err_t fpga_load(tx_app_t *a)
{
    const tx_board_t *b = a->b;
    if (b->fpga_port) TRY(b->fpga_port(b->ctx, true));
    esp_err_t e = ecp5_configure(b->ecp5, b->fpga_part_size, &a->fpga);
    esp_err_t e2 = b->fpga_port ? b->fpga_port(b->ctx, false) : ESP_OK;
    logf_(a, e == ESP_OK ? 'I' : 'E', "FPGA configured via %s (slave SPI: 0x%x, idcode %08lx, status %08lx)",
          a->fpga.via == ECP5_VIA_SSPI ? "slave SPI from the P4" :
          a->fpga.via == ECP5_VIA_FLASH ? "its W25Q32" : "nothing",
          (unsigned)a->fpga.sspi_err, (unsigned long)a->fpga.idcode, (unsigned long)a->fpga.status);
    TRY(e);
    TRY(e2);
    b->delay_us(b->ctx, 10000);         // FPGA PLL lock + its 2^10-clock reset
    uint32_t id = 0;
    e = fpga_link_check(b->link, &id);
    if (e != ESP_OK) logf_(a, 'E', "FPGA ID %08lx, expected %08lx", (unsigned long)id, (unsigned long)DVBT_ID);
    return e;
}

static esp_err_t lo_lock(tx_app_t *a)
{
    const tx_board_t *b = a->b;
    TRY(adrf6755_init(&a->mod, &a->lo, a->c.atten_db));
    int64_t t0 = b->now_us(b->ctx);
    uint32_t lim = a->c.ldet_timeout_us ? a->c.ldet_timeout_us : 10000;
    while (!b->gpio_get(b->ctx, TX_PIN_LDET)) {
        if (b->now_us(b->ctx) - t0 > (int64_t)lim) {
            logf_(a, 'E', "ADRF6755 PLL did not lock (LDET low after %lu us)", (unsigned long)lim);
            return ESP_ERR_TIMEOUT;
        }
        b->delay_us(b->ctx, 20);
    }
    return ESP_OK;
}

// Modulator config, FIFO primed with tx_en low, then tx_en.
static esp_err_t stream_start(tx_app_t *a)
{
    const fpga_link_t *l = a->b->link;
    TRY(fpga_reg_write(l, DVBT_REG_CTRL, a->ctrl));
    // Bench calibration (tx_config_t): I/Q gain and phase trims, DC offsets.
    uint16_t gi = a->c.gain_i ? a->c.gain_i : 40960, gq = a->c.gain_q ? a->c.gain_q : 40960;
    TRY(fpga_reg_write(l, DVBT_REG_GAIN, ((uint32_t)gi << 16) | gq));
    TRY(fpga_reg_write(l, DVBT_REG_PHASE, (uint16_t)a->c.phase));
    TRY(fpga_reg_write(l, DVBT_REG_DCOFF, (((uint32_t)a->c.dc_i & 0xFFF) << 16) | ((uint32_t)a->c.dc_q & 0xFFF)));
    TRY(fpga_reg_write(l, DVBT_REG_STATUS, DVBT_ST_CLEAR_NULLS | 0xFu));
    // Send while the DREQ pin says there is room. (Not the status byte: it
    // is sampled at the start of a frame, so it can still say "room" after
    // that frame's packet filled the FIFO -- and with tx_en low nothing
    // drains it, so a send waiting for DREQ would wait forever.)
    uint8_t sb = 0;
    int primed = 0;
    while (l->wait_dreq(l->ctx, 0)) {
        TRY(fpga_ts_send(l, a->pkts, 1, 100, &sb));
        primed++;
        if (a->b->on_sent) a->b->on_sent(a->b->ctx, a->pkts, 1);
        lock(a, true);
        ts_mux_next(&a->mux, a->pkts);
        lock(a, false);
    }
    if (primed < 2) return ESP_ERR_INVALID_STATE;     // the FIFO never asked for data
    TRY(fpga_reg_write(l, DVBT_REG_CTRL, a->ctrl | DVBT_CTRL_TX_EN));
    uint32_t rb = 0;
    TRY(fpga_reg_read(l, DVBT_REG_CTRL, &rb));
    return rb == (a->ctrl | DVBT_CTRL_TX_EN) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t rf_on(tx_app_t *a)
{
    TRY(adrf6755_modulator_on(&a->mod, true));      // only after lock (step 34)
    a->b->gpio_set(a->b->ctx, TX_PIN_TXDIS, false);
    a->on_air = true;
    return ESP_OK;
}

void tx_rf_off(tx_app_t *a)
{
    a->b->gpio_set(a->b->ctx, TX_PIN_TXDIS, true);
    adrf6755_modulator_on(&a->mod, false);
    a->on_air = false;
}

static bool in_band(const tx_app_t *a, uint64_t hz)
{
    return hz >= a->c.lo_min_hz && hz <= a->c.lo_max_hz;
}

static void fc_reply(tx_app_t *a, const char *fmt, ...)
{
    if (!a->b->fc_write) return;
    char body[80], line[FC_LINE_MAX + 8];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(body, sizeof body, fmt, ap);
    va_end(ap);
    if (fc_format(line, sizeof line, body)) a->b->fc_write(a->b->ctx, line);
}

static void announce(tx_app_t *a)
{
    ts_mux_chan_t ch = { .cur_khz = a->cur_khz, .next_khz = a->hop.pending ? a->hop.khz : a->cur_khz,
                         .seq = a->hop.pending ? a->hop.seq : a->done_seq, .pending = a->hop.pending,
                         .hop_t27 = a->hop.t27 };
    lock(a, true);
    ts_mux_set_chan(&a->mux, &ch);
    lock(a, false);
}

static uint32_t ms_until(const tx_app_t *a, uint64_t t27)
{
    uint64_t now = ts_mux_now_27(&a->mux);
    return t27 > now ? (uint32_t)((t27 - now) / 27000) : 0;
}

void tx_fc_command(tx_app_t *a, const fc_cmd_t *cmd)
{
    a->fc_lines++;
    if (cmd->kind == FC_BAD_CSUM || cmd->kind == FC_BAD_SYNTAX) {
        a->fc_bad++;
        fc_reply(a, "ERR,%s", cmd->kind == FC_BAD_CSUM ? "CSUM" : "SYNTAX");
        return;
    }
    if (cmd->kind == FC_QUERY) {
        if (a->hop.pending) fc_reply(a, "CH,%lu,PENDING,%u,%lu", (unsigned long)a->cur_khz, a->hop.seq,
                                     (unsigned long)a->hop.khz);
        else fc_reply(a, "CH,%lu,IDLE", (unsigned long)a->cur_khz);
        return;
    }
    // $HOP. A retry (same seq) gets the same answer and never a second hop.
    tx_hop_t *h = &a->hop;
    if (h->pending) {
        if (cmd->seq == h->seq && cmd->khz == h->khz)
            fc_reply(a, "ACK,%u,%lu,%lu,%llu", h->seq, (unsigned long)h->khz, (unsigned long)ms_until(a, h->t27),
                     (unsigned long long)(h->t27 % (300ull << 33)));
        else fc_reply(a, "NAK,%u,%s", cmd->seq, cmd->seq == h->seq ? "SEQ" : "BUSY");
        return;
    }
    if (a->done_valid && cmd->seq == a->done_seq) {
        if (cmd->khz != a->done_khz) { fc_reply(a, "NAK,%u,SEQ", cmd->seq); return; }
        fc_reply(a, "DONE,%u,%lu,%s", cmd->seq, (unsigned long)cmd->khz, a->done_ok ? "OK" : "FAIL");
        return;
    }
    uint64_t hz = (uint64_t)cmd->khz * 1000;
    if (!in_band(a, hz)) { fc_reply(a, "NAK,%u,RANGE", cmd->seq); return; }
    adrf6755_plan_t p;
    if (!adrf6755_plan_tol(a->c.refin_hz, a->c.refin_tol_ppm, hz, &p)) { fc_reply(a, "NAK,%u,NOPLAN", cmd->seq); return; }
    if (cmd->khz == a->cur_khz) {                 // already there: nothing to do
        a->done_valid = true; a->done_seq = cmd->seq; a->done_khz = cmd->khz; a->done_ok = true;
        fc_reply(a, "ACK,%u,%lu,0,0", cmd->seq, (unsigned long)cmd->khz);
        fc_reply(a, "DONE,%u,%lu,OK", cmd->seq, (unsigned long)cmd->khz);
        return;
    }
    h->pending = true;
    h->seq = cmd->seq;
    h->khz = cmd->khz;
    h->plan = p;
    h->t27 = ts_mux_now_27(&a->mux) + (uint64_t)a->c.hop_lead_ms * 27000;
    announce(a);
    logf_(a, 'I', "hop %u: to %lu kHz in %lu ms", h->seq, (unsigned long)h->khz, (unsigned long)a->c.hop_lead_ms);
    fc_reply(a, "ACK,%u,%lu,%lu,%llu", h->seq, (unsigned long)h->khz, (unsigned long)a->c.hop_lead_ms,
             (unsigned long long)(h->t27 % (300ull << 33)));
}

static void hop_now(tx_app_t *a)
{
    tx_hop_t *h = &a->hop;
    adrf6755_plan_t old = a->lo;
    tx_rf_off(a);
    a->lo = h->plan;
    esp_err_t e = lo_lock(a);
    bool ok = e == ESP_OK;
    if (!ok) {                                    // will not lock there: back to the channel we had
        a->lo = old;
        e = lo_lock(a);
        a->faults |= TX_F_HOP_FAIL;
        a->hops_failed++;
    } else a->cur_khz = h->khz;
    if (e == ESP_OK) e = rf_on(a);
    if (e != ESP_OK) a->faults |= TX_F_RECOVER_FAIL;    // RF stays off; the health check keeps trying
    a->hops++;
    h->pending = false;
    a->done_valid = true; a->done_seq = h->seq; a->done_khz = h->khz; a->done_ok = ok;
    announce(a);
    if (ok && a->b->on_channel) a->b->on_channel(a->b->ctx, a->cur_khz);
    if (ok) a->key_at_us = a->b->now_us(a->b->ctx) + 1000ll * a->c.hop_key_delay_ms;
    logf_(a, ok ? 'I' : 'E', "hop %u: %s %lu kHz (%s)", h->seq, ok ? "on air at" : "no lock at",
          (unsigned long)h->khz, e == ESP_OK ? (ok ? "LO locked" : "back on the old channel") : "RF off");
    fc_reply(a, "DONE,%u,%lu,%s", h->seq, (unsigned long)h->khz, ok ? "OK" : "FAIL");
}

static void fc_poll(tx_app_t *a)
{
    if (!a->b->fc_read) return;
    uint8_t buf[64];
    size_t n = a->b->fc_read(a->b->ctx, buf, sizeof buf);
    for (size_t i = 0; i < n; i++) {
        fc_cmd_t cmd;
        if (fc_rx_byte(&a->fc, buf[i], &cmd)) tx_fc_command(a, &cmd);
    }
}

esp_err_t tx_bringup(tx_app_t *a, const tx_board_t *b, const tx_config_t *c)
{
    memset(a, 0, sizeof *a);
    a->b = b;
    a->c = *c;
    if (!a->c.health_ms) a->c.health_ms = 100;
    if (!a->c.lo_min_hz) a->c.lo_min_hz = 1243500000ull;
    if (!a->c.lo_max_hz) a->c.lo_max_hz = 1296500000ull;
    if (!a->c.hop_lead_ms) a->c.hop_lead_ms = 500;
    if (!a->c.hop_key_delay_ms) a->c.hop_key_delay_ms = 250;
    a->dac = (ad9116_t){ .bus = b->setup, .dev = 0, .set_reset = dac_reset, .reset_ctx = a };
    a->mod = (adrf6755_t){ .bus = b->setup, .dev = 1 };
    // RF off and DAC in SPI mode (RESET/PINMD low) before anything is clocked.
    b->gpio_set(b->ctx, TX_PIN_TXDIS, true);
    b->gpio_set(b->ctx, TX_PIN_DAC_RESET, false);

    // 1. Clocks.
    esp_err_t e = si5351_start(b->i2c, c->xtal_hz, c->xtal_load_pf, 192000000ull, 7, 2, &a->clk);
    if (e != ESP_OK) { logf_(a, 'E', "Si5351A: 0x%x", (unsigned)e); return e; }
    logf_(a, 'I', "CLK0/CLK1 %.3f Hz (VCO %.0f Hz, MS %lu)", a->clk.out_hz, a->clk.vco_hz,
          (unsigned long)a->clk.ms_div);

    // 2. FPGA.
    TRY(fpga_load(a));

    // 3. Setup bus: ADRF6755 into SPI mode before any other traffic, then the DAC.
    TRY(adrf6755_lock_spi(&a->mod));
    e = ad9116_init(&a->dac, true, &a->dac_version);
    if (e != ESP_OK) { logf_(a, 'E', "AD9116 init: 0x%x", (unsigned)e); return e; }
    logf_(a, 'I', "AD9116 version %02x, retimer locked", a->dac_version);

    // 4. LO.
    if (!in_band(a, c->lo_hz)) {
        logf_(a, 'E', "carrier %llu Hz outside %llu..%llu Hz", (unsigned long long)c->lo_hz,
              (unsigned long long)a->c.lo_min_hz, (unsigned long long)a->c.lo_max_hz);
        return ESP_ERR_INVALID_ARG;
    }
    if (!adrf6755_plan_tol(c->refin_hz, c->refin_tol_ppm, c->lo_hz, &a->lo)) {
        logf_(a, 'E', "no ADRF6755 plan for %llu Hz from %lu Hz", (unsigned long long)c->lo_hz,
              (unsigned long)c->refin_hz);
        return ESP_ERR_INVALID_ARG;
    }
    TRY(lo_lock(a));
    logf_(a, 'I', "ADRF6755 locked: LO %.1f Hz (PFD %lu, INT %u, FRAC %lu, RFDIV %u)", a->lo.lo_hz,
          (unsigned long)a->lo.pfd_hz, a->lo.intg, (unsigned long)a->lo.frac, a->lo.rfdiv);

    // 5. Stream: the mux runs at the rate of exactly the mode CTRL sets.
    a->ctrl = DVBT_CTRL_MOD(c->mod) | DVBT_CTRL_RATE(c->rate) | DVBT_CTRL_GUARD(c->guard);  // two's complement
    ts_mux_config_t mc = {
        .tsid = 1, .onid = 1, .program = 1, .pmt_pid = 0x1000, .video_pid = 0x100,
        .provider = c->provider, .service = c->service, .hop_pid = TX_HOP_PID,
        .buf = c->mux_buf, .buf_size = c->mux_buf_size,
    };
    ts_dvbt_rate(c->bw_mhz, c->mod, c->rate, c->guard, &mc.rate_num, &mc.rate_den);
    ts_mux_init(&a->mux, &mc);
    a->cur_khz = (uint32_t)(c->lo_hz / 1000);
    announce(a);
    // A packet stamped t reaches the air once the FIFO ahead of it has drained.
    a->latency27 = a->c.hop_latency_us ? (uint64_t)a->c.hop_latency_us * 27
                 : (uint64_t)TX_FPGA_FIFO_BYTES * 8 * 27000000ull * mc.rate_den / mc.rate_num;
    ts_mux_next(&a->mux, a->pkts);
    TRY(stream_start(a));
    TRY(rf_on(a));
    logf_(a, 'I', "transmitting at %.3f MHz, %.0f bit/s", a->lo.lo_hz / 1e6,
          (double)mc.rate_num / (double)mc.rate_den);
    a->next_health_us = b->now_us(b->ctx) + 1000ll * a->c.health_ms;
    return ESP_OK;
}

esp_err_t tx_pump(tx_app_t *a)
{
    lock(a, true);
    ts_mux_next(&a->mux, a->pkts + TS_PKT);
    lock(a, false);
    // DREQ comes every ~0.4 ms; waiting longer than a health period means
    // the FPGA is not taking data (lost, or stalled): check at once rather
    // than leave the RF on for a long timeout.
    uint8_t sb = 0;
    esp_err_t e = fpga_ts_send(a->b->link, a->pkts, 2, a->c.health_ms, &sb);
    if (e == ESP_ERR_TIMEOUT) {
        tx_health(a);
        a->next_health_us = a->b->now_us(a->b->ctx) + 1000ll * a->c.health_ms;
        return e;
    }
    if (e == ESP_OK && a->b->on_sent) a->b->on_sent(a->b->ctx, a->pkts, 2);
    lock(a, true);
    ts_mux_next(&a->mux, a->pkts);
    lock(a, false);
    a->pumped += 2;
    fc_poll(a);
    if (a->hop.pending && ts_mux_now_27(&a->mux) >= a->hop.t27 + a->latency27) hop_now(a);
    if (a->key_at_us && a->b->now_us(a->b->ctx) >= a->key_at_us) {
        a->key_at_us = 0;
        if (a->b->keyframe) a->b->keyframe(a->b->ctx);
    }
    if (a->b->now_us(a->b->ctx) >= a->next_health_us) {
        tx_health(a);
        a->next_health_us = a->b->now_us(a->b->ctx) + 1000ll * a->c.health_ms;
    }
    if (e != ESP_OK) logf_(a, 'E', "TS send: 0x%x", (unsigned)e);
    return e;
}

bool tx_put_frame(tx_app_t *a, const uint8_t *au, size_t n, bool key, int64_t capture_us)
{
    lock(a, true);
    int64_t age_us = a->b->now_us(a->b->ctx) - capture_us;
    uint64_t age_90k = age_us > 0 ? (uint64_t)age_us * 9 / 100 : 0;
    uint64_t pts = ts_mux_now_90k(&a->mux) + a->c.video_delay_ms * 90ull - age_90k;
    bool ok = ts_mux_put(&a->mux, au, n, pts, key);
    a->frames++;
    if (!ok) a->frames_dropped++;
    lock(a, false);
    return ok;
}

static esp_err_t recover_fpga(tx_app_t *a)
{
    TRY(fpga_load(a));
    // The DAC's DCLKIO stopped while the FPGA was down: re-sync its retimer.
    TRY(ad9116_init(&a->dac, true, &a->dac_version));
    TRY(stream_start(a));
    return ESP_OK;
}

uint32_t tx_health(tx_app_t *a)
{
    const tx_board_t *b = a->b;
    uint32_t f = 0, st = 0, id = 0;
    bool lost = fpga_link_check(b->link, &id) != ESP_OK;
    if (lost) {
        f |= TX_F_FPGA_LOST;
    } else if (fpga_reg_read(b->link, DVBT_REG_STATUS, &st) == ESP_OK) {
        a->last_status = st;
        if (st & DVBT_ST_UNDERFLOW) f |= TX_F_UNDERFLOW;
        if (st & DVBT_ST_ALIGN) f |= TX_F_ALIGN;
        if (st & DVBT_ST_TS_BAD) f |= TX_F_TS_BAD;
        if (st & DVBT_ST_TS_OVERFLOW) f |= TX_F_TS_OVERFLOW;
        if (DVBT_ST_NULLS(st)) {
            // The FPGA filled a gap with nulls: the channel is that many packets
            // ahead of the mux's clock. Catch the clock up, so PCRs (and the PTS
            // stamped from now on) match the air again.
            f |= TX_F_NULLS;
            a->nulls += DVBT_ST_NULLS(st);
            lock(a, true);
            ts_mux_skip(&a->mux, DVBT_ST_NULLS(st));
            lock(a, false);
        }
        if (st & (0xFu | 0xFFFF0000u))
            fpga_reg_write(b->link, DVBT_REG_STATUS, (st & 0xFu) | (DVBT_ST_NULLS(st) ? DVBT_ST_CLEAR_NULLS : 0));
    }
    if (!b->gpio_get(b->ctx, TX_PIN_LDET)) f |= TX_F_LO_UNLOCK;
    uint8_t cm = 0;
    if (!lost && ad9116_read(&a->dac, AD9116_CLKMODE, &cm) == ESP_OK && (cm & AD9116_CLKMODE_SEARCHING))
        f |= TX_F_DAC_UNLOCK;

    if (f & ~TX_F_NULLS)
        logf_(a, 'W', "health: faults %03lx (status %08lx, ID %08lx)", (unsigned long)f,
              (unsigned long)st, (unsigned long)id);
    if (f & (TX_F_FPGA_LOST | TX_F_LO_UNLOCK | TX_F_DAC_UNLOCK)) {
        tx_rf_off(a);
        esp_err_t e = ESP_OK;
        if (f & TX_F_FPGA_LOST) e = recover_fpga(a);
        else if (f & TX_F_DAC_UNLOCK) e = ad9116_init(&a->dac, true, &a->dac_version);
        if (e == ESP_OK && (f & TX_F_LO_UNLOCK)) e = lo_lock(a);
        if (e == ESP_OK) e = rf_on(a);
        a->recoveries++;
        if (e != ESP_OK) f |= TX_F_RECOVER_FAIL;
        logf_(a, e == ESP_OK ? 'W' : 'E', "recovery %lu: %s (0x%x)", (unsigned long)a->recoveries,
              e == ESP_OK ? "back on air" : "RF stays off", (unsigned)e);
    }
    a->faults |= f;
    return f;
}
