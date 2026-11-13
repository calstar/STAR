#include "boot_report.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "self_test_devices.h"

static const char* device_name(uint16_t id) {
    switch (id) {
        case SELF_TEST_DEVICE_IMU:
            return "IMU ISM330DHCX";
        case SELF_TEST_DEVICE_HIGH_G:
            return "high-g H3LIS100DL";
        case SELF_TEST_DEVICE_BAROMETER:
            return "baro MS5611";
        case SELF_TEST_DEVICE_ETHERNET:
            return "ethernet W5500";
        case SELF_TEST_DEVICE_RADIO:
            return "radio SX1262";
        case SELF_TEST_DEVICE_GNSS:
            return "GPS MAX-M10S";
        case SELF_TEST_DEVICE_NAND:
            return "SD NAND";
        case SELF_TEST_DEVICE_EMMC:
            return "eMMC";
        default:
            return "device ?";
    }
}

static const char* result_name(self_test_result_t r) {
    switch (r) {
        case SELF_TEST_PASS:
            return "PASS";
        case SELF_TEST_FAIL:
            return "FAIL";
        case SELF_TEST_TIMEOUT:
            return "TIMEOUT";
        case SELF_TEST_NOT_CONFIGURED:
            return "NOT CONFIGURED";
        case SELF_TEST_NOT_IMPLEMENTED:
            return "NOT IMPLEMENTED";
        default:
            return "PENDING";
    }
}

const char* boot_verdict_name(boot_verdict_t v) {
    switch (v) {
        case BOOT_READY:
            return "READY";
        case BOOT_WARN:
            return "WARN";
        default:
            return "FAIL";
    }
}

typedef struct {
    char* buf;
    size_t cap, len;
} text_t;

static void put(text_t* t, const char* fmt, ...) {
    if (t->len + 1 >= t->cap) {
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(t->buf + t->len, t->cap - t->len, fmt, ap);
    va_end(ap);
    if (n > 0) {
        t->len += (size_t)n;
        if (t->len >= t->cap) {
            t->len = t->cap - 1; /* truncated */
        }
    }
}

void boot_report_build(boot_report_t* r, const self_test_status_t* s,
                       battery_t battery, uint32_t now_ms) {
    memset(r, 0, sizeof(*r));
    r->battery = battery;
    text_t t = {r->text, sizeof(r->text), 0};
    put(&t, "STAR flight computer self-test, t = %lu.%lu s\n",
        (unsigned long)(now_ms / 1000U),
        (unsigned long)(now_ms % 1000U / 100U));

    if (!s) {
        r->required_failed = 1;
        put(&t, "  self-test did not run (bad config)\n");
    } else {
        for (uint8_t i = 0; i < s->device_count && i < SELF_TEST_MAX_DEVICES;
             ++i) {
            const self_test_device_status_t* d = &s->devices[i];
            bool pass = d->reply.result == SELF_TEST_PASS;
            if (pass && d->device_id < 16U) {
                r->result_bits =
                    (uint16_t)(r->result_bits | (1U << d->device_id));
            } else if (!pass && d->required) {
                r->required_failed++;
            } else if (!pass) {
                r->optional_failed++;
            }
            put(&t, "  %-18s %-15s", device_name(d->device_id),
                result_name(d->reply.result));
            if (d->device_id == SELF_TEST_DEVICE_GNSS && pass) {
                /* board_bringup.h: a GNSS PASS carries the baud it heard */
                put(&t, " %ld baud", (long)d->reply.diagnostic);
            } else if (d->reply.diagnostic != 0) {
                put(&t, " diag 0x%lx",
                    (unsigned long)(uint32_t)d->reply.diagnostic);
            }
            if (d->attempts > 1U) {
                put(&t, " (%u tries)", (unsigned)d->attempts);
            }
            put(&t, "%s", d->required ? "" : " [optional]");
            while (t.len > 0 && t.buf[t.len - 1] == ' ') {
                t.buf[--t.len] = '\0'; /* no trailing padding */
            }
            put(&t, "\n");
        }
    }

    if (battery.state == BATTERY_INVALID || battery.state == BATTERY_UNKNOWN) {
        put(&t, "  %-18s %s\n", "battery", battery_state_name(battery.state));
    } else {
        put(&t, "  %-18s %u.%02u V  %s\n", "battery", battery.mv / 1000U,
            (battery.mv % 1000U) / 10U, battery_state_name(battery.state));
    }

    bool battery_bad = battery.state == BATTERY_FAIL ||
                       battery.state == BATTERY_INVALID ||
                       battery.state == BATTERY_UNKNOWN;
    if (r->required_failed || battery_bad) {
        r->verdict = BOOT_FAIL;
    } else if (r->optional_failed || battery.state == BATTERY_WARN) {
        r->verdict = BOOT_WARN;
    } else {
        r->verdict = BOOT_READY;
    }
    put(&t, "  %-18s %s (%u required, %u optional failed)\n", "verdict",
        boot_verdict_name(r->verdict), (unsigned)r->required_failed,
        (unsigned)r->optional_failed);
}
