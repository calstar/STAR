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
 */
export function loadPTCalibration(): CalibrationMap {
  // Try JSON first (from calibration GUI)
  // Path relative to backend directory: backend/src -> scripts/calibration/calibrations
  // __dirname points to the compiled JS location (backend/dist/src or backend/src)
  const calibrationDir = path.join(__dirname, '../../../scripts/calibration/calibrations');

  console.log(`🔍 Looking for calibration files in: ${calibrationDir}`);
  console.log(`   Current working directory: ${process.cwd()}`);
  console.log(`   __dirname: ${__dirname}`);

  if (fs.existsSync(calibrationDir)) {
    const jsonFiles = fs.readdirSync(calibrationDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(calibrationDir, f));

    if (jsonFiles.length > 0) {
      // Use most recent file
      const latest = jsonFiles.sort((a, b) =>
        fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      )[0];

      console.log(`📋 Loading calibration from: ${latest}`);
      const cal = loadCalibrationJSON(latest);
      if (cal.size > 0) {
        console.log(`✅ Loaded PT calibration: ${cal.size} sensors`);
        // Log which sensors have calibration
        for (const [sensorId, coeffs] of cal.entries()) {
          console.log(`   Sensor ${sensorId}: A=${coeffs.A.toExponential(2)}, B=${coeffs.B.toExponential(2)}, C=${coeffs.C.toExponential(2)}, D=${coeffs.D.toFixed(2)}`);
        }
        return cal;
      } else {
        console.warn(`⚠️ Calibration file found but no valid coefficients loaded`);
      }
    } else {
      console.warn(`⚠️ No JSON files found in ${calibrationDir}`);
    }
  } else {
    console.warn(`⚠️ Calibration directory does not exist: ${calibrationDir}`);
  }

  console.warn('⚠️ No PT calibration found - pressures will be uncalibrated');
  return new Map();
}
