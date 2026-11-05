#ifndef STAR_FAKE_GNSS_H
#define STAR_FAKE_GNSS_H

/*
 * A pretend MAX-M10S on the far end of UART9, behaving as its data sheet and
 * Interface Description say:
 *   - powers up at 9600 baud sending NMEA once a second (data sheet p.13)
 *   - hears the board only when both sides use the same baud
 *   - parses UBX-CFG-VALSET itself, reading each value's size from the key
 *     ID (bits 30..28, Interface Description p.124), not from the sender
 *   - CFG-UART1-BAUDRATE switches its baud; the other keys ACK and turn on
 *     NAV-PVT at the requested rate with NMEA off
 * Plugs into gnss_core as its gnss_io_t; fake_gnss_emit() returns what the
 * module transmitted by now_us (garbage bytes if the bauds disagree).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "gnss_core.h"

typedef void (*fake_gnss_truth_t)(uint32_t t_us, ubx_pvt_t* out);

typedef struct {
    uint32_t module_baud, uart_baud;
    bool nmea_on, pvt_on, mute;
    uint16_t rate_ms;
    uint8_t dynmodel;
    bool nak_next; /* answer the next config VALSET with a NAK */
    uint32_t next_nmea_us, next_pvt_us;
    gnss_frame_parser_t rx;
    unsigned valsets, baud_changes, acks, naks, garbled_rx;
    fake_gnss_truth_t truth;
    uint8_t pending[512];
    size_t pending_len;
} fake_gnss_t;

void fake_gnss_init(fake_gnss_t* f, uint32_t baud, fake_gnss_truth_t truth);
gnss_io_t fake_gnss_io(fake_gnss_t* f);
/* Bytes the module sent up to now_us, as the board's UART sees them. */
size_t fake_gnss_emit(fake_gnss_t* f, uint32_t now_us, uint8_t* out,
                      size_t cap);
/* Power cycle: back to 9600, NMEA, no NAV-PVT (RAM config lost). */
void fake_gnss_power_cycle(fake_gnss_t* f, uint32_t now_us);

#endif
