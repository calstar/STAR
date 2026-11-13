#include "board_adc.h"
#include "board_bringup.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "health_task.h"
#include "mode.h"

/* One conversion per input; 387.5-cycle sampling takes ~0.1 ms each. */
#define READ_TIMEOUT_MS 2U

_Static_assert(REC_HEALTH_INPUTS == BOARD_ADC_COUNT,
               "rec_health_t counts follow board_adc_input_t");

bool health_board_read(health_inputs_t* in) {
    bool any = false;
    for (unsigned i = 0; i < REC_HEALTH_INPUTS; ++i) {
        in->counts[i] = 0;
        in->valid[i] = board_adc_read((board_adc_input_t)i, &in->counts[i],
                                      READ_TIMEOUT_MS);
        any = any || in->valid[i];
    }
    in->on_usb = board_bringup_on_usb();
    return any;
}

void health_board_record(void* ctx, uint8_t type, const void* data,
                         uint8_t len) {
    (void)ctx;
    /* Non-blocking; refused outside ARMED/LAUNCHED/RECOVERY. */
    (void)emmc_log_append(emmc_stm32_log(), type, osKernelGetTickCount(), data,
                          len);
}

uint32_t health_board_interval_ms(void) {
    return app_state() >= FLIGHT_ARMED ? HEALTH_CORE_ARMED_MS
                                       : HEALTH_CORE_IDLE_MS;
}

uint32_t health_board_clock_ms(void) {
    return osKernelGetTickCount(); /* 1 kHz, caught up after Stop */
}
