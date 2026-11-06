#ifndef STAR_GNSS_CORE_H
#define STAR_GNSS_CORE_H

/*
 * MAX-M10S on UART9 as one state machine. Portable: bytes, baud changes and
 * time are passed in / out, so gnss_task and the host tests run the same code.
 *
 *   DETECT  listen GNSS_LISTEN_US at each of 9600 (the module's default,
 *           data sheet p.13), 38400, 115200 for one valid NMEA/UBX frame
 *   CONFIG  at 115200 (sent VALSET baud first if found lower): VALSET
 *           NMEA off, NAV-PVT on, 10 Hz, dynamic model AIR4; wait for
 *           UBX-ACK-ACK (GNSS_ACK_US, GNSS_CONFIG_TRIES tries)
 *   RUN     every NAV-PVT -> REC_GNSS; none for GNSS_SILENCE_US -> DETECT
 * Nothing is written to the module's flash: the RAM-layer config is re-sent
 * after every power-up or silence.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "gnss_frame.h"
#include "records.h"
#include "ubx.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GNSS_RUN_BAUD 115200U
#define GNSS_LISTEN_US 1500000U /* > one 1 Hz NMEA period */
#define GNSS_ACK_US 500000U
#define GNSS_CONFIG_TRIES 3U
#define GNSS_SILENCE_US 2000000U
#define GNSS_RATE_MS 100U /* 10 Hz NAV-PVT (data sheet p.4: up to 10 Hz) */

typedef struct {
    /* Blocking write of bytes to the module (returns when sent). */
    void (*send)(void* ctx, const uint8_t* bytes, uint16_t len);
    /* Re-open UART9 at this baud; received bytes after it are at the new
     * rate. */
    void (*set_baud)(void* ctx, uint32_t baud);
    void* ctx;
} gnss_io_t;

typedef enum { GNSS_DETECT = 0, GNSS_CONFIG, GNSS_RUN } gnss_state_t;

typedef struct {
    gnss_io_t io;
    record_sink_t sink;
    gnss_frame_parser_t parser;
    gnss_state_t state;
    uint32_t baud;
    uint8_t candidate; /* index into the DETECT baud list */
    uint8_t tries;
    uint32_t deadline_us;
    uint32_t pps_us;
    /* Counters */
    uint32_t detected_baud; /* last baud a frame was heard at */
    uint32_t fixes;         /* NAV-PVT records produced */
    uint32_t configs;       /* configurations acknowledged */
    uint32_t naks, resets;  /* NAKs; returns to DETECT */
    rec_gnss_t latest;
} gnss_core_t;

/* io and sink set first. Opens UART9 at the first candidate baud. */
void gnss_core_init(gnss_core_t* core, uint32_t now_us);

/* Bytes received on UART9 (any amount, in order). */
void gnss_core_feed(gnss_core_t* core, const uint8_t* bytes, size_t n,
                    uint32_t now_us);

/* Deadlines: listen window, ACK timeout, silence. Call when woken. */
void gnss_core_poll(gnss_core_t* core, uint32_t now_us);

/* Latest GPS TIMEPULSE edge (board_time_last_pps), stamped into records. */
void gnss_core_set_pps(gnss_core_t* core, uint32_t edge_us);

/* Microseconds until the next deadline. */
uint32_t gnss_core_wait_us(const gnss_core_t* core, uint32_t now_us);

#ifdef __cplusplus
}
#endif
#endif
