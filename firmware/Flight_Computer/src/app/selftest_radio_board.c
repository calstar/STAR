#include <stddef.h>

#include "board.h"
#include "cmsis_os2.h"
#include "radio_task.h"
#include "selftest_radio.h"

static selftest_tx_result_t send(void* ctx, uint8_t type,
                                 const uint8_t* payload, uint8_t len) {
    (void)ctx;
    switch (radio_task_send_frame(type, payload, len)) {
        case RADIO_SEND_OK:
            return SELFTEST_TX_DONE;
        case RADIO_SEND_TIMEOUT:
            return SELFTEST_TX_TIMEOUT;
        case RADIO_SEND_NO_RADIO:
            return SELFTEST_TX_UNAVAILABLE;
        default:
            return SELFTEST_TX_ERROR;
    }
}

void selftest_radio_send(selftest_radio_t* tx, uint16_t result_bits,
                         uint16_t battery_mv) {
    selftest_radio_init(tx, result_bits, battery_mv, board_now_ms());
    while (!tx->finished) {
        selftest_radio_step(tx, board_now_ms(), send, NULL);
        if (!tx->finished)
            osDelay(10U);
    }
}
