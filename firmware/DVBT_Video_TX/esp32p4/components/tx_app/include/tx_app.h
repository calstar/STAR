// The transmitter's application logic: bring-up, the transport stream, and
// the health watchdog. Pure C over a board HAL (tx_board_t): the ESP32-P4
// binds it to its drivers (main/main.c), and the end-to-end test binds it
// to chip models and the FPGA's RTL, so the code that flies is the code
// the test runs.
//
// Bring-up (tx_bringup), in this order because each step needs the last:
//  1. Si5351A: CLK0 (FPGA) and CLK1 (AD9116 CLKIN) at 192/7 MHz.
//  2. FPGA: bitstream over slave SPI from the P4's flash partition; if that
//     is missing or fails, the FPGA boots from its own W25Q32. Wait for its
//     PLL and reset (10 ms), then the stream link's ID check.
//  3. RF off (TXDIS high). Setup bus: lock the ADRF6755 into SPI mode first
//     (it powers up in I2C mode on the same SCLK/SDIO lines), then the
//     AD9116: reset, data format, retimer lock (needs CLKIN from the Si5351A
//     and DCLKIO from the FPGA, hence after 1 and 2).
//  4. ADRF6755: PLL to the carrier, modulator powered down; wait for LDET.
//  5. FPGA modulator configured, TS FIFO primed, tx_en; then the ADRF6755's
//     modulator on and TXDIS low: RF out.
//
// Running: tx_pump sends the next two TS packets (blocking on DREQ, so it
// paces the caller at the channel rate) and runs the health check when due.
// tx_put_frame queues an encoded access unit from another task.
//
// Health (every health_ms): FPGA STATUS (sticky flags, null-packet count),
// its ID register, the ADRF6755's LDET and the AD9116's retimer. LDET lost:
// RF off at once, relock, RF on. FPGA ID wrong (the FPGA lost its
// configuration, e.g. a brownout on its rail): RF off, reload the FPGA,
// re-prime, RF on. AD9116 retimer lost: re-initialise it with the RF off.
//
// Channel and hops (the flight computer's UART, protocol in fc_link.h): the
// carrier is anywhere in lo_min_hz..lo_max_hz (the 6 MHz signal inside the
// 1240-1300 MHz amateur band). The flight computer sends $HOP with a
// channel; tx_pump validates it and plans the PLL, then answers $ACK with
// when (hop_lead_ms from now, on the stream's 27 MHz clock) and puts the hop
// in the channel table every packet stream carries (ts_mux.h), so the
// ground station sees it coming in the video itself and retunes only on
// that. At the hop -- when the packet stamped with that time reaches the
// air, the FPGA's FIFO later than the mux -- RF off, the PLL to the new
// channel, LDET, modulator on, RF on (the LO-unlock recovery's path), $DONE,
// and hop_key_delay_ms later a key frame. A channel that will not lock goes back to the old
// one ($DONE ... FAIL). The FPGA, the FIFO and the SD recording never stop;
// the air is dark for the relock, a fraction of a millisecond.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "i2c_bus_if.h"
#include "spi_bus_if.h"
#include "fpga_link.h"
#include "ecp5_cfg.h"
#include "si5351.h"
#include "ad9116.h"
#include "adrf6755.h"
#include "ts_mux.h"
#include "fc_link.h"

typedef enum { TX_PIN_TXDIS, TX_PIN_DAC_RESET, TX_PIN_LDET } tx_pin_t;

typedef struct {
    void *ctx;
    const i2c_bus_if_t *i2c;            // Si5351A
    const ecp5_hal_t *ecp5;             // FPGA configuration port
    size_t fpga_part_size;              // the bitstream partition
    // Hand the shared SPI host between the configuration port (open) and
    // the stream link (closed); called around every FPGA load. May be NULL.
    esp_err_t (*fpga_port)(void *ctx, bool open);
    const fpga_link_t *link;
    const spi_bus_if_t *setup;          // dev 0 AD9116 (3-wire), dev 1 ADRF6755
    void (*gpio_set)(void *ctx, tx_pin_t pin, bool level);
    bool (*gpio_get)(void *ctx, tx_pin_t pin);
    int64_t (*now_us)(void *ctx);
    void (*delay_us)(void *ctx, uint32_t us);
    void (*log)(void *ctx, char level, const char *msg);      // 'E', 'W', 'I'
    void (*mux_lock)(void *ctx, bool take);                    // may be NULL (one task)
    // Every packet the FPGA accepted, in order (the SD recorder). May be NULL.
    void (*on_sent)(void *ctx, const uint8_t *pkts, size_t n);
    // The flight computer's UART: read whatever has arrived (never blocks),
    // write one reply line (queues; never blocks). May be NULL.
    size_t (*fc_read)(void *ctx, uint8_t *buf, size_t max);
    void (*fc_write)(void *ctx, const char *line);
    // On air on a new channel (store it: a reboot comes back there). May be NULL.
    void (*on_channel)(void *ctx, uint32_t khz);
    // Ask the encoder for a key frame (after a hop). May be NULL.
    void (*keyframe)(void *ctx);
} tx_board_t;

typedef struct {
    uint32_t xtal_hz;                   // Si5351A crystal
    int xtal_load_pf;
    uint32_t refin_hz;                  // ADRF6755 REFIN
    uint32_t refin_tol_ppm;             // its worst-case error (TCXO + aging): sizes the PFD
    uint64_t lo_hz;                     // carrier
    uint8_t atten_db;                   // ADRF6755 output attenuator
    int bw_mhz, mod, rate, guard;       // DVB-T: 6, 0 QPSK, 0 1/2, 2 1/8
    const char *provider, *service;     // SDT (service: the callsign)
    uint32_t video_delay_ms;            // decoder delay added to each PTS
    uint8_t *mux_buf;                   // video ring (PSRAM on the P4)
    size_t mux_buf_size;
    uint32_t health_ms;                 // 0: 100
    // Per-board calibration, measured on the bench with a spectrum analyser
    // (written to the FPGA's trims before every tx_en):
    //   dc_i, dc_q: DAC LSBs that null the ADRF6755's LO feedthrough (-43 dBc
    //     of its nominal output, i.e. above a single OFDM carrier at our
    //     back-off -- it corrupts the centre carrier and every 4th symbol's
    //     channel estimate there);
    //   gain_i, gain_q (Q2.14, 0 = the FPGA's reset 2.5) and phase (Q2.14):
    //     null the image from DAC gain error and modulator quadrature error.
    int16_t dc_i, dc_q;
    uint16_t gain_i, gain_q;
    int16_t phase;
    uint32_t ldet_timeout_us;           // 0: 10000
    // Channels: the carrier must lie in lo_min_hz..lo_max_hz (0: 1243.5 and
    // 1296.5 MHz, so the 5.7 MHz signal stays inside 1240-1300 MHz).
    uint64_t lo_min_hz, lo_max_hz;
    uint32_t hop_lead_ms;               // $HOP to the hop (0: 500): the table repeats 5x first
    uint32_t hop_latency_us;            // mux to air (0: the FPGA's TS FIFO at the channel rate)
    // A key frame this long after a hop (0: 250): once the ground's receiver
    // has acquired the new channel, so its decoder has a picture at once
    // rather than at the next GOP. One at the hop itself would be wasted.
    uint32_t hop_key_delay_ms;
} tx_config_t;

// Faults (tx_app_t.faults is sticky; tx_health returns this check's).
#define TX_F_UNDERFLOW    (1u << 0)     // DAC ran dry (the modulator stalled)
#define TX_F_ALIGN        (1u << 1)     // modulator lost OFDM symbol alignment
#define TX_F_TS_BAD       (1u << 2)     // a packet without 0x47 reached the FPGA
#define TX_F_TS_OVERFLOW  (1u << 3)     // a packet found the FIFO full
#define TX_F_NULLS        (1u << 4)     // FPGA inserted null packets (P4 behind)
#define TX_F_FPGA_LOST    (1u << 5)     // ID register wrong
#define TX_F_LO_UNLOCK    (1u << 6)     // LDET low
#define TX_F_DAC_UNLOCK   (1u << 7)     // AD9116 retimer searching
#define TX_F_RECOVER_FAIL (1u << 8)     // a recovery did not bring RF back
#define TX_F_HOP_FAIL     (1u << 9)     // a hop's channel did not lock (back on the old one)

#define TX_FPGA_FIFO_BYTES 16384        // gateware TS_FIFO_AW = 14
#define TX_HOP_PID 0x1FF0               // the channel table's PID

typedef struct {
    bool pending;
    uint16_t seq;
    uint32_t khz;
    uint64_t t27;                       // stream time of the hop
    adrf6755_plan_t plan;
} tx_hop_t;

typedef struct {
    const tx_board_t *b;
    tx_config_t c;
    si5351_plan_t clk;
    ecp5_result_t fpga;
    adrf6755_plan_t lo;
    ad9116_t dac;
    adrf6755_t mod;
    uint8_t dac_version;
    uint32_t ctrl;
    ts_mux_t mux;
    uint8_t pkts[2 * TS_PKT];
    bool on_air;
    int64_t next_health_us;
    uint32_t faults, last_status;
    uint64_t nulls, frames, frames_dropped, pumped;
    uint32_t recoveries;
    uint32_t cur_khz;
    tx_hop_t hop;
    bool done_valid;                    // the last hop finished: answer its retries
    uint16_t done_seq;
    uint32_t done_khz;
    bool done_ok;
    uint32_t hops, hops_failed, fc_lines, fc_bad;
    fc_rx_t fc;
    uint64_t latency27;
    int64_t key_at_us;                  // ask for a key frame then (0: none due)
} tx_app_t;

esp_err_t tx_bringup(tx_app_t *a, const tx_board_t *b, const tx_config_t *c);
esp_err_t tx_pump(tx_app_t *a);
// An encoded access unit, captured at capture_us (board clock): stamped on
// the mux clock with the decoder delay and queued. False if it was dropped
// (the encoder is ahead of the channel).
bool tx_put_frame(tx_app_t *a, const uint8_t *au, size_t n, bool key, int64_t capture_us);
uint32_t tx_health(tx_app_t *a);
// One command from the flight computer (tx_pump reads the UART and calls
// this; exposed for tests). Replies through b->fc_write.
void tx_fc_command(tx_app_t *a, const fc_cmd_t *cmd);
// RF off: TXDIS high and the ADRF6755's modulator powered down.
void tx_rf_off(tx_app_t *a);
