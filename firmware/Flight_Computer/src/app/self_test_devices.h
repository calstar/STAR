#ifndef STAR_SELF_TEST_DEVICES_H
#define STAR_SELF_TEST_DEVICES_H

#include "self_test_port.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    SELF_TEST_DEVICE_IMU = 0,
    SELF_TEST_DEVICE_HIGH_G,
    SELF_TEST_DEVICE_BAROMETER,
    SELF_TEST_DEVICE_ETHERNET,
    SELF_TEST_DEVICE_RADIO,
    SELF_TEST_DEVICE_GNSS,
    SELF_TEST_DEVICE_NAND,
    SELF_TEST_DEVICE_EMMC
} self_test_device_id_t;

#define SELF_TEST_DEVICE_ENABLED(id) (UINT32_C(1) << (id))
#define SELF_TEST_DIAG_IDENTITY 0x10000
#define SELF_TEST_DIAG_BLANK_PROM 0x20000
#define SELF_TEST_DIAG_PROM_CRC 0x30000
#define SELF_TEST_DIAG_RADIO_STATUS 0x40000
#define SELF_TEST_DIAG_RADIO_ERRORS 0x50000

typedef struct {
    uint8_t tx[4];
    uint8_t rx[4];
    uint8_t length;
} self_test_spi_frame_t;

/* One synchronous batch: separate CS assertion for EACH frame, no writes to
 * device registers, 8-bit MSB-first full duplex. The adapter must enforce mode,
 * max_hz and a TOTAL budget including locks, BUSY waits and every frame. PASS
 * means all RX bytes were acquired. Release CS/locks/transfers on every return.
 * Radio commands require BUSY low before each frame. No wake/reset is allowed.
 * Incompatible/uninitialized hardware returns NOT_CONFIGURED. A driver service
 * may return PENDING only without leaving a transaction owned by this call.
 */
typedef self_test_reply_t (*self_test_spi_exchange_t)(
    void* context, uint16_t device_id, uint8_t mode, uint32_t max_hz,
    self_test_spi_frame_t* frames, uint8_t count, uint32_t budget_ms);

typedef struct {
    self_test_spi_exchange_t exchange;
    void* io_context;
    /* Opt in only after board routing, power/reset/startup and SPI setup are
     * verified. MS5611 must have completed its startup reset/PROM reload;
     * SX1262 must already be awake. Zero means no device is configured. */
    uint32_t configured_mask;
    /* Private scratch; one owner, no reentry. Keep off a small RTOS stack. */
    self_test_spi_frame_t frames[8];
} self_test_devices_t;

/* Directly usable as self_test_port_t.probe, with self_test_devices_t context.
 * Battery/publication wrappers may compose this context into a board context.
 * No state survives a call except scratch; coordinator reset needs no cleanup.
 */
self_test_reply_t self_test_devices_probe(void* context, uint16_t device_id,
                                          uint8_t attempt, uint32_t now_ms,
                                          uint32_t budget_ms);

#ifdef __cplusplus
}
#endif
#endif
