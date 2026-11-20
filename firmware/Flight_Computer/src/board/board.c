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

uint32_t board_now_ms(void) {
    return HAL_GetTick();
}

void board_uid(uint32_t words[3]) {
    words[0] = HAL_GetUIDw0();
    words[1] = HAL_GetUIDw1();
    words[2] = HAL_GetUIDw2();
}
