#include "board_chips.h"

#include "FreeRTOS.h"
#include "board.h"
#include "bringup_task.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "main.h"
#include "radio_task.h"
#include "self_test_devices.h"
#include "sensors_task.h"
#include "task.h"

extern MMC_HandleTypeDef hmmc1;

/* The Idle task and USB SELF_TEST both check: one at a time (the probes share
 * scratch frames). latest[] is each chip's last live result. */
static osMutexId_t lock;
static status_chip_t latest[STATUS_CHIP_COUNT];
static uint8_t latest_mask;

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

void board_chips_init(void) {
    static const osMutexAttr_t attr = {"chips", osMutexPrioInherit, NULL, 0};
    lock = osMutexNew(&attr);
}

static void check(status_report_t* r) {
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

void board_chips_check(status_report_t* r) {
    if (!lock || osMutexAcquire(lock, osWaitForever) != osOK) {
        return;
    }
    sensors_task_pause(); /* Idle with a USB stream: the sensors are running */
    check(r);
    sensors_task_resume();
    taskENTER_CRITICAL();
    for (uint16_t id = 0; id < STATUS_CHIP_COUNT; ++id) {
        if (r->live_mask & (1U << id)) {
            latest[id] = r->chips[id];
        }
    }
    latest_mask |= r->live_mask;
    taskEXIT_CRITICAL();
    (void)osMutexRelease(lock);
}

bool board_chips_recheck(void) {
    static status_report_t r; /* static: off the caller's stack */
    if (!g_bringup_report.finished || !lock) {
        return false;
    }
    board_chips_check(&r);
    return true;
}

uint8_t board_chips_result(uint16_t id) {
    taskENTER_CRITICAL();
    bool live = id < STATUS_CHIP_COUNT && (latest_mask & (1U << id));
    uint8_t result = live ? latest[id].result : 0U;
    taskEXIT_CRITICAL();
    return live ? result : boot_result(id);
}
