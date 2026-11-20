#include "gnss_task.h"

#include "board_time.h"
#include "board_uart9.h"
#include "cmsis_os2.h"
#include "daq_task.h"
#include "emmc_stm32.h"
#include "health_task.h"
#include "main.h"

#define EV_RX (1U << 0)
#define EV_MODE (1U << 1) /* gnss_task_set_active() */

static gnss_core_t core;
static osThreadId_t thread;
static volatile bool want_active;
static volatile bool want_status; /* gnss_task_poll_status */

/* REG_3V6_EN (PE11): the 3V6 buck + LP5907 that make 3V3A, which only the
 * MAX-M10S uses (schematic p.10, p.12). 10 ms covers both regulators. */
static void gps_power(bool on) {
    HAL_GPIO_WritePin(REG_3V6_EN_GPIO_Port, REG_3V6_EN_Pin,
                      on ? GPIO_PIN_SET : GPIO_PIN_RESET);
    if (on) {
        osDelay(10);
    }
}

static void send(void* ctx, const uint8_t* bytes, uint16_t len) {
    (void)ctx;
    board_uart9_send(bytes, len);
}

static void set_baud(void* ctx, uint32_t baud) {
    (void)ctx;
    board_uart9_set_baud(baud);
}

static void to_emmc(void* ctx, uint8_t type, const void* data, uint8_t len) {
    (void)ctx;
    daq_record(type, data, len);
    (void)emmc_log_append(emmc_stm32_log(), type, osKernelGetTickCount(), data,
                          len);
}

static void gnss_task(void* argument) {
    (void)argument;
    core.io = (gnss_io_t){send, set_baud, NULL};
    core.sink = (record_sink_t){to_emmc, NULL};
    bool uart_started = false, active = false;
    uint8_t buf[128];
    for (;;) {
        if (!want_active) {
            if (active) {
                gps_power(false); /* Idle: the module loses its RAM config */
                active = false;
            }
            health_task_set_active(HEALTH_GNSS, false);
            (void)osThreadFlagsWait(EV_MODE, osFlagsWaitAny, osWaitForever);
            continue;
        }
        if (!active) {
            health_task_set_active(HEALTH_GNSS, true);
            gps_power(true);
            gnss_core_init(&core, board_time_us()); /* re-detect, reconfig */
            if (!uart_started) {
                board_uart9_start(osThreadGetId(), EV_RX);
                uart_started = true;
            }
            active = true;
        }
        uint32_t wait_us = gnss_core_wait_us(&core, board_time_us());
        (void)osThreadFlagsWait(EV_RX | EV_MODE, osFlagsWaitAny,
                                (wait_us + 999U) / 1000U);
        board_pps_t pps = board_time_last_pps();
        if (pps.count) {
            gnss_core_set_pps(&core, pps.edge_us);
        }
        size_t n;
        while ((n = board_uart9_read(buf, sizeof(buf))) > 0) {
            gnss_core_feed(&core, buf, n, board_time_us());
        }
        gnss_core_poll(&core, board_time_us());
        /* NAV-PVT wakes the task 10 times a second, so 1 s is honoured */
        static uint32_t last_status_us;
        uint32_t now = board_time_us();
        if (want_status && now - last_status_us >= 1000000U &&
            gnss_core_request_status(&core)) {
            last_status_us = now;
        }
        health_task_beat(HEALTH_GNSS);
    }
}

bool gnss_task_start(void) {
    static const osThreadAttr_t attr = {
        .name = "gnss",
        .stack_size = 1536,
        .priority = osPriorityNormal,
    };
    thread = osThreadNew(gnss_task, NULL, &attr);
    return thread != NULL;
}

void gnss_task_set_active(bool on) {
    want_active = on;
    if (thread) {
        (void)osThreadFlagsSet(thread, EV_MODE);
    }
}

void gnss_task_poll_status(bool on) {
    want_status = on;
}

const gnss_core_t* gnss_task_core(void) {
    return &core;
}
