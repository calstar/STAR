#include "board_chips.h"

#include "board.h"
#include "bringup_task.h"
#include "emmc_stm32.h"
#include "main.h"
#include "radio_task.h"
#include "self_test_devices.h"

extern MMC_HandleTypeDef hmmc1;

static uint8_t boot_result(uint16_t id) {
    const self_test_status_t* st = &g_bringup_report.self_test;
    for (uint8_t i = 0; i < st->device_count; ++i) {
        if (st->devices[i].device_id == id) {
            return (uint8_t)st->devices[i].reply.result;
        }
    }
    return SELF_TEST_PENDING;
}

static void card_state(void* out) { /* runs in the eMMC writer task */
    *(uint8_t*)out = (uint8_t)HAL_MMC_GetCardState(&hmmc1);
}

void board_chips_check(status_report_t* r) {
    r->live_mask = 0;
    for (uint16_t id = 0; id < STATUS_CHIP_COUNT; ++id) {
        r->chips[id] = (status_chip_t){boot_result(id), 0};
    }
    board_bringup_t* b = bringup_task_board();
    static const uint16_t spi[] = {SELF_TEST_DEVICE_IMU,
                                   SELF_TEST_DEVICE_HIGH_G,
                                   SELF_TEST_DEVICE_BAROMETER};
    for (unsigned i = 0; b && i < 3; ++i) {
        self_test_reply_t rep =
            self_test_devices_probe(&b->devices, spi[i], 1, board_now_ms(), 50);
        r->chips[spi[i]] = (status_chip_t){
            (uint8_t)rep.result, self_test_devices_value(&b->devices, spi[i])};
        r->live_mask |= (uint8_t)(1U << spi[i]);
    }
    radio_status_t radio;
    radio_task_status(&radio);
    bool radio_ok = radio.setup_step == 0 && radio.device_errors == 0;
    r->chips[SELF_TEST_DEVICE_RADIO] = (status_chip_t){
        radio_ok ? SELF_TEST_PASS : SELF_TEST_FAIL, radio.setup_step};
    r->radio_device_errors = radio.device_errors;
    r->live_mask |= 1U << SELF_TEST_DEVICE_RADIO;
    uint8_t state = 0;
    if (boot_result(SELF_TEST_DEVICE_EMMC) == SELF_TEST_PASS &&
        emmc_stm32_call(card_state, &state)) {
        r->chips[SELF_TEST_DEVICE_EMMC] = (status_chip_t){
            state == HAL_MMC_CARD_TRANSFER ? SELF_TEST_PASS : SELF_TEST_FAIL,
            state};
        r->live_mask |= 1U << SELF_TEST_DEVICE_EMMC;
    }
}
