#include "board_adc.h"

#include "main.h"

extern ADC_HandleTypeDef hadc1;

static const uint32_t channels[BOARD_ADC_COUNT] = {
    [BOARD_ADC_VBAT] = ADC_CHANNEL_16,
    [BOARD_ADC_EXT_SENSE_1] = ADC_CHANNEL_17,
    [BOARD_ADC_PYRO_1_CONT] = ADC_CHANNEL_14,
    [BOARD_ADC_PYRO_2_CONT] = ADC_CHANNEL_15,
    [BOARD_ADC_EXT_SENSE_2] = ADC_CHANNEL_18,
    [BOARD_ADC_ALT_CURR] = ADC_CHANNEL_10,
    [BOARD_ADC_CURR] = ADC_CHANNEL_11,
};

static bool calibrated;

bool board_adc_init(void) {
    if (!calibrated) {
        calibrated =
            HAL_ADCEx_Calibration_Start(&hadc1, ADC_CALIB_OFFSET_LINEARITY,
                                        ADC_SINGLE_ENDED) == HAL_OK;
    }
    return calibrated;
}

bool board_adc_read(board_adc_input_t input, uint16_t* counts,
                    uint32_t timeout_ms) {
    if ((unsigned)input >= BOARD_ADC_COUNT || !counts) {
        return false;
    }
    /* Same as MX_ADC1_Init's channel setup, only the channel differs. */
    ADC_ChannelConfTypeDef config = {0};
    config.Channel = channels[input];
    config.Rank = ADC_REGULAR_RANK_1;
    config.SamplingTime = ADC_SAMPLETIME_387CYCLES_5;
    config.SingleDiff = ADC_SINGLE_ENDED;
    config.OffsetNumber = ADC_OFFSET_NONE;
    config.Offset = 0;
    config.OffsetSignedSaturation = DISABLE;
    if (HAL_ADC_ConfigChannel(&hadc1, &config) != HAL_OK ||
        HAL_ADC_Start(&hadc1) != HAL_OK) {
        return false;
    }
    bool ok = HAL_ADC_PollForConversion(&hadc1, timeout_ms) == HAL_OK;
    if (ok) {
        *counts = (uint16_t)HAL_ADC_GetValue(&hadc1);
    }
    HAL_ADC_Stop(&hadc1);
    return ok;
}

void board_adc_snapshot(board_adc_snapshot_t* snapshot, uint32_t timeout_ms) {
    for (int i = 0; i < BOARD_ADC_COUNT; ++i) {
        snapshot->counts[i] = 0;
        snapshot->valid[i] = board_adc_read((board_adc_input_t)i,
                                            &snapshot->counts[i], timeout_ms);
    }
}
