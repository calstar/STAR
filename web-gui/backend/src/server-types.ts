/**
 * Shared types, interfaces, and constants for the sensor system server modules.
 */

import { WebSocket } from 'ws';
import { readConfig } from './routes/config.js';

// ── Network constants ──────────────────────────────────────────────────────────
export const WS_PORT = parseInt(process.env.WS_PORT || '8081', 10);
export const WS_HOST = process.env.WS_HOST || '0.0.0.0';
export const ELODIN_HOST = process.env.ELODIN_HOST || '::1';
export const ELODIN_PORT = parseInt(process.env.ELODIN_PORT || '2240', 10);

// ── Interfaces ─────────────────────────────────────────────────────────────────
export interface Client {
    ws: WebSocket;
    subscribedSensors: Set<string>;
    lastPing: number;
}

/** Configuration for a PT board that has 4-20 mA high-pressure sensors */
export interface HpPtBoardConfig {
    boardIp: string;
    adcRefVoltage: number;
    hpPtConnectors: Set<number>;
    excitationConnectorId: number;
    fullScalePsi: number;
    senseResistorOhms: number;
    excitationDividerRatio: number;
    channelToEntity: Record<number, string>;
}

// ── Actuator channel map (built from config.toml actuator_roles) ────────────
// String-based: maps actuator role name → physical channel number.
// No ActuatorId enum — everything uses config names directly.
export const ACTUATOR_CHANNEL_BY_NAME: Record<string, number> = (() => {
    const map: Record<string, number> = {};
    try {
        const cfg = readConfig();
        const roles = cfg.actuator_roles || {};
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
                map[name] = value[1];
            }
        }
        console.log(`📋 Built ACTUATOR_CHANNEL_BY_NAME from config.toml: ${Object.keys(map).length} entries`);
    } catch {
        console.warn('⚠️ Could not build ACTUATOR_CHANNEL_BY_NAME from config, using empty map');
    }
    return map;
})();
