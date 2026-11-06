#include "selftest_radio.h"

void selftest_radio_step(selftest_radio_t* tx, uint32_t now,
                         selftest_send_fn send, void* ctx) {
    if (tx->finished || (int32_t)(now - tx->next_ms) < 0)
        return;
    ++tx->attempts;
    tx->result =
        send ? send(ctx, tx->bytes, sizeof(tx->bytes), SELFTEST_RADIO_BUDGET_MS)
             : SELFTEST_TX_UNAVAILABLE;
    tx->finished = tx->result == SELFTEST_TX_DONE ||
                   tx->attempts >= SELFTEST_RADIO_MAX_ATTEMPTS;
    tx->next_ms = now + SELFTEST_RADIO_BUDGET_MS + SELFTEST_RADIO_RETRY_MS;
}
