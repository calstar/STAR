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
//  3. AD9116 (its own SPI bus): reset, data format, retimer lock (needs
//     CLKIN from the Si5351A and DCLKIO from the FPGA, hence after 1 and 2).
//  4. FPGA modulator configured, TS FIFO primed, tx_en: the DAC runs.
//  5. The RF chain (tx_rf_step below), if 5V_RF is up: bring-up waits for it
//     to reach "locked", and on air if ARM is high.
//
// The RF chain (ADRF6755, TCXO, PA) is on 5V_RF, which is off on USB power
// alone; a pin driven into an unpowered chip powers it through its ESD diodes.
// So its pins (ADRF6755 CS/CLK/SDI, TXDIS, PA_EN) are left undriven until
// RF_PWR (5V_RF, sensed on a GPIO) reads high, and released the moment it
// reads low. tx_rf_step, every pump:
//   unpowered -> 5V_RF up: drive the pins safe (TXDIS high, PA off), wait
//     tcxo_start_us (the TCXO's enable is the ADRF6755's regulator output, so
//     it starts with 5V_RF);
//   -> three CS pulses (SPI mode: the ADRF6755 powers up in I2C mode, every
//     time), PLL to the carrier, modulator off, LDET: "locked";
//   locked + ARM high (debounced arm_ms) + the stream up: modulator on, TXDIS
//     low, PA_EN high -- on air. ARM low: PA off, TXDIS high, modulator off.
//   A lock failure is retried every health period.
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
// Channel switching (the flight computer's UART, protocol in fc_link.h): the
// carrier is anywhere in lo_min_hz..lo_max_hz (the 6 MHz signal inside the
// 1240-1300 MHz amateur band). The flight computer sends $HOP with a
// channel; tx_pump checks it (band, PLL plan) and switches at once: RF off,
// the PLL to the new channel, LDET, modulator on, RF on (the LO-unlock
// recovery's path; on air again only if it was allowed to be), $DONE. A
// channel that will not lock goes back to the old one ($DONE ... FAIL). With
// the RF chain unpowered the channel is only selected: the PLL locks there
// when 5V_RF comes up. The FPGA, its FIFO and the SD recording never stop;
// the air is dark for the relock, a fraction of a millisecond. Telling the
// ground station is the flight computer's job (telemetry).
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

typedef enum {
    TX_PIN_TXDIS,       // out, RF domain: ADRF6755 RF off when high
    TX_PIN_DAC_RESET,   // out
    TX_PIN_LDET,        // in: ADRF6755 lock detect
    TX_PIN_PA_EN,       // out, RF domain: PA on when high (board pull-down)
    TX_PIN_RF_PWR,      // in: 5V_RF is up
    TX_PIN_ARM,         // in: armed (board pull-down: unplugged = not armed)
} tx_pin_t;

typedef enum { TX_RF_UNPOWERED, TX_RF_TCXO, TX_RF_LOCKED, TX_RF_ON_AIR } tx_rf_state_t;

typedef struct {
    void *ctx;
    const i2c_bus_if_t *i2c;            // Si5351A
    const ecp5_hal_t *ecp5;             // FPGA configuration port
    size_t fpga_part_size;              // the bitstream partition
    // Hand the shared SPI host between the configuration port (open) and
    // the stream link (closed); called around every FPGA load. May be NULL.
    esp_err_t (*fpga_port)(void *ctx, bool open);
    const fpga_link_t *link;
    const spi_bus_if_t *dac_bus;        // dev 0: the AD9116 (3-wire)
    const spi_bus_if_t *lo_bus;         // dev 0: the ADRF6755 (4-wire; RF domain)
    // Drive the RF domain's outputs (TXDIS high, PA_EN low, ADRF6755 CS high,
    // CLK and SDI low) or release them all (inputs, no pulls).
    void (*rf_pins)(void *ctx, bool drive);
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
    uint32_t tcxo_start_us;             // 5V_RF up to TCXO running (0: 10000)
    uint32_t arm_ms;                    // ARM debounce (0: 20)
    bool rf_without_arm;                // bench: ignore ARM
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
#define TX_F_HOP_FAIL     (1u << 9)     // a commanded channel did not lock (back on the old one)

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
    tx_rf_state_t rf;
    int64_t rf_at_us;                   // TCXO started / next lock attempt
    bool lo_spi;                        // the ADRF6755 is in SPI mode (since 5V_RF came up)
    bool stream_ok;                     // the FPGA is transmitting (RF may go on)
    bool armed, arm_raw;
    bool hold_off;                      // tx_rf_hold: off for good (an FPGA update)
    int64_t arm_since_us;
    uint32_t rf_ups, rf_downs, lock_fails;
    int64_t next_health_us;
    uint32_t faults, last_status;
    uint64_t nulls, frames, frames_dropped, pumped;
    uint32_t recoveries;
    uint32_t cur_khz;
    bool done_valid;                    // the last $HOP's answer, for its retries
    uint16_t done_seq;
    uint32_t done_khz;
    bool done_ok;
    uint32_t hops, hops_failed, fc_lines, fc_bad;
    fc_rx_t fc;
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
// RF off: PA off, TXDIS high and the ADRF6755's modulator powered down (if
// the RF chain is powered); it stays off until tx_rf_step turns it on.
void tx_rf_off(tx_app_t *a);
// RF off for good (until reboot), e.g. before a flash write.
void tx_rf_hold(tx_app_t *a);
// The RF chain's state machine (above); tx_pump calls it every time.
void tx_rf_step(tx_app_t *a);
