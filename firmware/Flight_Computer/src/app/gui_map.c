/*
 * The bridge between the firmware and the GUI. One row per value:
 *
 *   type  firmware expression  =  GUI name  unit  labels
 *
 * The GUI shows the rows it is sent, in this order: add, rename or remove a
 * row here and the GUI follows, with no GUI change. The expression is read
 * when the row is sent. Labels name an enum's values, from 0. The GUI reads
 * only "state", "flags" and "stream_rate_hz" itself; keep those names.
 */
#include "gui_map.h"

#include <string.h>

#include "board_bringup.h"
#include "bringup_task.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
#include "idle_task.h"
#include "mode.h"
#include "sensors_task.h"
#include "usb_link.h"

#define FLIGHT "SELF_TEST,IDLE,ARMED,LAUNCHED,RECOVERY"
#define BATTERY "UNKNOWN,OK,WARN,FAIL,USB,INVALID"
#define RESULT "PENDING,PASS,FAIL,TIMEOUT,NOT_CONFIGURED,NOT_IMPLEMENTED"
#define DISK "UNMOUNTED,MOUNTED,FULL,FAULT"
#define FIX "NO_FIX,DEAD_RECKONING,2D,3D,GNSS_DR,TIME_ONLY"

/* clang-format off */
#define GUI_MAP(X)                                                                         \
    X(U8,  app_state(),                         "state",             "",   FLIGHT)         \
    X(U8,  flags(),                             "flags",             "",   "")             \
    X(U32, osKernelGetTickCount(),              "uptime",            "ms", "")             \
    X(U16, idle->last.supply_mv,                "battery",           "mV", "")             \
    X(U8,  idle->last.battery,                  "battery_state",     "",   BATTERY)        \
    X(U8,  self_test(SELF_TEST_DEVICE_IMU),       "self_test_imu",       "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_HIGH_G),    "self_test_high_g",    "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_BAROMETER), "self_test_barometer", "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_ETHERNET),  "self_test_ethernet",  "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_RADIO),     "self_test_radio",     "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_GNSS),      "self_test_gnss",      "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_NAND),      "self_test_nand",      "", RESULT)       \
    X(U8,  self_test(SELF_TEST_DEVICE_EMMC),      "self_test_emmc",      "", RESULT)       \
    X(U8,  gnss->latest.fix_type,               "gnss_fix",          "",   FIX)            \
    X(U8,  gnss->latest.num_sv,                 "gnss_satellites",   "",   "")             \
    X(U8,  emmc->disk,                           "emmc",              "",   DISK)           \
    X(U32, log_used(),                          "emmc_blocks_used",  "",   "")             \
    X(U32, emmc->capacity,                       "emmc_blocks_total", "",   "")             \
    X(U32, emmc->stats.dropped,                  "emmc_dropped",      "",   "")             \
    X(U32, sensors.imu.errors + sensors.highg.errors + sensors.baro.errors, "sensor_errors", "", "")         \
    X(U16, usb_link_rate_hz(),                  "stream_rate_hz",    "Hz", "")
/* clang-format on */

enum { GUI_U8, GUI_U16, GUI_U32, GUI_I8, GUI_I16, GUI_I32 };
#define RAW_U8(e) ((uint32_t)(uint8_t)(e))
#define RAW_U16(e) ((uint32_t)(uint16_t)(e))
#define RAW_U32(e) ((uint32_t)(e))
#define RAW_I8(e) ((uint32_t)(int32_t)(int8_t)(e))
#define RAW_I16(e) ((uint32_t)(int32_t)(int16_t)(e))
#define RAW_I32(e) ((uint32_t)(int32_t)(e))

static const struct {
    uint8_t type;
    const char *name, *unit, *labels;
} rows[] = {
#define X(type, expr, name, unit, labels) {GUI_##type, name, unit, labels},
    GUI_MAP(X)
#undef X
};
#define COUNT (sizeof rows / sizeof rows[0])

static uint32_t values[COUNT];
static sensors_core_t sensors; /* a snapshot: too big for the stack */
static const idle_t* idle;
static const gnss_core_t* gnss;
static const emmc_log_t* emmc;

static uint8_t flags(void) {
    /* bit 0 on USB power, bit 2 streaming, bit 3 running defaults (no
     * config storage yet) */
    return (uint8_t)((board_bringup_on_usb() ? 1U : 0U) |
                     (usb_link_rate_hz() ? 4U : 0U) | 8U);
}

static uint8_t self_test(uint16_t id) {
    const self_test_status_t* st = &g_bringup_report.self_test;
    for (uint8_t i = 0; i < st->device_count; ++i) {
        if (st->devices[i].device_id == id) {
            return (uint8_t)st->devices[i].reply.result;
        }
    }
    return SELF_TEST_PENDING;
}

static uint32_t log_used(void) {
    return emmc->disk == EMMC_DISK_UNMOUNTED
               ? 0U
               : emmc->head - emmc->config.data_start_lba;
}

uint8_t gui_map_count(void) {
    return (uint8_t)COUNT;
}

void gui_map_read(void) {
    sensors_task_snapshot(&sensors);
    idle = idle_task_state();
    gnss = gnss_task_core();
    emmc = emmc_stm32_log();
    size_t i = 0;
#define X(type, expr, name, unit, labels) values[i++] = RAW_##type(expr);
    GUI_MAP(X)
#undef X
}

static uint16_t put_str(uint8_t* out, uint16_t at, const char* str) {
    size_t n = strlen(str) + 1U; /* with its NUL */
    if (at + n > GUI_VALUE_MAX) {
        n = 0;
    }
    memcpy(out + at, str, n);
    return (uint16_t)(at + n);
}

/* index u8, count u8, type u8, value u32, then name, unit, labels (NUL
 * ended) */
uint16_t gui_map_value(uint8_t i, uint8_t* out) {
    if (i >= COUNT) {
        return 0;
    }
    out[0] = i;
    out[1] = (uint8_t)COUNT;
    out[2] = rows[i].type;
    memcpy(out + 3, &values[i], 4); /* little-endian */
    uint16_t n = put_str(out, 7, rows[i].name);
    n = put_str(out, n, rows[i].unit);
    return put_str(out, n, rows[i].labels);
}
