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

esp_err_t tx_bringup(tx_app_t *a, const tx_board_t *b, const tx_config_t *c)
{
    memset(a, 0, sizeof *a);
    a->b = b;
    a->c = *c;
    if (!a->c.health_ms) a->c.health_ms = 100;
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
    if (!adrf6755_plan(c->refin_hz, c->lo_hz, &a->lo)) {
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
        .provider = c->provider, .service = c->service,
        .buf = c->mux_buf, .buf_size = c->mux_buf_size,
    };
    ts_dvbt_rate(c->bw_mhz, c->mod, c->rate, c->guard, &mc.rate_num, &mc.rate_den);
    ts_mux_init(&a->mux, &mc);
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
            f |= TX_F_NULLS;
            a->nulls += DVBT_ST_NULLS(st);
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
