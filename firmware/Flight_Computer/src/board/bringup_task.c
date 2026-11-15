#include "bringup_task.h"

#include <string.h>

#include "app.h"
#include "board.h"
#include "board_bringup.h"
#include "board_chips.h"
#include "boot_report.h"
#include "cmsis_os2.h"
#include "led_show.h"
#include "main.h"
#include "mode.h"
#include "radio_task.h"
#include "self_test.h"
#include "self_test_devices.h"

bringup_report_t g_bringup_report;

/* Large state stays off the task stack. */
static board_bringup_t bringup;
static self_test_t self_test;

/*
 * Required vs warn-only follows Inez's proposal in #137 section 7 (the team
 * has not approved an arming policy; this only decides LED2).
 */
static const self_test_config_t config = {
    .device_count = 8,
    .devices =
        {
            {SELF_TEST_DEVICE_IMU, true},
            {SELF_TEST_DEVICE_HIGH_G, true},
            {SELF_TEST_DEVICE_BAROMETER, true},
            {SELF_TEST_DEVICE_RADIO, true},
            {SELF_TEST_DEVICE_EMMC, true},
            {SELF_TEST_DEVICE_GNSS, false},
            {SELF_TEST_DEVICE_ETHERNET, false},
            {SELF_TEST_DEVICE_NAND, false},
        },
    .probe_timeout_ms = 3000,
    .retry_interval_ms = 200,
    .heartbeat_interval_ms = 1000,
    .battery_interval_ms = 1000,
    .battery_max_age_ms = 3000,
    /* GNSS listens up to 1.5 s and SD init up to 1 s in one call; the
     * coordinator requires callback_budget <= tick_budget / 3. */
    .callback_budget_ms = 2000,
    .tick_budget_ms = 6000,
    .probe_max_attempts = 3, /* #137: 3 attempts; GNSS alternates baud */
    .publication_max_attempts = 1,
    .session_timeout_ms = 0, /* default 29 s: always finishes, #137 */
};

static void led(GPIO_TypeDef* port, uint16_t pin, bool on) {
    /* LEDs are active low: 3V3 -> resistor -> LED -> pin. */
    HAL_GPIO_WritePin(port, pin, on ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

static volatile bool idle_awake;

void bringup_leds_note_awake(bool on) {
    idle_awake = on;
}

void bringup_leds_refresh(void) {
    if (!g_bringup_report.finished) {
        return;
    }
    led_lamps_t lamps =
        led_show(app_state(), g_bringup_report.report.verdict,
                 radio_task_arm_pending(), board_now_ms(), idle_awake);
    led(LED1_GPIO_Port, LED1_Pin, lamps.yellow);
    led(LED2_GPIO_Port, LED2_Pin, lamps.green);
}

static void bringup_task(void* argument) {
    (void)argument;
    led(LED1_GPIO_Port, LED1_Pin, true);
    board_bringup_power_up(&bringup);

    const self_test_port_t port = {
        .probe = board_bringup_probe,
        .read_battery = board_bringup_read_battery,
        .publish_status = NULL, /* radio TX not written yet */
    };
    bool running =
        self_test_init(&self_test, &config, &port, &bringup, board_now_ms());
    uint32_t blink = 0;
    while (running) {
        self_test_tick(&self_test, board_now_ms());
        const self_test_status_t* status = self_test_status(&self_test);
        if (!status || status->probes_complete) {
            break;
        }
        g_bringup_report.self_test = *status; /* live view in the debugger */
        led(LED1_GPIO_Port, LED1_Pin, (++blink & 4U) != 0U); /* ~6 Hz */
        osDelay(20);
    }

    const self_test_status_t* status = self_test_status(&self_test);
    if (status) {
        g_bringup_report.self_test = *status;
    }
    board_adc_snapshot(&g_bringup_report.analog, 10);

    /* Battery: the coordinator's last sample (taken during the checks,
     * before anything transmits), or one fresh reading if it had none. */
    self_test_battery_t sample =
        status ? status->battery : (self_test_battery_t){0};
    if (!sample.valid) {
        sample = board_bringup_read_battery(&bringup, board_now_ms(), 50);
    }
    battery_t battery =
        battery_assess(sample.valid, sample.raw_counts, board_bringup_on_usb());
    boot_report_build(&g_bringup_report.report, status, battery,
                      board_now_ms());
    g_bringup_report.finished_at_ms = board_now_ms();
    g_bringup_report.finished = true;

    /* Chips are out of reset and checked: start the application tasks. */
    board_chips_init();
    g_bringup_report.app_started = app_start();

    /* 50 ms tracks the 80 ms armed blink. In Idle Stop this task freezes;
     * the Idle task refreshes once on the way into sleep. */
    for (;;) {
        bringup_leds_refresh();
        osDelay(50);
    }
}

board_bringup_t* bringup_task_board(void) {
    return &bringup;
}

void bringup_task_start(void) {
    static const osThreadAttr_t attributes = {
        .name = "bringup",
        .stack_size = 6 * 1024,
        .priority = osPriorityNormal,
    };
    osThreadNew(bringup_task, NULL, &attributes);
}
