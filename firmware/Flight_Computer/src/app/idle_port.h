#ifndef STAR_IDLE_PORT_H
#define STAR_IDLE_PORT_H

/*
 * Idle seam: the only hardware operations Idle logic may use.
 *
 * Idle never calls STM32 HAL. The board provides these callbacks through
 * adapters that own the HAL handles; host tests provide fakes. Sleep entry,
 * RTC wakeup scheduling and clock restoration belong to the state machine,
 * not to this seam (see src/app/IDLE.md).
 *
 * Battery samples and replies reuse the self-test types so both modules
 * share one battery adapter and one result vocabulary.
 */

#include <stdbool.h>
#include <stdint.h>

#include "self_test_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    IDLE_CMD_NONE = 0, /* nothing waiting (not a failure) */
    IDLE_CMD_ARM,
    IDLE_CMD_DISARM
} idle_command_t;

typedef enum {
    IDLE_BATT_UNKNOWN = 0, /* no reading yet */
    IDLE_BATT_OK,
    IDLE_BATT_WARN,
    IDLE_BATT_FAIL,
    IDLE_BATT_USB,    /* board is on USB power; reading is not battery health */
    IDLE_BATT_INVALID /* read failed, pending, unsupported or out of range */
} idle_battery_state_t;

/* Heartbeat contents. Byte layout and checksum belong to the radio adapter. */
typedef struct {
    uint32_t sequence;  /* increments every heartbeat, wraps modulo 2^32 */
    uint32_t uptime_ms; /* monotonic clock, wraps modulo 2^32 */
    uint16_t supply_mv; /* converted PA0 reading; 0 when INVALID */
    idle_battery_state_t battery;
    /* Result of the previous heartbeat send (PENDING before the first). */
    self_test_result_t previous_send;
    uint8_t consecutive_send_failures; /* saturates at 255 */
} idle_heartbeat_t;

/*
 * All callbacks must return within budget_ms where given, must not block on
 * the radio or a bus, and must not retain the pointers they are passed.
 */
typedef struct {
    /* Raw ADC counts from PA0 (16-bit). Same contract as self-test's
     * read_battery: valid must be set on success. */
    self_test_battery_t (*read_battery)(void* context, uint32_t now_ms,
                                        uint32_t budget_ms);
    /* Reads SW_ST (PE10). True when the board runs on USB, in which case the
     * PA0 reading is USB voltage and must not be reported as battery health.
     */
    bool (*on_usb_power)(void* context);
    /* Send one heartbeat over LoRa. PASS only after SX1262 TxDone within
     * budget_ms; enqueueing bytes is not success. */
    self_test_reply_t (*send_heartbeat)(void* context,
                                        const idle_heartbeat_t* heartbeat,
                                        uint32_t budget_ms);
    /* Return the next received ground command without waiting. */
    idle_command_t (*poll_command)(void* context);
} idle_port_t;

#ifdef __cplusplus
}
#endif
#endif
