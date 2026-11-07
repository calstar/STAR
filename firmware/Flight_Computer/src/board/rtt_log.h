#ifndef STAR_RTT_LOG_H
#define STAR_RTT_LOG_H

/* Text to the Mac over the ST-Link (RTT), shown by scripts/serial.sh. */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void rtt_log_init(void);
/* Returns the bytes taken; the rest is dropped when the buffer is full. */
uint32_t rtt_log_write(const char* s, uint32_t n);

#ifdef __cplusplus
}
#endif
#endif
