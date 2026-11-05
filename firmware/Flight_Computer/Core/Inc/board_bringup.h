#ifndef STAR_BOARD_BRINGUP_H
#define STAR_BOARD_BRINGUP_H

/*
 * Bring-up: power and reset sequencing for every chip, then a probe that the
 * self-test coordinator can call for any device ID.
 *
 * board_bringup_power_up() runs once, from a task, before self-test. It only
 * enables a device's check (devices.configured_mask) after that device's
 * power/reset/startup steps are done, as self_test_devices.h requires.
 * It never enables a pyro output and never transmits on the radio.
 */

#include <stdbool.h>
#include <stdint.h>

#include "self_test_devices.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /* Pranay's SPI identity checks, wired to board_spi. */
    self_test_devices_t devices;
} board_bringup_t;

/* Release resets / power rails in order and enable each ready device. */
void board_bringup_power_up(board_bringup_t* bringup);

/* self_test_port_t.probe with a board_bringup_t context. */
self_test_reply_t board_bringup_probe(void* context, uint16_t device_id,
                                      uint8_t attempt, uint32_t now_ms,
                                      uint32_t budget_ms);

#ifdef __cplusplus
}
#endif
#endif
