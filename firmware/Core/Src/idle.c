#include "idle.h"

#include <string.h>

/* PA0 = VDD * 10k / (22k + 10k) = VDD * 0.3125, buffered, 16-bit ADC with a
 * 3.32 V reference (DEVICE_CHECKS.md on pranay/self-test-confirmed-requirements, #137).
 * mV = counts / 65535 * 3320 / 0.3125 = counts * 10624 / 65535.
 * 65535 * 10624 fits in uint32_t, so this is exact integer math. */
#define IDLE_ADC_FULL_SCALE 65535U
#define IDLE_MV_AT_FULL_SCALE 10624U

uint16_t idle_counts_to_mv(uint32_t raw_counts) {
    if (raw_counts > IDLE_ADC_FULL_SCALE) {
        return 0U;
    }
    /* Round to nearest. */
    uint32_t mv = (raw_counts * IDLE_MV_AT_FULL_SCALE + IDLE_ADC_FULL_SCALE / 2U) /
                  IDLE_ADC_FULL_SCALE;
    return (uint16_t)mv;
}

static bool config_valid(const idle_config_t* c) {
    if (c->heartbeat_interval_ms < 1000U ||
        c->heartbeat_interval_ms > (uint32_t)INT32_MAX) {
        return false;
    }
    if (c->wake_tolerance_ms >= c->heartbeat_interval_ms) {
        return false;
    }
    if (c->callback_budget_ms == 0U) {
        return false;
    }
    if (c->battery_fail_mv == 0U || c->battery_fail_mv >= c->battery_warn_mv) {
        return false;
    }
    /* Recovery levels must stay below the 16-bit range. */
    if ((uint32_t)c->battery_warn_mv + c->battery_hysteresis_mv > 0xFFFFU) {
        return false;
    }
    return true;
}

static bool port_valid(const idle_port_t* p) {
    return p->read_battery != NULL && p->on_usb_power != NULL &&
           p->send_heartbeat != NULL && p->poll_command != NULL;
}

bool idle_init(idle_t* idle, const idle_config_t* config,
               const idle_port_t* port, void* context) {
    if (idle == NULL) {
        return false;
    }
    memset(idle, 0, sizeof(*idle));
    if (config == NULL || port == NULL || !config_valid(config) ||
        !port_valid(port)) {
        return false;
    }
    idle->config = *config;
    idle->port = *port;
    idle->context = context;
    idle->last.previous_send = SELF_TEST_PENDING;
    idle->last.battery = IDLE_BATT_UNKNOWN;
    idle->battery_band = IDLE_BATT_UNKNOWN;
    idle->initialized = true;
    return true;
}

bool idle_enter(idle_t* idle, uint32_t now_ms) {
    if (idle == NULL || !idle->initialized) {
        return false;
    }
    /* First wake after entry sends a heartbeat immediately. */
    idle->next_heartbeat_ms = now_ms;
    idle->entered = true;
    return true;
}

/* Plain thresholds, used when there is no OK/WARN/FAIL history. */
static idle_battery_state_t band_fresh(const idle_config_t* c, uint16_t mv) {
    if (mv < c->battery_fail_mv) {
        return IDLE_BATT_FAIL;
    }
    if (mv < c->battery_warn_mv) {
        return IDLE_BATT_WARN;
    }
    return IDLE_BATT_OK;
}

/*
 * Getting worse is immediate; getting better needs the reading to clear the
 * threshold by the hysteresis margin. This stops a pack sitting near 7.0 V
 * from flipping OK/WARN on every heartbeat.
 */
static idle_battery_state_t band_next(const idle_config_t* c,
                                      idle_battery_state_t previous,
                                      uint16_t mv) {
    uint32_t warn_recover = (uint32_t)c->battery_warn_mv + c->battery_hysteresis_mv;
    uint32_t fail_recover = (uint32_t)c->battery_fail_mv + c->battery_hysteresis_mv;
    switch (previous) {
        case IDLE_BATT_WARN:
            if (mv < c->battery_fail_mv) {
                return IDLE_BATT_FAIL;
            }
            return mv >= warn_recover ? IDLE_BATT_OK : IDLE_BATT_WARN;
        case IDLE_BATT_FAIL:
            if (mv >= warn_recover) {
                return IDLE_BATT_OK;
            }
            return mv >= fail_recover ? IDLE_BATT_WARN : IDLE_BATT_FAIL;
        case IDLE_BATT_OK:
        default:
            return band_fresh(c, mv);
    }
}

static void read_battery(idle_t* idle, uint32_t now_ms) {
    self_test_battery_t sample = idle->port.read_battery(
        idle->context, now_ms, idle->config.callback_budget_ms);

    if (sample.reply.result != SELF_TEST_PASS || !sample.valid ||
        sample.raw_counts > IDLE_ADC_FULL_SCALE) {
        idle->last.supply_mv = 0U;
        idle->last.battery = IDLE_BATT_INVALID;
        return;
    }

    uint16_t mv = idle_counts_to_mv(sample.raw_counts);
    idle->last.supply_mv = mv;

    /* On USB, PA0 measures USB supply, not the pack. Never classify it as
     * battery health; keep the hysteresis memory for when USB is removed. */
    if (idle->port.on_usb_power(idle->context)) {
        idle->last.battery = IDLE_BATT_USB;
        return;
    }

    idle->battery_band = band_next(&idle->config, idle->battery_band, mv);
    idle->last.battery = idle->battery_band;
}

static void send_heartbeat(idle_t* idle, uint32_t now_ms) {
    idle->last.sequence += 1U; /* wraps modulo 2^32 by design */
    idle->last.uptime_ms = now_ms;

    self_test_reply_t reply = idle->port.send_heartbeat(
        idle->context, &idle->last, idle->config.callback_budget_ms);

    /* No retry within Idle: retries cost battery and the next heartbeat is
     * only one interval away. Failures are counted and reported instead. */
    idle->last.previous_send = reply.result;
    if (reply.result == SELF_TEST_PASS) {
        idle->last.consecutive_send_failures = 0U;
    } else if (idle->last.consecutive_send_failures < UINT8_MAX) {
        idle->last.consecutive_send_failures += 1U;
    }
}

/* Signed distance from a to b in modular milliseconds (valid for |gap| < 2^31). */
static int32_t ms_until(uint32_t now_ms, uint32_t target_ms) {
    return (int32_t)(target_ms - now_ms);
}

idle_result_t idle_on_wake(idle_t* idle, uint32_t now_ms) {
    idle_result_t result = {IDLE_EVENT_ERROR, 0U, false};
    /* Without idle_enter() the schedule is unset; after ~24 days of uptime
     * that would read as a heartbeat weeks away. Refuse instead. */
    if (idle == NULL || !idle->initialized || !idle->entered) {
        return result;
    }

    /* 1. Commands first: an Arm request must not wait behind a heartbeat. */
    for (unsigned i = 0; i < IDLE_MAX_COMMANDS_PER_WAKE; ++i) {
        idle_command_t cmd = idle->port.poll_command(idle->context);
        if (cmd == IDLE_CMD_NONE) {
            break;
        }
        if (cmd == IDLE_CMD_ARM) {
            result.event = IDLE_EVENT_ARM_REQUESTED;
            return result;
        }
        /* IDLE_CMD_DISARM (or anything unknown): already disarmed, ignore. */
    }

    /* 2. Heartbeat when due. Time decides, not the wake source, so a radio
     *    wake never delays the next heartbeat and an early LSI wake within
     *    tolerance still counts as on time. */
    int32_t remaining = ms_until(now_ms, idle->next_heartbeat_ms);
    if (remaining <= (int32_t)idle->config.wake_tolerance_ms) {
        /* Battery before transmit: LoRa TX current would sag the reading. */
        read_battery(idle, now_ms);
        send_heartbeat(idle, now_ms);
        result.heartbeat_sent = true;
        /* Schedule from now, not from the missed deadline: a long gap
         * produces one heartbeat, not a burst of catch-up heartbeats. */
        idle->next_heartbeat_ms = now_ms + idle->config.heartbeat_interval_ms;
        remaining = (int32_t)idle->config.heartbeat_interval_ms;
    }

    /* 3. Sleep until the next heartbeat, rounded up to whole RTC seconds. */
    uint32_t sleep_s = ((uint32_t)remaining + 999U) / 1000U;
    result.event = IDLE_EVENT_SLEEP;
    result.sleep_s = sleep_s == 0U ? 1U : sleep_s;
    return result;
}

const idle_heartbeat_t* idle_last_heartbeat(const idle_t* idle) {
    if (idle == NULL || !idle->initialized) {
        return NULL;
    }
    return &idle->last;
}
