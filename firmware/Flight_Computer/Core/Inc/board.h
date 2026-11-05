#ifndef STAR_BOARD_H
#define STAR_BOARD_H

/*
 * Board layer: the code that knows how the flight computer is wired.
 * Everything that touches a pin, a reset line or a HAL handle lives under
 * board_*; the portable modules (self_test*, idle*) only see callbacks.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * CubeMX's MX_*_Init() functions call Error_Handler() on any HAL failure, and
 * Error_Handler() halts the chip. That is right for on-chip peripherals but
 * wrong for ones that talk to an external chip during init (the eMMC): a
 * missing or dead part would brick the whole board.
 *
 * board_soft_init() runs such an init with Error_Handler() made non-fatal and
 * returns false if it was hit. Error_Handler() calls board_error_is_soft().
 */
bool board_soft_init(void (*init)(void));
bool board_error_is_soft(void);

/*
 * Put a buffer where DMA can reach it: the .dma_buffers section in AXI SRAM
 * (RAM_D1, see STM32H723xx_FLASH.ld). Default .bss is DTCM, which the SDMMC
 * IDMA and DMA1/2 cannot access. 32-byte alignment = one D-cache line, so
 * cache clean/invalidate never touches a neighbour. Not zeroed at boot.
 *   static uint8_t buf[512] BOARD_DMA_BUFFER;
 */
#define BOARD_DMA_BUFFER __attribute__((section(".dma_buffers"), aligned(32)))

/* Milliseconds since boot (HAL tick, TIM6). Wraps after ~49 days. */
uint32_t board_now_ms(void);

/* True once now_ms has reached deadline_ms (modular comparison). */
static inline bool board_deadline_passed(uint32_t deadline_ms) {
    return (int32_t)(board_now_ms() - deadline_ms) >= 0;
}

/* Milliseconds left before deadline_ms, 0 if it has passed. */
static inline uint32_t board_ms_left(uint32_t deadline_ms) {
    int32_t left = (int32_t)(deadline_ms - board_now_ms());
    return left > 0 ? (uint32_t)left : 0U;
}

#ifdef __cplusplus
}
#endif
#endif
