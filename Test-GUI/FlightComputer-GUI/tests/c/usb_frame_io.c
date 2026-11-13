/*
 * The firmware's USB frame code (src/app/usb_frame.c), for tests/usb_frame.rs.
 *
 *   usb_frame_io encode       one frame per line, hex, 0x00 included
 *   usb_frame_io decode HEX   "type seq payload-hex", or "bad"
 *   usb_frame_io defaults     the firmware's default config blob, hex
 *   usb_frame_io check HEX    "bad-blob", or the first bad field (0 = ok)
 *   usb_frame_io reports      a Status then a Telemetry payload, hex
 */
#include <stdio.h>
#include <string.h>

#include "fc_config.h"
#include "status_report.h"
#include "usb_frame.h"

static void print_hex(const uint8_t* b, size_t n) {
    for (size_t i = 0; i < n; ++i) printf("%02x", b[i]);
}

static void encode(uint8_t type, const uint8_t* p, uint16_t n) {
    static uint8_t out[USB_FRAME_WIRE_MAX];
    size_t len = usb_frame_encode(type, 7, p, n, out);
    print_hex(out, len);
    printf("\n");
}

int main(int argc, char** argv) {
    static uint8_t p[600];
    if (argc == 2 && strcmp(argv[1], "encode") == 0) {
        uint16_t n = usb_frame_value(p, 200, 1, 3, 0, 1, "state", "", "SELF_TEST,IDLE");
        encode(0x83, p, n);
        for (int i = 0; i < 600; ++i) p[i] = (uint8_t)(i % 7); /* zeros */
        encode(0xB0, p, 600);
        memset(p, 0xAB, 300); /* a run longer than one COBS block */
        encode(0xB0, p, 300);
        encode(0x7F, p, 0);
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "reports") == 0) {
        status_report_t r = {0};
        r.state = 1;
        r.uptime_ms = 123456;
        r.sequence = 42;
        for (int i = 0; i < STATUS_ADC_COUNT; ++i) r.adc[i] = (uint16_t)(1000 * (i + 1));
        r.battery_mv = 7920;
        r.flags = STATUS_ON_USB;
        r.live_mask = 0x97;
        r.chips[0] = (status_chip_t){1, 0x6B};
        r.chips[7] = (status_chip_t){2, 9};
        r.radio_device_errors = 0x0020;
        uint8_t s[STATUS_REPORT_LEN];
        status_report_pack(&r, s);
        print_hex(s, sizeof s);
        printf("\n");
        telemetry_t t = {0};
        t.state = 2;
        t.uptime_ms = 5000;
        t.fresh = TELEMETRY_IMU | TELEMETRY_BARO;
        t.imu.accel[2] = 2049;
        t.baro.pressure_pa = 101325;
        t.lat_e7 = -123456789;
        t.hmsl_mm = 150000;
        t.fix_type = 3;
        t.num_sv = 11;
        uint8_t b[TELEMETRY_LEN];
        telemetry_pack(&t, b);
        print_hex(b, sizeof b);
        printf("\n");
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "defaults") == 0) {
        fc_config_t d = fc_config_defaults();
        uint8_t blob[FC_CONFIG_SIZE];
        fc_config_pack(&d, blob);
        print_hex(blob, sizeof blob);
        printf("\n");
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "check") == 0) {
        uint8_t blob[FC_CONFIG_SIZE + 1];
        size_t n = strlen(argv[2]) / 2;
        if (n > sizeof blob) return 2;
        for (size_t i = 0; i < n; ++i) sscanf(argv[2] + 2 * i, "%2hhx", &blob[i]);
        fc_config_t c;
        if (!fc_config_unpack(blob, n, &c)) {
            printf("bad-blob\n");
        } else {
            printf("%u\n", fc_config_check(&c));
        }
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "decode") == 0) {
        static uint8_t buf[USB_FRAME_WIRE_MAX];
        size_t n = strlen(argv[2]) / 2;
        for (size_t i = 0; i < n; ++i) sscanf(argv[2] + 2 * i, "%2hhx", &buf[i]);
        int len = usb_frame_decode(buf, n);
        if (len < 0) {
            printf("bad\n");
        } else {
            printf("%u %u ", buf[0], buf[1]);
            print_hex(buf + 2, (size_t)len);
            printf("\n");
        }
        return 0;
    }
    return 2;
}
