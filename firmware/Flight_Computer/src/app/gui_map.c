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

#include "board_bringup.h"
#include "board_config.h"
#include "bringup_task.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
#include "idle_task.h"
#include "mode.h"
#include "radio_task.h"
#include "sensors_task.h"
#include "usb_frame.h"
#include "usb_link.h"

#define FLIGHT "SELF_TEST,IDLE,ARMED,LAUNCHED,RECOVERY"
#define BATTERY "UNKNOWN,OK,WARN,FAIL,USB,INVALID"
#define RESULT "PENDING,PASS,FAIL,TIMEOUT,NOT_CONFIGURED,NOT_IMPLEMENTED"
#define DISK "UNMOUNTED,MOUNTED,FULL,FAULT"
#define FIX "NO_FIX,DEAD_RECKONING,2D,3D,GNSS_DR,TIME_ONLY"
/* SetupStep (sx1262_setup.h): OK, or the first start-up step that failed */
#define SETUP                                                              \
    "OK,STANDBY,REGULATOR,TCXO,CALIBRATE,RF_SWITCH,PACKET_TYPE,FREQUENCY," \
    "IMAGE_CAL,PA_CONFIG,TX_PARAMS,BUFFER_BASE,MODULATION,PACKET_PARAMS,"  \
    "IRQ_MAP,TX_CLAMP,SYNC_WORD,DEVICE_ERRORS,START_RX"

/* clang-format off */
#define GUI_MAP(X)                                                                          \
    X(U8,  app_state(),                           "state",               "",       FLIGHT)  \
    X(U8,  flags(),                               "flags",               "",       "")      \
    X(U32, osKernelGetTickCount(),                "uptime",              "ms",     "")      \
    X(U16, idle->last.supply_mv,                  "battery",             "mV",     "")      \
    X(U8,  idle->last.battery,                    "battery_state",       "",       BATTERY) \
    X(U32, idle->last.sequence,                   "idle_heartbeats",     "",       "")      \
    X(U8,  idle->last.previous_send,              "idle_last_send",      "",       RESULT)  \
    X(U16, report.adc[0],                         "adc_vbat",            "counts", "")      \
    X(U16, report.adc[1],                         "adc_ext_sense_1",     "counts", "")      \
    X(U16, report.adc[2],                         "adc_pyro_1_cont",     "counts", "")      \
    X(U16, report.adc[3],                         "adc_pyro_2_cont",     "counts", "")      \
    X(U16, report.adc[4],                         "adc_ext_sense_2",     "counts", "")      \
    X(U16, report.adc[5],                         "adc_alt_curr",        "counts", "")      \
    X(U16, report.adc[6],                         "adc_curr",            "counts", "")      \
    X(U32, radio.setup_attempts,                  "radio_setups",        "",       "")      \
    X(U8,  radio.setup_step,                      "radio_setup",         "",       SETUP)   \
    X(U8,  self_test(SELF_TEST_DEVICE_IMU),       "self_test_imu",       "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_HIGH_G),    "self_test_high_g",    "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_BAROMETER), "self_test_barometer", "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_ETHERNET),  "self_test_ethernet",  "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_RADIO),     "self_test_radio",     "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_GNSS),      "self_test_gnss",      "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_NAND),      "self_test_nand",      "",       RESULT)  \
    X(U8,  self_test(SELF_TEST_DEVICE_EMMC),      "self_test_emmc",      "",       RESULT)  \
    X(U8,  gnss->latest.fix_type,                 "gnss_fix",            "",       FIX)     \
    X(U8,  gnss->latest.num_sv,                   "gnss_satellites",     "",       "")      \
    X(U8,  emmc->disk,                            "emmc",                "",       DISK)    \
    X(U32, log_used(),                            "emmc_blocks_used",    "",       "")      \
    X(U32, emmc->capacity,                        "emmc_blocks_total",   "",       "")      \
    X(U32, emmc->stats.dropped,                   "emmc_dropped",        "",       "")      \
    X(U32, sensor_errors(),                       "sensor_errors",       "",       "")      \
    X(U16, usb_link_rate_hz(),                    "stream_rate_hz",      "Hz",     "")
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

/* Every row fits one VALUE payload (7 bytes + three NUL-ended strings), or
 * the build stops here instead of the row going out empty. */
#define X(type, expr, name, unit, labels)                               \
    _Static_assert(7U + sizeof(name) + sizeof(unit) + sizeof(labels) <= \
                       GUI_VALUE_MAX,                                   \
                   "gui_map row " name " is longer than GUI_VALUE_MAX");
GUI_MAP(X)
#undef X

static uint32_t values[COUNT];
static sensors_core_t sensors; /* a snapshot: too big for the stack */
static const idle_t* idle;
static const gnss_core_t* gnss;
static radio_status_t radio;
static status_report_t report; /* the last Idle report (idle_task.c) */
static const emmc_log_t* emmc;

static uint8_t flags(void) {
    /* bit 0 on USB power, 1 settings not saved, 2 streaming, 3 flash held
     * no settings at boot (running the defaults) */
    return (uint8_t)((board_bringup_on_usb() ? 1U : 0U) |
                     (board_config_unsaved() ? 2U : 0U) |
                     (usb_link_rate_hz() ? 4U : 0U) |
                     (board_config_from_defaults() ? 8U : 0U));
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

static uint32_t sensor_errors(void) {
    return sensors.imu.errors + sensors.highg.errors + sensors.baro.errors;
}

uint8_t gui_map_count(void) {
    return (uint8_t)COUNT;
}

void gui_map_read(void) {
    sensors_task_snapshot(&sensors);
    idle = idle_task_state();
    gnss = gnss_task_core();
    radio_task_status(&radio);
    idle_task_last_status(&report);
    emmc = emmc_stm32_log();
    size_t i = 0;
#define X(type, expr, name, unit, labels) values[i++] = RAW_##type(expr);
    GUI_MAP(X)
#undef X
}

uint16_t gui_map_value(uint8_t i, uint8_t* out) {
    if (i >= COUNT) {
        return 0;
    }
    return usb_frame_value(out, GUI_VALUE_MAX, i, (uint8_t)COUNT, rows[i].type,
                           values[i], rows[i].name, rows[i].unit,
                           rows[i].labels);
}
