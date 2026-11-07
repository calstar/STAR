#include "rtt_log.h"

#ifdef STAR_BENCH /* the flight build carries no RTT block */

#include <string.h>

/*
 * A minimal SEGGER-RTT-compatible up buffer: a control block in RAM that
 * OpenOCD finds by its "SEGGER RTT" tag and drains over SWD while the core
 * runs (OpenOCD `rtt setup` / `rtt server start`, see scripts/serial.sh).
 * One up channel, no down channel. Non-blocking: when the host is not
 * reading, the bytes that do not fit are dropped.
 */

#define RTT_UP_SIZE 2048U

typedef struct {
    const char* name;
    char* buffer;
    uint32_t size;
    volatile uint32_t wr; /* written by the target */
    volatile uint32_t rd; /* written by the host */
    uint32_t flags;       /* 0: skip when full */
} rtt_buffer_t;

typedef struct {
    char id[16];
    int32_t max_up, max_down;
    rtt_buffer_t up[1];
    rtt_buffer_t down[1];
} rtt_cb_t;

static char up_buffer[RTT_UP_SIZE];
rtt_cb_t _SEGGER_RTT; /* the name OpenOCD's docs and tools look for */

void rtt_log_init(void) {
    _SEGGER_RTT.max_up = 1;
    _SEGGER_RTT.max_down = 1;
    _SEGGER_RTT.up[0] =
        (rtt_buffer_t){"Terminal", up_buffer, RTT_UP_SIZE, 0, 0, 0};
    _SEGGER_RTT.down[0] = (rtt_buffer_t){"Terminal", NULL, 0, 0, 0, 0};
    /* The tag goes in last, so the host never finds a half-built block. */
    __asm volatile("dmb" ::: "memory");
    memcpy(_SEGGER_RTT.id, "SEGGER RTT", 11);
    __asm volatile("dmb" ::: "memory");
}

uint32_t rtt_log_write(const char* s, uint32_t n) {
    rtt_buffer_t* b = &_SEGGER_RTT.up[0];
    uint32_t wr = b->wr, rd = b->rd, done = 0;
    while (done < n) {
        uint32_t next = (wr + 1U) % b->size;
        if (next == rd) {
            break; /* full: drop the rest */
        }
        b->buffer[wr] = s[done++];
        wr = next;
    }
    __asm volatile("dmb" ::: "memory");
    b->wr = wr;
    return done;
}
#endif /* STAR_BENCH */
