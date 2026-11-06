#include "board_watchdog.h"

#include "board.h"
#include "stm32h7xx.h"

/* RM0468 IWDG registers: /256, 4096 LSI cycles, no window. LSI continues
 * through Stop. At a conservative 60 kHz upper bound this allows 17.47 s;
 * the sleep API allows 10 s plus 1 s wake margin. Verify against the actual
 * board/option bytes before flight. No debug freeze or ISR refresh. */
bool board_watchdog_start(void) {
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
