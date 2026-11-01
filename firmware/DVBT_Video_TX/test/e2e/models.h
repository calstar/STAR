// Chip models for the end-to-end test, written from the datasheets (not from
// the firmware's drivers), strict about protocol, and loud: every rule the
// firmware breaks becomes a violation in the run report.
//
//   Si5351A   Skyworks/Silicon Labs AN619 register map: the output frequency
//             is decoded from the PLL and multisynth registers, so the FPGA
//             and DAC clocks in the simulation are what the firmware programs.
//   ECP5      sysCONFIG slave SPI (the opcodes ecpprog and openFPGALoader use)
//             and master-SPI boot from the W25Q32.
//   AD9116    Rev. F: 3-wire SPI (instruction byte, MSB first), RESET/PINMD,
//             DATA_CTRL (TWOS/IFIRST/IRISING/DCI_EN), the retimer's 128-cycle
//             search, and the DDR data latch on DCLKIO edges.
//   ADRF6755  Rev. B: I2C power-up mode and the SPI lock on the third CS
//             rising edge, 24-bit writes / 16+16-bit reads, every "set to"
//             bit, double buffering on CR0, Equations 1-3 and Table 6, the
//             VCO range, LDET, TXDIS and the modulator power bit.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

typedef int64_t fs_t;                       // femtoseconds
static const fs_t FS_PER_US = 1000000000LL;
static const fs_t FS_PER_NS = 1000000LL;

struct Report {
    std::vector<std::string> violations;
    std::vector<std::string> events;
    std::function<fs_t()> now;
    void violation(const std::string &s)
    {
        char b[64];
        snprintf(b, sizeof b, "[%.6f s] ", now ? now() / 1e15 : 0.0);
        if (violations.size() < 200) violations.push_back(b + s);
        fprintf(stderr, "VIOLATION %s%s\n", b, s.c_str());
    }
    void event(const std::string &s)
    {
        char b[64];
        snprintf(b, sizeof b, "[%.6f s] ", now ? now() / 1e15 : 0.0);
        events.push_back(b + s);
    }
};

// ---------------------------------------------------------------- Si5351A --
struct Si5351 {
    Report &rep;
    uint8_t reg[256] = {};
    double xtal_hz;
    fs_t por_done, pll_lock_at = -1;
    bool pll_reset_seen = false, params_written = false;
    Si5351(Report &r, double xtal) : rep(r), xtal_hz(xtal)
    {
        por_done = 2 * 1000 * FS_PER_US;    // SYS_INIT clears ~2 ms after power-up
        for (int i = 16; i <= 23; i++) reg[i] = 0x80;
        reg[3] = 0xFF;
    }
    int write(fs_t t, uint8_t addr, const uint8_t *b, size_t n)
    {
        if (addr != 0x60) return -1;        // NACK
        if (n < 1) return 0;
        if (t < por_done) rep.violation("Si5351A written before SYS_INIT cleared");
        uint8_t r = b[0];
        for (size_t i = 1; i < n; i++, r++) {
            reg[r] = b[i];
            if (r >= 26 && r <= 33) params_written = true;
            if (r == 177 && (b[i] & 0x20)) {
                if (!params_written) rep.violation("Si5351A PLLA reset before its parameters were written");
                pll_lock_at = t + 1000 * FS_PER_US / 2;   // PLL settles
                pll_reset_seen = true;
            }
            if (r == 183 && (b[i] & 0x3F) != 0x12)
                rep.violation("Si5351A reg 183: bits 5:0 must be 010010b (AN619)");
        }
        return 0;
    }
    int write_read(fs_t t, uint8_t addr, const uint8_t *w, size_t nw, uint8_t *r, size_t nr)
    {
        if (addr != 0x60) return -1;
        if (nw != 1) return -1;
        for (size_t i = 0; i < nr; i++) {
            uint8_t a = w[0] + i;
            uint8_t v = reg[a];
            if (a == 0) v = (t < por_done ? 0x80 : 0) | (pll_locked(t) ? 0 : 0x20);
            r[i] = v;
        }
        return 0;
    }
    bool pll_locked(fs_t t) const { return pll_reset_seen && t >= pll_lock_at; }
    static void decode(const uint8_t *p, uint32_t &p1, uint32_t &p2, uint32_t &p3)
    {
        p3 = ((uint32_t)(p[5] >> 4) << 16) | ((uint32_t)p[0] << 8) | p[1];
        p1 = ((uint32_t)(p[2] & 3) << 16) | ((uint32_t)p[3] << 8) | p[4];
        p2 = ((uint32_t)(p[5] & 0xF) << 16) | ((uint32_t)p[6] << 8) | p[7];
    }
    double vco() const
    {
        uint32_t p1, p2, p3;
        decode(&reg[26], p1, p2, p3);
        if (!p3) return 0;
        double m = (p1 + 512.0 + (double)p2 / p3) / 128.0;    // a + b/c
        return xtal_hz * m;
    }
    // Output n's frequency, 0 if it is off or invalid.
    double out_hz(fs_t t, int n) const
    {
        uint8_t ctl = reg[16 + n];
        if (ctl & 0x80) return 0;                       // powered down
        if (reg[3] & (1 << n)) return 0;                // output disabled (OEB)
        if (((ctl >> 2) & 3) != 3) return 0;            // not from its multisynth
        if (ctl & 0x20) return 0;                       // from PLLB: not configured
        if (!pll_locked(t)) return 0;
        double v = vco();
        if (v < 600e6 || v > 900e6) return 0;
        uint32_t p1, p2, p3;
        decode(&reg[42 + 8 * n], p1, p2, p3);
        if (!p3) return 0;
        double div = (p1 + 512.0 + (double)p2 / p3) / 128.0;
        if (div < 8 || div > 2048) return 0;
        if ((ctl & 0x40) && (p2 != 0 || std::fmod(div, 2.0) != 0)) return 0;  // integer mode needs an even integer
        int r = (reg[42 + 8 * n + 2] >> 4) & 7;
        return v / div / (1 << r);
    }
};

// ------------------------------------------------------------------- ECP5 --
struct Ecp5 {
    Report &rep;
    uint32_t idcode = 0x41111043;
    uint32_t good_crc;                  // CRC-32 of the valid bitstream (also in the W25Q32)
    bool flash_ok = true;
    int sspi_code = 0;                  // CFG[1:0] for slave SPI (to confirm in TN1260)
    bool cfg_driven = false;            // P4 drives CFG (else the straps: master SPI)
    int cfg_val = 0;
    bool programn = true, cs = false, initn = false, done = false;
    fs_t initn_at = -1, done_at = -1;
    std::string state = "unconfigured";
    std::vector<uint8_t> frame, loaded;
    std::function<void()> on_configured, on_cleared;
    bool warned_user = false, bad_bits = false;
    Ecp5(Report &r, uint32_t crc) : rep(r), good_crc(crc) {}

    bool sspi() const { return cfg_driven && cfg_val == sspi_code; }
    void tick(fs_t t)
    {
        if (initn_at >= 0 && t >= initn_at) { initn = true; initn_at = -1; }
        if (done_at >= 0 && t >= done_at) {
            done_at = -1;
            if (!done) { done = true; state = "user"; if (on_configured) on_configured(); }
        }
    }
    void set_programn(fs_t t, bool high)
    {
        if (programn && !high) {
            bool was = done;
            initn = done = false;
            initn_at = done_at = -1;
            bad_bits = warned_user = false;
            state = "reset";
            loaded.clear();
            if (was && on_cleared) on_cleared();
        }
        if (!programn && high) {
            if (sspi()) {
                initn_at = t + 50 * FS_PER_US;
                state = "wait_cmd";
            } else {
                if (cfg_driven) rep.violation("ECP5 PROGRAMN released with CFG driven to a non-slave-SPI code");
                initn_at = t + 50 * FS_PER_US;
                state = flash_ok ? "flash" : "flash_failed";
                if (flash_ok) done_at = t + 40 * 1000 * FS_PER_US;   // ~40 ms from the W25Q32
                rep.event("ECP5 master-SPI boot from the W25Q32");
            }
        }
        programn = high;
    }
    void set_cs(bool low)
    {
        if (low && !cs) frame.clear();
        if (!low && cs) end_frame();
        cs = low;
    }
    void spi(const uint8_t *tx, uint8_t *rx, size_t n)
    {
        if (state == "user") {
            // Woken up: the slave-SPI port is released (no persistence in the
            // bitstream). Commands go nowhere; MISO floats high.
            if (!warned_user) { rep.event("ECP5 slave-SPI traffic after wake-up: ignored, reads 0xFF"); warned_user = true; }
            if (rx) for (size_t i = 0; i < n; i++) rx[i] = 0xFF;
            return;
        }
        if (!cs) rep.violation("ECP5 SPI bytes with SN high");
        if (!sspi()) rep.violation("ECP5 slave-SPI traffic while CFG does not select slave SPI");
        size_t start = frame.size();
        if (frame.size() < 64) frame.insert(frame.end(), tx, tx + n);
        else if (state == "crc" || state == "burst") {          // the burst: keep everything
            frame.insert(frame.end(), tx, tx + n);
        }
        if (rx) {
            uint32_t val = 0;
            bool any = false;
            if (!frame.empty() && frame[0] == 0xE0) { val = idcode; any = true; }
            if (!frame.empty() && frame[0] == 0x3C) {
                // DONE (bit 8) only once woken; FAIL (bit 13) when the loaded bitstream is bad.
                val = (done ? 1u << 8 : 0) | (state == "enabled" ? 1u << 9 : 0) | (bad_bits ? 1u << 13 : 0);
                any = true;
            }
            for (size_t i = 0; i < n; i++) {
                long k = (long)(start + i) - 4;
                rx[i] = (any && k >= 0 && k < 4) ? (uint8_t)(val >> (24 - 8 * k)) : 0xFF;
            }
        }
        if (frame.size() == 4 && frame[0] == 0x7A) state = state == "crc" ? "burst" : state;
    }
    static uint32_t crc32(const uint8_t *p, size_t n)
    {
        uint32_t c = 0xFFFFFFFF;
        for (size_t i = 0; i < n; i++) {
            c ^= p[i];
            for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & -(c & 1));
        }
        return ~c;
    }
    void end_frame()
    {
        if (frame.empty() || state == "user") return;
        uint8_t op = frame[0];
        bool ready = state == "wait_cmd" || state == "enabled" || state == "erased" || state == "crc" ||
                     state == "burst" || state == "loaded";
        if (!ready) { rep.violation("ECP5 command " + hex(op) + " before PROGRAMN/INITN (state " + state + ")"); return; }
        if (!initn) rep.violation("ECP5 command " + hex(op) + " before INITN went high");
        if (op == 0xC6) state = "enabled";
        else if (op == 0x0E) {
            if (state != "enabled") rep.violation("ECP5 erase before ISC_ENABLE");
            if (frame.size() < 4 || frame[1] != 0x01 || frame[2] || frame[3]) rep.violation("ECP5 SRAM erase operand");
            state = "erased";
        } else if (op == 0x3B) {
            if (state != "erased") rep.violation("ECP5 CRC reset before erase");
            state = "crc";
        } else if (op == 0x7A) {
            if (state != "burst") rep.violation("ECP5 bitstream burst before enable/erase/CRC reset");
            loaded.assign(frame.begin() + 4, frame.end());
            bad_bits = crc32(loaded.data(), loaded.size()) != good_crc;
            state = "loaded";
        } else if (op == 0x26) {
            if (state != "loaded") rep.violation("ECP5 ISC_DISABLE without a burst");
            bool good = !bad_bits;
            if (!good) rep.event("ECP5 loaded a bitstream with the wrong CRC: DONE stays low");
            state = "wait_cmd";
            if (good) done_at = 0;   // on the next tick
        } else if (op == 0xE0 || op == 0x3C || op == 0xFF) {
        } else rep.violation("ECP5 unexpected opcode " + hex(op));
    }
    static std::string hex(unsigned v) { char b[8]; snprintf(b, sizeof b, "%02X", v); return b; }
};

// ----------------------------------------------------------------- AD9116 --
struct Ad9116 {
    Report &rep;
    uint8_t reg[32];
    bool reset_pin = false;             // RESET/PINMD (board pull-down)
    fs_t reset_rise = -1;
    bool searching = true;
    int search_cnt = 0;
    // SPI
    bool cs = false;
    int bit = 0;
    uint8_t ins = 0, shreg = 0;
    int addr = 0, bytes_left = 0;
    bool rd = false;
    // data path
    int lat_i = 0, lat_q = 0;
    bool have_first = false;
    Ad9116(Report &r) : rep(r) { defaults(); }
    void defaults()
    {
        for (auto &v : reg) v = 0;
        reg[0x01] = 0x40;
        reg[0x02] = 0x34;
        reg[0x11] = 0x3F;
        reg[0x1F] = 0x0A;
        searching = true;
        search_cnt = 0;
    }
    void set_reset(fs_t t, bool high)
    {
        if (high && !reset_pin) reset_rise = t;
        if (!high && reset_pin) {
            if (t - reset_rise < 50 * FS_PER_NS) rep.violation("AD9116 RESET pulse shorter than 50 ns");
            defaults();
            rep.event("AD9116 reset");
        }
        reset_pin = high;
    }
    void set_cs(bool low)
    {
        if (low && !cs) { bit = 0; bytes_left = 0; }
        if (!low && cs && bit > 8 && (bit % 8) != 0)
            rep.violation("AD9116 CS rose mid-byte (" + std::to_string(bit) + " bits): the byte is not written");
        cs = low;
    }
    // SCLK rising edge with the SDIO level the master drives (write phase).
    void clk_rise(bool sdio)
    {
        if (!cs) return;
        if (reset_pin) { rep.violation("AD9116 SPI clocked while RESET/PINMD is high (pin mode)"); return; }
        if (reg[0] & 0x40) rep.violation("AD9116 LSBFIRST set: the firmware's frames are MSB first");
        if (bit < 8) {
            ins = (ins << 1) | sdio;
            if (++bit == 8) {
                rd = ins & 0x80;
                bytes_left = ((ins >> 5) & 3) + 1;
                addr = ins & 0x1F;
                shreg = 0;
            }
            return;
        }
        if (!bytes_left) { rep.violation("AD9116 clocked past the end of its transfer"); bit++; return; }
        if (rd) { bit++; if ((bit - 8) % 8 == 0) { bytes_left--; addr = (addr - 1) & 0x1F; } return; }
        shreg = (shreg << 1) | sdio;
        if (++bit % 8 == 0) {
            write_reg(addr, shreg);
            addr = (addr - 1) & 0x1F;
            bytes_left--;
        }
    }
    // The level the AD9116 drives on SDIO for the read bit about to be sampled.
    bool sdio_out() const
    {
        if (!cs || bit < 8 || !rd || !bytes_left) return true;
        int k = (bit - 8) % 8;
        return (read_reg(addr) >> (7 - k)) & 1;
    }
    uint8_t read_reg(int a) const
    {
        if (a == 0x14) return (reg[0x14] & ~0x10) | (searching ? 0x10 : 0);
        return reg[a];
    }
    void write_reg(int a, uint8_t v)
    {
        if (a == 0x1F) { rep.violation("AD9116 write to the read-only version register"); return; }
        if (a == 0x02 && (v & 0x03) && (v & 0x04))
            rep.violation("AD9116 DCI_EN with DCOSGL/DCODBL: the datasheet says not to");
        if (a == 0x14) {
            if ((v & 0x08) && !(reg[0x14] & 0x08)) { searching = true; search_cnt = 0; }
            reg[0x14] = (reg[0x14] & 0xC3) | (v & 0x0C) | ((v & 0x04) ? (v & 0x03) : 0);
            return;
        }
        if (a == 0x00 && (v & 0x20)) { uint8_t k = reg[0]; defaults(); reg[0] = k; }
        reg[a] = v;
    }
    bool twos() const { return reg[2] & 0x80; }
    bool ifirst() const { return reg[2] & 0x20; }
    bool irising() const { return reg[2] & 0x10; }
    bool output_on() const
    {
        return !searching && (reg[2] & 0x04) && !(reg[1] & 0x20) && !(reg[1] & 0x18) && !(reg[1] & 0x06);
    }
    // A DCLKIO edge with the data pins; clkin_ok: CLKIN present at the DCLKIO rate.
    // Returns true with (i, q) when a pair completes.
    bool dclk_edge(bool rising, uint16_t d, bool clkin_ok, int &i, int &q)
    {
        if (rising && searching && clkin_ok && !reset_pin) {
            if (++search_cnt >= 128) {
                searching = false;
                reg[0x14] = (reg[0x14] & 0x3C) | 0x41;     // CLKMODEQ = CLKMODEI = 01 (reported phase)
                rep.event("AD9116 retimer locked");
            }
        }
        int v = d & 0xFFF;
        int s = twos() ? (v & 0x800 ? v - 4096 : v) : v - 2048;
        bool is_i = rising == irising();
        if (is_i) lat_i = s; else lat_q = s;
        // The pair completes on its second half: Q when I comes first, else I.
        bool second = ifirst() ? !is_i : is_i;
        if (!second) { have_first = true; return false; }
        if (!have_first) return false;
        have_first = false;
        i = lat_i;
        q = lat_q;
        return true;
    }
};

// --------------------------------------------------------------- ADRF6755 --
struct Adrf6755 {
    Report &rep;
    double refin_hz;
    uint8_t reg[34] = {}, act[34] = {};   // written (shadow) and active (double buffered)
    bool written[31] = {};
    bool spi_mode = false;
    int cs_rises = 0;
    bool cs = false, txdis = true;
    int bit = 0;
    uint32_t sh = 0;
    int rd_sel = -1;
    uint8_t rd_val = 0;
    bool reading = false;
    fs_t lock_at = -1, forced_unlock_until = -1;
    bool locked_flag = false;
    bool broken = false;                // injected: the PLL never locks (e.g. a dead loop filter)
    double lo_hz = 0, vco_hz = 0, pfd_hz = 0;
    Adrf6755(Report &r, double refin) : rep(r), refin_hz(refin) { reg[33] = act[33] = 0x13; }

    void set_cs(fs_t t, bool low)
    {
        if (low && !cs) { bit = 0; sh = 0; reading = false; }
        if (!low && cs) {
            if (!spi_mode) {
                if (++cs_rises == 3) { spi_mode = true; rep.event("ADRF6755 locked into SPI mode"); }
            } else end_frame(t);
        }
        cs = low;
    }
    // Any SCLK edge on the shared setup bus (whichever chip is selected).
    bool warned_i2c = false;
    void bus_clock(bool selected)
    {
        if (!spi_mode && !warned_i2c) {
            rep.violation("setup bus clocked while the ADRF6755 is still in I2C mode (it would see I2C traffic)");
            warned_i2c = true;
        }
        (void)selected;
    }
    void clk_rise(bool sdi)
    {
        if (!cs || !spi_mode) return;
        sh = (sh << 1) | sdi;
        bit++;
        if (bit == 8) reading = ((sh & 0xFF) == 0xD5);
    }
    bool sdo() const
    {
        if (!cs || !spi_mode || !reading || bit < 8) return false;
        int k = bit - 8;
        return k < 8 ? (rd_val >> (7 - k)) & 1 : false;
    }
    void end_frame(fs_t t)
    {
        uint8_t cmd = bit >= 8 ? (sh >> (bit - 8)) & 0xFF : 0;
        if (bit == 24 && cmd == 0xD4) write(t, (sh >> 8) & 0xFF, sh & 0xFF);
        else if (bit == 16 && cmd == 0xD4) {
            rd_sel = sh & 0xFF;
            if (rd_sel > 33) rep.violation("ADRF6755 read of register " + std::to_string(rd_sel));
            rd_val = rd_sel <= 33 ? reg[rd_sel] : 0;
        } else if (bit == 16 && cmd == 0xD5) {
            if (rd_sel < 0) rep.violation("ADRF6755 read without selecting a register first");
        } else rep.violation("ADRF6755 frame of " + std::to_string(bit) + " bits, command " + std::to_string(cmd));
        bit = 0;
    }
    void must(int r, uint8_t v, uint8_t mask, uint8_t val, const char *what)
    {
        if ((v & mask) != val) {
            char b[160];
            snprintf(b, sizeof b, "ADRF6755 CR%d = 0x%02X: %s", r, v, what);
            rep.violation(b);
        }
    }
    void write(fs_t t, int r, uint8_t v)
    {
        if (r > 30) { rep.violation("ADRF6755 write to read-only CR" + std::to_string(r)); return; }
        switch (r) {
        case 3: must(r, v, 0xFE, 0x04, "bits 7:1 must be 0000010"); break;
        case 5: must(r, v, 0xEF, 0x00, "only bit 4 may be set"); break;
        case 9: must(r, v, 0x0F, 0x00, "bits 3:0 must be 0"); break;
        case 10: must(r, v, 0x80, 0x00, "bit 7 must be 0"); break;
        case 12: must(r, v, 0xFB, 0x18, "bits 4,3 = 1, others 0 (bit 2 = PLL power-down)"); break;
        case 13: must(r, v, 0xBF, 0xA8, "bits 7,5,3 = 1, bit 4 and 2:0 = 0"); break;
        case 14: must(r, v, 0x7F, 0x00, "bits 6:0 must be 0"); break;
        case 23: must(r, v, 0xE3, 0x60, "bit 7 = 0, bits 6,5 = 1, bits 1,0 = 0"); break;
        case 24: must(r, v, 0xFE, 0x18, "bits 4,3 = 1, others 0"); break;
        case 27: must(r, v, 0xE8, 0x00, "bits 7:5 and 3 must be 0"); break;
        case 28: must(r, v, 0xE8, 0x08, "bit 3 = 1, bits 7:5 = 0"); break;
        case 29: must(r, v, 0xFE, 0x80, "bit 7 = 1, bits 6:1 = 0"); break;
        case 30:
            must(r, v, 0xC0, 0x00, "bits 7:6 must be 0");
            if ((v & 0x3F) > 31 && (v & 0x30) != 0x30) rep.violation("ADRF6755 CR30 attenuator code not in Table 27");
            break;
        case 4: must(r, v, 0xFF, 0x01, "reserved: the power-up sequence writes 0x01"); break;
        case 8: case 11: case 15: case 16: case 17: case 20: case 21: case 26:
            must(r, v, 0xFF, 0x00, "reserved: the power-up sequence writes 0x00"); break;
        case 18: must(r, v, 0xFF, 0x60, "reserved: the power-up sequence writes 0x60"); break;
        case 19: case 22: must(r, v, 0xFF, 0x80, "reserved: the power-up sequence writes 0x80"); break;
        default: break;
        }
        reg[r] = v;
        written[r] = true;
        if (r == 29) {
            act[29] = v;
            if ((v & 1) && !locked(t)) rep.violation("ADRF6755 modulator powered up before the PLL locked (step 34)");
            return;
        }
        if (r == 30 || r == 14 || r == 12 || r == 13 || r == 23 || r == 24 || r == 25 || r == 27 || r == 26 ||
            r == 4 || r == 8 || r == 11 || (r >= 15 && r <= 22)) {
            act[r] = v;
            return;
        }
        if (r == 0) {
            for (int k = 1; k <= 30; k++)
                if (!written[k]) rep.violation("ADRF6755 CR0 written before CR" + std::to_string(k) +
                                               " was ever written (all writable registers on power-up)");
            for (int k = 0; k <= 10; k++) act[k] = reg[k];
            act[28] = reg[28];
            acquire(t);
        }
    }
    void acquire(fs_t t)
    {
        locked_flag = false;
        bool rdiv_en = act[5] & 0x10;
        int d = (act[10] >> 5) & 1, half = (act[10] >> 6) & 1, r = act[10] & 0x1F;
        if (!r) r = 32;
        pfd_hz = rdiv_en ? refin_hz * (1 + d) / (r * (1 + half)) : refin_hz * (1 + d);   // Equation 1
        uint32_t intg = ((act[7] & 0x0F) << 8) | act[6];
        uint32_t frac = ((uint32_t)(act[3] & 1) << 24) | (act[2] << 16) | (act[1] << 8) | act[0];
        int rfdiv = act[28] & 7;
        lo_hz = pfd_hz * (intg + frac / 33554432.0) / (1 << rfdiv);        // Equation 2
        vco_hz = lo_hz * (1 << rfdiv) * 2;                                  // divide-by-2 quadrature
        double autocal = act[25] * 28.0 / pfd_hz;                           // Equation 3
        bool ok = true;
        auto bad = [&](const std::string &s) { rep.violation("ADRF6755 will not lock: " + s); ok = false; };
        if (pfd_hz > 40e6) bad("PFD above 40 MHz");
        if (intg < 23 || intg > 4095) bad("INT out of range");
        if (vco_hz < 2310e6 || vco_hz > 4800e6) bad("VCO outside 2310-4800 MHz");
        if (rfdiv > 4) bad("RFDIV code");
        // Table 6: RFDIV and CR27[4] for the LO band.
        int want = lo_hz > 1155e6 ? 0 : lo_hz > 577.5e6 ? 1 : lo_hz > 288.75e6 ? 2 : lo_hz > 144.375e6 ? 3 : 4;
        if (rfdiv != want) bad("RFDIV does not match Table 6 for this LO");
        if (((reg[27] >> 4) & 1) != (want == 0)) rep.violation("ADRF6755 CR27[4] does not match Table 6");
        if (act[12] & 0x04) bad("PLL powered down (CR12 bit 2)");
        if (!(act[23] & 0x10)) bad("lock detector disabled (CR23 bit 4)");
        if (act[24] & 0x01) bad("autocalibration disabled (CR24 bit 0)");
        if (act[28] & 0x10) bad("RF divider powered down (CR28 bit 4)");
        if (autocal < 50e-6 || autocal > 100e-6)
            rep.violation("ADRF6755 autocalibration time " + std::to_string(autocal * 1e6) + " us (recommended 70)");
        if (std::fabs(pfd_hz - 40e6) > 1 && (act[23] == 0x70 || act[13] == 0xE8))
            rep.violation("ADRF6755 lock detector set for a 40 MHz PFD, PFD is " + std::to_string(pfd_hz));
        char b[160];
        snprintf(b, sizeof b, "ADRF6755 acquisition: PFD %.0f Hz, INT %u, FRAC %u, RFDIV %d -> LO %.3f Hz",
                 pfd_hz, intg, frac, rfdiv, lo_hz);
        rep.event(b);
        lock_at = ok && !broken ? t + (fs_t)(autocal * 1e15) + 100 * FS_PER_US : -1;
    }
    bool locked(fs_t t)
    {
        bool l = lock_at >= 0 && t >= lock_at && t >= forced_unlock_until;
        if (l != locked_flag) { locked_flag = l; rep.event(l ? "ADRF6755 LDET high" : "ADRF6755 LDET low"); }
        return l;
    }
    // The VCO drifts out of its calibrated band (temperature): the PLL stays
    // unlocked until a CR0 write runs a new autocalibration.
    void force_unlock(fs_t t)
    {
        lock_at = -1;
        rep.event("injected: ADRF6755 loses lock");
        locked(t);
    }
    bool modulator_on() const { return act[29] & 1; }
    // RF output: the modulator powered, TXDIS low; it emits whether or not the
    // PLL is locked (that is what the firmware has to prevent).
    bool rf_out() const { return modulator_on() && !txdis; }
};
