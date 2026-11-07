#ifndef STAR_BOARD_EXTI_H
#define STAR_BOARD_EXTI_H

/*
 * Interrupt pins -> tasks. Each enabled EXTI line (see the .ioc) is routed to
 * the task that owns the chip:
 *
 *   PD0  IMU_INT1     ISM330DHCX data ready (rising)   -> sensors task
 *   PD3  ACCEL_INT_1  H3LIS100DL data ready (rising)   -> sensors task
 *   PB2  RADIO_DIO1   SX1262 IRQ (rising)              -> radio task
 *   PE15 ETH_INT      W5500 INTn (falling, active low) -> ethernet task
 *
 * The ISR only stamps the edge time (board_time_us) and sets the task's
 * thread flags; all bus traffic happens in the task.
 */

#include <stdbool.h>
#include <stdint.h>

#include "cmsis_os2.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Call from the owning task before enabling the chip's interrupt output.
 * Returns false for a pin that is not an EXTI pin on this board. */
bool board_exti_route(uint16_t pin, osThreadId_t thread, uint32_t flags);

/* board_time_us() of the most recent edge on pin (0 before the first). */
uint32_t board_exti_last_us(uint16_t pin);

#ifdef __cplusplus
}
#endif
#endif
