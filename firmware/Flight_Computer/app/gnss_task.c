#include "gnss_task.h"

#include "board_time.h"
#include "board_uart9.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "health_task.h"

#define EV_RX (1U << 0)

static gnss_core_t core;

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
    (void)emmc_log_append(emmc_stm32_log(), type, osKernelGetTickCount(), data,
                          len);
}

static void gnss_task(void* argument) {
    (void)argument;
    core.io = (gnss_io_t){send, set_baud, NULL};
    core.sink = (record_sink_t){to_emmc, NULL};
    gnss_core_init(&core, board_time_us());
    board_uart9_start(osThreadGetId(), EV_RX);
    uint8_t buf[128];
    for (;;) {
        uint32_t wait_us = gnss_core_wait_us(&core, board_time_us());
        (void)osThreadFlagsWait(EV_RX, osFlagsWaitAny,
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
        health_task_beat(HEALTH_GNSS);
    }
}

bool gnss_task_start(void) {
    static const osThreadAttr_t attr = {
        .name = "gnss",
        .stack_size = 1536,
        .priority = osPriorityNormal,
    };
    return osThreadNew(gnss_task, NULL, &attr) != NULL;
}

const gnss_core_t* gnss_task_core(void) {
    return &core;
}
