#include "selftest_radio.h"

#include <string.h>

uint16_t selftest_radio_mv(battery_t battery) {
    bool pack = battery.state == BATTERY_OK || battery.state == BATTERY_WARN ||
                battery.state == BATTERY_FAIL;
    return pack ? battery.mv : 0U;
}

void selftest_radio_init(selftest_radio_t* tx, uint16_t result_bits,
                         uint16_t battery_mv, uint32_t now_ms) {
    memset(tx, 0, sizeof(*tx));
    tx->payload[0] = (uint8_t)result_bits;
    tx->payload[1] = (uint8_t)(result_bits >> 8);
    tx->payload[2] = (uint8_t)battery_mv;
    tx->payload[3] = (uint8_t)(battery_mv >> 8);
    tx->next_ms = now_ms;
}

void selftest_radio_step(selftest_radio_t* tx, uint32_t now_ms,
                         selftest_send_fn send, void* ctx) {
    if (tx->finished || (int32_t)(now_ms - tx->next_ms) < 0)
        return;
    ++tx->attempts;
    tx->result = send ? send(ctx, SELFTEST_RADIO_TYPE, tx->payload,
                             SELFTEST_RADIO_PAYLOAD)
                      : SELFTEST_TX_UNAVAILABLE;
    tx->finished = tx->result == SELFTEST_TX_DONE ||
                   tx->attempts >= SELFTEST_RADIO_MAX_ATTEMPTS;
    tx->next_ms = now_ms + SELFTEST_RADIO_RETRY_MS;
}
