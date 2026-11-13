#ifndef STAR_BOARD_WATCHDOG_H
#define STAR_BOARD_WATCHDOG_H

#include <stdbool.h>
#include <stdint.h>

/* Starts IWDG1 once; it cannot be stopped in software until reset. It is
 * frozen while a debugger halts the core, so a breakpoint is not a reset. */
bool board_watchdog_start(void);
void board_watchdog_refresh(void);

/* RCC_RSR as it was at reset (BOOT_RESET_* bits, boot_report.h), then
 * cleared so the next reset reports only its own cause. Once, early. */
uint32_t board_reset_flags_take(void);

#endif
