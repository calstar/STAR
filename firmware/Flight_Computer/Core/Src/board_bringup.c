#include "board_bringup.h"

#include "board.h"
#include "board_spi.h"
#include "cmsis_os2.h"
#include "main.h"

static void enable(board_bringup_t* b, uint16_t device_id) {
    b->devices.configured_mask |= SELF_TEST_DEVICE_ENABLED(device_id);
}

/* Sleep until at least ms after reset (the HAL tick starts at reset). */
static void wait_since_boot(uint32_t ms) {
    uint32_t now = board_now_ms();
    if (now < ms) {
        osDelay(ms - now);
    }
}

void board_bringup_power_up(board_bringup_t* b) {
    b->devices.exchange = board_spi_self_test_exchange;
    b->devices.io_context = NULL;
    b->devices.configured_mask = 0;
    if (!board_spi_init()) {
        return; /* no bus locks: no SPI device is enabled */
    }

    /* ISM330DHCX (U4): on the always-on 3V3 rail. Its boot sequence takes
     * about 10 ms after power-up; 20 ms gives margin. SPI needs no setup: CS
     * is driven high by MX_GPIO_Init and goes low only for a transfer. */
    wait_since_boot(20);
    enable(b, SELF_TEST_DEVICE_IMU);

    /* H3LIS100DL (U3), high-g: same rail and bus as the IMU. At power-up it
     * loads its trimming from internal flash (DocID027504 p.27); no separate
     * boot time is specified, and the 20 ms above covers it. It starts in
     * power-down (CTRL_REG1 = 0x07), which still answers WHO_AM_I. */
    enable(b, SELF_TEST_DEVICE_HIGH_G);
}

self_test_reply_t board_bringup_probe(void* context, uint16_t device_id,
                                      uint8_t attempt, uint32_t now_ms,
                                      uint32_t budget_ms) {
    board_bringup_t* b = context;
    if (!b) {
        self_test_reply_t r = {SELF_TEST_NOT_CONFIGURED, 0};
        return r;
    }
    switch (device_id) {
        default:
            /* SPI identity checks (IMU, high-g, baro, Ethernet, radio). */
            return self_test_devices_probe(&b->devices, device_id, attempt,
                                           now_ms, budget_ms);
    }
}
