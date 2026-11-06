#include "board_time.h"

#include "main.h"

extern TIM_HandleTypeDef htim2;

static volatile uint32_t pps_edge_us;
static volatile uint32_t pps_count;

/*
 * TIM2's kernel clock (RM0468 Rev 3, RCC_CFGR.TIMPRE, p.371): with TIMPRE = 0
 * it equals HCLK when the APB1 divider is 1 or 2, else 2 x PCLK1; with
 * TIMPRE = 1, HCLK when the divider is 1, 2 or 4, else 4 x PCLK1.
 */
static uint32_t tim2_kernel_hz(void) {
    uint32_t ppre = READ_BIT(RCC->D2CFGR, RCC_D2CFGR_D2PPRE1);
    bool timpre = READ_BIT(RCC->CFGR, RCC_CFGR_TIMPRE) != 0U;
    bool hclk = ppre == RCC_D2CFGR_D2PPRE1_DIV1 ||
                ppre == RCC_D2CFGR_D2PPRE1_DIV2 ||
                (timpre && ppre == RCC_D2CFGR_D2PPRE1_DIV4);
    if (hclk) {
        return HAL_RCC_GetHCLKFreq();
    }
    return (timpre ? 4U : 2U) * HAL_RCC_GetPCLK1Freq();
}

bool board_time_start(void) {
    bool one_mhz = tim2_kernel_hz() / (htim2.Init.Prescaler + 1U) == 1000000U;
    /* Starts the counter and the CH4 capture interrupt together. */
    bool started = HAL_TIM_IC_Start_IT(&htim2, TIM_CHANNEL_4) == HAL_OK;
    return one_mhz && started;
}

uint32_t board_time_us(void) {
    return htim2.Instance->CNT;
}

board_pps_t board_time_last_pps(void) {
    board_pps_t pps;
    uint32_t count;
    do { /* consistent pair even if a capture lands in between */
        count = pps_count;
        pps.edge_us = pps_edge_us;
    } while (count != pps_count);
    pps.count = count;
    return pps;
}

/* HAL weak override: TIM2 CH4 rising edge = GPS TIMEPULSE (PB11). */
void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef* htim) {
    if (htim->Instance == TIM2 && htim->Channel == HAL_TIM_ACTIVE_CHANNEL_4) {
        pps_edge_us = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_4);
        pps_count = pps_count + 1U;
    }
}
