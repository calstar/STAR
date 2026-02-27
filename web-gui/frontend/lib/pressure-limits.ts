/**
 * Pressure limits pulled from config.toml via /api/pressure-limits.
 *
 * Use `usePressureLimits()` in React components to get NOP/MEOP/POP for each
 * fluid system (GN2, ETH, LOX).  Data is fetched once and cached.
 */

import { useEffect, useState } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8082';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SystemLimits {
    THRESH?: number;
    NOP: number;
    MEOP: number;
    POP: number;
}

export type PressureLimitsMap = Record<string, SystemLimits>;

// ── Defaults (used while loading or on fetch failure) ──────────────────────────

const DEFAULT_LIMITS: PressureLimitsMap = {
    GN2: { NOP: 900, MEOP: 950, POP: 1000 },
    ETH: { NOP: 600, MEOP: 650, POP: 750 },
    LOX: { NOP: 600, MEOP: 650, POP: 750 },
};

// ── Module-level cache ─────────────────────────────────────────────────────────

let _cache: PressureLimitsMap | null = null;
let _fetchPromise: Promise<PressureLimitsMap> | null = null;

export async function fetchPressureLimits(): Promise<PressureLimitsMap> {
    if (_cache !== null) return _cache;
    if (_fetchPromise) return _fetchPromise;

    _fetchPromise = fetch(`${API_BASE_URL}/api/pressure-limits`)
        .then((res) => {
            if (!res.ok) throw new Error(`pressure-limits fetch failed: ${res.status}`);
            return res.json();
        })
        .then((data: { pressure_limits: PressureLimitsMap }) => {
            _cache = data.pressure_limits;
            return data.pressure_limits;
        })
        .catch((err) => {
            console.error('[pressure-limits] Failed to fetch, using defaults:', err);
            _fetchPromise = null;
            return DEFAULT_LIMITS;
        });

    return _fetchPromise;
}

// ── React hook ─────────────────────────────────────────────────────────────────

/**
 * Returns the pressure limits map.
 * Returns defaults while loading; updates once the fetch completes.
 */
export function usePressureLimits(): PressureLimitsMap {
    const [limits, setLimits] = useState<PressureLimitsMap>(_cache ?? DEFAULT_LIMITS);

    useEffect(() => {
        let cancelled = false;
        fetchPressureLimits().then((l) => {
            if (!cancelled) setLimits(l);
        });
        return () => { cancelled = true; };
    }, []);

    return limits;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Get limits for a specific fluid system (case-insensitive). Falls back to ETH. */
export function getLimitsForSystem(
    limits: PressureLimitsMap,
    system: string,
): SystemLimits {
    // Try exact match first, then case-insensitive
    return (
        limits[system] ||
        limits[system.toUpperCase()] ||
        Object.entries(limits).find(
            ([k]) => k.toLowerCase() === system.toLowerCase(),
        )?.[1] ||
        DEFAULT_LIMITS.ETH
    );
}
