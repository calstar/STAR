#ifndef STAR_SDLOG_STM32_H
#define STAR_SDLOG_STM32_H

/*
 * Board side of the SD NAND backup log: emmc_port_t over dev_sdnand on SPI4,
 * and the writer task. NOT COMPILED YET (needs the board patch in
 * boardBringup). Wiring, next to each eMMC call:
 *   app.c          sdlog_stm32_init(), then osThreadNew(sdlog_stm32_task, ...)
 *                  (osPriorityLow, ~1 KB stack, as start_emmc)
 *   mode.c         sdlog_on_state(sdlog_stm32_log(), from, to, now)
 *   sensors_task.c, gnss_task.c
 *                  sdlog_append(sdlog_stm32_log(), type, now, data, len)
 */

#include <stdbool.h>

#include "sdlog_core.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Mutex and log init, no card I/O. Once, after osKernelInitialize(). */
bool sdlog_stm32_init(void);

sdlog_t* sdlog_stm32_log(void);

/* The writer: loops sdlog_service(). Run at low priority. */
void sdlog_stm32_task(void* argument);

#ifdef __cplusplus
}
#endif
#endif
