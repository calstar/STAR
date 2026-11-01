// End-to-end test harness: the ESP32-P4 firmware's application code
// (components/tx_app and every driver under it, compiled for the host)
// drives the FPGA's real top level (gateware/rtl, Verilated) and models of
// the Si5351A, ECP5 configuration port, AD9116 and ADRF6755 (models.h).
//
// Time is simulated, in femtoseconds, and owned here: each HAL call the
// firmware makes advances it -- an SPI frame clocks its bits into the RTL
// at the real SCK rate while the FPGA's clock runs alongside, a delay runs
// the clock for that long, a DREQ wait runs it until DREQ rises. The FPGA's
// clock is whatever the firmware programmed into the Si5351A, and only runs
// once the ECP5 model says the FPGA is configured.
//
// Outputs (in --out): rf.iq (int16 I, Q per DAC sample, zero while the RF
// is off), sent.ts (every packet the FPGA accepted), report.json.
#include <cinttypes>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "Vdvbt_tx_top.h"
#include "Vdvbt_tx_top___024root.h"
#include "verilated.h"
#include "models.h"
#ifdef E2E_TRACE
#include "verilated_vcd_c.h"
static VerilatedVcdC *g_vcd;
static void trace_dump(fs_t t) { if (g_vcd) g_vcd->dump((uint64_t)(t / 1000)); }   // ps
#else
static void trace_dump(fs_t) {}
#endif

extern "C" {
#include "tx_app.h"
#include "spi_bus_pack.h"
}

// --------------------------------------------------------------- options --
struct Opts {
    std::string out = ".", image, aus;
    double air_ms = 100;            // run this long after bring-up
    double health_ms = 10;
    double inject_ldet_ms = -1, inject_ldet_dur_ms = 1;
    double inject_fpga_ms = -1;
    double inject_stall_ms = -1, inject_stall_dur_ms = 5;
    double video_delay_ms = 400;
    double video_start_ms = 50;     // camera running this long after bring-up
    bool flash_ok = true;
    bool pll_broken = false;
    unsigned seed = 1;
    uint32_t good_crc = 0;
};
static Opts O;

// ------------------------------------------------------------------ world --
static Report R;
static std::unique_ptr<VerilatedContext> g_ctx;
static std::unique_ptr<Vdvbt_tx_top> g_top;
static fs_t g_now = 0;
static std::unique_ptr<Si5351> g_si;
static std::unique_ptr<Ecp5> g_ecp5;
static std::unique_ptr<Ad9116> g_dac;
static std::unique_ptr<Adrf6755> g_adrf;
static std::vector<uint8_t> g_part;         // the P4's "fpga" partition
static FILE *g_rf, *g_sent, *g_log;

// FPGA clock (Si5351A CLK0) and the 4 edges per period.
static bool g_running = false;
static double g_period_fs = 0;
static fs_t g_clk_t0 = 0;
static int64_t g_edge = 0;
static bool g_last_dclk = false;
static uint16_t g_last_d = 0;
static fs_t g_last_d_change = -1, g_last_latch = -1;

// statistics
static uint64_t n_rf_samples = 0, n_rf_unlocked_fs = 0, n_samples = 0, n_dac_off_rf = 0;
static fs_t g_rf_unlocked_since = -1, g_rf_unlocked_max = 0;
static fs_t g_first_rf = -1;
static int g_fpga_loads = 0;

static fs_t now_fs() { return g_now; }

static void new_fpga()
{
    g_top.reset(new Vdvbt_tx_top(g_ctx.get()));
#ifdef E2E_TRACE
    if (getenv("E2E_VCD")) {
        g_ctx->traceEverOn(true);
        g_vcd = new VerilatedVcdC;
        g_top->trace(g_vcd, 99);
        g_vcd->open(getenv("E2E_VCD"));
    }
#endif
    g_top->clk_in = 0;
    g_top->spi_sck = 0;
    g_top->spi_cs_n = 1;
    g_top->spi_mosi = 0;
    g_top->eval();
}

static void start_fpga_clock()
{
    double f = g_si->out_hz(g_now, 0);
    double fclk1 = g_si->out_hz(g_now, 1);
    char b[160];
    snprintf(b, sizeof b, "FPGA configured; CLK0 %.3f Hz, CLK1 %.3f Hz", f, fclk1);
    R.event(b);
    g_fpga_loads++;
    new_fpga();
    if (f <= 0) {
        R.violation("FPGA configured with no clock on Si5351A CLK0");
        g_running = false;
        return;
    }
    if (std::fabs(f - 192e6 / 7) > 192e6 / 7 * 1e-6)
        R.violation("FPGA clock " + std::to_string(f) + " Hz, not 27.428571 MHz (DVB-T 6 MHz needs 4 x 48/7)");
    g_period_fs = 1e15 / f;
    g_clk_t0 = g_now;
    g_edge = 0;
    g_running = true;
}

static void stop_fpga()
{
    g_running = false;
    g_top.reset();
    R.event("FPGA unconfigured: outputs high-impedance, logic stopped");
}

static fs_t edge_time(int64_t k) { return g_clk_t0 + (fs_t)llround(k * g_period_fs / 4); }

static void track_rf(int i, int q)
{
    bool rf = g_adrf->rf_out();
    bool locked = g_adrf->locked(g_now);
    int16_t s[2] = {0, 0};
    if (rf) {
        if (g_first_rf < 0) g_first_rf = g_now;
        if (!g_dac->output_on()) n_dac_off_rf++;
        else { s[0] = (int16_t)i; s[1] = (int16_t)q; }
        n_rf_samples++;
    }
    if (g_first_rf >= 0) fwrite(s, sizeof s, 1, g_rf);
    n_samples++;
    // RF emitted with the PLL unlocked: how long each time.
    if (rf && !locked) {
        if (g_rf_unlocked_since < 0) g_rf_unlocked_since = g_now;
        g_rf_unlocked_max = std::max(g_rf_unlocked_max, g_now - g_rf_unlocked_since);
    } else g_rf_unlocked_since = -1;
}

// One FPGA clock edge (k mod 4: clk rise, clk90 rise, clk fall, clk90 fall).
static void clock_edge()
{
    g_now = edge_time(g_edge);
    int ph = g_edge & 3;
    auto *root = g_top->rootp;
    if (ph == 0) g_top->clk_in = 1;
    else if (ph == 2) g_top->clk_in = 0;
    else root->dvbt_tx_top__DOT__u_pll__DOT__pll_i__DOT__clkos_sim = (ph == 1);
    g_top->eval();
    trace_dump(g_now);
    g_edge++;
    uint16_t d = g_top->dac_d;
    if (d != g_last_d) {
        if (g_last_latch == g_now) R.violation("AD9116 hold: DAC data changed on a DCLKIO edge");
        g_last_d = d;
        g_last_d_change = g_now;
    }
    bool dclk = g_top->dac_dclk;
    if (dclk != g_last_dclk) {
        g_last_dclk = dclk;
        if (g_last_d_change == g_now && g_dac->output_on())
            R.violation("AD9116 setup: DCLKIO edge in the same instant the data changed");
        g_last_latch = g_now;
        // CLKIN (Si5351A CLK1) at the DCLKIO rate: re-derived from the
        // registers every 4096 edges (they change only during bring-up).
        static bool clkin_ok = false;
        static int64_t clkin_at = -1;
        if (clkin_at < 0 || g_edge < clkin_at || g_edge - clkin_at > 4096) {
            double f0 = g_si->out_hz(g_now, 0), f1 = g_si->out_hz(g_now, 1);
            clkin_ok = f1 > 0 && std::fabs(f1 - f0) < 1;
            clkin_at = g_edge;
        }
        int i, q;
        if (g_dac->dclk_edge(dclk, d, clkin_ok, i, q)) track_rf(i, q);
    }
}

// Run simulated time forward to t.
static void advance(fs_t t)
{
    g_ecp5->tick(g_now);
    while (g_running && edge_time(g_edge) <= t) clock_edge();
    if (t > g_now) g_now = t;
    g_ecp5->tick(g_now);
    g_adrf->locked(g_now);
}

template <class F> static bool run_until(F pred, fs_t deadline)
{
    for (;;) {
        if (pred()) return true;
        if (!g_running) {
            // Nothing clocked: jump to the next model event or the deadline.
            fs_t next = deadline;
            if (g_ecp5->done_at >= 0 && g_ecp5->done_at < next) next = std::max(g_ecp5->done_at, g_now);
            if (g_ecp5->initn_at >= 0 && g_ecp5->initn_at < next) next = std::max(g_ecp5->initn_at, g_now);
            advance(next);
            if (next >= deadline) return pred();
            continue;
        }
        fs_t next = edge_time(g_edge);
        if (next > deadline) { advance(deadline); return pred(); }
        advance(next);
    }
}

// --------------------------------------------------------------- HAL: I2C --
static esp_err_t i2c_write(void *, uint8_t addr, const uint8_t *b, size_t n)
{
    advance(g_now + (fs_t)((n + 1) * 9 * 2.5 * FS_PER_US));      // 400 kHz
    return g_si->write(g_now, addr, b, n) ? ESP_FAIL : ESP_OK;
}
static esp_err_t i2c_write_read(void *, uint8_t addr, const uint8_t *w, size_t nw, uint8_t *r, size_t nr)
{
    advance(g_now + (fs_t)((nw + nr + 2) * 9 * 2.5 * FS_PER_US));
    return g_si->write_read(g_now, addr, w, nw, r, nr) ? ESP_FAIL : ESP_OK;
}
static void hal_delay_us(void *, uint32_t us) { advance(g_now + (fs_t)us * FS_PER_US); }
extern "C" void esp_rom_delay_us(unsigned us) { advance(g_now + (fs_t)us * FS_PER_US); }

// ------------------------------------------------------- HAL: ECP5 config --
static void e_set_cfg(void *, bool sspi)
{
    g_ecp5->cfg_driven = sspi;
    g_ecp5->cfg_val = sspi ? g_ecp5->sspi_code : 0;
}
static void e_programn(void *, bool high) { g_ecp5->set_programn(g_now, high); }
static bool e_initn(void *) { g_ecp5->tick(g_now); return g_ecp5->initn; }
static bool e_done(void *) { g_ecp5->tick(g_now); return g_ecp5->done; }
static void e_cs(void *, bool low) { g_ecp5->set_cs(low); }
static esp_err_t e_spi(void *, const uint8_t *tx, uint8_t *rx, size_t n)
{
    advance(g_now + (fs_t)(n * 8 * 50 * FS_PER_NS));             // 20 MHz CCLK
    g_ecp5->spi(tx, rx, n);
    return ESP_OK;
}
static esp_err_t e_read(void *, size_t off, uint8_t *buf, size_t n)
{
    for (size_t i = 0; i < n; i++) buf[i] = off + i < g_part.size() ? g_part[off + i] : 0xFF;
    return ESP_OK;
}

// ------------------------------------------------------- HAL: FPGA link --
static const fs_t SCK_HALF = 25 * FS_PER_NS;                     // 20 MHz
static bool miso()
{
    return g_running ? g_top->spi_miso : true;                   // unconfigured: floats (pulled high)
}
static void set_pins(int cs_n, int sck, int mosi)
{
    if (!g_running) return;
    g_top->spi_cs_n = cs_n;
    g_top->spi_sck = sck;
    g_top->spi_mosi = mosi;
    g_top->eval();
    trace_dump(g_now);
}
static esp_err_t link_frame(void *, const uint8_t *tx, uint8_t *rx, size_t n)
{
    set_pins(0, 0, 0);
    advance(g_now + 4 * SCK_HALF);                               // cs_ena_pretrans = 2
    for (size_t i = 0; i < n; i++) {
        uint8_t in = 0;
        for (int b = 7; b >= 0; b--) {
            set_pins(0, 0, (tx[i] >> b) & 1);
            advance(g_now + SCK_HALF);
            set_pins(0, 1, (tx[i] >> b) & 1);
            in = (in << 1) | miso();                             // mode 0: sample on the rising edge
            advance(g_now + SCK_HALF);
        }
        rx[i] = in;
    }
    set_pins(0, 0, 0);
    advance(g_now + 4 * SCK_HALF);                               // cs_ena_posttrans = 2
    set_pins(1, 0, 0);
    if (getenv("E2E_DEBUG_LINK") && n < 16) {
        fprintf(stderr, "link %s:", g_running ? "up" : "down");
        for (size_t i = 0; i < n; i++) fprintf(stderr, " %02x/%02x", tx[i], rx[i]);
        fprintf(stderr, " dreq=%d\n", g_running ? (int)g_top->dreq : -1);
    }
    advance(g_now + 1500 * FS_PER_NS);                           // driver overhead between frames
    return ESP_OK;
}
static bool link_dreq(void *, uint32_t timeout_ms)
{
    return run_until([] { return g_running && g_top->dreq; }, g_now + (fs_t)timeout_ms * 1000 * FS_PER_US);
}

// ------------------------------------------------------- HAL: setup bus --
// As spi_bus_esp does it: spi_bus_pack (the firmware's own code) makes the
// frame, the bits go out MSB first at 10 MHz with a GPIO chip select.
static const fs_t SETUP_HALF = 50 * FS_PER_NS;
static esp_err_t setup_xfer(void *, int dev, int nbits, bool three_wire, int wr_bits, uint32_t tx, uint32_t *rxp)
{
    if (dev < 0 || dev > 1 || nbits < 1 || nbits > 32) return ESP_ERR_INVALID_ARG;
    spi_bus_frame_t f;
    spi_bus_pack(nbits, three_wire, wr_bits, tx, &f);
    uint8_t rxb[4] = {0, 0, 0, 0};
    auto cs = [&](bool low) {
        if (dev == 0) g_dac->set_cs(low); else g_adrf->set_cs(g_now, low);
    };
    cs(true);
    advance(g_now + SETUP_HALF);
    int total = f.tx_bits + (three_wire ? f.rx_bits : 0);
    for (int k = 0; k < total; k++) {
        bool writing = k < f.tx_bits;
        bool out = writing ? (f.tx[k / 8] >> (7 - k % 8)) & 1 : false;
        advance(g_now + SETUP_HALF);
        g_adrf->bus_clock(dev == 1);
        // the line: the master's bit while writing; the AD9116's while it reads back
        bool line = writing ? out : (dev == 0 ? g_dac->sdio_out() : true);
        bool sdo = g_adrf->sdo();
        if (dev == 0) g_dac->clk_rise(line);
        else g_adrf->clk_rise(line);
        int rbit = -1;
        if (three_wire && !writing) rbit = k - f.tx_bits;
        else if (!three_wire && f.rx_bits) rbit = k;
        if (rbit >= 0 && ((three_wire ? line : sdo)))
            rxb[rbit / 8] |= 0x80 >> (rbit % 8);
        advance(g_now + SETUP_HALF);
    }
    advance(g_now + SETUP_HALF);
    cs(false);
    advance(g_now + SETUP_HALF);
    if (rxp) *rxp = spi_bus_unpack(&f, rxb);
    return ESP_OK;
}
static esp_err_t setup_cs_pulse(void *, int dev)
{
    auto cs = [&](bool low) { if (dev == 0) g_dac->set_cs(low); else g_adrf->set_cs(g_now, low); };
    cs(true);
    advance(g_now + FS_PER_US);
    cs(false);
    advance(g_now + FS_PER_US);
    return ESP_OK;
}

// -------------------------------------------------------------- HAL: GPIO --
static void gpio_set(void *, tx_pin_t p, bool v)
{
    if (p == TX_PIN_TXDIS) {
        if (g_adrf->txdis != v) R.event(v ? "TXDIS high (RF off)" : "TXDIS low (RF on)");
        g_adrf->txdis = v;
    } else if (p == TX_PIN_DAC_RESET) g_dac->set_reset(g_now, v);
}
static bool gpio_get(void *, tx_pin_t p)
{
    if (p == TX_PIN_LDET) return g_adrf->locked(g_now);
    return false;
}
static int64_t now_us(void *) { return g_now / FS_PER_US; }
static void log_cb(void *, char lvl, const char *m)
{
    fprintf(g_log, "[%.6f] %c %s\n", g_now / 1e15, lvl, m);
    fprintf(stderr, "[%.6f] %c %s\n", g_now / 1e15, lvl, m);
    if (lvl == 'E') R.event(std::string("firmware error: ") + m);
}
static uint64_t g_sent_pkts = 0;
static void on_sent(void *, const uint8_t *pkts, size_t n)
{
    fwrite(pkts, 188, n, g_sent);
    g_sent_pkts += n;
}

// ------------------------------------------------------------------ video --
struct Au { std::vector<uint8_t> d; bool key; };
static std::vector<Au> load_aus(const std::string &path)
{
    std::vector<Au> v;
    if (path.empty()) return v;
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) { perror(path.c_str()); exit(2); }
    for (;;) {
        uint32_t n;
        uint8_t k;
        if (fread(&n, 4, 1, f) != 1 || fread(&k, 1, 1, f) != 1) break;
        Au a;
        a.d.resize(n);
        a.key = k;
        if (fread(a.d.data(), 1, n, f) != n) break;
        v.push_back(std::move(a));
    }
    fclose(f);
    return v;
}

// ------------------------------------------------------------------- main --
static void usage()
{
    fprintf(stderr, "e2e --out DIR [--image FILE] [--good-crc HEX] [--aus FILE] [--video-start-ms N] [--air-ms N]\n"
                    "    [--health-ms N]\n"
                    "    [--no-flash] [--inject-ldet MS[,DUR]] [--inject-fpga MS] [--inject-stall MS[,DUR]] [--seed N]\n");
    exit(2);
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto val = [&]() -> std::string { if (i + 1 >= argc) usage(); return argv[++i]; };
        if (a == "--out") O.out = val();
        else if (a == "--image") O.image = val();
        else if (a == "--good-crc") O.good_crc = strtoul(val().c_str(), nullptr, 16);
        else if (a == "--aus") O.aus = val();
        else if (a == "--air-ms") O.air_ms = atof(val().c_str());
        else if (a == "--health-ms") O.health_ms = atof(val().c_str());
        else if (a == "--no-flash") O.flash_ok = false;
        else if (a == "--pll-broken") O.pll_broken = true;
        else if (a == "--seed") O.seed = atoi(val().c_str());
        else if (a == "--video-start-ms") O.video_start_ms = atof(val().c_str());
        else if (a == "--inject-ldet") { std::string v = val(); O.inject_ldet_ms = atof(v.c_str());
            if (v.find(',') != std::string::npos) O.inject_ldet_dur_ms = atof(v.c_str() + v.find(',') + 1); }
        else if (a == "--inject-fpga") O.inject_fpga_ms = atof(val().c_str());
        else if (a == "--inject-stall") { std::string v = val(); O.inject_stall_ms = atof(v.c_str());
            if (v.find(',') != std::string::npos) O.inject_stall_dur_ms = atof(v.c_str() + v.find(',') + 1); }
        else usage();
    }
    R.now = now_fs;
    g_ctx.reset(new VerilatedContext);
    // RTL state without an initialiser starts at 0, as the ECP5's global
    // set/reset leaves every flip-flop and BRAM after configuration
    // (build.py: --x-initial 0); explicit X assignments are randomised.
    std::string seedarg = "+verilator+seed+" + std::to_string(O.seed);
    const char *vargs[] = {"e2e", seedarg.c_str()};
    g_ctx->commandArgs(2, vargs);
    g_rf = fopen((O.out + "/rf.iq").c_str(), "wb");
    g_sent = fopen((O.out + "/sent.ts").c_str(), "wb");
    g_log = fopen((O.out + "/firmware.log").c_str(), "w");
    if (!g_rf || !g_sent || !g_log) { perror("output"); return 2; }

    if (!O.image.empty()) {
        FILE *f = fopen(O.image.c_str(), "rb");
        if (!f) { perror(O.image.c_str()); return 2; }
        uint8_t b[65536];
        size_t n;
        while ((n = fread(b, 1, sizeof b, f)) > 0) g_part.insert(g_part.end(), b, b + n);
        fclose(f);
    }
    g_part.resize(0x100000, 0xFF);                               // erased flash beyond the image
    g_si.reset(new Si5351(R, 25e6));
    g_ecp5.reset(new Ecp5(R, O.good_crc));
    g_ecp5->flash_ok = O.flash_ok;
    g_ecp5->on_configured = start_fpga_clock;
    g_ecp5->on_cleared = stop_fpga;
    g_dac.reset(new Ad9116(R));
    g_adrf.reset(new Adrf6755(R, 40e6));
    g_adrf->broken = O.pll_broken;
    std::vector<Au> aus = load_aus(O.aus);

    i2c_bus_if_t i2c = {i2c_write, i2c_write_read, hal_delay_us, nullptr};
    ecp5_hal_t ecp5 = {nullptr, e_set_cfg, e_programn, e_initn, e_done, e_cs, e_spi, e_read, hal_delay_us};
    static uint8_t ltx[FPGA_FRAME_MAX], lrx[FPGA_FRAME_MAX];
    fpga_link_t link = {link_frame, link_dreq, nullptr, ltx, lrx};
    spi_bus_if_t setup = {setup_xfer, setup_cs_pulse, nullptr};
    tx_board_t board = {};
    board.i2c = &i2c;
    board.ecp5 = &ecp5;
    board.fpga_part_size = g_part.size();
    board.link = &link;
    board.setup = &setup;
    board.gpio_set = gpio_set;
    board.gpio_get = gpio_get;
    board.now_us = now_us;
    board.delay_us = hal_delay_us;
    board.log = log_cb;
    board.on_sent = on_sent;
    static uint8_t muxbuf[256 * 1024];
    tx_config_t cfg = {};
    cfg.xtal_hz = 25000000;
    cfg.xtal_load_pf = 8;
    cfg.refin_hz = 40000000;
    cfg.lo_hz = 1279000000ull;
    cfg.atten_db = 0;
    cfg.bw_mhz = 6;
    cfg.mod = 0;
    cfg.rate = 0;
    cfg.guard = 2;
    cfg.provider = "STAR";
    cfg.service = "N0CALL";
    cfg.video_delay_ms = (uint32_t)O.video_delay_ms;
    cfg.mux_buf = muxbuf;
    cfg.mux_buf_size = sizeof muxbuf;
    cfg.health_ms = (uint32_t)O.health_ms;

    static tx_app_t app;
    // The P4 boots ~0.3 s after power-up (ROM, bootloader, app start).
    advance(300 * 1000 * FS_PER_US);
    esp_err_t e = tx_bringup(&app, &board, &cfg);
    fs_t t_up = g_now;
    char b[200];
    snprintf(b, sizeof b, "bring-up returned 0x%x after %.3f ms", (unsigned)e, (t_up - 300e12) / 1e12);
    R.event(b);

    fs_t t_end = t_up + (fs_t)(O.air_ms * 1000 * FS_PER_US);
    size_t next_au = 0;
    const fs_t frame_fs = (fs_t)(1e15 / 30), enc_latency = 40 * 1000 * FS_PER_US;
    fs_t video_t0 = t_up + (fs_t)(O.video_start_ms * 1e12);     // camera starts after bring-up
    bool ldet_done = false, fpga_done = false, stall_done = false;
    uint64_t frames_put = 0, frames_dropped = 0;
    while (e == ESP_OK && g_now < t_end) {
        // Encoded frames: frame k captured at video_t0 + k/30 s, ready 40 ms later.
        while (next_au < aus.size() && g_now >= video_t0 + (fs_t)next_au * frame_fs + enc_latency) {
            fs_t cap = video_t0 + (fs_t)next_au * frame_fs;
            if (!tx_put_frame(&app, aus[next_au].d.data(), aus[next_au].d.size(), aus[next_au].key, cap / FS_PER_US))
                frames_dropped++;
            frames_put++;
            next_au++;
        }
        fs_t rel = g_now - t_up;
        if (!ldet_done && O.inject_ldet_ms >= 0 && rel >= (fs_t)(O.inject_ldet_ms * 1e12)) {
            g_adrf->force_unlock(g_now);
            ldet_done = true;
        }
        if (!fpga_done && O.inject_fpga_ms >= 0 && rel >= (fs_t)(O.inject_fpga_ms * 1e12)) {
            R.event("injected: FPGA loses its configuration");
            g_ecp5->done = false;
            g_ecp5->state = "unconfigured";
            stop_fpga();
            fpga_done = true;
        }
        if (!stall_done && O.inject_stall_ms >= 0 && rel >= (fs_t)(O.inject_stall_ms * 1e12)) {
            R.event("injected: the P4 stalls (no TS sent)");
            advance(g_now + (fs_t)(O.inject_stall_dur_ms * 1e12));
            stall_done = true;
        }
        tx_pump(&app);
    }
#ifdef E2E_TRACE
    if (g_vcd) g_vcd->close();
#endif
    fclose(g_rf);
    fclose(g_sent);
    fclose(g_log);

    FILE *j = fopen((O.out + "/report.json").c_str(), "w");
    auto jstr = [&](const std::string &s) {
        std::string o = "\"";
        for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; }
        return o + "\"";
    };
    fprintf(j, "{\n \"bringup_err\": %d,\n \"t_bringup_s\": %.9f,\n \"t_end_s\": %.9f,\n", (int)e, t_up / 1e15, g_now / 1e15);
    fprintf(j, " \"t_first_rf_s\": %.9f,\n", g_first_rf / 1e15);
    fprintf(j, " \"clk0_hz\": %.6f,\n \"clk1_hz\": %.6f,\n", g_si->out_hz(g_now, 0), g_si->out_hz(g_now, 1));
    fprintf(j, " \"lo_hz\": %.6f,\n \"vco_hz\": %.3f,\n \"pfd_hz\": %.3f,\n", g_adrf->lo_hz, g_adrf->vco_hz, g_adrf->pfd_hz);
    fprintf(j, " \"dac_twos\": %d,\n \"dac_irising\": %d,\n \"dac_ifirst\": %d,\n \"dac_searching\": %d,\n",
            g_dac->twos(), g_dac->irising(), g_dac->ifirst(), g_dac->searching);
    fprintf(j, " \"fpga_via\": %d,\n \"fpga_sspi_err\": %d,\n \"fpga_loads\": %d,\n", (int)app.fpga.via,
            (int)app.fpga.sspi_err, g_fpga_loads);
    fprintf(j, " \"faults\": %u,\n \"recoveries\": %u,\n \"nulls\": %" PRIu64 ",\n", app.faults, app.recoveries, app.nulls);
    fprintf(j, " \"frames_put\": %" PRIu64 ",\n \"frames_dropped\": %" PRIu64 ",\n", frames_put, frames_dropped);
    fprintf(j, " \"packets_sent\": %" PRIu64 ",\n \"dac_samples\": %" PRIu64 ",\n \"rf_samples\": %" PRIu64 ",\n",
            g_sent_pkts, n_samples, n_rf_samples);
    fprintf(j, " \"rf_while_dac_off\": %" PRIu64 ",\n \"rf_unlocked_max_s\": %.9f,\n", n_dac_off_rf, g_rf_unlocked_max / 1e15);
    fprintf(j, " \"dac_rate_hz\": %.6f,\n", g_period_fs > 0 ? 1e15 / g_period_fs : 0.0);
    fprintf(j, " \"violations\": [");
    for (size_t i = 0; i < R.violations.size(); i++) fprintf(j, "%s\n  %s", i ? "," : "", jstr(R.violations[i]).c_str());
    fprintf(j, "],\n \"events\": [");
    for (size_t i = 0; i < R.events.size(); i++) fprintf(j, "%s\n  %s", i ? "," : "", jstr(R.events[i]).c_str());
    fprintf(j, "]\n}\n");
    fclose(j);
    fprintf(stderr, "e2e: done at %.6f s, %" PRIu64 " packets, %zu violations\n", g_now / 1e15, g_sent_pkts,
            R.violations.size());
    return 0;
}
