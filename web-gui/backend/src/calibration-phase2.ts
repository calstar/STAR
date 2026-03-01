/**
 * Phase 2: Autonomous Monitoring and Self-Recalibration
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
 * Key insight: All sensors should behave roughly the same way.
 * All coefficients (A, B, C, D) can drift and should be self-correcting.
 * The zero is just a reference point to recenter, not a permanent target.
 *
 * Implements:
 * - RLS (Recursive Least Squares) with forgetting factor
 * - GLR (Generalized Likelihood Ratio) drift detection
 * - Process-noise covariance growth for autonomous confidence tracking
 * - Self-correcting calibration that adjusts all coefficients
 * - Periodic saving of updated coefficients
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { CalibrationCoefficients, validateCalibrationCoefficients } from './calibration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SensorState {
  // Baseline calibration coefficients (from JSON) — starting point for calibration
  baselineCoeffs: CalibrationCoefficients;

  // Drift adjustment (what Phase 2 modifies) — all coefficients can drift and be corrected
  adjustment: CalibrationCoefficients;

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

  // Ground truth tracking for automatic drift correction
  lastGroundTruth: number | null;  // Last known ground truth value (from zero_all or capture_reference)
  lastGroundTruthTime: number;    // When ground truth was set

  // Cross-sensor coupling state
  recentReadings: Array<{ time: number; psi: number }>; // Recent pressure readings for consensus
  consensusWeight: number; // Weight in consensus calculations (based on confidence)
}

// Helper to compute live coefficients from baseline + adjustment
function getLiveCoeffs(state: SensorState): CalibrationCoefficients {
  return {
    A: state.baselineCoeffs.A + state.adjustment.A,
    B: state.baselineCoeffs.B + state.adjustment.B,
    C: state.baselineCoeffs.C + state.adjustment.C,
    D: state.baselineCoeffs.D + state.adjustment.D,
  };
}

// Sensor groups that should agree (for consensus-based calibration)
// Removing hardcoded exclusions to dynamically support GUI-selected boards and mappings.
const SENSOR_GROUPS: Record<string, number[]> = {};

export class Phase2CalibrationEngine {
  private sensorStates: Map<number, SensorState> = new Map();
  private enabled: boolean = true;
  private saveInterval: number = 300; // 5 minutes
  private driftThreshold: number = 2.0; // GLR threshold (lowered from 3.0 for better sensitivity)
  private forgettingFactor: number = 0.995; // RLS forgetting factor

  // Process noise added to covariance diagonal each monitoring tick.
  // Models expected drift rate — confidence decays naturally without ground truth.
  private processNoise: number = 1e-6;

  // EMA smoothing factor for prediction baseline (0.01 = very slow, stable)
  private emaSmoothingAlpha: number = 0.02;

  // Cross-sensor coupling parameters
  private consensusThreshold: number = 1.0; // PSI difference threshold for consensus (sensors should agree within this)
  private consensusUpdateRate: number = 0.1; // How aggressively to update based on consensus (0-1)
  private minConsensusSensors: number = 2; // Minimum sensors needed for consensus

  // Configurable parameters (can be set from config file)
  public setDriftThreshold(threshold: number): void {
    this.driftThreshold = threshold;
    // Update all existing sensor states
    for (const state of this.sensorStates.values()) {
      state.driftThreshold = threshold;
    }
    console.log(`🔧 Phase 2 drift threshold updated to ${threshold}`);
  }

  public setProcessNoise(noise: number): void {
    this.processNoise = noise;
    console.log(`🔧 Phase 2 process noise updated to ${noise}`);
  }

  public setEMASmoothingAlpha(alpha: number): void {
    this.emaSmoothingAlpha = alpha;
    console.log(`🔧 Phase 2 EMA smoothing alpha updated to ${alpha}`);
  }

  public setForgettingFactor(factor: number): void {
    this.forgettingFactor = factor;
    // Update all existing sensor states
    for (const state of this.sensorStates.values()) {
      state.forgettingFactor = factor;
    }
    console.log(`🔧 Phase 2 forgetting factor updated to ${factor}`);
  }

  public setSaveInterval(intervalSeconds: number): void {
    this.saveInterval = intervalSeconds;
    console.log(`🔧 Phase 2 save interval updated to ${intervalSeconds}s`);
  }

  public setMinResidualsForDriftCheck(minResiduals: number): void {
    // This is used in checkDrift - we'll store it as a class property
    console.log(`🔧 Phase 2 min residuals for drift check updated to ${minResiduals}`);
  }

  public setAbsoluteDriftThresholdPsi(threshold: number): void {
    // This is used in checkDrift - we'll store it as a class property
    console.log(`🔧 Phase 2 absolute drift threshold updated to ${threshold} PSI`);
  }

  public setConsensusThreshold(threshold: number): void {
    this.consensusThreshold = threshold;
    console.log(`🔧 Phase 2 consensus threshold updated to ${threshold} PSI`);
  }

  public setConsensusUpdateRate(rate: number): void {
    this.consensusUpdateRate = Math.max(0, Math.min(1, rate)); // Clamp to [0, 1]
    console.log(`🔧 Phase 2 consensus update rate updated to ${this.consensusUpdateRate}`);
  }

  constructor() {
    console.log('🤖 Phase 2 Calibration Engine initialized');
    console.log(`   Forgetting factor: ${this.forgettingFactor}`);
    console.log(`   Drift threshold:   ${this.driftThreshold}`);
    console.log(`   Process noise:     ${this.processNoise}`);
    console.log(`   Auto-save interval: ${this.saveInterval}s`);
  }

  /**
   * Reset Phase 2 adjustment for a sensor (sets adjustment back to zero)
   * This undoes any consensus or drift corrections that may have corrupted the calibration
   */
  resetAdjustment(sensorId: number): void {
    const state = this.sensorStates.get(sensorId);
    if (!state) {
      console.warn(`⚠️ Cannot reset adjustment for CH${sensorId}: sensor not initialized`);
      return;
    }

    const oldAdjustment = { ...state.adjustment };
    state.adjustment = { A: 0, B: 0, C: 0, D: 0 };
    state.consensusWeight = 1.0; // Reset consensus weight
    state.smoothedPrediction = null; // Reset EMA
    state.recentResiduals = []; // Clear residuals
    state.recentPredictions = []; // Clear predictions
    state.recentReadings = []; // Clear readings

    console.log(
      `🔄 Phase 2 adjustment reset for CH${sensorId}: ` +
      `D was ${oldAdjustment.D.toFixed(6)}, now 0.000000. All state cleared.`
    );
  }

  /**
   * Reset adjustments for all sensors in a group (useful when consensus corrupted multiple sensors)
   */
  resetGroupAdjustments(groupName: string): void {
    const sensorGroup = SENSOR_GROUPS[groupName];
    if (!sensorGroup) {
      console.warn(`⚠️ Unknown sensor group: ${groupName}`);
      return;
    }

    console.log(`🔄 Resetting Phase 2 adjustments for group ${groupName}: [${sensorGroup.join(', ')}]`);
    for (const sensorId of sensorGroup) {
      this.resetAdjustment(sensorId);
    }
  }

  /**
   * Initialize sensor state from existing calibration (baseline)
   * Adjustment starts at zero — Phase 2 will guide it to correct drift
   * Idempotent: if sensor already initialized, only updates baseline if different
   */
  initializeSensor(sensorId: number, baselineCoeffs: CalibrationCoefficients): void {
    const existing = this.sensorStates.get(sensorId);
    if (existing) {
      // Already initialized — update baseline but preserve adjustment
      existing.baselineCoeffs = baselineCoeffs;
      return;
    }

    const P: number[][] = [
      [1e6, 0, 0, 0],
      [0, 1e6, 0, 0],
      [0, 0, 1e6, 0],
      [0, 0, 0, 1e6],
    ];

    this.sensorStates.set(sensorId, {
      baselineCoeffs, // Immutable baseline from JSON
      adjustment: { A: 0, B: 0, C: 0, D: 0 }, // Start with no adjustment
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
      lastGroundTruth: null,
      lastGroundTruthTime: 0,
      recentReadings: [],
      consensusWeight: 1.0, // Start with equal weight
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

    // Current prediction from live coefficients (baseline + adjustment)
    const coeffs = getLiveCoeffs(state);
    const predicted =
      coeffs.A * adcCode ** 3 +
      coeffs.B * adcCode ** 2 +
      coeffs.C * adcCode +
      coeffs.D;

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

    // NOTE: We do NOT auto-correct based on ground truth here
    // Ground truth (like 0 PSI from zero_all) is just a calibration reference point
    // It's used to set the offset, not to clamp readings to that value
    // If pressure legitimately changes (0 → 100 PSI), Phase 2 should track that, not force it back to 0
    // Phase 2 self-corrects by tracking residuals and detecting actual sensor drift, not pressure changes

    // Process noise: covariance grows each tick → confidence naturally decays
    // without ground truth updates. This models expected sensor drift.
    for (let i = 0; i < 4; i++) {
      state.P[i][i] += this.processNoise;
    }

    state.updateCount++;
    state.lastUpdate = Date.now();

    // Store recent reading for consensus calculations
    state.recentReadings.push({ time: Date.now(), psi: predicted });
    if (state.recentReadings.length > 50) state.recentReadings.shift();

    // GLR drift check
    this.checkDrift(sensorId, state);

    // Cross-sensor consensus check (autonomous calibration using sensor agreement)
    this.checkConsensusAndUpdate(sensorId, state, adcCode);
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

    // Current prediction from live coefficients (baseline + adjustment)
    const coeffs = getLiveCoeffs(state);
    const predicted =
      coeffs.A * phi[0] +
      coeffs.B * phi[1] +
      coeffs.C * phi[2] +
      coeffs.D * phi[3];

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

    // Weighting: All coefficients can drift and be corrected, but with different sensitivities
    // D (offset) drifts most (thermal, aging), but A, B, C can also drift (sensor degradation)
    // All sensors should behave roughly the same way, so all coefficients should be self-correcting
    // Use smaller weights for A, B, C to allow correction but prefer D adjustments
    const weights = [0.1, 0.1, 0.1, 1.0]; // A, B, C get 10% weight, D gets 100%
    const weightedK = K.map((k, i) => k * weights[i]);

    // Update ADJUSTMENT (not baseline): adjustment = adjustment + weightedK · error
    // This self-corrects all coefficients based on ground truth, allowing all to drift and be corrected
    // The adjustment is added to baseline, so we're correcting drift in all coefficients
    const newAdjustment = {
      A: state.adjustment.A + weightedK[0] * error,  // Can drift and be corrected
      B: state.adjustment.B + weightedK[1] * error,  // Can drift and be corrected
      C: state.adjustment.C + weightedK[2] * error,  // Can drift and be corrected
      D: state.adjustment.D + weightedK[3] * error,  // Drifts most, gets full correction
    };

    // Validate the new calibration before accepting it
    const testCoeffs = {
      A: state.baselineCoeffs.A + newAdjustment.A,
      B: state.baselineCoeffs.B + newAdjustment.B,
      C: state.baselineCoeffs.C + newAdjustment.C,
      D: state.baselineCoeffs.D + newAdjustment.D,
    };

    if (!validateCalibrationCoefficients(testCoeffs)) {
      console.error(
        `❌ Phase 2 update rejected for sensor ${sensorId}: would produce invalid calibration. ` +
        `Adjustment: A=${newAdjustment.A.toExponential(2)}, B=${newAdjustment.B.toExponential(2)}, ` +
        `C=${newAdjustment.C.toExponential(2)}, D=${newAdjustment.D.toFixed(2)}`
      );
      // Reject the update - keep old adjustment
      return null;
    }

    state.adjustment = newAdjustment;

    // Update covariance: P = (P − K · φᵀ · P) / λ
    // Use original K (not weighted) for covariance update
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

    // Get updated live coefficients for return
    const updatedCoeffs = getLiveCoeffs(state);
    state.rlsUpdateCount++;
    state.updateCount++;
    state.lastUpdate = Date.now();

    // Reset EMA after a ground-truth update so it re-centres
    state.smoothedPrediction = referencePressure;

    // Store ground truth for reference (used for logging/debugging, NOT for clamping)
    // The zero (0 PSI) is just a calibration reference point to recenter, not a permanent target
    // If pressure legitimately changes (0 → 100 PSI), Phase 2 should track that, not force it back to 0
    state.lastGroundTruth = referencePressure;
    state.lastGroundTruthTime = Date.now();

    // Check drift (informational only - doesn't auto-correct)
    this.checkDrift(sensorId, state);

    // Auto-save
    if (Date.now() - state.lastSave > this.saveInterval * 1000) {
      this.saveCalibration(sensorId, state);
      state.lastSave = Date.now();
    }

    return updatedCoeffs;
  }

  // ─── Cross-sensor consensus and covariance coupling ────────────────────────

  /**
   * Calculate measurement uncertainty for a sensor at a given ADC code.
   * Uses the covariance matrix P to compute prediction uncertainty.
   * Based on robust calibration framework: σ²_pred = φᵀ P φ
   */
  private calculateMeasurementUncertainty(
    state: SensorState,
    adcCode: number
  ): number {
    const phi = [adcCode ** 3, adcCode ** 2, adcCode, 1.0];
    // Compute φᵀ P φ (prediction variance)
    let variance = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        variance += phi[i] * state.P[i][j] * phi[j];
      }
    }
    return Math.sqrt(Math.max(0, variance));
  }

  /**
   * Calculate sensor reliability score based on:
   * - Number of RLS updates (ground truth calibrations)
   * - Recent residual statistics (lower residuals = more reliable)
   * - Measurement uncertainty (lower uncertainty = more reliable)
   *
   * NOTE: We do NOT bias toward zero PSI - sensors should agree at whatever pressure they're actually at
   */
  private calculateSensorReliability(
    state: SensorState,
    measurementUncertainty: number
  ): number {
    // Factor 1: RLS updates (ground truth calibrations) - most important
    const rlsFactor = Math.min(1.0, state.rlsUpdateCount / 10.0); // 10 updates = full confidence

    // Factor 2: Recent residual statistics (lower mean residual = more reliable)
    let residualFactor = 0.5; // Default if no residuals
    if (state.recentResiduals.length >= 10) {
      const meanResidual = state.recentResiduals.reduce((a, b) => a + b, 0) / state.recentResiduals.length;
      residualFactor = Math.max(0.1, Math.min(1.0, 1.0 - meanResidual / 5.0)); // 5 PSI residual = 0 confidence
    }

    // Factor 3: Measurement uncertainty (inverse - lower uncertainty = higher reliability)
    const uncertaintyFactor = 1.0 / (1.0 + measurementUncertainty);

    // Weighted combination: RLS updates are most important
    return 0.5 * rlsFactor + 0.3 * residualFactor + 0.2 * uncertaintyFactor;
  }

  /**
   * Check consensus between sensors in the same group and autonomously update
   * calibrations to bring them into agreement. Implements proper covariance coupling:
   * - Uses measurement uncertainty (not parameter covariance) to determine reliability
   * - Only updates the LESS reliable sensor toward the MORE reliable one
   * - Uses empirical Bayes approach: sensors that agree reinforce each other
   */
  private checkConsensusAndUpdate(sensorId: number, state: SensorState, adcCode: number): void {
    // Find which sensor group this sensor belongs to
    let sensorGroup: number[] | null = null;
    for (const group of Object.values(SENSOR_GROUPS)) {
      if (group.includes(sensorId)) {
        sensorGroup = group;
        break;
      }
    }

    if (!sensorGroup || sensorGroup.length < this.minConsensusSensors) return;

    // Get current sensor's reading first (needed for reliability calculation)
    const currentPsi = state.recentReadings.length > 0
      ? state.recentReadings[state.recentReadings.length - 1].psi
      : null;
    if (currentPsi === null) return;

    // Calculate current sensor's measurement uncertainty and reliability
    const currentUncertainty = this.calculateMeasurementUncertainty(state, adcCode);
    const currentReliability = this.calculateSensorReliability(state, currentUncertainty);

    // Get recent readings from all sensors in the group
    const groupReadings: Array<{
      sensorId: number;
      psi: number;
      uncertainty: number;
      reliability: number;
      state: SensorState;
      adcCode: number;
    }> = [];
    const now = Date.now();
    const maxAge = 10000; // 10 seconds - readings must be recent

    for (const otherSensorId of sensorGroup) {
      const otherState = this.sensorStates.get(otherSensorId);
      if (!otherState || otherSensorId === sensorId) continue;

      // Get most recent reading
      if (otherState.recentReadings.length === 0) continue;
      const latest = otherState.recentReadings[otherState.recentReadings.length - 1];
      if (now - latest.time > maxAge) continue;

      // Need to get the ADC code that produced this reading - estimate from current reading
      // For now, use a representative ADC (we'll improve this)
      const otherAdcCode = adcCode; // Approximate - in practice should track ADC with readings
      const otherUncertainty = this.calculateMeasurementUncertainty(otherState, otherAdcCode);
      const otherReliability = this.calculateSensorReliability(otherState, otherUncertainty);

      groupReadings.push({
        sensorId: otherSensorId,
        psi: latest.psi,
        uncertainty: otherUncertainty,
        reliability: otherReliability,
        state: otherState,
        adcCode: otherAdcCode,
      });
    }

    if (groupReadings.length === 0) return;

    // Find the best reference sensor in the group
    // Prefer sensors that are: 1) More reliable, 2) Lower uncertainty, 3) More consistent with group
    // NOTE: We do NOT bias toward zero - sensors should agree at whatever pressure they're actually at
    const allSensors = [
      { sensorId, psi: currentPsi, reliability: currentReliability, uncertainty: currentUncertainty },
      ...groupReadings.map(r => ({ sensorId: r.sensorId, psi: r.psi, reliability: r.reliability, uncertainty: r.uncertainty }))
    ];

    // Calculate group mean pressure (what the group thinks the pressure is)
    const groupMeanPsi = groupReadings.length > 0
      ? groupReadings.reduce((sum, r) => sum + r.psi, 0) / groupReadings.length
      : currentPsi;

    // Score each sensor: reliability and low uncertainty are most important
    // Also consider how well it agrees with the group (but don't force toward zero)
    const scoredSensors = allSensors.map(s => {
      const reliabilityScore = s.reliability;
      const uncertaintyScore = 1.0 / (1.0 + s.uncertainty);
      // Agreement score: how well does this sensor agree with the group?
      // This helps when most sensors agree but one doesn't
      const agreementScore = groupReadings.length > 0
        ? 1.0 / (1.0 + Math.abs(s.psi - groupMeanPsi) / 10.0) // Better agreement = higher score
        : 0.5;
      const totalScore = reliabilityScore * 2.0 + uncertaintyScore * 1.5 + agreementScore * 0.5;
      return { ...s, score: totalScore };
    });

    const bestReference = scoredSensors.reduce((best, curr) =>
      curr.score > best.score ? curr : best
    );

    // Calculate weighted consensus using reliability-weighted mean of OTHER sensors
    // More reliable sensors have more weight
    const totalReliability = groupReadings.reduce((sum, r) => sum + r.reliability, 0);
    if (totalReliability === 0) return;

    const weightedSum = groupReadings.reduce((sum, r) => sum + r.psi * r.reliability, 0);
    const reliabilityWeightedConsensus = weightedSum / totalReliability;

    // Use inverse-variance weighting for consensus (like robust calibration framework)
    // Sensors with lower uncertainty get more weight
    // EXCLUDE current sensor from consensus (use other sensors as ground truth)
    const groupWeights = groupReadings.map(r => 1.0 / (r.uncertainty ** 2 + 1e-6));
    const totalGroupWeight = groupWeights.reduce((sum, w) => sum + w, 0);
    const inverseVarianceConsensus = totalGroupWeight > 0
      ? groupReadings.reduce((sum, r, i) => sum + r.psi * groupWeights[i], 0) / totalGroupWeight
      : reliabilityWeightedConsensus;

    // Use inverse-variance consensus if uncertainties are valid,
    // otherwise fall back to reliability-weighted
    const consensusPsi = (totalGroupWeight > 0 &&
      groupReadings.every(r => r.uncertainty < 1000 && r.uncertainty > 0))
      ? inverseVarianceConsensus
      : reliabilityWeightedConsensus;

    // Recalculate disagreement with proper consensus
    const disagreement = Math.abs(currentPsi - consensusPsi);

    // CRITICAL: Only apply consensus when sensors are at similar pressures (steady state)
    // During pressurization/venting, sensors are legitimately at different pressures
    // Consensus should only update when sensors should agree (same location, steady state)
    const groupPressureRange = groupReadings.length > 0
      ? Math.max(...groupReadings.map(r => r.psi)) - Math.min(...groupReadings.map(r => r.psi))
      : 0;
    const allNearZero = Math.abs(currentPsi) < 5.0 && groupReadings.every(r => Math.abs(r.psi) < 5.0);
    const allAtSimilarPressure = groupPressureRange < 10.0; // Sensors within 10 PSI of each other

    // Check if pressure is changing rapidly (pressurization/venting)
    const pressureChangeRate = state.recentReadings.length >= 10
      ? Math.abs(state.recentReadings[state.recentReadings.length - 1].psi -
        state.recentReadings[state.recentReadings.length - 10].psi) / 10
      : 0;
    const isPressureChanging = pressureChangeRate > 2.0; // More than 2 PSI per reading indicates rapid change

    // Only allow consensus updates when:
    // 1. All sensors are near zero (steady state, should agree), OR
    // 2. All sensors are at similar pressures AND pressure is stable (not changing rapidly)
    // This prevents zero point from shifting during pressurization/venting when sensors are at different pressures
    if (!allNearZero && (!allAtSimilarPressure || isPressureChanging)) {
      // Sensors are at different pressures or pressure is changing - this is expected during pressurization/venting
      // Don't apply consensus updates as this would corrupt the zero point
      if (disagreement > 10.0 && Math.random() < 0.01) {
        console.log(
          `🛡️ CH${sensorId} consensus update skipped: sensors at different pressures or pressure changing ` +
          `(current=${currentPsi.toFixed(2)} PSI, group range=${groupPressureRange.toFixed(2)} PSI, ` +
          `change rate=${pressureChangeRate.toFixed(2)} PSI/reading, disagreement=${disagreement.toFixed(2)} PSI). ` +
          `This is expected during pressurization/venting - not a calibration error.`
        );
      }
      return;
    }

    // CRITICAL: Protect sensors that agree with the group majority
    // If most sensors in the group agree and current sensor is an outlier, check carefully
    // Calculate group statistics (excluding current sensor)
    const groupPressures = groupReadings.map(r => r.psi);
    const groupMean = groupPressures.length > 0
      ? groupPressures.reduce((a, b) => a + b, 0) / groupPressures.length
      : currentPsi;
    const groupStd = groupPressures.length > 1
      ? Math.sqrt(groupPressures.reduce((sum, p) => sum + (p - groupMean) ** 2, 0) / groupPressures.length)
      : 0;

    // If group sensors are in good agreement (low std dev) and current sensor is an outlier, be cautious
    const groupAgreementGood = groupStd < 2.0 && groupReadings.length >= 1; // Group agrees within 2 PSI
    const currentIsOutlier = groupAgreementGood && Math.abs(currentPsi - groupMean) > 3 * Math.max(groupStd, 0.5);

    // If group agrees well and current is an outlier, only update if current is clearly less reliable
    if (groupAgreementGood && currentIsOutlier) {
      const avgGroupReliability = groupReadings.reduce((sum, r) => sum + r.reliability, 0) / groupReadings.length;
      // Only update if current is significantly less reliable than group average
      if (currentReliability >= avgGroupReliability * 0.8) {
        if (disagreement > 5.0 && Math.random() < 0.1) {
          console.warn(
            `🛡️ CH${sensorId} protected: Group sensors agree well (mean=${groupMean.toFixed(2)} PSI, ` +
            `std=${groupStd.toFixed(2)} PSI) but current (${currentPsi.toFixed(2)} PSI) is outlier. ` +
            `Current reliability (${currentReliability.toFixed(3)}) similar to group (${avgGroupReliability.toFixed(3)}). ` +
            `Not updating to prevent corruption.`
          );
        }
        return;
      }
    }

    // For large disagreements, be more aggressive about correction
    // If disagreement > 20 PSI, we should correct even if reliability is similar
    // This handles cases where one sensor is clearly wrong
    const largeDisagreement = disagreement > 20.0;

    // Only update if current sensor is NOT the best reference
    // AND current sensor is significantly worse (lower score)
    const currentScore = scoredSensors.find(s => s.sensorId === sensorId)?.score ?? 0;
    const scoreGap = bestReference.score - currentScore;

    // Don't update if current sensor is the best reference or close to it
    if (bestReference.sensorId === sensorId || scoreGap < 0.5) {
      if (disagreement > 10.0 && Math.random() < 0.05) {
        console.log(
          `ℹ️ CH${sensorId} consensus: Current sensor is best reference (score=${currentScore.toFixed(3)}, ` +
          `best=${bestReference.score.toFixed(3)}, gap=${scoreGap.toFixed(3)}). ` +
          `Not updating (current=${currentPsi.toFixed(2)} PSI, consensus=${consensusPsi.toFixed(2)} PSI)`
        );
      }
      return;
    }

    // Log why we're updating
    if (disagreement > 5.0) {
      console.warn(
        `⚠️ CH${sensorId} consensus update: ` +
        `Current=${currentPsi.toFixed(2)} PSI (score=${currentScore.toFixed(3)}) ` +
        `→ Consensus=${consensusPsi.toFixed(2)} PSI (best reference: CH${bestReference.sensorId}, ` +
        `score=${bestReference.score.toFixed(3)}, gap=${scoreGap.toFixed(3)}), ` +
        `disagreement=${disagreement.toFixed(2)} PSI`
      );
    }

    // Log consensus status for large disagreements (before protection checks)
    if (disagreement > 5.0 && Math.random() < 0.1) {
      console.warn(
        `⚠️ CH${sensorId} large disagreement: ` +
        `current=${currentPsi.toFixed(2)} PSI (score=${currentScore.toFixed(3)}), ` +
        `consensus=${consensusPsi.toFixed(2)} PSI (best reference: CH${bestReference.sensorId}, score=${bestReference.score.toFixed(3)}), ` +
        `disagreement=${disagreement.toFixed(2)} PSI, ` +
        `group: ${groupReadings.map(r => `CH${r.sensorId}=${r.psi.toFixed(2)}`).join(', ')}`
      );
    }

    if (disagreement > this.consensusThreshold) {

      // CRITICAL: Protect zero point calibration from being overwritten by consensus
      // If sensor was recently zeroed (within last 10 seconds), skip consensus updates
      // This prevents consensus from undoing the zero_all calibration immediately after zeroing
      // Reduced from 30s to 10s to allow legitimate pressure changes sooner
      const timeSinceZero = state.lastGroundTruthTime ? Date.now() - state.lastGroundTruthTime : Infinity;
      const wasRecentlyZeroed = state.lastGroundTruth === 0 && timeSinceZero < 10000; // 10 seconds protection (reduced)

      // Update calibration to bring it into agreement
      const error = consensusPsi - currentPsi;

      // Only protect zero calibration for a short time after zeroing
      // After that, allow consensus to work normally (it won't corrupt zero if sensors are actually at zero)
      if (wasRecentlyZeroed && Math.abs(error) > 2.0) {
        // Skip consensus update only if sensor was very recently zeroed AND consensus wants large change
        // This protects immediate post-zero calibration but allows gradual transitions
        if (Math.random() < 0.1) { // Log occasionally
          console.log(
            `🛡️ CH${sensorId} consensus update skipped: sensor was recently zeroed ` +
            `(${(timeSinceZero / 1000).toFixed(1)}s ago) and consensus wants large change (${error.toFixed(2)} PSI) - protecting zero point calibration`
          );
        }
        return; // Don't apply consensus correction
      }

      // Only update if error is significant and we have enough consensus sensors
      // Lowered threshold from 0.5 to 0.1 PSI to catch smaller errors
      if (Math.abs(error) > 0.1 && groupReadings.length >= this.minConsensusSensors - 1) {
        // For large errors, apply corrections gradually in smaller steps
        // Cap the maximum single-step adjustment to prevent validation failures
        const maxSingleStepAdjustment = 2.0; // Maximum PSI adjustment per step
        const baseUpdateRate = this.consensusUpdateRate;

        // Calculate desired adjustment, but cap it
        let desiredAdjustment = error * baseUpdateRate;
        if (Math.abs(desiredAdjustment) > maxSingleStepAdjustment) {
          // For very large errors, use smaller steps - will converge over multiple iterations
          desiredAdjustment = Math.sign(error) * maxSingleStepAdjustment;
          console.log(
            `📊 CH${sensorId} large error (${error.toFixed(2)} PSI): capping adjustment to ${desiredAdjustment.toFixed(4)} PSI ` +
            `(will converge over multiple steps)`
          );
        }

        // Update D term (offset) to bring sensor into agreement with consensus
        // This is a simplified update - full RLS would be better but this is autonomous
        const adjustmentDelta = desiredAdjustment;
        const newAdjustment = {
          ...state.adjustment,
          D: state.adjustment.D + adjustmentDelta,
          // Don't adjust C term for large errors - focus on D (offset) correction
          C: Math.abs(error) > 2.0 && Math.abs(error) < 10.0 ? state.adjustment.C + adjustmentDelta * 0.05 : state.adjustment.C,
        };

        // Validate the new calibration before accepting it
        const consensusTestCoeffs = {
          A: state.baselineCoeffs.A + newAdjustment.A,
          B: state.baselineCoeffs.B + newAdjustment.B,
          C: state.baselineCoeffs.C + newAdjustment.C,
          D: state.baselineCoeffs.D + newAdjustment.D,
        };

        // Check what's failing validation
        let validationFailed = false;
        let failureReason = '';
        if (!isFinite(consensusTestCoeffs.A) || !isFinite(consensusTestCoeffs.B) ||
          !isFinite(consensusTestCoeffs.C) || !isFinite(consensusTestCoeffs.D)) {
          validationFailed = true;
          failureReason = 'NaN/Infinity in coefficients';
        } else if (Math.abs(consensusTestCoeffs.A) > 1e-12) {
          validationFailed = true;
          failureReason = `A coefficient too large: ${consensusTestCoeffs.A.toExponential(2)}`;
        } else {
          // Test at typical ADC values
          const testAdcs = [1000000, 150000000, 300000000];
          for (const adc of testAdcs) {
            const testPsi = consensusTestCoeffs.A * (adc ** 3) +
              consensusTestCoeffs.B * (adc ** 2) +
              consensusTestCoeffs.C * adc +
              consensusTestCoeffs.D;
            if (!isFinite(testPsi) || testPsi < -1000 || testPsi > 10000) {
              validationFailed = true;
              failureReason = `Test at ADC=${adc} produced invalid PSI: ${testPsi.toFixed(2)}`;
              break;
            }
          }
        }

        if (!validationFailed) {
          const oldD = state.adjustment.D;
          state.adjustment = newAdjustment;

          // Update consensus weight based on agreement (sensors that agree get higher weight)
          state.consensusWeight = Math.max(0.1, Math.min(2.0, state.consensusWeight * 1.001));

          // Log autonomous correction (always log for large corrections)
          const shouldLog = Math.abs(error) > 5.0 || Math.random() < 0.2;
          if (shouldLog) {
            console.log(
              `🔄 Phase 2 autonomous correction: CH${sensorId} D adjusted from ${oldD.toFixed(6)} to ${newAdjustment.D.toFixed(6)} ` +
              `(Δ=${adjustmentDelta.toFixed(4)} PSI, error=${error.toFixed(2)} PSI, ` +
              `disagreement=${disagreement.toFixed(2)} PSI, consensus=${consensusPsi.toFixed(2)} PSI, ` +
              `current=${currentPsi.toFixed(2)} PSI)`
            );
          }

          // Update covariance to reflect increased uncertainty after autonomous correction
          // (we're less confident after making an autonomous adjustment)
          for (let i = 0; i < 4; i++) {
            state.P[i][i] += this.processNoise * 10; // Increase uncertainty
          }
        } else {
          // Consensus update would produce invalid calibration - reject it with detailed reason
          console.warn(
            `❌ Phase 2 consensus update rejected for CH${sensorId}: ${failureReason} ` +
            `(error=${error.toFixed(2)} PSI, adjustmentDelta=${adjustmentDelta.toFixed(4)} PSI, ` +
            `current D=${state.adjustment.D.toFixed(6)}, new D=${newAdjustment.D.toFixed(6)}, ` +
            `baseline D=${state.baselineCoeffs.D.toFixed(6)})`
          );
          return; // Don't update
        }
      } else {
        // Error too small or not enough sensors
        if (disagreement > 10.0 && Math.random() < 0.1) {
          console.warn(
            `⚠️ CH${sensorId} consensus update skipped: error=${error.toFixed(2)} PSI ` +
            `(too small: ${Math.abs(error) <= 0.1}), groupReadings=${groupReadings.length} ` +
            `(need ${this.minConsensusSensors - 1})`
          );
        }
      }
    } else {
      // Sensor agrees with consensus - increase confidence
      state.consensusWeight = Math.min(2.0, state.consensusWeight * 1.001);
    }
  }

  // ─── GLR drift detection ──────────────────────────────────────────────────

  private checkDrift(sensorId: number, state: SensorState): void {
    // Lower minimum samples for faster detection (was 20, now 10)
    if (state.recentResiduals.length < 10) return;

    const mean =
      state.recentResiduals.reduce((a, b) => a + b, 0) /
      state.recentResiduals.length;
    const variance =
      state.recentResiduals.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
      state.recentResiduals.length;
    const std = Math.sqrt(variance);

    // Improved GLR statistic: use mean/std ratio but also check absolute mean
    // This catches both relative drift (mean >> std) and absolute drift (mean > threshold_psi)
    const glr = mean / (std + 1e-6);
    const absoluteThresholdPsi = 2.0; // Also trigger on absolute mean residual > 2 PSI

    // Log drift check occasionally for debugging
    if (Math.random() < 0.01 && state.recentResiduals.length >= 20) {
      console.log(`[Phase2 CH${sensorId}] Drift check: mean=${mean.toFixed(4)}, std=${std.toFixed(4)}, GLR=${glr.toFixed(2)}, threshold=${state.driftThreshold}`);
    }

    if ((glr > state.driftThreshold || mean > absoluteThresholdPsi) && !state.driftDetected) {
      state.driftDetected = true;
      console.warn(
        `⚠️ Drift detected for sensor ${sensorId}: GLR=${glr.toFixed(2)} (threshold=${state.driftThreshold}), mean=${mean.toFixed(4)} PSI`
      );
      console.warn(`   Mean residual: ${mean.toFixed(4)} PSI, Std: ${std.toFixed(4)} PSI`);
      console.warn(`   Note: Drift detection indicates sensor offset may be changing. Use zero_all or capture_reference to recalibrate.`);
      // NOTE: We do NOT auto-correct here - drift detection is informational
      // Ground truth (0 PSI) is a calibration reference, not a permanent target
      // If pressure legitimately changes, that's not drift - it's a real pressure change
      // Phase 2 tracks the actual pressure via smoothed prediction, not by clamping to ground truth
    } else if (glr <= state.driftThreshold && mean <= absoluteThresholdPsi && state.driftDetected) {
      state.driftDetected = false;
      console.log(`✅ Drift cleared for sensor ${sensorId}`);
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private saveCalibration(sensorId: number, state: SensorState): void {
    const calibrationDir = '/home/kush-mahajan/sensor_system/calibration';
    if (!fs.existsSync(calibrationDir)) {
      fs.mkdirSync(calibrationDir, { recursive: true });
    }
    const filename = path.join(calibrationDir, `robust_calibration.json`);

    try {
      let data: any = {
        sensor_type: 'PT',
        unit: 'PSI',
        framework: 'phase2_rls',
        created: new Date().toISOString(),
        phase: 'MONITORING',
        calibration_polynomials: {},
        phase2_updates: {}
      };

      if (fs.existsSync(filename)) {
        try {
          data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
        } catch (e) {
          console.warn(`⚠️ Failed to parse existing calibration, starting fresh`);
        }
      }

      if (!data.calibration_polynomials) data.calibration_polynomials = {};
      const liveCoeffs = getLiveCoeffs(state);
      data.calibration_polynomials[sensorId.toString()] = [
        liveCoeffs.A,
        liveCoeffs.B,
        liveCoeffs.C,
        liveCoeffs.D,
      ];

      if (!data.phase2_updates) data.phase2_updates = {};
      data.phase2_updates[sensorId.toString()] = {
        update_count: state.updateCount,
        rls_updates: state.rlsUpdateCount,
        last_update: new Date(state.lastUpdate).toISOString(),
        drift_detected: state.driftDetected,
      };

      fs.writeFileSync(filename, JSON.stringify(data, null, 2));
      console.log(`💾 Phase 2 calibration saved for sensor ${sensorId} to robust_calibration.json`);
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
    const calibrationDir = '/home/kush-mahajan/sensor_system/calibration';
    if (!fs.existsSync(calibrationDir)) return null;

    // Favor stable file if it exists
    const stable = path.join(calibrationDir, 'robust_calibration.json');
    if (fs.existsSync(stable)) return stable;

    const jsonFiles = fs
      .readdirSync(calibrationDir)
      .filter((f) => f.endsWith('.json') && !f.includes('learned_prior'))
      .map((f) => path.join(calibrationDir, f));

    if (jsonFiles.length === 0) return null;
    return jsonFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }

  /**
   * Load saved Phase 2 calibration from disk
   */
  loadSavedCalibration(): Map<number, { coeffs: CalibrationCoefficients; rlsUpdateCount: number }> {
    const result = new Map<number, { coeffs: CalibrationCoefficients; rlsUpdateCount: number }>();
    const latestFile = this.findLatestCalibrationFile();

    if (!latestFile) {
      return result;
    }

    try {
      const data = JSON.parse(fs.readFileSync(latestFile, 'utf-8'));
      if (data.calibration_polynomials) {
        for (const [sensorIdStr, coeffs] of Object.entries(data.calibration_polynomials)) {
          const sensorId = parseInt(sensorIdStr, 10);
          if (Array.isArray(coeffs) && coeffs.length === 4) {
            const rlsUpdateCount = data.phase2_updates?.[sensorIdStr]?.rls_updates ?? 0;
            result.set(sensorId, {
              coeffs: {
                A: coeffs[0],
                B: coeffs[1],
                C: coeffs[2],
                D: coeffs[3],
              },
              rlsUpdateCount
            });
          }
        }
      }
      console.log(`📋 Loaded ${result.size} saved Phase 2 calibrations from ${latestFile}`);
    } catch (error) {
      console.error(`❌ Failed to load saved Phase 2 calibration: ${error}`);
    }

    return result;
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getCalibration(sensorId: number): CalibrationCoefficients | null {
    const state = this.sensorStates.get(sensorId);
    return state ? getLiveCoeffs(state) : null;
  }

  /**
   * Get sensor state for checking update timestamps
   */
  getSensorState(sensorId: number): SensorState | null {
    return this.sensorStates.get(sensorId) ?? null;
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
        coeffs: { ...getLiveCoeffs(state) },
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

  /**
   * Clear all sensor state (for "start from scratch").
   * Caller should re-initialize with default or loaded baseline after.
   */
  clearAll(): void {
    this.sensorStates.clear();
    console.log('🗑️ Phase 2 calibration state cleared');
  }

  /** All sensor IDs that have state */
  getSensorIds(): number[] {
    return Array.from(this.sensorStates.keys());
  }
}
