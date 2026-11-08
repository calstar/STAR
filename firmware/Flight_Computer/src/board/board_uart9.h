#ifndef STAR_BOARD_UART9_H
#define STAR_BOARD_UART9_H

/*
 * UART9 to the MAX-M10S (PD14 RX <- GPS TXD, PD15 TX -> GPS RXD; schematic
 * p.10). Interrupt-driven receive (HAL ReceiveToIdle, hardware FIFO at half
 * full, see the .ioc) into a ring buffer; each burst sets the owning task's
 * thread flag. No DMA, so no DTCM/RAM_D1 concern. Transmit is blocking and
 * short (UBX config frames).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cmsis_os2.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Start receiving; each received burst sets `flag` on `thread`. */
bool board_uart9_start(osThreadId_t thread, uint32_t flag);

/* Received bytes, oldest first; returns how many were copied. */
size_t board_uart9_read(uint8_t* out, size_t cap);

/* Blocking transmit, bounded at 100 ms. */
void board_uart9_send(const uint8_t* bytes, uint16_t len);

/* Re-open at another baud (receive restarts; the ring is kept). */
void board_uart9_set_baud(uint32_t baud);

/* Only reconfigure the UART at `baud`, FIFO included, without starting the
 * interrupt receive (the self-test's polled listen). Every baud change goes
 * through this: a bare HAL_UART_Init turns the hardware FIFO off. */
bool board_uart9_apply_baud(uint32_t baud);

/* Bytes received since boot (counts on past a full ring); bytes dropped
 * because the ring was full; UART errors seen. */
uint32_t board_uart9_rx_bytes(void);
uint32_t board_uart9_overflows(void);
uint32_t board_uart9_errors(void);

#ifdef __cplusplus
}
#endif
#endif
