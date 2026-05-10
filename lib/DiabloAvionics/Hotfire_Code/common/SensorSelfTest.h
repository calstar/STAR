#pragma once

#include <Arduino.h>
#include "STAR_ADS126X.h"

namespace SensorSelfTest {

// Thresholds (ADC codes, full-scale = 2^31)
// ADC TDAC test: VDD reference. TDACP = 0.6*AVDD, TDACN = 0.5*AVDD.
// Differential = 0.1*AVDD. Reference = AVDD. So code = 0.1 * 2^31.
// We allow ±1% of the expected code.
constexpr int32_t ADC_TDAC_EXPECTED_CODE = 214748364;           // 0.1 * 2^31
constexpr int32_t ADC_TDAC_TOLERANCE     = 2147484;            // 1% of expected code

// Sensor bias test (SBMAG = 0b110 → 10MΩ pull resistor via MODE1):
// Open circuit  → bias pulls pin to rail → code saturates at +FS (~2^31)
// Connected     → sensor loads the bias  → small-to-moderate code
// Two thresholds with an AMBIGUOUS band in between:
//   |code| < 40% FS  → CONNECTED
//   |code| > 60% FS  → DISCONNECTED
//   between          → AMBIGUOUS
constexpr int32_t SENSOR_BIAS_CLOSED_THRESHOLD = 858993459;  // 40% of 2^31
constexpr int32_t SENSOR_BIAS_OPEN_THRESHOLD   = 1288490188; // 60% of 2^31

// Analog settling delay (ms) after mux switch during bias test.
// The 10MΩ bias resistor × parasitic capacitance (traces, connectors)
// forms an RC that needs ~3τ to reach the rail on open pins.
// 50ms covers ~3τ for up to ~1.6nF parasitic capacitance.
constexpr unsigned long BIAS_SETTLE_MS = 50;

// Number of ADC samples to average per channel during the bias test.
constexpr uint8_t BIAS_AVG_SAMPLES = 4;

enum class BiasResult : uint8_t {
  CONNECTED    = 0,  // |code| < closed threshold — sensor is present
  AMBIGUOUS    = 1,  // between thresholds — uncertain
  DISCONNECTED = 2,  // |code| > open threshold — no sensor
};

/**
 * ADC self-test via internal TDAC.
 * Sets TDACP to 0.6*VDD and TDACN to 0.5*VDD.
 * Muxes TDAC vs TDAC, uses VDD reference (5V).
 * Reads and checks that the code is near ADC_TDAC_EXPECTED_CODE.
 * Restores original reference, mux, and turns off TDAC after test.
 */
struct AdcSelfTestResult {
    bool passed;
    int32_t code;         // raw ADC code read
    bool checksum_valid;
};

inline AdcSelfTestResult run_adc_self_test(ADS126X& adc, uint8_t drdy_pin,
                              uint8_t original_ref_neg, uint8_t original_ref_pos) {
    adc.bypassPGA();
    adc.setInputMux(ADS126X_TDAC, ADS126X_TDAC);

    adc.setOutputTDACP(1);
    adc.setOutputTDACN(1);
    adc.setOutputmagnitudeTDACP(ADS126X_TDAC_DIV_0_6);
    adc.setOutputmagnitudeTDACN(ADS126X_TDAC_DIV_0_5);

    adc.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);

    // Flush 5 conversions so SINC5 filter settles after mux/ref change
    for (uint8_t i = 0; i < 5; i++) {
        delayMicroseconds(10);
        while (digitalRead(drdy_pin) != LOW)
            delayMicroseconds(10);
        adc.readADC1();
    }

    // Real measurement
    delayMicroseconds(10);
    while (digitalRead(drdy_pin) != LOW)
        delayMicroseconds(10);

    const auto reading = adc.readADC1();
    int32_t code = reading.value;

    adc.bypassPGA();
    adc.setOutputTDACP(0);
    adc.setOutputTDACN(0);
    adc.setReference(original_ref_neg, original_ref_pos);

    if (!reading.checksumValid) {
        return {false, code, false};
    }

    int32_t diff = code - ADC_TDAC_EXPECTED_CODE;
    if (diff < 0) diff = -diff;

    return {diff <= ADC_TDAC_TOLERANCE, code, true};
}

/** Call once before the connector loop. Configures sensor bias on ADC1 with
 *  10MΩ pull-up, bypasses PGA (bias voltages can exceed PGA input range),
 *  and turns off IDACs. */
inline void sensor_bias_enable(ADS126X& adc) {
    adc.bypassPGA();
    adc.setIDAC1Mag(ADS126X_IDAC_MAG_0);
    adc.setIDAC2Mag(ADS126X_IDAC_MAG_0);
    adc.setBiasADC(ADS126X_BIAS_ADC1);
    adc.setBiasPolarity(ADS126X_BIAS_PULLUP);
    adc.setBiasMagnitude(ADS126X_BIAS_MAG_10M);
    delay(BIAS_SETTLE_MS);
}

struct BiasReadResult {
    BiasResult result;
    int32_t code;         // raw signed ADC code
    bool checksum_valid;
};

/**
 * Read one connector with sensor bias already active.
 * After switching the mux, flushes `settle_cycles` conversions so the
 * digital filter (e.g. SINC5 needs 5) fully settles on the new channel
 * before taking the real measurement.
 *
 * Returns CONNECTED if |code| < SENSOR_BIAS_CLOSED_THRESHOLD,
 * DISCONNECTED if |code| >= SENSOR_BIAS_OPEN_THRESHOLD,
 * AMBIGUOUS otherwise (or on checksum failure).
 */
inline BiasReadResult read_sensor_bias(ADS126X& adc, uint8_t drdy_pin,
                                       uint8_t adc_channel, uint8_t aincom,
                                       uint8_t settle_cycles = 5) {
    // Stop ADC so the filter doesn't fill with mid-transition data
    adc.stopADC1();
    adc.setInputMux(adc_channel, aincom);

    // Let the 10MΩ bias resistor charge/discharge parasitic capacitance
    delay(BIAS_SETTLE_MS);

    // Restart ADC — filter pipeline starts fresh on the settled signal
    adc.startADC1();

    // Flush conversions so the digital filter (SINC5) fully settles
    for (uint8_t i = 0; i < settle_cycles; i++) {
        delayMicroseconds(10);
        while (digitalRead(drdy_pin) != LOW)
            delayMicroseconds(10);
        adc.readADC1();
    }

    // Take multiple samples and average for noise rejection
    int64_t sum = 0;
    uint8_t good_count = 0;
    for (uint8_t s = 0; s < BIAS_AVG_SAMPLES; s++) {
        delayMicroseconds(10);
        while (digitalRead(drdy_pin) != LOW)
            delayMicroseconds(10);
        auto reading = adc.readADC1();
        if (reading.checksumValid) {
            sum += reading.value;
            good_count++;
        }
    }

    if (good_count == 0)
        return {BiasResult::AMBIGUOUS, 0, false};

    int32_t val = static_cast<int32_t>(sum / good_count);
    int32_t abs_val = (val < 0) ? -val : val;
    
    BiasResult r;
    if (abs_val < SENSOR_BIAS_CLOSED_THRESHOLD)      r = BiasResult::CONNECTED;
    else if (abs_val >= SENSOR_BIAS_OPEN_THRESHOLD)   r = BiasResult::DISCONNECTED;
    else                                               r = BiasResult::AMBIGUOUS;

    return {r, val, true};
}

/** Call once after the connector loop. Restores SBMAG = 0. */
inline void sensor_bias_disable(ADS126X& adc) {
    adc.setBiasMagnitude(ADS126X_BIAS_MAG_0);
}

} // namespace SensorSelfTest
