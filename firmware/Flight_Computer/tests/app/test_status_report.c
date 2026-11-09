/* status_report: the Status and Telemetry payloads, byte for byte. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "status_report.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void test_status_round_trip_and_layout(void) {
    status_report_t r = {0}, back;
    r.state = 1;
    r.uptime_ms = 0x11223344;
    r.sequence = 7;
    for (int i = 0; i < STATUS_ADC_COUNT; ++i) {
        r.adc[i] = (uint16_t)(0x1000 + i);
    }
    r.battery_mv = 7920;
    r.flags = STATUS_ON_USB;
    r.live_mask = 0x97;
    r.chips[0] = (status_chip_t){1, 0x6B}; /* IMU WHO_AM_I */
    r.chips[7] = (status_chip_t){1, 4};    /* eMMC in transfer state */
    r.radio_device_errors = 0x0020;
    uint8_t b[STATUS_REPORT_LEN];
    status_report_pack(&r, b);
    /* Fixed positions the ground station decodes. */
    CHECK(b[0] == 1 && b[1] == 0x44 && b[4] == 0x11);
    CHECK(b[9] == 0x00 && b[10] == 0x10); /* adc[0] at 9..10 */
    CHECK(b[23] == (7920 & 0xFF) && b[25] == STATUS_ON_USB && b[26] == 0x97);
    CHECK(b[27] == 1 && b[28] == 0x6B); /* chip 0 at 27..28 */
    CHECK(b[43] == 0x20 && b[44] == 0x00);
    CHECK(status_report_unpack(b, sizeof b, &back));
    CHECK(back.uptime_ms == r.uptime_ms && back.adc[6] == 0x1006);
    CHECK(back.chips[7].value == 4 && back.radio_device_errors == 0x20);
    CHECK(!status_report_unpack(b, sizeof b - 1, &back));
}

static void test_telemetry_round_trip_and_layout(void) {
    telemetry_t t = {0}, back;
    t.state = 2;
    t.uptime_ms = 1000;
    t.fresh = TELEMETRY_IMU | TELEMETRY_GNSS;
    t.imu.accel[2] = 2048; /* ~1 g at +-16 g */
    t.highg.accel[0] = -3;
    t.baro.pressure_pa = 101325;
    t.lat_e7 = -123456789;
    t.hmsl_mm = 150000;
    t.fix_type = 3;
    t.num_sv = 11;
    uint8_t b[TELEMETRY_LEN];
    telemetry_pack(&t, b);
    CHECK(b[0] == 2 && b[5] == (TELEMETRY_IMU | TELEMETRY_GNSS));
    CHECK(b[6 + 16] == 0x00 && b[6 + 17] == 0x08); /* imu accel z at 22..23 */
    CHECK(b[55] == 3 && b[56] == 11);
    CHECK(telemetry_unpack(b, sizeof b, &back));
    CHECK(back.imu.accel[2] == 2048 && back.highg.accel[0] == -3);
    CHECK(back.baro.pressure_pa == 101325 && back.lat_e7 == -123456789);
    CHECK(back.hmsl_mm == 150000 && back.num_sv == 11);
    CHECK(!telemetry_unpack(b, sizeof b + 1, &back));
}

int main(void) {
    test_status_round_trip_and_layout();
    test_telemetry_round_trip_and_layout();
    printf("test_status_report: ok\n");
    return 0;
}
