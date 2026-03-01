/**
 * Sense conversions: K-type thermocouple, Pt1000 RTD, load cell.
 * Ported from external/DiabloAvionics/test_guis/sense_testing_gui.py
 */

// K-type thermocouple: voltage (V) -> temperature (°C), ITS-90 rational polynomial (Mosaic/NIST-style)
// Each row: (v_min_mV, v_max_mV, T0, V0, p1, p2, p3, p4, q1, q2, q3)
const K_TYPE_INVERSE: ReadonlyArray<readonly number[]> = [
  [-6.404, -3.554, -121.47164, -4.1790858, 36.069513, 30.722076, 7.791386, 0.52593997, 0.93939547, 0.2779128, 0.02516334],
  [-3.554, 4.096, -8.7935962, -0.34489914, 25.678719, -0.49887904, -0.44705222, -0.044869202, 0.00023893439, -0.02039775, -0.0018424107],
  [4.096, 16.397, 310.18976, 12.631386, 24.061949, 4.0158622, 0.26853917, -0.0097188544, 0.16995872, 0.011413069, -0.00039275155],
  [16.397, 33.275, 605.72562, 25.148718, 23.539401, 0.046547228, 0.0134444, 0.0005923685, 0.00083445513, 0.0004612144, 0.00002548812],
  [33.275, 69.553, 1018.4705, 41.99385, 25.783239, -1.8363403, 0.05617666, 0.000185324, -0.074803355, 0.002384186, 0],
];

/**
 * Convert K-type thermocouple voltage (V) to temperature (°C). Returns null if out of range.
 */
export function kTypeVoltageToTempC(vVolts: number): number | null {
  const vMv = vVolts * 1000;
  for (const row of K_TYPE_INVERSE) {
    const [vLo, vHi, t0, v0, p1, p2, p3, p4, q1, q2, q3] = row;
    if (vMv >= vLo && vMv <= vHi) {
      const x = vMv - v0;
      const num = p1 + x * (p2 + x * (p3 + x * p4));
      const den = 1 + x * (q1 + x * (q2 + x * q3));
      if (Math.abs(den) < 1e-20) return null;
      return t0 + (x * num) / den;
    }
  }
  return null;
}

// Pt1000 RTD: R(T) = R0*(1 + A*T + B*T^2) for T >= 0; solve for T
const PT1000_R0 = 1000;
const PT1000_A = 3.9083e-3;
const PT1000_B = -5.775e-7;
const PT1000_EXCITATION_UA = 1000;

/**
 * Convert Pt1000 resistance (Ω) to temperature (°C). Returns null if out of range.
 */
export function pt1000ResistanceToTempC(rOhm: number): number | null {
  const rr = rOhm / PT1000_R0;
  const d = PT1000_A * PT1000_A - 4 * PT1000_B * (1 - rr);
  if (d < 0) return null;
  const sqrtD = Math.sqrt(d);
  const t = (-PT1000_A + sqrtD) / (2 * PT1000_B);
  if (t >= -400 && t <= 1100) return t;
  return null;
}

/**
 * Convert Pt1000 differential voltage (V) to temperature (°C).
 * excitationUa = IDAC current in µA (default 1000). Returns null if out of range.
 */
export function pt1000VoltageToTempC(vVolts: number, excitationUa: number = PT1000_EXCITATION_UA): number | null {
  if (excitationUa <= 0) return null;
  const rOhm = (Math.abs(vVolts) * 1e6) / excitationUa;
  return pt1000ResistanceToTempC(rOhm);
}

const ADC32_FULL_SCALE = 2147483648;

/** Interpret uint32 as int32 (for 32-bit signed ADC codes). */
function uint32ToInt32(u: number): number {
  u = u >>> 0;
  return u > 0x7fffffff ? u - 0x100000000 : u;
}

/**
 * Ratiometric load-cell force from raw 32-bit ADC code.
 * Force = (code / code_fs) * full_scale_force.
 */
export function codeToForce(
  codeUint32: number,
  adcRefVoltage: number,
  excitationVoltage: number,
  sensitivityMvPerV: number,
  pgaGain: number,
  fullScaleForce: number
): number | null {
  if (adcRefVoltage <= 0 || pgaGain <= 0 || excitationVoltage <= 0 || sensitivityMvPerV <= 0) return null;
  const codeInt32 = uint32ToInt32(codeUint32 >>> 0);
  const codeFs =
    (excitationVoltage * (sensitivityMvPerV / 1000) * pgaGain / adcRefVoltage) * ADC32_FULL_SCALE;
  if (codeFs <= 0) return null;
  return (codeInt32 / codeFs) * fullScaleForce;
}
