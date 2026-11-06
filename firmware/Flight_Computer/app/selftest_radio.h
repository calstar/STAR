#ifndef STAR_SELFTEST_RADIO_H
#define STAR_SELFTEST_RADIO_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Matches the existing src/frame.h SelfTest: result_bits u16, supply mV u16.
 * This protocol has no battery-valid/USB/verdict field; 0 means unavailable. */
#define SELFTEST_RADIO_FRAME_SIZE 11U
#define SELFTEST_RADIO_MAX_ATTEMPTS 3U
#define SELFTEST_RADIO_BUDGET_MS 1000U
#define SELFTEST_RADIO_RETRY_MS 500U
typedef enum {
    SELFTEST_TX_PENDING,
    SELFTEST_TX_DONE,
    SELFTEST_TX_TIMEOUT,
    SELFTEST_TX_ERROR,
    SELFTEST_TX_UNAVAILABLE
} selftest_tx_result_t;
typedef struct {
    uint8_t bytes[SELFTEST_RADIO_FRAME_SIZE];
    uint8_t attempts;
    uint32_t next_ms;
    selftest_tx_result_t result;
    bool finished;
} selftest_radio_t;
typedef selftest_tx_result_t (*selftest_send_fn)(void* ctx,
                                                 const uint8_t* bytes,
                                                 uint8_t len,
                                                 uint32_t budget_ms);
bool selftest_radio_init(selftest_radio_t* tx, uint16_t result_bits,
                         uint16_t supply_mv, uint16_t sequence, uint32_t now);
/* One bounded attempt, called by a dedicated task. Retries preserve sequence.
 * Callback must return within budget, and DONE requires hardware TxDone. */
void selftest_radio_step(selftest_radio_t* tx, uint32_t now,
                         selftest_send_fn send, void* ctx);
/* Shared radio service integration hook. Serialize with RX/heartbeat/commands,
 * apply reviewed modem config, await TxDone, then re-arm continuous RX. The
 * default returns UNAVAILABLE: there is no board transmitter on main yet. */
selftest_tx_result_t flight_radio_send(void* ctx, const uint8_t* bytes,
                                       uint8_t len, uint32_t budget_ms);
bool selftest_radio_task_start(uint16_t result_bits, uint16_t supply_mv);
/* Read after finished, or halt all threads in the debugger. */
extern selftest_radio_t g_selftest_radio;
#ifdef __cplusplus
}
#endif
#endif
