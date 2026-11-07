#ifndef STAR_SELF_TEST_PORT_H
#define STAR_SELF_TEST_PORT_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SELF_TEST_MAX_DEVICES 8U

typedef enum {
    SELF_TEST_PENDING = 0,
    SELF_TEST_PASS,
    SELF_TEST_FAIL,
    SELF_TEST_TIMEOUT,
    SELF_TEST_NOT_CONFIGURED,
    SELF_TEST_NOT_IMPLEMENTED
} self_test_result_t;

typedef struct {
    self_test_result_t result;
    int32_t diagnostic;
} self_test_reply_t;

/* Negative diagnostics are reserved for the coordinator. */
#define SELF_TEST_DIAG_BAD_REPLY (-1)
#define SELF_TEST_DIAG_STALE_BATTERY (-2)
#define SELF_TEST_DIAG_SESSION_TIMEOUT (-3)

typedef struct {
    uint16_t device_id;
    bool required;
    bool complete;
    uint8_t attempts;
    self_test_reply_t reply;
} self_test_device_status_t;

typedef struct {
    self_test_reply_t reply;
    bool valid;
    uint32_t raw_counts;
    uint32_t sampled_at_ms;
} self_test_battery_t;

typedef struct {
    uint32_t now_ms;
    uint8_t device_count;
    self_test_device_status_t devices[SELF_TEST_MAX_DEVICES];
    /* Required probes only; neither battery health nor link health. */
    self_test_result_t probes_outcome;
    /* All inventory entries terminal, regardless of pass/fail or required.
     * This does not assert report delivery/storage or authorize arming. */
    bool probes_complete;
    bool deadline_expired;
    self_test_battery_t battery;
    /* Result of the previous publication when passed to publish_status. */
    self_test_reply_t publication;
    uint8_t publication_attempts;
} self_test_status_t;

/*
 * All callbacks must return within budget_ms and release bus locks/resources
 * before returning. PENDING permits later polling, not a retained transaction.
 * Drivers own context; NULL context is allowed for stateless implementations.
 * No callback may re-enter the coordinator or retain a status pointer.
 */
typedef struct {
    /* attempt is one-based and remains unchanged while polling PENDING. */
    self_test_reply_t (*probe)(void* context, uint16_t device_id,
                               uint8_t attempt, uint32_t now_ms,
                               uint32_t budget_ms);
    /* Stamp fresh samples with now_ms; cached samples retain their old stamp.
     */
    self_test_battery_t (*read_battery)(void* context, uint32_t now_ms,
                                        uint32_t budget_ms);
    /*
     * PASS requires LoRa TxDone within the adapter deadline, not merely
     * enqueueing bytes. No ground-station ACK is required. PENDING/FAIL/TIMEOUT
     * consume bounded retry attempts. Every call receives a fresh snapshot;
     * coalesce superseded queued status.
     */
    self_test_reply_t (*publish_status)(void* context,
                                        const self_test_status_t* status,
                                        uint32_t budget_ms);
} self_test_port_t;

#ifdef __cplusplus
}
#endif
#endif
