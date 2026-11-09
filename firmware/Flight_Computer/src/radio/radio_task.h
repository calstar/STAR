#ifndef STAR_RADIO_TASK_H
#define STAR_RADIO_TASK_H

/*
 * The LoRa radio (Wio-SX1262 on SPI1) as one RTOS task, from C.
 *
 * At start the task runs Sx1262Setup::configure() (src/chips/sx1262_setup.h),
 * retrying every 5 s until the chip answers, then listens in continuous RX.
 * DIO1 (PB2, EXTI2) wakes it; it runs Ryan's Link::poll() (frame decode +
 * ARM gate, src/radio/link.h) once per wake, and once a second in case an edge
 * was missed. A confirmed Arm or an Un-arm goes to the command callback.
 *
 * Sending: any task may call radio_task_send_frame(); it takes the radio
 * mutex, so a send and a receive never interleave on the chip, and returns
 * after TxDone (up to ~0.4 s at SF9) or a timeout.
 */

#include <stdbool.h>
#include <stdint.h>

#include "fc_config.h"

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

/* The last frame received (any type), with its signal quality. RSSI in
 * dBm x 2 and SNR in dB x 4: the SX1262's own units (GetPacketStatus). */
typedef struct {
    uint32_t count; /* frames received so far; 0 = the rest is not valid */
    uint32_t at_ms; /* board_now_ms() when it was read */
    uint8_t type;   /* FrameType */
    uint16_t seq;
    uint8_t payload_len;
    uint8_t payload[16]; /* first 16 bytes */
    bool quality_ok;     /* GetPacketStatus answered */
    int16_t rssi_x2;
    int8_t snr_x4;
    int16_t signal_rssi_x2;
} radio_rx_t;

void radio_task_last_rx(radio_rx_t* out);

/* Called from the radio task when the ARM gate confirms a command. */
void radio_task_on_command(void (*callback)(radio_command_t command));

/* Every frame received with a good CRC, whole (the ground station's view).
 * Called in the radio task: copy and return, never block. */
typedef void (*radio_frame_cb_t)(uint8_t type, uint16_t seq,
                                 const uint8_t* payload, uint8_t len,
                                 int16_t rssi_x2, int16_t snr_x4);
void radio_task_on_frame(radio_frame_cb_t callback);

bool radio_task_start(void);

/* New link settings (already checked): the radio task re-runs its full
 * start-up with them, then returns to the RX mode it was in. */
void radio_task_set_config(const fc_config_t* c);

/* Switch the radio to sniff mode (SetRxDutyCycle, DS 13.1.7).
 * Safe to call from any task. The radio uses these parameters until
 * radio_task_start_continuous_rx() or a new call to this function. */
void radio_task_start_sniff(uint32_t rx_ms, uint32_t sleep_ms);

/* Switch the radio back to continuous RX (SetRx 0xFFFFFF). */
void radio_task_start_continuous_rx(void);

/* Frame type (src/radio/frame.h FrameType) + payload; blocks until TxDone. */
/* As radio_task_send_frame, with a preamble of `preamble` symbols for this
 * frame (Arm/Un-arm to a rocket that sniffs in Idle: > 1 s, ~260+). */
radio_send_result_t radio_task_send_frame_preamble(uint8_t type,
                                                   const uint8_t* payload,
                                                   uint8_t len,
                                                   uint16_t preamble);

/* Ground station: Arm sends two Arm frames with consecutive seqs (the
 * rocket's gate needs both within kArmConfirmWindowMs), Un-arm sends two
 * Un-arm frames; both with a 300-symbol preamble, heard by a rocket that
 * sniffs in Idle. Blocks ~3 s. The result of the last frame sent. */
radio_send_result_t radio_task_ground_command(bool arm);

radio_send_result_t radio_task_send_frame(uint8_t type, const uint8_t* payload,
                                          uint8_t len);

void radio_task_status(radio_status_t* out);

#ifdef __cplusplus
}
#endif
#endif
