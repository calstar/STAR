/* battery + boot_report: the start-up self-test's verdict and text. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "battery.h"
#include "boot_report.h"
#include "self_test_devices.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

/* Counts computed independently in Python from the schematic:
 * mV = round(counts x 3320 / 0.3125 / 65535). Aaron's PR #162 examples:
 * 40712 -> 6600, 51818 -> 8400. Physically, a full 8.40 V pack puts
 * 8.40 x 0.3125 = 2.625 V on PA0 = 2.625 / 3.32 x 65535 = 51816 counts. */
static void test_conversion(void) {
    CHECK(battery_counts_to_mv(0) == 0);
    CHECK(battery_counts_to_mv(65535) == 10624);
    CHECK(battery_counts_to_mv(40712) == 6600);
    CHECK(battery_counts_to_mv(51818) == 8400);
    CHECK(battery_counts_to_mv(51816) == 8400);
    CHECK(battery_counts_to_mv(48853) == 7920);
    CHECK(battery_counts_to_mv(65536) == 0); /* not a 16-bit reading */
}

static void test_thresholds(void) {
    CHECK(battery_assess(true, 51816, false).state == BATTERY_OK);
    CHECK(battery_assess(true, 43177, false).state == BATTERY_OK);   /* 7000 */
    CHECK(battery_assess(true, 43176, false).state == BATTERY_WARN); /* 6999 */
    CHECK(battery_assess(true, 40710, false).state == BATTERY_WARN); /* 6600 */
    CHECK(battery_assess(true, 40709, false).state == BATTERY_FAIL); /* 6599 */
    CHECK(battery_assess(true, 54286, false).state == BATTERY_OK);   /* 8800 */
    CHECK(battery_assess(true, 54287, false).state == BATTERY_FAIL); /* 8801 */
    CHECK(battery_assess(true, 0, false).state == BATTERY_FAIL);     /* none */
    /* On USB the reading is USB_5V, never judged as the pack. */
    battery_t usb = battery_assess(true, 30840, true);
    CHECK(usb.state == BATTERY_USB && usb.mv == 5000);
    CHECK(battery_assess(true, 0, true).state == BATTERY_USB);
    CHECK(battery_assess(false, 51816, false).state == BATTERY_INVALID);
    CHECK(battery_assess(false, 51816, false).mv == 0);
}

/* The board's 8 checks, all passing; required as in bringup_task.c. */
static self_test_status_t all_pass(void) {
    static const struct {
        uint16_t id;
        bool required;
    } inv[8] = {
        {SELF_TEST_DEVICE_IMU, true},       {SELF_TEST_DEVICE_HIGH_G, true},
        {SELF_TEST_DEVICE_BAROMETER, true}, {SELF_TEST_DEVICE_RADIO, true},
        {SELF_TEST_DEVICE_EMMC, true},      {SELF_TEST_DEVICE_GNSS, false},
        {SELF_TEST_DEVICE_ETHERNET, false}, {SELF_TEST_DEVICE_NAND, false},
    };
    self_test_status_t s;
    memset(&s, 0, sizeof(s));
    s.device_count = 8;
    for (int i = 0; i < 8; ++i) {
        s.devices[i].device_id = inv[i].id;
        s.devices[i].required = inv[i].required;
        s.devices[i].complete = true;
        s.devices[i].attempts = 1;
        s.devices[i].reply.result = SELF_TEST_PASS;
    }
    return s;
}

static boot_report_t r;

static void test_all_pass_on_battery_is_ready(void) {
    self_test_status_t s = all_pass();
    boot_report_build(&r, &s, battery_assess(true, 48853, false), 3250);
    CHECK(r.verdict == BOOT_READY);
    CHECK(r.result_bits == 0x00FF); /* device ids 0..7 all passed */
    CHECK(r.required_failed == 0 && r.optional_failed == 0);
    CHECK(strstr(r.text, "t = 3.2 s"));
    CHECK(strstr(r.text, "IMU ISM330DHCX     PASS\n"));
    CHECK(strstr(r.text, "battery            7.92 V  OK"));
    CHECK(strstr(r.text, "verdict            READY"));
}

static void test_optional_chip_or_low_battery_is_warn(void) {
    self_test_status_t s = all_pass();
    s.devices[5].reply.result = SELF_TEST_TIMEOUT; /* GPS, optional */
    s.devices[5].attempts = 3;
    boot_report_build(&r, &s, battery_assess(true, 48853, false), 1000);
    CHECK(r.verdict == BOOT_WARN && r.optional_failed == 1);
    CHECK(r.result_bits == (0x00FF & ~(1U << SELF_TEST_DEVICE_GNSS)));
    CHECK(strstr(r.text,
                 "GPS MAX-M10S       TIMEOUT         (3 tries) [optional]"));

    s = all_pass();
    boot_report_build(&r, &s, battery_assess(true, 42000, false), 1000);
    CHECK(r.verdict == BOOT_WARN);
    CHECK(strstr(r.text, "6.80 V  LOW, charge before flight"));
}

static void test_required_chip_or_bad_battery_is_fail(void) {
    self_test_status_t s = all_pass();
    s.devices[2].reply.result = SELF_TEST_FAIL; /* baro, required */
    s.devices[2].reply.diagnostic = 0x30000;    /* PROM CRC */
    boot_report_build(&r, &s, battery_assess(true, 48853, false), 1000);
    CHECK(r.verdict == BOOT_FAIL && r.required_failed == 1);
    CHECK(!strstr(r.text, " \n")); /* no trailing padding */
    CHECK(strstr(r.text, "baro MS5611        FAIL            diag 0x30000"));

    s = all_pass();
    boot_report_build(&r, &s, battery_assess(true, 40000, false), 1000);
    CHECK(r.verdict == BOOT_FAIL); /* 6.48 V */
    boot_report_build(&r, &s, battery_assess(false, 0, false), 1000);
    CHECK(r.verdict == BOOT_FAIL);
    CHECK(strstr(r.text, "battery            ADC read failed"));
    boot_report_build(&r, NULL, battery_assess(true, 48853, false), 1000);
    CHECK(r.verdict == BOOT_FAIL && r.result_bits == 0);
}

static void test_gps_reports_its_baud(void) {
    self_test_status_t s = all_pass();
    s.devices[5].reply.diagnostic = 9600; /* GNSS PASS: baud that worked */
    boot_report_build(&r, &s, battery_assess(true, 48853, false), 1000);
    CHECK(strstr(r.text,
                 "GPS MAX-M10S       PASS            9600 baud [optional]\n"));
}

static void test_usb_is_not_judged(void) {
    self_test_status_t s = all_pass();
    boot_report_build(&r, &s, battery_assess(true, 30840, true), 1000);
    CHECK(r.verdict == BOOT_READY);
    CHECK(strstr(r.text, "5.00 V  on USB (battery not measured)"));
}

int main(void) {
    test_conversion();
    test_thresholds();
    test_all_pass_on_battery_is_ready();
    test_optional_chip_or_low_battery_is_warn();
    test_required_chip_or_bad_battery_is_fail();
    test_gps_reports_its_baud();
    test_usb_is_not_judged();
    puts("boot_report: all tests passed");
    return 0;
}
