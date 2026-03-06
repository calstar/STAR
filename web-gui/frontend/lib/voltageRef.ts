/**
 * Voltage reference helpers for per-board ADC handling.
 * 0 = Internal, 1 = VDD (ratiometric), 2 = 5V absolute.
 * Nominals come from config [adc] (internal_v, absolute_5v_v); defaults 2.5V / 5V.
 *
 * Rule: VDD (ref=1) is ratiometric — never convert to voltage; use raw ADC code only.
 */

const ADC_FULL_SCALE = 2 ** 31;

export interface VoltageRefNominals {
  internalV: number;
  absolute5vV: number;
}

const DEFAULT_NOMINALS: VoltageRefNominals = { internalV: 2.5, absolute5vV: 5 };

let vddConversionWarned = false;

/**
 * Convert signed 32-bit ADC code to voltage (V).
 * For ref 1 (VDD ratiometric), do not use for display/threshold — use raw code only.
 * nominals: from config [adc] (internal_v, absolute_5v_v).
 */
export function adcToVoltage(
  rawAdc: number,
  voltageReference: number,
  nominals?: VoltageRefNominals
): number {
  const ref = Math.min(2, Math.max(0, voltageReference));
  if (ref === 1) {
    if (!vddConversionWarned) {
      console.warn('VDD ratiometric board: do not convert to voltage, use raw code only');
      vddConversionWarned = true;
    }
    return NaN;
  }
  const n = nominals ?? DEFAULT_NOMINALS;
  const vref = ref === 0 ? n.internalV : n.absolute5vV;
  return (rawAdc / ADC_FULL_SCALE) * vref;
}

/**
 * Nominal reference voltage (V) for ref 0 or 2. For ref 1 returns NaN (ratiometric).
 */
export function getNominalVref(
  voltageReference: number,
  nominals?: VoltageRefNominals
): number {
  const ref = Math.min(2, Math.max(0, voltageReference));
  if (ref === 1) return NaN;
  const n = nominals ?? DEFAULT_NOMINALS;
  return ref === 0 ? n.internalV : n.absolute5vV;
}

/**
 * Return raw ADC threshold for "actuator open" detection.
 * nominals: from config [adc] (internal_v, absolute_5v_v).
 */
export function getActuatorOpenThreshold(
  voltageReference: number,
  nominals?: VoltageRefNominals
): number {
  const ref = Math.min(2, Math.max(0, voltageReference ?? 0));
  if (ref === 1) {
    return 50000000; // raw ADC threshold for ratiometric; do not interpret as voltage
  }
  const n = nominals ?? DEFAULT_NOMINALS;
  const vref = ref === 0 ? n.internalV : n.absolute5vV;
  return Math.floor((0.04 / vref) * ADC_FULL_SCALE);
}
