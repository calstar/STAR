/**
 * PT Calibration
 * Loads calibration coefficients and applies them to raw ADC values
 *
 * Integration with calibration orchestrator:
 * - Phase 1: Initial calibration with reference points (0-point, multi-point)
 * - Phase 2: Autonomous monitoring and self-recalibration (RLS updates, drift detection)
 *
 * For now, loads static calibration files. Full integration with orchestrator
 * will enable real-time Phase 2 updates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface CalibrationCoefficients {
  A: number;
  B: number;
  C: number;
  D: number;
  /** When set, pressure = sum(polyCoeffs[i] * x^i) with x = (adc - adcNormMin) / adcNormScale. Avoids ill-conditioned Vandermonde in raw ADC. */
  polyCoeffs?: number[];
  adcNormMin?: number;
  adcNormScale?: number;
}

type CalibrationMap = Map<number, CalibrationCoefficients>;

export interface EnvironmentalState {
  temperature: number;
  humidity: number;
  vibration: number;
  aging_factor: number;
  mounting_torque: number;
}

/**
 * Validate calibration coefficients to ensure they won't produce extreme values
 * Returns true if coefficients are reasonable
 */
export function validateCalibrationCoefficients(
  coeffs: CalibrationCoefficients,
  typicalAdcRange: [number, number] = [0, 4000000000]
): boolean {
  const { A, B, C, D, polyCoeffs } = coeffs;
  const minN = coeffs.adcNormMin;
  const scaleN = coeffs.adcNormScale;
  const useNorm = minN != null && scaleN != null && scaleN > 0;

  // For normalized coefficients, we MUST validate within the [0, 1] range they were fit for.
  // Testing far-away static ADC values will fail due to polynomial divergence.
  const testXs = useNorm ? [0, 0.5, 1.0] : [];

  // If not using norm, or for general safety, we also test some representative ADC values.
  const [minAdc, maxAdc] = typicalAdcRange;
  const testAdcs = [minAdc, (minAdc + maxAdc) / 2, maxAdc];

  if (polyCoeffs != null && polyCoeffs.length > 0) {
    if (polyCoeffs.some((c) => !isFinite(c))) return false;

    // Check normalized range [0, 1]
    if (useNorm) {
      for (const x of testXs) {
        const psi = polyCoeffs.reduce((sum, c, i) => sum + c * Math.pow(x, i), 0);
        if (!isFinite(psi) || psi < -5000 || psi > 20000) return false;
      }
    } else {
      // Check absolute ADC range
      for (const adc of testAdcs) {
        const psi = polyCoeffs.reduce((sum, c, i) => sum + c * Math.pow(adc, i), 0);
        if (!isFinite(psi) || psi < -5000 || psi > 20000) return false;
      }
    }
    return true;
  }

  if (!isFinite(A) || !isFinite(B) || !isFinite(C) || !isFinite(D)) return false;

  if (useNorm) {
    for (const x of testXs) {
      const psi = A * (x ** 3) + B * (x ** 2) + C * x + D;
      if (!isFinite(psi) || psi < -5000 || psi > 20000) return false;
    }
  } else {
    for (const adc of testAdcs) {
      const psi = A * (adc ** 3) + B * (adc ** 2) + C * adc + D;
      if (!isFinite(psi) || psi < -5000 || psi > 20000) return false;
    }
    // Strictness check for unnormalized cubic: A should be VERY small if it's meant for raw ADC ~1B
    if (Math.abs(A) > 1e-11) return false;
  }
  return true;
}

/**
 * Calculate pressure (psi) from ADC code using cubic polynomial
 * Formula: pressure = A*x^3 + B*x^2 + C*x + D
 * where x = raw ADC code
 *
 * Includes validation to prevent extreme values from bad calibrations
 */
export function calculatePressure(
  adcCode: number,
  coeffs: CalibrationCoefficients,
  _env?: EnvironmentalState // Reserved for future use (robust calibration)
): number {
  if (!validateCalibrationCoefficients(coeffs)) return NaN;
  const { A, B, C, D, polyCoeffs } = coeffs;
  const minN = coeffs.adcNormMin;
  const scaleN = coeffs.adcNormScale;
  const useNorm = minN != null && scaleN != null && scaleN > 0;
  const x = useNorm ? (adcCode - minN) / scaleN : adcCode;
  const result =
    polyCoeffs != null && polyCoeffs.length > 0
      ? polyCoeffs.reduce((sum, c, i) => sum + c * Math.pow(x, i), 0)
      : A * (x ** 3) + B * (x ** 2) + C * x + D;
  return isFinite(result) ? result : NaN;
}

/** Maximum ADC value for bisection range (24-bit typical) */
const MAX_ADC = 16777216;

/**
 * Inverse of calculatePressure: given target PSI, solve for ADC code.
 * Solves A*x³ + B*x² + C*x + D = targetPsi for x using bisection.
 * Used when building ACTUATOR_CONFIG so the packet sends threshold as ADC code.
 *
 * @param targetPsi Target pressure in PSI (from config).
 * @param coeffs Same calibration coefficients as used by calculatePressure.
 * @return ADC code (integer in [0, MAX_ADC]), or NaN if no solution in range.
 */
export function inversePressureToAdc(
  targetPsi: number,
  coeffs: CalibrationCoefficients
): number {
  const { A, B, C, D } = coeffs;
  const f = (x: number) => A * (x ** 3) + B * (x ** 2) + C * x + D - targetPsi;

  let lo = 0;
  let hi = MAX_ADC;
  const fLo = f(lo);
  const fHi = f(hi);

  if (fLo * fHi > 0) {
    return NaN; // No root in [0, MAX_ADC] or same sign at both ends
  }

  const maxIter = 80;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1e-6 || hi - lo < 1) {
      return Math.round(mid);
    }
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return Math.round((lo + hi) / 2);
}

/**
 * Load calibration from JSON file (from calibration GUI)
 */
function loadCalibrationJSON(jsonPath: string): CalibrationMap {
  const calMap: CalibrationMap = new Map();

  if (!fs.existsSync(jsonPath)) {
    return calMap;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const polyCoeffsMap = data.calibration_poly_coeffs as Record<string, number[]> | undefined;
    const adcNormMinMap = data.calibration_adc_norm_min as Record<string, number> | undefined;
    const adcNormScaleMap = data.calibration_adc_norm_scale as Record<string, number> | undefined;

    if (data.calibration_polynomials) {
      for (const [sensorIdStr, coeffs] of Object.entries(data.calibration_polynomials)) {
        const sensorId = parseInt(sensorIdStr, 10);
        const poly = polyCoeffsMap?.[sensorIdStr];
        if (Array.isArray(poly) && poly.length > 0) {
          const entry: CalibrationCoefficients = { A: 0, B: 0, C: 0, D: 0, polyCoeffs: poly };
          if (adcNormMinMap?.[sensorIdStr] != null) entry.adcNormMin = adcNormMinMap[sensorIdStr];
          if (adcNormScaleMap?.[sensorIdStr] != null) entry.adcNormScale = adcNormScaleMap[sensorIdStr];
          calMap.set(sensorId, entry);
        } else if (Array.isArray(coeffs) && coeffs.length >= 4) {
          const entry: CalibrationCoefficients = { A: coeffs[0], B: coeffs[1], C: coeffs[2], D: coeffs[3] };
          if (adcNormMinMap?.[sensorIdStr] != null) entry.adcNormMin = adcNormMinMap[sensorIdStr];
          if (adcNormScaleMap?.[sensorIdStr] != null) entry.adcNormScale = adcNormScaleMap[sensorIdStr];
          calMap.set(sensorId, entry);
        }
      }
    }
  } catch (error) {
    console.error(`❌ Failed to load calibration JSON: ${error}`);
  }

  return calMap;
}

export interface PTCalibrationResult {
  map: CalibrationMap;
  /** Absolute path of the file that was loaded, or null if none found. */
  filePath: string | null;
}

/**
 * Load PT calibration (tries JSON first, then CSV)
 * Returns the calibration map and the path of the file that was loaded.
 *
 * Search order:
 *  1. scripts/calibration/calibrations/ (relative to project root via __dirname)
 *  2. web-gui/backend/data/             (backend local data dir)
 *  3. external/DiabloAvionics/test_guis/ (original source)
 */
export function loadPTCalibration(overridePath?: string): PTCalibrationResult {
  // Build a list of candidate directories to search
  const candidateDirs: string[] = [
    '/home/kush-mahajan/sensor_system/calibration',                      // New robust calibration home
    path.join(__dirname, '../../../scripts/calibration/calibrations'),   // project root
    path.join(__dirname, '../data'),                                      // backend/data
    path.join(__dirname, '../../../external/DiabloAvionics/test_guis'),  // original source
  ];

  // If caller supplied a specific file path, try it first
  if (overridePath) {
    if (fs.existsSync(overridePath)) {
      const cal = loadCalibrationJSON(overridePath);
      if (cal.size > 0) {
        console.log(`📋 Loading calibration from override: ${overridePath}`);
        console.log(`✅ Loaded PT calibration: ${cal.size} sensors`);
        return { map: cal, filePath: overridePath };
      }
    } else {
      console.warn(`⚠️ Override calibration path not found: ${overridePath}`);
    }
  }

  console.log(`🔍 Searching for calibration files…`);
  console.log(`   __dirname: ${__dirname}`);

  for (const calibrationDir of candidateDirs) {
    if (!fs.existsSync(calibrationDir)) {
      console.log(`   ❌ ${calibrationDir} — not found`);
      continue;
    }

    const jsonFiles = fs.readdirSync(calibrationDir)
      .filter(f => f.endsWith('.json') && (f.startsWith('calibration') || f === 'robust_calibration.json'))
      .map(f => path.join(calibrationDir, f));

    if (jsonFiles.length === 0) {
      console.log(`   ⚠️ ${calibrationDir} — no calibration JSON files`);
      continue;
    }

    // Use most recent file
    const latest = jsonFiles.sort((a, b) =>
      fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    )[0];

    console.log(`📋 Loading calibration from: ${latest}`);
    const cal = loadCalibrationJSON(latest);
    if (cal.size > 0) {
      console.log(`✅ Loaded PT calibration: ${cal.size} sensors`);
      for (const [sensorId, coeffs] of cal.entries()) {
        console.log(`   Sensor ${sensorId}: A=${coeffs.A.toExponential(2)}, B=${coeffs.B.toExponential(2)}, C=${coeffs.C.toExponential(2)}, D=${coeffs.D.toFixed(2)}`);
      }
      return { map: cal, filePath: latest };
    }
    console.warn(`   ⚠️ ${latest} — no valid coefficients`);
  }

  console.warn('⚠️ No PT calibration found - pressures will be uncalibrated');
  return { map: new Map(), filePath: null };
}
