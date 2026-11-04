// The flight computer's command link to the P4 (UART, 115200 8N1), in plain
// C with no I/O: bytes in, commands out; replies formatted for the caller
// to write. NMEA-style ASCII lines so a person can read them on a terminal:
//
//     $<BODY>*<HH>\r\n        HH: XOR of every byte of BODY, two hex digits
//
// Flight computer -> P4:
//   $HOP,<seq>,<kHz>       hop to kHz. seq (0-65535) names this hop: a
//                          resend with the same seq and kHz is a retry and
//                          gets the same answer, never a second hop.
//   $CH?                   which channel, and any hop pending
// P4 -> flight computer:
//   $ACK,<seq>,<kHz>,<ms>,<pcr>    scheduled: on air at kHz in <ms>, at the
//                          stream time <pcr> (27 MHz, the PCR timeline the
//                          ground receives; the in-band table carries it too)
//   $NAK,<seq>,<why>       refused, nothing changes. why: RANGE (outside the
//                          band), NOPLAN (no PLL plan), BUSY (another hop is
//                          pending), SEQ (seq reused for a different kHz)
//   $DONE,<seq>,<kHz>,OK   on air at kHz
//   $DONE,<seq>,<kHz>,FAIL the PLL did not lock there: still on the old
//                          channel (the table says which)
//   $CH,<kHz>,IDLE  |  $CH,<kHz>,PENDING,<seq>,<next kHz>
//   $ERR,CSUM | $ERR,SYNTAX   a line the P4 could not use (no seq to name)
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FC_LINE_MAX 96

typedef enum { FC_HOP, FC_QUERY, FC_BAD_CSUM, FC_BAD_SYNTAX } fc_kind_t;

typedef struct {
    fc_kind_t kind;
    uint16_t seq;
    uint32_t khz;
} fc_cmd_t;

typedef struct {
    char buf[FC_LINE_MAX];
    size_t n;
    bool in_line, overflow;
} fc_rx_t;

// Feed one received byte. True when it completed a line, with *cmd set.
// Bytes outside $...\n are ignored (line noise, a terminal's echo).
bool fc_rx_byte(fc_rx_t *r, uint8_t c, fc_cmd_t *cmd);
uint8_t fc_csum(const char *s, size_t n);
// "$" body "*HH\r\n" into out (NUL-terminated); returns its length, 0 if it
// does not fit.
size_t fc_format(char *out, size_t max, const char *body);
