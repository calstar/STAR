/**
 * Voltage reference helpers for per-board ADC handling.
 * 0 = Internal 2.5V, 1 = VDD (ratiometric), 2 = 5V absolute.
 *
 * Rule: VDD (ref=1) is ratiometric — never convert to voltage; use raw ADC code only.
 */

const ADC_FULL_SCALE = 2 ** 31;

let vddConversionWarned = false;

/**
 * Convert signed 32-bit ADC code to voltage (V).
 * For ref 1 (VDD ratiometric), do not use for display/threshold — use raw code only.
 * If called with ref 1, logs a warning once and returns NaN.
 */
export function adcToVoltage(rawAdc: number, voltageReference: number): number {
  const ref = Math.min(2, Math.max(0, voltageReference));
  if (ref === 1) {
    if (!vddConversionWarned) {
      console.warn('VDD ratiometric board: do not convert to voltage, use raw code only');
      vddConversionWarned = true;
    }
    return NaN;
  }
  const vref = ref === 0 ? 2.5 : 5;
  return (rawAdc / ADC_FULL_SCALE) * vref;
}

/**
 * Nominal reference voltage (V) for ref 0 or 2. For ref 1 returns NaN (ratiometric).
 */
export function getNominalVref(voltageReference: number): number {
  const ref = Math.min(2, Math.max(0, voltageReference));
  if (ref === 1) return NaN;
  return ref === 0 ? 2.5 : 5;
}

/**
 * Return raw ADC threshold for "actuator open" detection.
 * - Ref 0 (2.5V): threshold equivalent to ~0.04 V.
 * - Ref 1 (VDD): use raw code only — fixed threshold (e.g. 50M), no voltage conversion.
 * - Ref 2 (5V): threshold equivalent to ~0.04 V.
 */
export function getActuatorOpenThreshold(voltageReference: number): number {
  const ref = Math.min(2, Math.max(0, voltageReference ?? 0));
  if (ref === 1) {
    return 50000000; // raw ADC threshold for ratiometric; do not interpret as voltage
  }
  const vref = ref === 0 ? 2.5 : 5;
  return Math.floor((0.04 / vref) * ADC_FULL_SCALE);
}
