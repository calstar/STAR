/**
 * Calibration command handling — zero_all, capture_reference, save coefficients, etc.
 * Extracted from server.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { loadPTCalibration, calculatePressure, CalibrationCoefficients } from './calibration.js';
import { Phase2CalibrationEngine } from './calibration-phase2.js';
import {
    MessageType,
} from '../../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Single (ADC code, pressure) calibration point — human value is guidance for the fit, not a fixed intercept. */
export interface CalibrationPoint { adc: number; pressure: number; }

/** Minimal interface for the parts of SensorSystemServer that calibration needs. */
export interface CalibrationHost {
    ptCalibration: Map<number, CalibrationCoefficients>;
    /** Absolute path of the calibration file loaded at startup (null = none found). */
    ptCalibrationFilePath: string | null;
    /** Accumulated (adc, pressure) points per channel for ADC→pressure fit. */
    calibrationPoints: Map<number, CalibrationPoint[]>;
    phase2Engine: Phase2CalibrationEngine | null;
    calibrationSidecar?: any; // Add sidecar for robust calibration routing
    channelToEntityMap?: Record<number, string>;
    boardChannelToEntityMaps?: Map<string, Record<number, string>>;
    ipToBoardId?: Map<string, number>;
    lastRawAdc: Map<number, number>;
    send(ws: WebSocket, message: any): void;
    broadcast(message: any): void;
    /** If set, called after ptCalibration is updated so the UI can show the new fit immediately. */
    pushCalibrationUpdate?(uniqueId: number): void;
}

/**
 * Normalize ADC to x in [0,1] to avoid ill-conditioned Vandermonde (same idea as pt_cali.py scale).
 * Returns x[], adcMin, adcScale.
 */
function normalizeAdc(adc: number[]): { x: number[]; adcMin: number; adcScale: number } {
    const adcMin = Math.min(...adc);
    const adcMax = Math.max(...adc);
    const adcScale = Math.max(adcMax - adcMin, 1);
    const x = adc.map((a) => (a - adcMin) / adcScale);
    return { x, adcMin, adcScale };
}

const EPSILON = 1e-10;

/**
 * Numpy-style polyfit: P(x) = c0 + c1*x + c2*x^2 + ... in normalized x.
 * Same algorithm as pt_cali.py (np.polyfit / np.polyval) but in normalized x for stability.
 * - 1 point @ 0 PSI: P = 0 (polyCoeffs = [0]).
 * - 2+ points: order = min(n-1, 3), least-squares with epsilon regularization.
 */
function fitAdcToPressure(points: CalibrationPoint[]): CalibrationCoefficients | null {
    if (points.length < 1) return null;
    if (points.length === 1) {
        const { pressure } = points[0];
        if (Math.abs(pressure) > 1e-6) return null;
        return { A: 0, B: 0, C: 0, D: 0, polyCoeffs: [0], adcNormMin: points[0].adc, adcNormScale: 1 };
    }
    const adc = points.map((p) => p.adc);
    const y = points.map((p) => p.pressure);
    const n = points.length;
    const { x, adcMin, adcScale } = normalizeAdc(adc);
    const order = Math.min(n - 1, 3);
    const nCoeff = order + 1;

    // Vandermonde: row i = [1, x_i, x_i^2, x_i^3] (ascending powers, P(x)=c0+c1*x+...)
    const X: number[][] = [];
    for (let i = 0; i < n; i++) {
        const row: number[] = [1];
        let v = 1;
        for (let k = 1; k < nCoeff; k++) {
            v *= x[i];
            row.push(v);
        }
        X.push(row);
    }

    // Normal equations XtX * b = XtY (same as np.polyfit least-squares)
    const XtX: number[][] = Array.from({ length: nCoeff }, () => new Array(nCoeff).fill(0));
    const XtY: number[] = new Array(nCoeff).fill(0);
    for (let i = 0; i < n; i++) {
        const row = X[i];
        for (let j = 0; j < nCoeff; j++)
            for (let k = 0; k < nCoeff; k++) XtX[j][k] += row[j] * row[k];
        for (let j = 0; j < nCoeff; j++) XtY[j] += row[j] * y[i];
    }

    // Regularize like pt_cali.py (epsilon) to avoid singular/ill-conditioned
    let maxDiag = 0;
    for (let j = 0; j < nCoeff; j++) maxDiag = Math.max(maxDiag, Math.abs(XtX[j][j]));
    const reg = EPSILON * (1 + maxDiag);
    for (let j = 0; j < nCoeff; j++) XtX[j][j] += reg;

    const b = solveSquare(XtX, XtY);
    if (b == null) return null;
    const polyCoeffs = [...b];
    const out: CalibrationCoefficients = {
        A: 0, B: 0, C: 0, D: 0,
        polyCoeffs,
        adcNormMin: adcMin,
        adcNormScale: adcScale,
    };
    return coeffsFinite(out) ? out : null;
}

/** True if coeffs are usable (polyCoeffs all finite, or A,B,C,D finite; norm params valid). */
function coeffsFinite(c: CalibrationCoefficients): boolean {
    if (c.polyCoeffs != null && c.polyCoeffs.length > 0) {
        if (c.polyCoeffs.some((v) => !Number.isFinite(v))) return false;
        if (c.adcNormMin != null && !Number.isFinite(c.adcNormMin)) return false;
        if (c.adcNormScale != null && (!Number.isFinite(c.adcNormScale) || c.adcNormScale <= 0)) return false;
        return true;
    }
    if (!Number.isFinite(c.A) || !Number.isFinite(c.B) || !Number.isFinite(c.C) || !Number.isFinite(c.D)) return false;
    if (c.adcNormMin != null && !Number.isFinite(c.adcNormMin)) return false;
    if (c.adcNormScale != null && (!Number.isFinite(c.adcNormScale) || c.adcNormScale <= 0)) return false;
    return true;
}

/** Solve n×n system V * x = b (Gaussian elimination with partial pivot). */
function solveSquare(V: number[][], b: number[]): number[] | null {
    const n = V.length;
    const A = V.map(row => [...row]);
    const y = [...b];
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
        [A[col], A[pivot]] = [A[pivot], A[col]];
        [y[col], y[pivot]] = [y[pivot], y[col]];
        const v = A[col][col];
        if (Math.abs(v) < 1e-12) return null;
        for (let j = col; j < n; j++) A[col][j] /= v;
        y[col] /= v;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = A[r][col];
            for (let j = col; j < n; j++) A[r][j] -= f * A[col][j];
            y[r] -= f * y[col];
        }
    }
    return y;
}

function getActiveChannels(host: CalibrationHost): number[] {
    const channels = new Set<number>();

    // Board-aware uniqueness: boardId * 100 + channelId
    if (host.boardChannelToEntityMaps && host.ipToBoardId) {
        for (const [ip, map] of host.boardChannelToEntityMaps.entries()) {
            const boardId = host.ipToBoardId.get(ip) ?? 1;
            Object.keys(map).forEach(id => channels.add(boardId * 100 + Number(id)));
        }
    } else if (host.channelToEntityMap) {
        // Fallback or solo board
        Object.keys(host.channelToEntityMap).forEach(id => channels.add(100 + Number(id)));
    }

    // Fallback if no maps available
    if (channels.size === 0) {
        for (let i = 1; i <= 10; i++) channels.add(100 + i);
    }
    return Array.from(channels).sort((a, b) => a - b);
}

/**
 * Handle calibration commands from the frontend.
 */
export function handleCalibrationCommand(
    host: CalibrationHost,
    ws: WebSocket,
    payload: any,
): void {
    const { commandType, sensorId, boardId, referencePressure } = payload ?? {};
    const uniqueId = (boardId != null && sensorId != null) ? (boardId * 100 + sensorId) : sensorId;

    switch (commandType) {
        case 'capture_reference': {
            const refPsi = Number(referencePressure);
            if (sensorId == null || referencePressure == null || !Number.isFinite(refPsi)) {
                host.send(ws, {
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: 'capture_reference requires sensorId and a numeric referencePressure (PSI)' }
                });
                return;
            }

            const activeChannels = getActiveChannels(host);
            if (uniqueId == null || !activeChannels.includes(uniqueId)) {
                host.send(ws, {
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: `Channel ${sensorId} on Board ${boardId} is not a valid PT channel` }
                });
                return;
            }
            const adc = host.lastRawAdc.get(uniqueId) ?? 0;
            if (adc === 0) {
                host.send(ws, {
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: 'No ADC data for channel yet' }
                });
                return;
            }
            const points = host.calibrationPoints.get(uniqueId) ?? [];
            points.push({ adc, pressure: refPsi });
            if (points.length > 50) points.splice(0, points.length - 50); // cap to prevent lag buildup
            host.calibrationPoints.set(uniqueId, points);

            let coeffs: CalibrationCoefficients | null = null;
            const sidecarPrimary = !!(host.calibrationSidecar && host.calibrationSidecar.enabled);

            if (sidecarPrimary) {
                host.calibrationSidecar.calibrateChannel(uniqueId, adc, refPsi);
            } else {
                coeffs = fitAdcToPressure(points);
                if (!coeffs) {
                    const adcArr = points.map((pt) => pt.adc);
                    const sameAdc = adcArr.length === 2 && Math.abs(adcArr[1] - adcArr[0]) < 1e-9;
                    host.send(ws, {
                        type: MessageType.ERROR, timestamp: Date.now(),
                        payload: {
                            message: sameAdc
                                ? 'Same ADC for both points — change pressure between ZERO ALL and CAPTURE, then CAPTURE again.'
                                : 'Cannot build fit. Run ZERO ALL to add a 0 PSI point, then CAPTURE at one or more known pressures.'
                        }
                    });
                    return;
                }
                const testReading = calculatePressure(adc, coeffs);
                if (!Number.isFinite(testReading)) {
                    host.send(ws, {
                        type: MessageType.ERROR, timestamp: Date.now(),
                        payload: { message: 'Fit produced invalid reading; using constant 0 PSI for this channel.' }
                    });
                    coeffs = { A: 0, B: 0, C: 0, D: 0 };
                }
                host.ptCalibration.set(uniqueId, coeffs);
                host.pushCalibrationUpdate?.(uniqueId);
            }
            // Internal Phase 2 engine is only used when sidecar is not primary.
            if (!sidecarPrimary && host.phase2Engine && coeffs) {
                host.phase2Engine.initializeSensor(uniqueId, coeffs);
                const state = host.phase2Engine.getSensorState(uniqueId);
                if (state) {
                    state.adjustment = { A: 0, B: 0, C: 0, D: 0 };
                    state.smoothedPrediction = refPsi;
                    state.lastGroundTruth = refPsi;
                    state.lastGroundTruthTime = Date.now();
                    state.rlsUpdateCount++;
                }
            }

            console.log(
                `📐 Calibration: CH${sensorId} (Board ${boardId}) ADC=${adc} ref=${refPsi} PSI → ` +
                (sidecarPrimary
                    ? 'delegated to robust sidecar'
                    : `local ADC→pressure fit from ${points.length} point(s)`)
            );
            break;
        }
        case 'enable_phase2':
            if (host.phase2Engine) {
                host.phase2Engine.setEnabled(true);
            } else {
                console.warn('⚠️ Phase 2 engine not available');
            }
            break;
        case 'disable_phase2':
            if (host.phase2Engine) {
                host.phase2Engine.setEnabled(false);
            } else {
                console.warn('⚠️ Phase 2 engine not available');
            }
            break;
        case 'reset_channel':
            const activeChannelsReset = getActiveChannels(host);
            if (uniqueId == null || !activeChannelsReset.includes(uniqueId)) {
                host.send(ws, {
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: `Channel ${sensorId} on Board ${boardId} is not a valid PT channel` }
                });
                return;
            }
            if (host.phase2Engine && uniqueId != null) {
                host.phase2Engine.resetAdjustment(uniqueId);
                console.log(`🔄 Phase 2 adjustment reset for CH${sensorId} (Board ${boardId})`);
            } else {
                console.warn('⚠️ Phase 2 engine not available or uniqueId missing');
            }
            break;
        case 'zero_all': {
            console.log('🎯 ZERO ALL PTs — adding (ADC, 0 PSI) calibration point per channel');
            let successCount = 0;
            let skipCount = 0;
            const channelsToUpdate = getActiveChannels(host);
            const sidecarZeroPayload: { id: number; adc_code: number }[] = [];

            for (const chUniqueId of channelsToUpdate) {
                const currentAdc = host.lastRawAdc.get(chUniqueId) ?? 0;
                if (currentAdc === 0) {
                    console.log(`   ID ${chUniqueId}: no ADC data yet, skipping`);
                    skipCount++;
                    continue;
                }

                // Replace any prior zero-point (keep non-zero CAPTURE references)
                const prevPoints = host.calibrationPoints.get(chUniqueId) ?? [];
                let points = [...prevPoints.filter(p => p.pressure !== 0), { adc: currentAdc, pressure: 0 }];
                if (points.length > 50) points = points.slice(-50); // cap to prevent lag buildup
                host.calibrationPoints.set(chUniqueId, points);

                const sidecarPrimaryZero = !!(host.calibrationSidecar && host.calibrationSidecar.enabled);

                // When sidecar is enabled, it owns the zero-point update; we just
                // accumulate points and forward raw ADC codes. Local polynomial fit
                // remains as a fallback when sidecar is disabled.
                if (!sidecarPrimaryZero) {
                    let coeffs: CalibrationCoefficients;
                    if (points.length === 1) {
                        // Single point = zero point only. Don't use constant-0 polynomial
                        // (which would force every ADC to 0 PSI). If we have a prior
                        // calibration, shift it so current ADC → 0 PSI; otherwise constant 0.
                        // Use the same fallback pattern as the packet processor: unique board
                        // key first (e.g. 101), then plain channel key (e.g. 1) for JSON-loaded cal.
                        const chId = chUniqueId % 100;
                        const existing = host.ptCalibration.get(chUniqueId) ?? host.ptCalibration.get(chId);
                        const hasPriorCurve =
                            existing &&
                            coeffsFinite(existing) &&
                            ((existing.polyCoeffs != null && existing.polyCoeffs.length > 1) ||
                                (Math.abs(existing.A) + Math.abs(existing.B) + Math.abs(existing.C) > 1e-15));
                        if (hasPriorCurve) {
                            const pZero = calculatePressure(currentAdc, existing!);
                            if (!Number.isFinite(pZero)) {
                                coeffs = { A: 0, B: 0, C: 0, D: 0, polyCoeffs: [0], adcNormMin: currentAdc, adcNormScale: 1 };
                            } else {
                                if (existing!.polyCoeffs != null && existing!.polyCoeffs.length > 0) {
                                    const newPoly = [...existing!.polyCoeffs];
                                    newPoly[0] = (newPoly[0] ?? 0) - pZero;
                                    coeffs = { ...existing!, polyCoeffs: newPoly };
                                } else {
                                    coeffs = { ...existing!, D: existing!.D - pZero };
                                }
                            }
                        } else {
                            coeffs = { A: 0, B: 0, C: 0, D: 0, polyCoeffs: [0], adcNormMin: currentAdc, adcNormScale: 1 };
                        }
                    } else {
                        coeffs = fitAdcToPressure(points) ?? { A: 0, B: 0, C: 0, D: 0 };
                        const reading = calculatePressure(currentAdc, coeffs);
                        if (!Number.isFinite(reading) && points.length > 1) {
                            console.warn(`   ID ${chUniqueId}: fit failed or produced NaN (${points.length} pts), using constant 0 PSI`);
                            coeffs = { A: 0, B: 0, C: 0, D: 0 };
                        }
                    }
                    host.ptCalibration.set(chUniqueId, coeffs);
                    host.pushCalibrationUpdate?.(chUniqueId);
                    if (host.phase2Engine) {
                        try {
                            host.phase2Engine.initializeSensor(chUniqueId, coeffs);
                            const state = host.phase2Engine.getSensorState(chUniqueId);
                            if (state) {
                                state.adjustment = { A: 0, B: 0, C: 0, D: 0 };
                                state.smoothedPrediction = 0;
                                state.lastGroundTruth = 0;
                                state.lastGroundTruthTime = Date.now();
                                state.rlsUpdateCount++;
                            }
                        } catch (err) {
                            console.warn(`   ID ${chUniqueId}: Phase 2 update failed (non-critical):`, err);
                        }
                    }
                    const newReading = calculatePressure(currentAdc, coeffs);
                    console.log(`   ID ${chUniqueId}: ADC=${currentAdc} → 0 PSI (${points.length} pt fit), reading=${Number.isFinite(newReading) ? newReading.toFixed(2) : 'NaN'} PSI`);
                }
                sidecarZeroPayload.push({ id: chUniqueId, adc_code: currentAdc });
                successCount++;
            }
            if (host.calibrationSidecar && host.calibrationSidecar.enabled) {
                if (!host.calibrationSidecar.isConnected) {
                    host.broadcast({ type: MessageType.ERROR, timestamp: Date.now(), payload: { message: 'ZERO ALL failed: calibration server not connected. Start calibration_server.py and ensure it listens on the configured port.' } });
                    console.warn('⚠️ ZERO ALL: sidecar enabled but not connected — start calibration_server.py');
                } else if (sidecarZeroPayload.length > 0) {
                    host.calibrationSidecar.zeroAll(sidecarZeroPayload);
                } else if (skipCount > 0) {
                    host.broadcast({ type: MessageType.ERROR, timestamp: Date.now(), payload: { message: 'ZERO ALL: no ADC data for any channel. Ensure sensor data is flowing (relay connected, boards sending).' } });
                    console.warn('⚠️ ZERO ALL: all channels skipped — no raw ADC data yet');
                }
            }
            console.log(`✅ Zero all complete: ${successCount} channels updated, ${skipCount} skipped`);
            break;
        }
        case 'save_coefficients': {
            const calibrationDir = path.join(__dirname, '../../../calibration');
            try {
                if (!fs.existsSync(calibrationDir)) {
                    fs.mkdirSync(calibrationDir, { recursive: true });
                }
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const filename = path.join(calibrationDir, `calibration_${ts}.json`);
                const calibration_polynomials: Record<string, number[]> = {};
                const calibration_poly_coeffs: Record<string, number[]> = {};
                const calibration_adc_norm_min: Record<string, number> = {};
                const calibration_adc_norm_scale: Record<string, number> = {};
                const channelsToSave = getActiveChannels(host);
                for (const ch of channelsToSave) {
                    const ptCoeffs = host.ptCalibration.get(ch);
                    const coeffs = (ptCoeffs?.polyCoeffs?.length ? ptCoeffs : null) ?? host.phase2Engine?.getCalibration(ch) ?? ptCoeffs;
                    if (coeffs) {
                        calibration_polynomials[String(ch)] = [coeffs.A, coeffs.B, coeffs.C, coeffs.D];
                        if (coeffs.polyCoeffs?.length) calibration_poly_coeffs[String(ch)] = coeffs.polyCoeffs;
                        if (coeffs.adcNormMin != null) calibration_adc_norm_min[String(ch)] = coeffs.adcNormMin;
                        if (coeffs.adcNormScale != null) calibration_adc_norm_scale[String(ch)] = coeffs.adcNormScale;
                    }
                }
                if (Object.keys(calibration_polynomials).length === 0) {
                    host.send(ws, {
                        type: MessageType.ERROR, timestamp: Date.now(),
                        payload: { message: 'No calibration coefficients to save' }
                    });
                    return;
                }
                const data: Record<string, unknown> = {
                    sensor_type: 'PT',
                    unit: 'PSI',
                    framework: 'phase2_rls',
                    created: new Date().toISOString(),
                    phase: 'MONITORING',
                    calibration_polynomials,
                };
                if (Object.keys(calibration_poly_coeffs).length > 0) data.calibration_poly_coeffs = calibration_poly_coeffs;
                if (Object.keys(calibration_adc_norm_min).length > 0) data.calibration_adc_norm_min = calibration_adc_norm_min;
                if (Object.keys(calibration_adc_norm_scale).length > 0) data.calibration_adc_norm_scale = calibration_adc_norm_scale;
                fs.writeFileSync(filename, JSON.stringify(data, null, 2));
                console.log(`💾 Calibration saved to ${filename}`);
                host.ptCalibrationFilePath = filename;
                host.send(ws, {
                    type: MessageType.CALIBRATION_STATUS, timestamp: Date.now(),
                    payload: { message: 'Calibration saved', path: filename }
                });
            } catch (err) {
                console.error('❌ Save calibration failed:', err);
                host.send(ws, {
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: String(err) }
                });
            }
            break;
        }
        case 'clear_calibration': {
            const defaultCoeffs: CalibrationCoefficients = { A: 0, B: 0, C: 1e-8, D: 0 };
            host.ptCalibration.clear();
            host.calibrationPoints.clear();
            const channelsToClear = getActiveChannels(host);
            for (const ch of channelsToClear) {
                host.ptCalibration.set(ch, { ...defaultCoeffs });
            }
            if (host.phase2Engine) {
                host.phase2Engine.clearAll();
                host.ptCalibration.forEach((coeffs, sensorId) => {
                    host.phase2Engine!.initializeSensor(sensorId, coeffs);
                });
            }
            host.lastRawAdc.clear();
            console.log('🗑️ Calibration cleared — ZERO ALL then CAPTURE to build ADC→pressure fit');
            break;
        }
        default:
            console.warn('⚠️ Unknown calibration command:', commandType);
    }

    // Always immediately broadcast updated status after a command
    if (host.phase2Engine) {
        const channels = host.phase2Engine.getAllStatus();
        host.broadcast({
            type: MessageType.CALIBRATION_STATUS,
            timestamp: Date.now(),
            payload: { channels, phase2Enabled: host.phase2Engine.isEnabled(), timestamp: Date.now(), calibrationFilePath: host.ptCalibrationFilePath },
        });
    }
}
