#include "board_sleep.h"

#include "FreeRTOS.h"
#include "board_time.h"
#include "cmsis_os2.h"
#include "main.h"
#include "sleep_math.h"
#include "task.h"
#include "usbd_cdc_if.h"

extern RTC_HandleTypeDef hrtc;
void SystemClock_Config(void);

static board_sleep_info_t info;
static volatile bool rtc_fired;

/* HAL weak override, from RTC_WKUP_IRQHandler. */
void HAL_RTCEx_WakeUpTimerEventCallback(RTC_HandleTypeDef* h) {
    (void)h;
    rtc_fired = true;
}

static uint32_t rtc_stamp(void) {
    RTC_TimeTypeDef t;
    RTC_DateTypeDef d;
    (void)HAL_RTC_GetTime(&hrtc, &t, RTC_FORMAT_BIN);
    (void)HAL_RTC_GetDate(&hrtc, &d, RTC_FORMAT_BIN); /* unlocks shadows */
    return sleep_rtc_steps(t.Hours, t.Minutes, t.Seconds, t.SubSeconds);
}

/* Count 125 sub-second steps (0.5 s nominal) against TIM2. */
static uint32_t measure_lsi(void) {
    const uint32_t steps = 125U;
    uint32_t start = board_time_us(), ssr = RTC->SSR;
    while (RTC->SSR == ssr) { /* align to a step edge */
        if (board_time_us() - start > 20000U) {
            return 0; /* RTC not counting: LSI dead */
        }
    }
    uint32_t t0 = board_time_us();
    for (uint32_t n = 0; n < steps; ++n) {
        ssr = RTC->SSR;
        while (RTC->SSR == ssr) {
            if (board_time_us() - t0 > 1000000U) {
                return 0;
            }
        }
    }
    return sleep_lsi_hz(steps, board_time_us() - t0);
}

bool board_sleep_init(void) {
    info.stop_allowed = (FLASH->OPTSR_CUR & FLASH_OPTSR_NRST_STOP_D1) != 0U;
    info.lsi_hz = measure_lsi();
    /* RM0468: LSI is 32 kHz nominal; refuse a reading far from it. */
    info.ready = info.lsi_hz > 24000U && info.lsi_hz < 40000U;
    if (CoreDebug->DHCSR & CoreDebug_DHCSR_C_DEBUGEN_Msk) {
        SET_BIT(DBGMCU->CR, DBGMCU_CR_DBG_SLEEPD1 | DBGMCU_CR_DBG_STOPD1 |
                                DBGMCU_CR_DBG_STOPD3);
    }
    return info.ready;
}

const board_sleep_info_t* board_sleep_info(void) {
    return &info;
}

uint32_t board_sleep(uint32_t ms, bool (*wake_now)(void)) {
    /* Stop gates off the USB clocks: stay awake while a host is attached. */
    if (!info.ready || !info.stop_allowed || usb_configured()) {
        info.awake_waits++;
        return 0;
    }
    vTaskSuspendAll();
    if (wake_now && wake_now()) {
        (void)xTaskResumeAll();
        return 0;
    }
    rtc_fired = false;
    (void)HAL_RTCEx_SetWakeUpTimer_IT(&hrtc, sleep_wut_reload(ms, info.lsi_hz),
                                      RTC_WAKEUPCLOCK_RTCCLK_DIV16);
    uint32_t before = rtc_stamp();
    HAL_SuspendTick();                         /* TIM6, HAL timebase */
    SysTick->CTRL &= ~SysTick_CTRL_ENABLE_Msk; /* FreeRTOS tick */

    /* D2 and D3 to DStop (not DStandby), then D1: SLEEPDEEP + WFI. */
    HAL_PWREx_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON, PWR_STOPENTRY_WFI,
                            PWR_D2_DOMAIN);
    HAL_PWREx_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON, PWR_STOPENTRY_WFI,
                            PWR_D3_DOMAIN);
    HAL_PWREx_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON, PWR_STOPENTRY_WFI,
                            PWR_D1_DOMAIN);

    /* Awake: clocks first, then read how long that was. */
    SystemClock_Config();
    (void)HAL_RTCEx_DeactivateWakeUpTimer(&hrtc);
    __HAL_RTC_WRITEPROTECTION_DISABLE(&hrtc);
    (void)HAL_RTC_WaitForSynchro(&hrtc); /* shadow registers stale after Stop */
    __HAL_RTC_WRITEPROTECTION_ENABLE(&hrtc);
    uint32_t slept = sleep_elapsed_ms(before, rtc_stamp(), info.lsi_hz);
    SysTick->CTRL |= SysTick_CTRL_ENABLE_Msk;
    HAL_ResumeTick();

    info.sleeps++;
    if (rtc_fired) {
        info.rtc_wakes++;
    } else {
        info.early_wakes++;
    }
    info.last_slept_ms = slept;
    (void)xTaskResumeAll();
    (void)xTaskCatchUpTicks(pdMS_TO_TICKS(slept));
    return slept;
}
