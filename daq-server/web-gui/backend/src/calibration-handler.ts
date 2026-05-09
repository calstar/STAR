/**
 * Calibration command handling — zero_all, capture_reference, save coefficients, etc.
 * Extracted from server.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { loadPTCalibration, CalibrationCoefficients } from './calibration.js';
import { readConfig } from './routes/config.js';
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
    /** calibration_service (FSW) owns RLS / robust adjustments; backend only forwards commands via Elodin. */
    calibrationSidecar?: any;
    channelToEntityMap?: Record<number, string>;
    boardChannelToEntityMaps?: Map<string, Record<number, string>>;
    ipToBoardId?: Map<string, number>;
    lastRawAdc: Map<number, number>;
    send(ws: WebSocket, message: any): void;
    broadcast(message: any): void;
    elodin?: any; // Elodin client for publishing commands
    /** If set, called after ptCalibration is updated so the UI can show the new fit immediately. */
    pushCalibrationUpdate?(uniqueId: number): void;
}

/**
 * Publish a CalibrationCommand [0x46, 0x00] packet to Elodin DB.
 * Layout: [timestamp_ns(8), command_type(1), sensor_id(uint16 LE), pad(1), reference_value(f32)]
 */
function publishCalibrationCommand(host: CalibrationHost, type: number, sensorId: number, ref: number): void {
    if (!host.elodin) {
        console.warn('⚠️ Cannot publish calibration command: Elodin not connected');
        return;
    }
    const payload = Buffer.alloc(16);
    // timestamp_ns (8 bytes)
    payload.writeBigUInt64LE(BigInt(Date.now()) * 1000000n, 0);
    payload.writeUInt8(type, 8);
    payload.writeUInt16LE(sensorId & 0xffff, 9);
    payload.writeUInt8(0, 11);
    payload.writeFloatLE(ref, 12);
    host.elodin.publishTable([0x46, 0x00], payload);
}

function getActiveChannels(host: CalibrationHost): number[] {
    const channels = new Set<number>();

    // Preferred: derive PT channels directly from config boards (board_id * 100 + channel).
    // This matches calibration_service unique IDs and avoids mismatches with legacy maps.
    try {
        const config = readConfig() as any;
        const boards = (config?.boards || {}) as Record<string, any>;
        for (const [, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            if (board?.enabled === false) continue;
            if (board?.type !== 'PT') continue;
            const boardId = Number(board?.board_id);
            if (!Number.isFinite(boardId)) continue;
            const activeChannels: number[] =
                Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                    ? board.active_connectors.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v) && v >= 1)
                    : Array.from({ length: Math.max(0, Number(board.num_sensors) || 0) }, (_, i) => i + 1);
            for (const ch of activeChannels) channels.add(boardId * 100 + ch);
        }
    } catch {
        // Keep legacy fallbacks below.
    }

    if (channels.size > 0) {
        return Array.from(channels).sort((a, b) => a - b);
    }

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
            if (!host.elodin) {
                host.send(ws, {
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: 'Elodin not connected — start calibration_service and DB; cannot forward capture_reference.' }
                });
                return;
            }
            publishCalibrationCommand(host, 1, uniqueId, refPsi);
            console.log(`📐 Calibration: CH${sensorId} (Board ${boardId}) ref=${refPsi} PSI → calibration_service (Elodin)`);
            break;
        }
        case 'enable_phase2':
            console.log('[Calibration] enable_phase2 ignored — robust calibration runs in calibration_service');
            break;
        case 'disable_phase2':
            console.log('[Calibration] disable_phase2 ignored — robust calibration runs in calibration_service');
            break;
        case 'reset_channel':
            host.send(ws, {
                type: MessageType.ERROR, timestamp: Date.now(),
                payload: { message: 'reset_channel is not supported from the GUI; edit adjustments on disk or restart calibration_service.' }
            });
            break;
        case 'zero_all': {
            console.log('🎯 ZERO ALL PTs — forwarding to calibration_service via Elodin');
            if (!host.elodin) {
                host.broadcast({
                    type: MessageType.ERROR, timestamp: Date.now(),
                    payload: { message: 'ZERO ALL failed: Elodin not connected. Start calibration_service and the database.' }
                });
                break;
            }
            // Forward one command; calibration_service owns per-channel ADC checks and prior updates.
            publishCalibrationCommand(host, 0, 0, 0);
            console.log('✅ Zero all forwarded as global command (sensor_id=0)');
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
                    const coeffs = (ptCoeffs?.polyCoeffs?.length ? ptCoeffs : null) ?? ptCoeffs;
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

                // Also trigger save in C++ service
                publishCalibrationCommand(host, 2, 0, 0);

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
            host.lastRawAdc.clear();
            console.log('🗑️ Calibration cleared — ZERO ALL then CAPTURE to build ADC→pressure fit');
            break;
        }
        default:
            console.warn('⚠️ Unknown calibration command:', commandType);
    }

    host.broadcast({
        type: MessageType.CALIBRATION_STATUS,
        timestamp: Date.now(),
        payload: {
            channels: [],
            phase2Enabled: true,
            timestamp: Date.now(),
            calibrationFilePath: host.ptCalibrationFilePath,
            message: 'Robust calibration runs in calibration_service (FSW); GUI displays Elodin streams.',
        },
    });
}
