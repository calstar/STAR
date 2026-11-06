#ifndef STAR_BOARD_ADC_H
#define STAR_BOARD_ADC_H

/*
 * ADC1 analog inputs (16-bit, VREF+ = 3V3 ~3.32 V, 387.5-cycle sampling for
 * the TLV9004 buffers). The .ioc scans only PA0; these helpers point ADC1 at
 * one channel per conversion, with the same settings CubeMX generated.
 * Raw counts only: scaling and thresholds belong to the adapters (#137).
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BOARD_ADC_VBAT = 0,    /* PA0 INP16: VDD after ORing x 0.3125 */
    BOARD_ADC_EXT_SENSE_1, /* PA1 INP17 */
    BOARD_ADC_PYRO_1_CONT, /* PA2 INP14: ~590 counts with an igniter */
    BOARD_ADC_PYRO_2_CONT, /* PA3 INP15 */
    BOARD_ADC_EXT_SENSE_2, /* PA4 INP18 (J4, unbuffered) */
    BOARD_ADC_ALT_CURR,    /* PC0 INP10: altimeter battery current */
    BOARD_ADC_CURR,        /* PC1 INP11: main current, 1 V/A */
    BOARD_ADC_COUNT
} board_adc_input_t;

typedef struct {
    bool valid[BOARD_ADC_COUNT];
    uint16_t counts[BOARD_ADC_COUNT];
} board_adc_snapshot_t;

/* Offset + linearity calibration. Once, before the first conversion. */
bool board_adc_init(void);

/* One conversion. False on HAL error or timeout. */
bool board_adc_read(board_adc_input_t input, uint16_t* counts,
                    uint32_t timeout_ms);

/* Every input once (bring-up report). */
void board_adc_snapshot(board_adc_snapshot_t* snapshot, uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif
#endif
