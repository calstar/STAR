#ifndef STAR_EMMC_STM32_H
#define STAR_EMMC_STM32_H

/*
 * Board side of the eMMC flight log: emmc_port_t on SDMMC1 (4-bit, IDMA),
 * the log's RAM buffers in AXI SRAM, and the writer task.
 *
 * NOT YET COMPILED: the STM32 build (PlatformIO env:flight) comes with
 * PR #165. The portable log it serves is host-tested (tests/emmc). What
 * integration still needs (linker section for the DMA buffers, SDMMC1
 * interrupt, writer task) is listed in EMMC-ARCHITECTURE.md, section 7.
 */

#include <stdint.h>

#include "emmc_card.h"
#include "emmc_log.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Create the mutex and completion semaphore and initialise the log. No card
 * I/O. Call once after osKernelInitialize(), before any task appends.
 */
emmc_status_t emmc_stm32_init(void);

/* The board's one flight log, for emmc_log_on_state()/emmc_log_append(). */
emmc_log_t* emmc_stm32_log(void);

/*
 * What start() read from the card (CID/EXT_CSD) and emmc_card_check()'s
 * verdict. Valid once the log has mounted (first service after Arm);
 * returns NULL before.
 */
const emmc_card_info_t* emmc_stm32_card(uint32_t* issues);

/* The writer: loops emmc_log_service(). Run at low priority. */
void emmc_stm32_writer_task(void* argument);

#ifdef __cplusplus
}
#endif
#endif
