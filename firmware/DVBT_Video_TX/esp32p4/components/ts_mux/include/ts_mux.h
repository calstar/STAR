// MPEG-2 transport stream multiplexer for one H.264 service, at a constant
// bit rate (the DVB-T channel's), in plain C with no allocation.
//
// Each call to ts_mux_next() produces the next 188-byte packet of the
// stream. Its time is fixed by its position: packet n leaves at
// n * 1504 / R seconds, so the PCR is derived from the packet count, which
// is real time because the FPGA takes packets at exactly R (DREQ). In each
// slot, in priority order:
//   PAT + PMT (every pat_ms), SDT (every sdt_ms), a video packet carrying
//   the PCR when one is due (every pcr_ms; adaptation-field only if there
//   is no video), video payload, else a null packet.
// Channel table (when hop_pid is set): one private section every chan_ms
// on its own PID, saying which channel this is and whether a hop is coming
// (ts_mux_set_chan; sent at once when it changes). Section, after the usual
// 8-byte long header (table_id 0xF0, table_id_extension 0x4850 "HP",
// version = a counter bumped on every change):
//   u8 format (1), u8 flags (bit 0: hop pending), u16 seq,
//   u32 current kHz, u32 next kHz (= current when none pending),
//   u48 hop PCR: 33-bit base + 6 reserved + 9-bit extension, coded as an
//       adaptation field's PCR: on the old channel, no packet after it
//   CRC-32/MPEG-2.
// Decoders ignore it (the PMT does not list it); the ground station's
// software reads it to follow a hop (see ../../../ground/dvbt_hop.py).
// Video: access units go in with ts_mux_put(), PTS in 90 kHz on the mux's
// own clock (ts_mux_now_90k() at capture + the decoder delay); each AU
// becomes one PES (stream 0xE0, PTS only: no B-frames), an access-unit
// delimiter added if the AU lacks one, the last packet padded with
// adaptation-field stuffing. Tables follow ISO/IEC 13818-1 and ETSI EN
// 300 468 (SDT service descriptor), CRC-32/MPEG-2.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TS_PKT 188

typedef struct {
    uint64_t rate_num, rate_den;     // stream rate in bit/s = num / den
    uint16_t tsid, onid, program, pmt_pid, video_pid;
    const char *provider, *service;  // SDT strings (service: the callsign)
    uint32_t pat_ms, sdt_ms, pcr_ms; // 0: defaults 100, 1000, 20
    uint8_t *buf;                    // video byte ring, caller's memory (PSRAM)
    size_t buf_size;
    uint16_t hop_pid;                // channel table PID; 0: no table
    uint32_t chan_ms;                // 0: 100
} ts_mux_config_t;

typedef struct {
    size_t off, len;                 // in the ring
    uint64_t pts;
    bool key;
} ts_mux_au_t;

#define TS_MUX_MAX_AU 64

typedef struct {
    uint32_t cur_khz, next_khz;
    uint16_t seq;
    bool pending;
    uint64_t hop_t27;                // stream time of the hop (27 MHz, the mux's clock)
} ts_mux_chan_t;

typedef struct {
    ts_mux_config_t c;
    uint64_t pkt;                    // packets produced
    uint64_t pcr_k_num, pcr_k_den;   // 27 MHz ticks per byte = num/den (reduced)
    uint8_t cc_pat, cc_pmt, cc_sdt, cc_vid, cc_chan;
    uint64_t next_pat, next_sdt, next_pcr, next_chan;   // in 27 MHz ticks
    ts_mux_chan_t chan;
    uint8_t chan_ver;
    ts_mux_au_t q[TS_MUX_MAX_AU];
    unsigned qh, qn;                 // queue head, count
    size_t ring_w, ring_used;
    size_t cur_sent;                 // bytes of the head AU's PES already sent
    uint8_t pes_hdr[20];
    size_t pes_hdr_len;
    bool pes_started;
    uint64_t nulls, stuffed;         // statistics
} ts_mux_t;

// DVB-T useful bit rate for a channel (EN 300 744 Table 17's formula):
// bandwidth 6/7/8 MHz, mod 0 QPSK / 1 16QAM / 2 64QAM, rate 0..4 = 1/2..7/8,
// guard 0..3 = 1/32..1/4, 2K or 8K (same rate). Returns num/den bit/s.
void ts_dvbt_rate(int bw_mhz, int mod, int rate, int guard, uint64_t *num, uint64_t *den);

void ts_mux_init(ts_mux_t *m, const ts_mux_config_t *c);
// Queue one access unit (copied into the ring). False if it does not fit:
// the encoder is ahead of the channel -- drop the frame or lower the rate.
bool ts_mux_put(ts_mux_t *m, const uint8_t *au, size_t n, uint64_t pts_90k, bool key);
void ts_mux_next(ts_mux_t *m, uint8_t out[TS_PKT]);
uint64_t ts_mux_now_90k(const ts_mux_t *m);      // time of the next packet
uint64_t ts_mux_now_27(const ts_mux_t *m);       // the same, in 27 MHz ticks
// Set the channel table's contents; the next packet slot carries it.
void ts_mux_set_chan(ts_mux_t *m, const ts_mux_chan_t *c);
// The FPGA inserted n null packets of its own (the P4 fell behind): the
// channel is n packets further on than the mux's count, so move the mux's
// clock (PCR, PTS stamping, table timers) forward to match.
void ts_mux_skip(ts_mux_t *m, uint64_t n);
size_t ts_mux_backlog(const ts_mux_t *m);        // video bytes queued
uint32_t ts_crc32_mpeg(const uint8_t *p, size_t n);
