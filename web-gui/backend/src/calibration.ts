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
 * Validate calibration coefficients to ensure they won't produce extreme values
 * Returns true if coefficients are reasonable
 */
export function validateCalibrationCoefficients(
  coeffs: CalibrationCoefficients,
  typicalAdcRange: [number, number] = [1000000, 300000000]
): boolean {
  const { A, B, C, D } = coeffs;

  // Check for NaN or Infinity
  if (!isFinite(A) || !isFinite(B) || !isFinite(C) || !isFinite(D)) {
    return false;
  }

  // Test at typical ADC values to ensure result is reasonable
  const [minAdc, maxAdc] = typicalAdcRange;
  const testAdcs = [minAdc, (minAdc + maxAdc) / 2, maxAdc];

  for (const adc of testAdcs) {
    const psi = A * (adc ** 3) + B * (adc ** 2) + C * adc + D;
    // Reject if result is outside reasonable physical bounds
    if (!isFinite(psi) || psi < -1000 || psi > 10000) {
      return false;
    }
  }

  // Check if cubic term dominates too much (A term should be very small for large ADC codes)
  // For ADC ~250M, A * (250M)^3 should be reasonable
  // Relaxed threshold: If |A| > 1e-11, the cubic term might dominate (was 1e-12, too strict)
  // Some valid calibrations have slightly larger A terms, especially at high pressures
  if (Math.abs(A) > 1e-11) {
    return false;
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
  coeffs: CalibrationCoefficients
): number {
  const { A, B, C, D } = coeffs;

  // Validate coefficients before calculation
  if (!validateCalibrationCoefficients(coeffs)) {
    // Return NaN to signal invalid calibration
    return NaN;
  }

  const result = A * (adcCode ** 3) + B * (adcCode ** 2) + C * adcCode + D;

  // Double-check result is finite
  if (!isFinite(result)) {
    return NaN;
  }

  return result;
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
