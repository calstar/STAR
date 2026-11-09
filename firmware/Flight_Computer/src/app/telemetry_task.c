#include "telemetry_task.h"

#include "board_config.h"
#include "cmsis_os2.h"
#include "gnss_task.h"
#include "mode.h"
#include "radio_task.h"
#include "sensors_task.h"
#include "status_report.h"

#define FRAME_TELEMETRY 0x20U /* src/radio/frame.h FrameType::Telemetry */

static bool armed(flight_state_t s) {
    return s == FLIGHT_ARMED || s == FLIGHT_LAUNCHED || s == FLIGHT_RECOVERY;
}

static void telemetry_task(void* argument) {
    (void)argument;
    static sensors_core_t s; /* static: too big for the stack */
    static telemetry_t t;
    uint32_t seen[4] = {0};
    for (;;) {
        osDelay(board_config_get().hb_flight_ms);
        flight_state_t state = app_state();
        if (!armed(state)) {
            continue;
        }
        sensors_task_snapshot(&s);
        const gnss_core_t* g = gnss_task_core();
        const uint32_t now[4] = {s.imu.samples, s.highg.samples, s.baro.samples,
                                 g->fixes};
        t.fresh = 0;
        for (int i = 0; i < 4; ++i) {
            if (now[i] != seen[i]) {
                t.fresh |= (uint8_t)(1U << i); /* TELEMETRY_IMU ... _GNSS */
                seen[i] = now[i];
            }
        }
        t.state = (uint8_t)state;
        t.uptime_ms = osKernelGetTickCount();
        t.imu = s.imu_latest;
        t.highg = s.highg_latest;
        t.baro = s.baro_latest;
        t.lat_e7 = g->latest.lat_e7;
        t.lon_e7 = g->latest.lon_e7;
        t.hmsl_mm = g->latest.hmsl_mm;
        t.fix_type = g->latest.fix_type;
        t.num_sv = g->latest.num_sv;
        uint8_t p[TELEMETRY_LEN];
        telemetry_pack(&t, p);
        (void)radio_task_send_frame(FRAME_TELEMETRY, p, sizeof p);
    }
}

bool telemetry_task_start(void) {
    static const osThreadAttr_t attr = {
        .name = "telemetry",
        .stack_size = 1024,
        .priority = osPriorityBelowNormal,
    };
    return osThreadNew(telemetry_task, NULL, &attr) != NULL;
}
