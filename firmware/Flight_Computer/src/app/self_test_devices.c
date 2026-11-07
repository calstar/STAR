#include "self_test_devices.h"

#include <string.h>

static self_test_reply_t reply(self_test_result_t result, int32_t diagnostic) {
    self_test_reply_t value = {result, diagnostic};
    return value;
}

/* MS56xx AN520: consume high byte first and clear the entire CRC byte. */
static uint8_t prom_crc(const uint16_t prom[8]) {
    uint16_t remainder = 0;
    for (uint8_t byte = 0; byte < 16; ++byte) {
        uint16_t word = prom[byte / 2];
        if (byte / 2 == 7) {
            word &= 0xFF00U;
        }
        remainder ^= (byte & 1U) ? (word & 0xFFU) : (word >> 8);
        for (uint8_t bit = 0; bit < 8; ++bit) {
            remainder = (uint16_t)((remainder << 1) ^
                                   ((remainder & 0x8000U) ? 0x3000U : 0U));
        }
    }
    return (uint8_t)((remainder >> 12) & 0xFU);
}

self_test_reply_t self_test_devices_probe(void* context, uint16_t device_id,
                                          uint8_t attempt, uint32_t now_ms,
                                          uint32_t budget_ms) {
    self_test_devices_t* devices = context;
    uint8_t mode = 0, count = 1, expected = 0, response_index = 1;
    uint32_t max_hz = 10000000U;
    (void)attempt;
    (void)now_ms;
    if (device_id > SELF_TEST_DEVICE_RADIO) {
        return reply(SELF_TEST_NOT_IMPLEMENTED, 0);
    }
    if (!devices ||
        !(devices->configured_mask & SELF_TEST_DEVICE_ENABLED(device_id))) {
        return reply(SELF_TEST_NOT_CONFIGURED, 0);
    }
    if (!devices->exchange) {
        return reply(SELF_TEST_NOT_IMPLEMENTED, 0);
    }
    if (!budget_ms) {
        return reply(SELF_TEST_TIMEOUT, 0);
    }
    memset(devices->frames, 0, sizeof(devices->frames));
    self_test_spi_frame_t* frames = devices->frames;
    switch (device_id) {
        case SELF_TEST_DEVICE_IMU:
        case SELF_TEST_DEVICE_HIGH_G:
            mode = 3;
            frames[0].tx[0] = 0x8F;
            frames[0].length = 2;
            expected = device_id == SELF_TEST_DEVICE_IMU ? 0x6B : 0x32;
            break;
        case SELF_TEST_DEVICE_BAROMETER:
            mode = 3; /* Shared SPI3 with the IMU and high-g accelerometer. */
            max_hz = 20000000U;
            count = 8;
            for (uint8_t i = 0; i < count; ++i) {
                frames[i].tx[0] = (uint8_t)(0xA0U + 2U * i);
                frames[i].length = 3;
            }
            break;
        case SELF_TEST_DEVICE_ETHERNET:
            max_hz = 80000000U;
            frames[0].tx[1] = 0x39;
            frames[0].length = 4;
            response_index = 3;
            expected = 0x04;
            break;
        case SELF_TEST_DEVICE_RADIO:
            max_hz = 16000000U;
            count = 2;
            frames[0].tx[0] = 0xC0; /* GetStatus */
            frames[0].length = 2;
            frames[1].tx[0] = 0x17; /* GetDeviceErrors; do not clear errors. */
            frames[1].length = 4;
            break;
        default:
            return reply(SELF_TEST_NOT_IMPLEMENTED, 0);
    }
    self_test_reply_t transport = devices->exchange(
        devices->io_context, device_id, mode, max_hz, frames, count, budget_ms);
    if (transport.result != SELF_TEST_PASS) {
        return transport;
    }
    if (device_id == SELF_TEST_DEVICE_BAROMETER) {
        uint16_t prom[8];
        bool zero = true, ones = true;
        for (uint8_t i = 0; i < 8; ++i) {
            prom[i] =
                (uint16_t)(((uint16_t)frames[i].rx[1] << 8) | frames[i].rx[2]);
            zero = zero && prom[i] == 0;
            ones = ones && prom[i] == 0xFFFFU;
        }
        if (zero || ones) {
            return reply(SELF_TEST_FAIL, SELF_TEST_DIAG_BLANK_PROM);
        }
        uint8_t expected_crc = (uint8_t)(prom[7] & 0xFU);
        uint8_t actual_crc = prom_crc(prom);
        if (expected_crc != actual_crc) {
            return reply(SELF_TEST_FAIL, SELF_TEST_DIAG_PROM_CRC |
                                             (actual_crc << 4) | expected_crc);
        }
    } else if (device_id == SELF_TEST_DEVICE_RADIO) {
        for (uint8_t i = 0; i < count; ++i) {
            uint8_t status = frames[i].rx[1];
            uint8_t chip_mode = (status >> 4) & 7U;
            uint8_t command_status = (status >> 1) & 7U;
            if (chip_mode < 2 || chip_mode > 6 ||
                (command_status >= 3 && command_status <= 5)) {
                return reply(SELF_TEST_FAIL,
                             SELF_TEST_DIAG_RADIO_STATUS | status);
            }
        }
        uint16_t errors =
            (uint16_t)(((uint16_t)frames[1].rx[2] << 8) | frames[1].rx[3]);
        if (errors) {
            return reply(SELF_TEST_FAIL, SELF_TEST_DIAG_RADIO_ERRORS | errors);
        }
    } else if (frames[0].rx[response_index] != expected) {
        return reply(SELF_TEST_FAIL,
                     SELF_TEST_DIAG_IDENTITY | frames[0].rx[response_index]);
    }
    return reply(SELF_TEST_PASS, 0);
}
