#ifndef STAR_RADIO_TASK_H
#define STAR_RADIO_TASK_H

/*
 * The LoRa radio (Wio-SX1262 on SPI1) as one RTOS task, from C.
 *
 * At start the task runs Sx1262Setup::configure() (src/sx1262_setup.h),
 * retrying every 5 s until the chip answers, then listens in continuous RX.
 * DIO1 (PB2, EXTI2) wakes it; it runs Ryan's Link::poll() (frame decode +
 * ARM gate, src/link.h) once per wake, and once a second in case an edge
 * was missed. A confirmed Arm or an Un-arm goes to the command callback.
 *
 * Sending: any task may call radio_task_send_frame(); it takes the radio
 * mutex, so a send and a receive never interleave on the chip, and returns
 * after TxDone (up to ~0.4 s at SF9) or a timeout.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    RADIO_SEND_OK = 0,
    RADIO_SEND_TIMEOUT,  /* no TxDone in time */
    RADIO_SEND_NO_RADIO, /* chip not set up or not answering */
    RADIO_SEND_BAD_FRAME /* payload does not fit the frame type */
} radio_send_result_t;

typedef enum { RADIO_CMD_ARM = 1, RADIO_CMD_DISARM } radio_command_t;

typedef struct {
    uint8_t setup_step;     /* SetupStep: 0 = configured */
    uint16_t device_errors; /* SX1262 OpError after start-up */
    uint32_t setup_attempts;
    uint32_t frames_ok, frames_dropped, radio_errors, crc_errors;
    uint32_t tx_ok, tx_timeouts;
    uint32_t arms, disarms;
} radio_status_t;

/* Called from the radio task when the ARM gate confirms a command. */
void radio_task_on_command(void (*callback)(radio_command_t command));

bool radio_task_start(void);

/* Switch the radio to sniff mode (SetRxDutyCycle, DS 13.1.7).
 * Safe to call from any task. The radio uses these parameters until
 * radio_task_start_continuous_rx() or a new call to this function. */
void radio_task_start_sniff(uint32_t rx_ms, uint32_t sleep_ms);

/* Switch the radio back to continuous RX (SetRx 0xFFFFFF). */
void radio_task_start_continuous_rx(void);

/* Frame type (src/frame.h FrameType) + payload; blocks until TxDone. */
radio_send_result_t radio_task_send_frame(uint8_t type, const uint8_t* payload,
                                          uint8_t len);

void radio_task_status(radio_status_t* out);

#ifdef __cplusplus
}
#endif
#endif
