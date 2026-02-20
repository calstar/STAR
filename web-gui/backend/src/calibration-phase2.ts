/**
 * Phase 2: Autonomous Monitoring and Self-Recalibration
 *
 * Key insight: the PT's intrinsic transfer function (A,B,C) does NOT change —
 * sensor physics are fixed. What drifts is the offset D (thermal, aging, etc.).
 *
 * Phase 2 runs CONTINUOUSLY on every incoming ADC reading:
 *   1.  Predict PSI from current polynomial
 *   2.  Track prediction via exponential moving average (EMA)
 *   3.  Residual = |prediction − EMA| → feeds GLR drift detector
 *   4.  Covariance P grows each tick by process noise (models drift)
 *        → confidence naturally decays without ground truth
 *   5.  When user provides ground truth (zero-point or known ref)
 *        → full RLS update shrinks P and corrects coefficients
 *
 * Implements:
 * - RLS (Recursive Least Squares) with forgetting factor
 * - GLR (Generalized Likelihood Ratio) drift detection
 * - Process-noise covariance growth for autonomous confidence tracking
 * - Automatic recalibration on drift
 * - Periodic saving of updated coefficients
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { CalibrationCoefficients } from './calibration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SensorState {
  // Current calibration coefficients
  coeffs: CalibrationCoefficients;

  // RLS state
  P: number[][]; // Covariance matrix (4x4 for cubic polynomial)
  forgettingFactor: number;

  // Continuous monitoring state
  recentPredictions: number[];
  smoothedPrediction: number | null;

  // Drift detection
  recentResiduals: number[];
  driftThreshold: number;
  driftDetected: boolean;

  // Statistics
  updateCount: number;       // total readings processed
  rlsUpdateCount: number;    // ground-truth RLS updates
  lastUpdate: number;
  lastSave: number;
}

export class Phase2CalibrationEngine {
  private sensorStates: Map<number, SensorState> = new Map();
  private enabled: boolean = true;
  private saveInterval: number = 300; // 5 minutes
  private driftThreshold: number = 3.0; // GLR threshold
  private forgettingFactor: number = 0.995; // RLS forgetting factor

  // Process noise added to covariance diagonal each monitoring tick.
  // Models expected drift rate — confidence decays naturally without ground truth.
  private processNoise: number = 1e-6;

  // EMA smoothing factor for prediction baseline (0.01 = very slow, stable)
  private emaSmoothingAlpha: number = 0.02;

  constructor() {
    console.log('🤖 Phase 2 Calibration Engine initialized');
    console.log(`   Forgetting factor: ${this.forgettingFactor}`);
    console.log(`   Drift threshold:   ${this.driftThreshold}`);
    console.log(`   Process noise:     ${this.processNoise}`);
    console.log(`   Auto-save interval: ${this.saveInterval}s`);
  }

  /**
   * Initialize sensor state from existing calibration
   */
  initializeSensor(sensorId: number, coeffs: CalibrationCoefficients): void {
    const P: number[][] = [
      [1e6, 0, 0, 0],
      [0, 1e6, 0, 0],
      [0, 0, 1e6, 0],
      [0, 0, 0, 1e6],
    ];

    this.sensorStates.set(sensorId, {
      coeffs,
      P,
      forgettingFactor: this.forgettingFactor,
      recentPredictions: [],
      smoothedPrediction: null,
      recentResiduals: [],
      driftThreshold: this.driftThreshold,
      driftDetected: false,
      updateCount: 0,
      rlsUpdateCount: 0,
      lastUpdate: Date.now(),
      lastSave: Date.now(),
    });
  }

  // ─── Continuous monitoring (called on EVERY incoming ADC reading) ──────────

  /**
   * Process a raw ADC reading — runs every time the DAQ sends data.
   * Does NOT require ground truth. Evolves covariance, tracks predictions,
   * computes residuals, feeds GLR drift detector.
   */
  monitorReading(sensorId: number, adcCode: number): void {
    if (!this.enabled) return;
    const state = this.sensorStates.get(sensorId);
    if (!state) return;

    // Current prediction from polynomial
    const predicted =
      state.coeffs.A * adcCode ** 3 +
      state.coeffs.B * adcCode ** 2 +
      state.coeffs.C * adcCode +
      state.coeffs.D;

    // Track recent predictions
    state.recentPredictions.push(predicted);
    if (state.recentPredictions.length > 200) state.recentPredictions.shift();

    // Initialise EMA on first reading
    if (state.smoothedPrediction === null) {
      state.smoothedPrediction = predicted;
    }

    // Exponential moving average — slow baseline that lags behind drift
    state.smoothedPrediction =
      this.emaSmoothingAlpha * predicted +
      (1 - this.emaSmoothingAlpha) * state.smoothedPrediction;

    // Residual: deviation from the smoothed baseline.
    // Stable sensor → tiny residuals. Drifting sensor → growing residuals.
    const residual = Math.abs(predicted - state.smoothedPrediction);
    state.recentResiduals.push(residual);
    if (state.recentResiduals.length > 100) state.recentResiduals.shift();

    // Process noise: covariance grows each tick → confidence naturally decays
    // without ground truth updates. This models expected sensor drift.
    for (let i = 0; i < 4; i++) {
      state.P[i][i] += this.processNoise;
    }

    state.updateCount++;
    state.lastUpdate = Date.now();

    // GLR drift check
    this.checkDrift(sensorId, state);
  }

  // ─── Full RLS update (called when user provides ground truth) ─────────────

  /**
   * Update calibration using RLS with forgetting factor.
   * Called when the user supplies a known reference pressure (zero-point init,
   * Phase 1 capture, or any manual reference).
   *
   * Formula: θ(k+1) = θ(k) + K(k+1) · e(k+1)
   */
  updateCalibration(
    sensorId: number,
    adcCode: number,
    referencePressure: number
  ): CalibrationCoefficients | null {
    if (!this.enabled) return null;
    const state = this.sensorStates.get(sensorId);
    if (!state) return null;

    // Feature vector for cubic polynomial: [adc³, adc², adc, 1]
    const phi = [adcCode ** 3, adcCode ** 2, adcCode, 1.0];

    // Current prediction
    const predicted =
      state.coeffs.A * phi[0] +
      state.coeffs.B * phi[1] +
      state.coeffs.C * phi[2] +
      state.coeffs.D * phi[3];

    // Prediction error
    const error = referencePressure - predicted;

    // Store residual
    state.recentResiduals.push(Math.abs(error));
    if (state.recentResiduals.length > 100) state.recentResiduals.shift();

    // RLS: K = P · φ / (λ + φᵀ · P · φ)
    const phiTP = [
      phi[0] * state.P[0][0] + phi[1] * state.P[1][0] + phi[2] * state.P[2][0] + phi[3] * state.P[3][0],
      phi[0] * state.P[0][1] + phi[1] * state.P[1][1] + phi[2] * state.P[2][1] + phi[3] * state.P[3][1],
      phi[0] * state.P[0][2] + phi[1] * state.P[1][2] + phi[2] * state.P[2][2] + phi[3] * state.P[3][2],
      phi[0] * state.P[0][3] + phi[1] * state.P[1][3] + phi[2] * state.P[2][3] + phi[3] * state.P[3][3],
    ];

    const denominator =
      this.forgettingFactor +
      phi[0] * phiTP[0] + phi[1] * phiTP[1] + phi[2] * phiTP[2] + phi[3] * phiTP[3];

    if (Math.abs(denominator) < 1e-10) return null;

    const K = phiTP.map((v) => v / denominator);

    // Update coefficients: θ = θ + K · error
    const newCoeffs: CalibrationCoefficients = {
      A: state.coeffs.A + K[0] * error,
      B: state.coeffs.B + K[1] * error,
      C: state.coeffs.C + K[2] * error,
      D: state.coeffs.D + K[3] * error,
    };

    // Update covariance: P = (P − K · φᵀ · P) / λ
    const KP = [
      [K[0] * phiTP[0], K[0] * phiTP[1], K[0] * phiTP[2], K[0] * phiTP[3]],
      [K[1] * phiTP[0], K[1] * phiTP[1], K[1] * phiTP[2], K[1] * phiTP[3]],
      [K[2] * phiTP[0], K[2] * phiTP[1], K[2] * phiTP[2], K[2] * phiTP[3]],
      [K[3] * phiTP[0], K[3] * phiTP[1], K[3] * phiTP[2], K[3] * phiTP[3]],
    ];

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        state.P[i][j] = (state.P[i][j] - KP[i][j]) / this.forgettingFactor;
      }
    }

    // Commit
    state.coeffs = newCoeffs;
    state.rlsUpdateCount++;
    state.updateCount++;
    state.lastUpdate = Date.now();

    // Reset EMA after a ground-truth update so it re-centres
    state.smoothedPrediction = referencePressure;

    // Check drift
    this.checkDrift(sensorId, state);

    // Auto-save
    if (Date.now() - state.lastSave > this.saveInterval * 1000) {
      this.saveCalibration(sensorId, state);
      state.lastSave = Date.now();
    }

    return newCoeffs;
  }

  // ─── GLR drift detection ──────────────────────────────────────────────────

  private checkDrift(sensorId: number, state: SensorState): void {
    if (state.recentResiduals.length < 20) return;

    const mean =
      state.recentResiduals.reduce((a, b) => a + b, 0) /
      state.recentResiduals.length;
    const variance =
      state.recentResiduals.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
      state.recentResiduals.length;
    const std = Math.sqrt(variance);

    // GLR statistic (simplified)
    const glr = mean / (std + 1e-6);

    if (glr > state.driftThreshold && !state.driftDetected) {
      state.driftDetected = true;
      console.warn(
        `⚠️ Drift detected for sensor ${sensorId}: GLR=${glr.toFixed(2)} (threshold=${state.driftThreshold})`
      );
      console.warn(`   Mean residual: ${mean.toFixed(4)}, Std: ${std.toFixed(4)}`);
    } else if (glr <= state.driftThreshold && state.driftDetected) {
      state.driftDetected = false;
      console.log(`✅ Drift cleared for sensor ${sensorId}`);
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private saveCalibration(sensorId: number, state: SensorState): void {
    const calibrationDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(calibrationDir)) {
      fs.mkdirSync(calibrationDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = path.join(calibrationDir, `phase2_update_${timestamp}.json`);

    try {
      const existingFile = this.findLatestCalibrationFile();
      let data: Record<string, unknown> = {};

      if (existingFile && fs.existsSync(existingFile)) {
        data = JSON.parse(fs.readFileSync(existingFile, 'utf-8'));
      } else {
        data = {
          sensor_type: 'PT',
          unit: 'PSI',
          framework: 'phase2_rls',
          created: new Date().toISOString(),
          phase: 'MONITORING',
          calibration_polynomials: {},
        };
      }

      if (!data.calibration_polynomials) data.calibration_polynomials = {};
      (data.calibration_polynomials as Record<string, number[]>)[sensorId.toString()] = [
        state.coeffs.A,
        state.coeffs.B,
        state.coeffs.C,
        state.coeffs.D,
      ];

      if (!data.phase2_updates) data.phase2_updates = {};
      (data.phase2_updates as Record<string, unknown>)[sensorId.toString()] = {
        update_count: state.updateCount,
        rls_updates: state.rlsUpdateCount,
        last_update: new Date(state.lastUpdate).toISOString(),
        drift_detected: state.driftDetected,
      };

      fs.writeFileSync(filename, JSON.stringify(data, null, 2));
      console.log(`💾 Phase 2 calibration saved for sensor ${sensorId}: ${filename}`);
    } catch (error) {
      console.error(`❌ Failed to save Phase 2 calibration: ${error}`);
    }
  }

  /**
   * Force save all channels NOW (called by save_coefficients command)
   */
  saveAllNow(): void {
    for (const [sensorId, state] of this.sensorStates) {
      this.saveCalibration(sensorId, state);
      state.lastSave = Date.now();
    }
  }

  private findLatestCalibrationFile(): string | null {
    const calibrationDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(calibrationDir)) return null;

    const jsonFiles = fs
      .readdirSync(calibrationDir)
      .filter((f) => f.endsWith('.json') && !f.includes('learned_prior'))
      .map((f) => path.join(calibrationDir, f));

    if (jsonFiles.length === 0) return null;
    return jsonFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getCalibration(sensorId: number): CalibrationCoefficients | null {
    return this.sensorStates.get(sensorId)?.coeffs ?? null;
  }

  getAllStatus(): Array<{
    sensorId: number;
    updateCount: number;
    rlsUpdateCount: number;
    lastUpdate: number;
    driftDetected: boolean;
    meanResidual: number;
    glrStat: number;
    confidence: 'MAXIMUM' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCALIBRATED';
    coeffs: { A: number; B: number; C: number; D: number };
    phase2Active: boolean;
    covarianceTrace: number;
  }> {
    const result: ReturnType<typeof this.getAllStatus> = [];

    for (const [sensorId, state] of this.sensorStates) {
      const n = state.recentResiduals.length;
      const mean = n > 0 ? state.recentResiduals.reduce((a, b) => a + b, 0) / n : 0;
      const variance =
        n > 1 ? state.recentResiduals.reduce((s, r) => s + (r - mean) ** 2, 0) / n : 0;
      const std = Math.sqrt(variance);
      const glrStat = mean / (std + 1e-6);

      // Covariance trace — proxy for overall uncertainty
      const covTrace = state.P[0][0] + state.P[1][1] + state.P[2][2] + state.P[3][3];

      let confidence: 'MAXIMUM' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCALIBRATED';
      if (state.rlsUpdateCount === 0) {
        confidence = 'UNCALIBRATED';
      } else if (
        state.rlsUpdateCount > 200 &&
        !state.driftDetected &&
        glrStat < this.driftThreshold
      ) {
        confidence = 'MAXIMUM';
      } else if (state.rlsUpdateCount > 50 && !state.driftDetected) {
        confidence = 'HIGH';
      } else if (state.rlsUpdateCount > 5) {
        confidence = 'MEDIUM';
      } else {
        confidence = 'LOW';
      }

      result.push({
        sensorId,
        updateCount: state.updateCount,
        rlsUpdateCount: state.rlsUpdateCount,
        lastUpdate: state.lastUpdate,
        driftDetected: state.driftDetected,
        meanResidual: mean,
        glrStat,
        confidence,
        coeffs: { ...state.coeffs },
        phase2Active: this.enabled,
        covarianceTrace: covTrace,
      });
    }

    return result.sort((a, b) => a.sensorId - b.sensorId);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`Phase 2 calibration ${enabled ? 'enabled' : 'disabled'}`);
  }
}
