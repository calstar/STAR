#ifndef STAR_SELFTEST_RADIO_H
#define STAR_SELFTEST_RADIO_H

/*
 * The start-up self-test report, sent once over LoRa so the pad crew sees
 * the result without an ST-Link. Portable: the send is a callback.
 *
 * Payload: Ryan's SelfTest frame (src/radio/frame.h), result_bits u16 and
 * battery_mV u16, little-endian. The radio task (radio_task_send_frame)
 * adds the header, its own sequence number and the CRC. battery_mV is 0 on
 * USB or an unread ADC, the heartbeat's rule: never USB's 5 V as the pack.
 *
 * At most SELFTEST_RADIO_MAX_ATTEMPTS sends, SELFTEST_RADIO_RETRY_MS apart.
 * Only SELFTEST_TX_DONE (SX1262 TxDone) is success.
 */

#include <stdbool.h>
#include <stdint.h>

#include "battery.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SELFTEST_RADIO_TYPE 0x02U /* FrameType::SelfTest */
#define SELFTEST_RADIO_PAYLOAD 4U /* kSelfTestLen */
#define SELFTEST_RADIO_MAX_ATTEMPTS 3U
#define SELFTEST_RADIO_RETRY_MS 500U

typedef enum {
    SELFTEST_TX_PENDING = 0, /* not sent yet */
    SELFTEST_TX_DONE,        /* TxDone */
    SELFTEST_TX_TIMEOUT,     /* no TxDone in time */
    SELFTEST_TX_ERROR,       /* frame refused */
    SELFTEST_TX_UNAVAILABLE  /* radio not set up or not answering */
} selftest_tx_result_t;

typedef struct {
    uint8_t payload[SELFTEST_RADIO_PAYLOAD];
    uint8_t attempts;
    uint32_t next_ms;
    selftest_tx_result_t result; /* of the last attempt */
    bool finished;
} selftest_radio_t;

/* Blocks until TxDone or a bounded timeout. */
typedef selftest_tx_result_t (*selftest_send_fn)(void* ctx, uint8_t type,
                                                 const uint8_t* payload,
                                                 uint8_t len);

/* battery_mV for the frame: the reading only when it is the pack's. */
uint16_t selftest_radio_mv(battery_t battery);

void selftest_radio_init(selftest_radio_t* tx, uint16_t result_bits,
                         uint16_t battery_mv, uint32_t now_ms);

/* One attempt when due. Retries send the same payload. */
void selftest_radio_step(selftest_radio_t* tx, uint32_t now_ms,
                         selftest_send_fn send, void* ctx);

/* Board: send over the radio task until finished (bounded). Called from
 * app_start() after the radio task starts and before the Idle loop, so the
 * report is the first frame after boot, ahead of the first heartbeat. */
void selftest_radio_send(selftest_radio_t* tx, uint16_t result_bits,
                         uint16_t battery_mv);

#ifdef __cplusplus
}
#endif
#endif
