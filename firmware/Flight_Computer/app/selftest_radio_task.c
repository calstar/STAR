#include "board.h"
#include "cmsis_os2.h"
#include "selftest_radio.h"

selftest_radio_t g_selftest_radio;
__attribute__((weak)) selftest_tx_result_t flight_radio_send(
    void* ctx, const uint8_t* bytes, uint8_t len, uint32_t budget_ms) {
    (void)ctx;
    (void)bytes;
    (void)len;
    (void)budget_ms;
    return SELFTEST_TX_UNAVAILABLE;
}
static void run(void* arg) {
    (void)arg;
    while (!g_selftest_radio.finished) {
        selftest_radio_step(&g_selftest_radio, board_now_ms(),
                            flight_radio_send, NULL);
        if (!g_selftest_radio.finished)
            osDelay((osKernelGetTickFreq() + 9U) / 10U);
    }
    osThreadExit();
}
bool selftest_radio_task_start(uint16_t bits, uint16_t supply_mv) {
    static const osThreadAttr_t attr = {
        .name = "selftest-radio",
        .stack_size = 2048,
        .priority = osPriorityNormal,
    };
    /* First frame of this boot; the future shared link owner must allocate
     * following heartbeat sequence numbers from the same sequence space. */
    if (!selftest_radio_init(&g_selftest_radio, bits, supply_mv, 0,
                             board_now_ms()))
        return false;
    if (!osThreadNew(run, NULL, &attr)) {
        g_selftest_radio.result = SELFTEST_TX_ERROR;
        g_selftest_radio.finished = true;
        return false;
    }
    return true;
}
