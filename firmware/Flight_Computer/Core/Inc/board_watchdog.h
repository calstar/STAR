#ifndef STAR_BOARD_WATCHDOG_H
#define STAR_BOARD_WATCHDOG_H
#include <stdbool.h>
/* Starts IWDG1 once; it cannot be stopped in software until reset. */
bool board_watchdog_start(void);
void board_watchdog_refresh(void);
#endif
