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

/* GNSS probe diagnostics: PASS carries the baud rate that worked. */
#define BOARD_GNSS_DIAG_ANTENNA_SHORT 1 /* PD10 low: antenna switch fault */
#define BOARD_GNSS_LISTEN_MS 1500U      /* > one 1 Hz NMEA period */

/* SD NAND probe diagnostics. FAIL/TIMEOUT: (stage << 8) | last R1 byte.
 * PASS: CID manufacturer ID | 0x100 if the card is high capacity (CCS). */
#define BOARD_SD_STAGE_CMD0 1
#define BOARD_SD_STAGE_CMD8 2
#define BOARD_SD_STAGE_ACMD41 3
#define BOARD_SD_STAGE_CMD58 4
#define BOARD_SD_STAGE_CMD10 5
#define BOARD_SD_INIT_MS 1000U /* ACMD41 loop limit (SD spec: 1 s) */

typedef struct {
    /* Pranay's SPI identity checks, wired to board_spi. */
    self_test_devices_t devices;
    bool gnss_powered;
    bool emmc_reset_released;
    bool emmc_init_attempted; /* the card is initialized once per power-up */
    self_test_reply_t emmc_result;
    bool adc_ready;
    bool time_ok; /* TIM2 really ticks at 1 MHz (board_time_start) */
} board_bringup_t;

/* eMMC probe diagnostics: PASS = CID manufacturer ID (Kioxia/Toshiba is
 * 0x11). FAIL = HAL MMC error code, or BOARD_EMMC_DIAG_STATE | card state. */
#define BOARD_EMMC_DIAG_STATE 0x10000

/* Release resets / power rails in order and enable each ready device. */
void board_bringup_power_up(board_bringup_t* bringup);

/* self_test_port_t.read_battery: raw PA0 counts (VDD after the ORing,
 * x 0.3125). Conversion and thresholds are the battery adapter's (#137). */
self_test_battery_t board_bringup_read_battery(void* context, uint32_t now_ms,
                                               uint32_t budget_ms);

/* self_test_port_t.probe with a board_bringup_t context. */
self_test_reply_t board_bringup_probe(void* context, uint16_t device_id,
                                      uint8_t attempt, uint32_t now_ms,
                                      uint32_t budget_ms);

#ifdef __cplusplus
}
#endif
#endif
