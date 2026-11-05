#ifndef STAR_APP_H
#define STAR_APP_H

/*
 * Application tasks, started once by bringup_task after power/reset
 * sequencing and the self-test (so every chip is out of reset first).
 *
 *   task       priority          owns     woken by
 *   sensors    Realtime          SPI3     IMU/high-g DRDY EXTI, deadlines
 *   radio      AboveNormal       SPI1     SX1262 DIO1 EXTI, 1 s poll
 *   gnss       Normal            UART9    received bytes, deadlines
 *   emmc       Low (its own)     SDMMC1   records waiting (emmc_stm32.c)
 */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Returns false if any task could not be created; the rest still run. */
bool app_start(void);

#ifdef __cplusplus
}
#endif
#endif
