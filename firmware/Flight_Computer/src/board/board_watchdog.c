#include "board_watchdog.h"

#include "board.h"
#include "boot_report.h"
#include "stm32h7xx.h"

_Static_assert(BOOT_RESET_IWDG == RCC_RSR_IWDG1RSTF &&
                   BOOT_RESET_WWDG == RCC_RSR_WWDG1RSTF &&
                   BOOT_RESET_SOFTWARE == RCC_RSR_SFTRSTF &&
                   BOOT_RESET_POWER_ON == RCC_RSR_PORRSTF &&
                   BOOT_RESET_PIN == RCC_RSR_PINRSTF &&
                   BOOT_RESET_BROWN_OUT == RCC_RSR_BORRSTF &&
                   BOOT_RESET_LOW_POWER == RCC_RSR_LPWRRSTF,
               "BOOT_RESET_* are the RCC_RSR bits");

/* RM0468 IWDG registers: /256, 4096 LSI cycles, no window. LSI continues
 * through Stop, so the timeout must outlast the Idle loop's 10 s sleep
 * (choice a in #521; IWDG_FZ_STOP is left alone). Nominal 32 kHz: 32.8 s.
 * A conservative 60 kHz upper bound still gives 17.47 s. */
bool board_watchdog_start(void) {
    /* DBGMCU APB4FZ1.DBG_IWDG1: counter stops while the core is halted. */
    DBGMCU->APB4FZ1 |= DBGMCU_APB4FZ1_DBG_IWDG1;
    IWDG1->KR = 0xCCCCU;
    IWDG1->KR = 0x5555U;
    IWDG1->PR = 6U;
    IWDG1->RLR = 4095U;
    uint32_t deadline = board_now_ms() + 100U;
    while (IWDG1->SR != 0U) {
        if (board_deadline_passed(deadline))
            return false;
    }
    IWDG1->WINR = 4095U;
    board_watchdog_refresh();
    return true;
}
void board_watchdog_refresh(void) {
    IWDG1->KR = 0xAAAAU;
}
uint32_t board_reset_flags_take(void) {
    uint32_t flags = RCC->RSR;
    RCC->RSR |= RCC_RSR_RMVF;
    return flags;
}
