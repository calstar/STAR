#include "board.h"

#include "main.h"

static volatile bool soft_section;
static volatile bool soft_failed;

bool board_error_is_soft(void) {
    if (!soft_section) {
        return false;
    }
    soft_failed = true;
    return true;
}

bool board_soft_init(void (*init)(void)) {
    soft_failed = false;
    soft_section = true;
    init();
    soft_section = false;
    return !soft_failed;
}

uint32_t board_now_ms(void) { return HAL_GetTick(); }
