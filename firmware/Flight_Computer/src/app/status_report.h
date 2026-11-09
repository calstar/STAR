#ifndef STAR_STATUS_REPORT_H
#define STAR_STATUS_REPORT_H

/*
 * The radio payloads the rocket sends besides the 7-byte heartbeat
 * (src/radio/frame.h): Status (0x03) in Idle and Telemetry (0x20) once armed.
 * Little-endian, fixed length. No I/O: the ground station and the laptop
 * tests unpack with the same code.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "records.h"

#ifdef __cplusplus
extern "C" {
#endif

#define STATUS_ADC_COUNT 7  /* board_adc.h order */
#define STATUS_CHIP_COUNT 8 /* self_test_devices.h order */
#define STATUS_REPORT_LEN 45
#define TELEMETRY_LEN 57

#define STATUS_ON_USB 0x01U /* flags: the TPS2121 runs the board from USB */

typedef struct {
    uint8_t result; /* self_test_result_t: 1 PASS, 2 FAIL, 3 TIMEOUT, ... */
    uint8_t value;  /* what was read back (see board_chips.h) */
} status_chip_t;

typedef struct {
    uint8_t state; /* flight_state_t */
    uint32_t uptime_ms;
    uint32_t sequence;              /* Idle heartbeat count */
    uint16_t adc[STATUS_ADC_COUNT]; /* raw 16-bit counts */
    uint16_t battery_mv;
    uint8_t flags;
    uint8_t live_mask; /* bit = chip checked now; clear = its boot result */
    status_chip_t chips[STATUS_CHIP_COUNT];
    uint16_t radio_device_errors;
} status_report_t;

/* Bits of telemetry_t.fresh: a reading new since the last frame. */
#define TELEMETRY_IMU 0x01U
#define TELEMETRY_HIGHG 0x02U
#define TELEMETRY_BARO 0x04U
#define TELEMETRY_GNSS 0x08U

typedef struct {
    uint8_t state;
    uint32_t uptime_ms;
    uint8_t fresh;
    rec_imu_t imu;
    rec_highg_t highg;
    rec_baro_t baro;
    int32_t lat_e7, lon_e7, hmsl_mm;
    uint8_t fix_type, num_sv;
} telemetry_t;

void status_report_pack(const status_report_t* r,
                        uint8_t out[STATUS_REPORT_LEN]);
bool status_report_unpack(const uint8_t* p, size_t len, status_report_t* r);

void telemetry_pack(const telemetry_t* t, uint8_t out[TELEMETRY_LEN]);
bool telemetry_unpack(const uint8_t* p, size_t len, telemetry_t* t);

#ifdef __cplusplus
}
#endif
#endif
