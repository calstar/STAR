#include "idle_task.h"

#include "board_bringup.h"
#include "board_config.h"
#include "board_sleep.h"
#include "bringup_task.h"
#include "cmsis_os2.h"
#include "main.h"
#include "mode.h"
#include "radio_task.h"

#define EV_MODE (1U << 0)
#define EV_CMD (1U << 1)
#define FRAME_HEARTBEAT 0x01U /* src/radio/frame.h FrameType::Heartbeat */

/* Aaron's proposals (src/app/IDLE.md); the budget covers one SF9 TxDone
 * (2 x 165 ms time on air + 50 ms, sx1262_setup.cpp). */
static idle_config_t config = {
    .heartbeat_interval_ms = 10000,
    .wake_tolerance_ms = 500,
    .callback_budget_ms = 500,
    .battery_warn_mv = 7000,
    .battery_fail_mv = 6600,
    .battery_hysteresis_mv = 100,
};

static idle_t idle;
static osThreadId_t thread;
static osMessageQueueId_t commands;
static volatile bool want_active;

static self_test_battery_t read_battery(void* ctx, uint32_t now_ms,
                                        uint32_t budget_ms) {
    (void)ctx;
    return board_bringup_read_battery(bringup_task_board(), now_ms, budget_ms);
}

static bool on_usb(void* ctx) {
    (void)ctx;
    return board_bringup_on_usb();
}

static self_test_reply_t send_heartbeat(void* ctx, const idle_heartbeat_t* hb,
                                        uint32_t budget_ms) {
    (void)ctx;
    (void)budget_ms; /* the radio task bounds TxDone itself */
    bool pack = hb->battery == IDLE_BATT_OK || hb->battery == IDLE_BATT_WARN ||
                hb->battery == IDLE_BATT_FAIL;
    uint16_t mv = pack ? hb->supply_mv : 0U;
    uint32_t up_s = hb->uptime_ms / 1000U;
    const uint8_t payload[7] = {(uint8_t)FLIGHT_IDLE, (uint8_t)mv,
                                (uint8_t)(mv >> 8),   (uint8_t)up_s,
                                (uint8_t)(up_s >> 8), (uint8_t)(up_s >> 16),
                                (uint8_t)(up_s >> 24)};
    switch (radio_task_send_frame(FRAME_HEARTBEAT, payload, sizeof payload)) {
        case RADIO_SEND_OK:
            return (self_test_reply_t){SELF_TEST_PASS, 0};
        case RADIO_SEND_TIMEOUT:
            return (self_test_reply_t){SELF_TEST_TIMEOUT, 0};
        default:
            return (self_test_reply_t){SELF_TEST_FAIL, 0};
    }
}

static idle_command_t poll_command(void* ctx) {
    (void)ctx;
    uint8_t c;
    if (osMessageQueueGet(commands, &c, NULL, 0) != osOK) {
        return IDLE_CMD_NONE;
    }
    return c == MODE_CMD_ARM ? IDLE_CMD_ARM : IDLE_CMD_DISARM;
}

/* Checked by board_sleep with the scheduler suspended. */
static bool work_waiting(void) {
    return osMessageQueueGetCount(commands) > 0U || !want_active;
}

static void led1(bool on) { /* active low */
    HAL_GPIO_WritePin(LED1_GPIO_Port, LED1_Pin,
                      on ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

static void idle_task(void* argument) {
    (void)argument;
    static const idle_port_t port = {read_battery, on_usb, send_heartbeat,
                                     poll_command};
    (void)board_sleep_init();
    config.heartbeat_interval_ms = board_config_get().hb_idle_ms;
    (void)idle_init(&idle, &config, &port, NULL);
    for (;;) {
        if (!want_active) {
            (void)osThreadFlagsWait(EV_MODE, osFlagsWaitAny, osWaitForever);
            continue;
        }
        (void)idle_enter(&idle, osKernelGetTickCount());
        while (want_active) {
            led1(true);
            idle_result_t r = idle_on_wake(&idle, osKernelGetTickCount());
            led1(false);
            if (r.event == IDLE_EVENT_ARM_REQUESTED) {
                app_set_state(flight_state_next(FLIGHT_IDLE, FLIGHT_EV_ARM));
                break;
            }
            uint32_t ms =
                r.event == IDLE_EVENT_SLEEP ? r.sleep_s * 1000U : 1000U;
            if (board_sleep(ms, work_waiting) == 0U && !work_waiting()) {
                /* Stop refused (option byte, LSI): wait awake instead. */
                (void)osThreadFlagsWait(EV_CMD | EV_MODE, osFlagsWaitAny, ms);
            }
        }
    }
}

bool idle_task_start(void) {
    static const osThreadAttr_t attr = {
        .name = "idle",
        .stack_size = 1024,
        .priority = osPriorityBelowNormal,
    };
    commands = osMessageQueueNew(4, sizeof(uint8_t), NULL);
    thread = commands ? osThreadNew(idle_task, NULL, &attr) : NULL;
    return thread != NULL;
}

void idle_task_set_interval(uint32_t ms) {
    idle.config.heartbeat_interval_ms = ms; /* from the next heartbeat */
}

void idle_task_set_active(bool on) {
    want_active = on;
    if (thread) {
        (void)osThreadFlagsSet(thread, EV_MODE);
    }
}

void idle_task_command(mode_command_t command) {
    uint8_t c = (uint8_t)command;
    if (commands && osMessageQueuePut(commands, &c, 0, 0) == osOK && thread) {
        (void)osThreadFlagsSet(thread, EV_CMD);
    }
}

const idle_t* idle_task_state(void) {
    return &idle;
}
