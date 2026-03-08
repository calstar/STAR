/**
 * Sensor configuration pulled from config.toml via /api/sensor-config.
 *
 * Use `useSensorConfig()` in React components to get a live array of
 * SensorConfig entries derived from the backend config (sensor_roles_pt_board,
 * sensor_roles_pt2 sections).  The data is fetched once on mount and cached
 * in module scope so subsequent renders are instant.
 */

import { useEffect, useState } from 'react';
import { getApiBaseUrl, getWebSocketClient } from './websocket';
import { MessageType } from './types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SensorConfig {
    /** 1-based channel / connector ID local to the board */
    id: number;
    /** Human-readable role name from config.toml, e.g. "Fuel Upstream" */
    role: string;
    /** board_id from config.toml boards section */
    boardId: number;
    /** Board IP address */
    boardIp: string;
    /** true if this sensor is a high-pressure 4-20 mA PT (sensor_roles_pt2) */
    isHpPt: boolean;
    /** false → HP PT (no calibration capture); true → low-pressure PT */
    inCalibrationSequence: boolean;
    /** Raw ADC entity string, e.g. "PT.Fuel_Upstream" */
    entity: string;
    /** Calibrated PSI entity string, e.g. "PT_Cal.Fuel_Upstream" */
    calEntity: string;
}

// ── Module-level cache so all components share one fetch ───────────────────────

let _cache: SensorConfig[] | null = null;
let _fetchPromise: Promise<SensorConfig[]> | null = null;

export async function fetchSensorConfig(): Promise<SensorConfig[]> {
    if (_cache !== null) return _cache;
    if (_fetchPromise) return _fetchPromise;

    _fetchPromise = fetch(`${getApiBaseUrl()}/api/sensor-config`)
        .then((res) => {
            if (!res.ok) throw new Error(`sensor-config fetch failed: ${res.status}`);
            return res.json();
        })
        .then((data: { sensors: SensorConfig[] }) => {
            _cache = data.sensors;
            return data.sensors;
        })
        .catch((err) => {
            console.error('[sensor-config] Failed to fetch sensor config:', err);
            _fetchPromise = null; // allow retry on next call
            return [] as SensorConfig[];
        });

    return _fetchPromise;
}

/** Call this to invalidate the cache (e.g. after a config save). */
export function invalidateSensorConfigCache(): void {
    _cache = null;
    _fetchPromise = null;
}

// ── React hook ─────────────────────────────────────────────────────────────────

/**
 * Returns the sensor config array.
 * Returns [] while loading; updates to the full list once fetch completes.
 */
export function useSensorConfig(): SensorConfig[] {
    const [sensors, setSensors] = useState<SensorConfig[]>(_cache ?? []);

    useEffect(() => {
        let cancelled = false;
        fetchSensorConfig().then((s) => {
            if (!cancelled) setSensors(s);
        });
        return () => { cancelled = true; };
    }, []);

    // Refetch whenever config is updated (e.g. config pane save) so all panes see fresh sensor list
    useEffect(() => {
        const ws = getWebSocketClient();
        const unsub = ws.on(MessageType.CONFIG_UPDATED, () => {
            invalidateSensorConfigCache();
            fetchSensorConfig().then((s) => setSensors(s));
        });
        return unsub;
    }, []);

    return sensors;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Filter sensors whose role string contains substring (case-insensitive). */
export function filterByRole(sensors: SensorConfig[], ...substrings: string[]): SensorConfig[] {
    return sensors.filter((s) =>
        substrings.some((sub) => s.role.toLowerCase().includes(sub.toLowerCase()))
    );
}

/** Filter sensors by board ID. */
export function filterByBoardId(sensors: SensorConfig[], boardId: number): SensorConfig[] {
    return sensors.filter((s) => s.boardId === boardId);
}

/** Find a single sensor by exact role name. */
export function sensorByRole(sensors: SensorConfig[], role: string): SensorConfig | undefined {
    return sensors.find((s) => s.role === role);
}
