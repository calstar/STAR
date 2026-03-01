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
}

type CalibrationMap = Map<number, CalibrationCoefficients>;

/**
 * Calculate pressure (psi) from ADC code using cubic polynomial
 * Formula: pressure = A*x^3 + B*x^2 + C*x + D
 * where x = raw ADC code
 */
export function calculatePressure(
  adcCode: number,
  coeffs: CalibrationCoefficients
): number {
  const { A, B, C, D } = coeffs;
  return A * (adcCode ** 3) + B * (adcCode ** 2) + C * adcCode + D;
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

    if (data.calibration_polynomials) {
      for (const [sensorIdStr, coeffs] of Object.entries(data.calibration_polynomials)) {
        const sensorId = parseInt(sensorIdStr, 10);
        if (Array.isArray(coeffs) && coeffs.length >= 4) {
          calMap.set(sensorId, {
            A: coeffs[0],
            B: coeffs[1],
            C: coeffs[2],
            D: coeffs[3],
          });
        }
      }
    }
  } catch (error) {
    console.error(`❌ Failed to load calibration JSON: ${error}`);
  }

  return calMap;
}

/**
 * Load PT calibration (tries JSON first, then CSV)
 * Returns map: sensor_id -> {A, B, C, D}
 *
 * Search order:
 *  1. scripts/calibration/calibrations/ (relative to project root via __dirname)
 *  2. web-gui/backend/data/             (backend local data dir)
 *  3. external/DiabloAvionics/test_guis/ (original source)
 */
export function loadPTCalibration(): CalibrationMap {
  // Build a list of candidate directories to search
  const candidateDirs: string[] = [
    path.join(__dirname, '../../../scripts/calibration/calibrations'),   // project root
    path.join(__dirname, '../data'),                                      // backend/data
    path.join(__dirname, '../../../external/DiabloAvionics/test_guis'),  // original source
  ];

  console.log(`🔍 Searching for calibration files…`);
  console.log(`   __dirname: ${__dirname}`);

  for (const calibrationDir of candidateDirs) {
    if (!fs.existsSync(calibrationDir)) {
      console.log(`   ❌ ${calibrationDir} — not found`);
      continue;
    }

    const jsonFiles = fs.readdirSync(calibrationDir)
      .filter(f => f.endsWith('.json') && f.startsWith('calibration'))
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
      return cal;
    }
    console.warn(`   ⚠️ ${latest} — no valid coefficients`);
  }

  console.warn('⚠️ No PT calibration found - pressures will be uncalibrated');
  return new Map();
}
