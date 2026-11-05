#ifndef STAR_SELF_TEST_H
#define STAR_SELF_TEST_H

#include "self_test_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t device_id;
    bool required;
} self_test_device_t;

typedef struct {
    uint8_t device_count;
    self_test_device_t devices[SELF_TEST_MAX_DEVICES];
    uint32_t probe_timeout_ms;
    uint32_t retry_interval_ms;
    uint32_t heartbeat_interval_ms;
    uint32_t battery_interval_ms;
    uint32_t battery_max_age_ms;
    uint32_t callback_budget_ms;
    uint32_t tick_budget_ms;
    uint8_t probe_max_attempts;
    uint8_t publication_max_attempts;
} self_test_config_t;

typedef struct {
    uint32_t started_at_ms;
    uint32_t retry_at_ms;
    bool started;
    bool retry_wait;
} self_test_probe_state_t;

/* Fixed caller-owned storage. Zero-initialize; treat fields as private. */
typedef struct {
    self_test_config_t config;
    self_test_port_t port;
    void* context;
    self_test_status_t status;
    self_test_probe_state_t probes[SELF_TEST_MAX_DEVICES];
    uint32_t last_heartbeat_ms;
    uint32_t last_battery_ms;
    uint32_t last_publication_ms;
    uint8_t next_probe;
    bool heartbeat_started;
    bool battery_started;
    bool publication_retry;
    bool initialized;
} self_test_t;

/* Inputs are copied and must not alias test's storage. Missing callbacks are
 * supported and report NOT_IMPLEMENTED. Invalid config disables the instance.
 */
bool self_test_init(self_test_t* test, const self_test_config_t* config,
                    const self_test_port_t* port, void* context,
                    uint32_t now_ms);
bool self_test_reset(self_test_t* test, uint32_t now_ms);
/* One owner, monotonic modular milliseconds, tick gaps < 2^31 ms. */
void self_test_tick(self_test_t* test, uint32_t now_ms);
/* Borrowed until next tick/reset; NULL for an invalid instance. */
const self_test_status_t* self_test_status(const self_test_t* test);

#ifdef __cplusplus
}
#endif
#endif
