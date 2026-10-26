#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "self_test.h"
#include "self_test_devices.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

typedef struct {
    unsigned calls;
    uint16_t expected_id;
    uint8_t identity;
    uint16_t prom[8];
    uint8_t status[2];
    uint16_t errors;
    self_test_reply_t result;
} fake_t;

static self_test_reply_t exchange(void* context, uint16_t id, uint8_t mode,
                                  uint32_t max_hz,
                                  self_test_spi_frame_t* frames, uint8_t count,
                                  uint32_t budget_ms) {
    fake_t* fake = context;
    ++fake->calls;
    CHECK(id == fake->expected_id);
    CHECK(budget_ms == 7);
    for (uint8_t i = 0; i < count; ++i) {
        for (uint8_t j = 0; j < 4; ++j)
            CHECK(frames[i].rx[j] == 0);
    }
    if (id == SELF_TEST_DEVICE_BAROMETER) {
        CHECK(mode == 0 && max_hz == 20000000U && count == 8);
        for (uint8_t i = 0; i < count; ++i) {
            CHECK(frames[i].length == 3);
            CHECK(frames[i].tx[0] == 0xA0 + 2 * i);
            CHECK(frames[i].tx[1] == 0 && frames[i].tx[2] == 0);
            frames[i].rx[1] = (uint8_t)(fake->prom[i] >> 8);
            frames[i].rx[2] = (uint8_t)fake->prom[i];
        }
    } else if (id == SELF_TEST_DEVICE_RADIO) {
        CHECK(mode == 0 && max_hz == 16000000U && count == 2);
        const uint8_t status_cmd[4] = {0xC0, 0, 0, 0};
        const uint8_t errors_cmd[4] = {0x17, 0, 0, 0};
        CHECK(frames[0].length == 2 && frames[1].length == 4);
        CHECK(!memcmp(frames[0].tx, status_cmd, 4));
        CHECK(!memcmp(frames[1].tx, errors_cmd, 4));
        frames[0].rx[1] = fake->status[0];
        frames[1].rx[1] = fake->status[1];
        frames[1].rx[2] = (uint8_t)(fake->errors >> 8);
        frames[1].rx[3] = (uint8_t)fake->errors;
    } else if (id == SELF_TEST_DEVICE_ETHERNET) {
        const uint8_t command[4] = {0, 0x39, 0, 0};
        CHECK(mode == 0 && max_hz == 80000000U && count == 1);
        CHECK(frames[0].length == 4 && !memcmp(frames[0].tx, command, 4));
        frames[0].rx[3] = fake->identity;
    } else {
        const uint8_t command[4] = {0x8F, 0, 0, 0};
        CHECK(mode == 3 && max_hz == 10000000U && count == 1);
        CHECK(frames[0].length == 2 && !memcmp(frames[0].tx, command, 4));
        frames[0].rx[1] = fake->identity;
    }
    return fake->result;
}

static self_test_reply_t probe(self_test_devices_t* devices, fake_t* fake,
                               uint16_t id) {
    fake->expected_id = id;
    return self_test_devices_probe(devices, id, 1, 123, 7);
}

int main(void) {
    fake_t fake = {.result = {SELF_TEST_PASS, 0}};
    self_test_devices_t devices = {.exchange = exchange, .io_context = &fake};
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_IMU).result ==
          SELF_TEST_NOT_CONFIGURED);
    CHECK(self_test_devices_probe(NULL, 0, 1, 0, 7).result ==
          SELF_TEST_NOT_CONFIGURED);
    devices.configured_mask = 0xFF;
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_GNSS).result ==
          SELF_TEST_NOT_IMPLEMENTED);
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_NAND).result ==
          SELF_TEST_NOT_IMPLEMENTED);
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_EMMC).result ==
          SELF_TEST_NOT_IMPLEMENTED);
    CHECK(probe(&devices, &fake, UINT16_MAX).result ==
          SELF_TEST_NOT_IMPLEMENTED);
    CHECK(self_test_devices_probe(&devices, 0, 1, 0, 0).result ==
          SELF_TEST_TIMEOUT);
    devices.exchange = NULL;
    CHECK(probe(&devices, &fake, 0).result == SELF_TEST_NOT_IMPLEMENTED);
    CHECK(fake.calls == 0);
    devices.exchange = exchange;

    const uint16_t ids[] = {SELF_TEST_DEVICE_IMU, SELF_TEST_DEVICE_HIGH_G,
                            SELF_TEST_DEVICE_ETHERNET};
    const uint8_t identities[] = {0x6B, 0x32, 0x04};
    for (unsigned i = 0; i < 3; ++i) {
        fake.identity = identities[i];
        CHECK(probe(&devices, &fake, ids[i]).result == SELF_TEST_PASS);
        fake.identity ^= 1;
        self_test_reply_t bad = probe(&devices, &fake, ids[i]);
        CHECK(bad.result == SELF_TEST_FAIL);
        CHECK(bad.diagnostic == (SELF_TEST_DIAG_IDENTITY | fake.identity));
        fake.identity = 0;
        CHECK(probe(&devices, &fake, ids[i]).result == SELF_TEST_FAIL);
        fake.identity = 0xFF;
        CHECK(probe(&devices, &fake, ids[i]).result == SELF_TEST_FAIL);
    }

    /* Independent manufacturer AN520 example: expected CRC is 0xB. */
    const uint16_t reference[8] = {0x3132, 0x3334, 0x3536, 0x3738,
                                   0x3940, 0x4142, 0x4344, 0x450B};
    memcpy(fake.prom, reference, sizeof(reference));
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_BAROMETER).result ==
          SELF_TEST_PASS);
    fake.prom[7] = 0x45FB; /* Entire low byte excluded, not just CRC nibble. */
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_BAROMETER).result ==
          SELF_TEST_PASS);
    for (unsigned word = 0; word < 7; ++word) {
        for (unsigned bit = 0; bit < 16; ++bit) {
            memcpy(fake.prom, reference, sizeof(reference));
            fake.prom[word] ^= (uint16_t)(1U << bit);
            CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_BAROMETER).result ==
                  SELF_TEST_FAIL);
        }
    }
    memcpy(fake.prom, reference, sizeof(reference));
    fake.prom[7] ^= 1;
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_BAROMETER).result ==
          SELF_TEST_FAIL);
    memset(fake.prom, 0, sizeof(fake.prom));
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_BAROMETER).diagnostic ==
          SELF_TEST_DIAG_BLANK_PROM);
    memset(fake.prom, 0xFF, sizeof(fake.prom));
    CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_BAROMETER).diagnostic ==
          SELF_TEST_DIAG_BLANK_PROM);

    for (unsigned mode = 2; mode <= 6; ++mode) {
        fake.status[0] = fake.status[1] = (uint8_t)((mode << 4) | 4);
        CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_RADIO).result ==
              SELF_TEST_PASS);
    }
    for (unsigned frame = 0; frame < 2; ++frame) {
        const uint8_t bad_status[] = {0, 0xFF, 0x10, 0x70, 0x26, 0x28, 0x2A};
        for (unsigned i = 0; i < sizeof(bad_status); ++i) {
            fake.status[0] = fake.status[1] = 0x24;
            fake.status[frame] = bad_status[i];
            CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_RADIO).diagnostic ==
                  (SELF_TEST_DIAG_RADIO_STATUS | bad_status[i]));
        }
    }
    fake.status[0] = fake.status[1] = 0x24;
    for (unsigned bit = 0; bit < 16; ++bit) {
        fake.errors = (uint16_t)(1U << bit);
        CHECK(probe(&devices, &fake, SELF_TEST_DEVICE_RADIO).diagnostic ==
              (SELF_TEST_DIAG_RADIO_ERRORS | fake.errors));
    }
    fake.errors = 0;
    /* A valid payload must never hide a failed/partial transport. */
    const self_test_result_t failures[] = {
        SELF_TEST_PENDING, SELF_TEST_FAIL, SELF_TEST_TIMEOUT,
        SELF_TEST_NOT_CONFIGURED, SELF_TEST_NOT_IMPLEMENTED};
    for (unsigned i = 0; i < sizeof(failures) / sizeof(failures[0]); ++i) {
        fake.result = (self_test_reply_t){failures[i], 1234};
        for (uint16_t id = 0; id <= SELF_TEST_DEVICE_RADIO; ++id) {
            self_test_reply_t result = probe(&devices, &fake, id);
            CHECK(result.result == failures[i] && result.diagnostic == 1234);
        }
    }
    fake.result = (self_test_reply_t){SELF_TEST_PASS, 0};
    fake.identity = 0x6B;
    fake.expected_id = SELF_TEST_DEVICE_IMU;
    self_test_t coordinator = {0};
    self_test_config_t config = {.device_count = 1,
                                 .devices = {{SELF_TEST_DEVICE_IMU, true}},
                                 .probe_timeout_ms = 100,
                                 .retry_interval_ms = 10,
                                 .heartbeat_interval_ms = 1000,
                                 .battery_interval_ms = 1000,
                                 .battery_max_age_ms = 2000,
                                 .callback_budget_ms = 7,
                                 .tick_budget_ms = 21,
                                 .probe_max_attempts = 2,
                                 .publication_max_attempts = 2};
    const self_test_port_t port = {.probe = self_test_devices_probe};
    CHECK(self_test_init(&coordinator, &config, &port, &devices, 0));
    self_test_tick(&coordinator, 0);
    CHECK(self_test_status(&coordinator)->probes_outcome == SELF_TEST_PASS);
    CHECK(self_test_reset(&coordinator, 1));
    fake.identity = 0;
    self_test_tick(&coordinator, 1);
    CHECK(self_test_status(&coordinator)->devices[0].reply.result ==
          SELF_TEST_FAIL);
    puts("Device protocol checks passed");
    return 0;
}
