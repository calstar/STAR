#ifndef STAR_NAND_STM32_H
#define STAR_NAND_STM32_H

/*
 * The backup flight log on the SD NAND (U10, Zetta ZDSD01GLGEAG, 1 Gbit SLC,
 * 128 MB) over SPI4 in SD SPI mode. Same log as the eMMC (emmc_log.c: same
 * block format, sessions, power-cut recovery, wipe and card check), its own
 * RAM chunks and its own writer task, so a stalled eMMC never holds it up
 * and the other way round. Every record the sensors and GPS append goes to
 * both. API mirrors emmc_stm32.h.
 */

#include <stdbool.h>
#include <stdint.h>

#include "emmc_log.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Mutexes, semaphores and the log. No card I/O. Once, before any append. */
emmc_status_t nand_stm32_init(void);

emmc_log_t* nand_stm32_log(void);

/* Card read-back, wipe and check (USB), run in the writer task. */
emmc_status_t nand_stm32_open(void);
emmc_status_t nand_stm32_sessions(uint32_t start, emmc_log_session_t* out,
                                  uint32_t max, uint32_t* n, uint32_t* total);
emmc_status_t nand_stm32_read(uint32_t k, uint8_t out[EMMC_BLOCK_SIZE]);
emmc_status_t nand_stm32_wipe(void);
emmc_status_t nand_stm32_check(uint32_t seed, emmc_log_check_t* out,
                               uint32_t* elapsed_ms);

/* The writer: loops emmc_log_service() on the NAND log. Low priority. */
void nand_stm32_writer_task(void* argument);

#ifdef __cplusplus
}
#endif
#endif
