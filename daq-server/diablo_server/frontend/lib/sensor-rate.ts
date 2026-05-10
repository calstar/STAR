/**
 * Lightweight per-channel update rate tracker.
 *
 * Call `recordSensorUpdate(entity, component)` every time a sensor value
 * arrives (e.g. inside store.ts `updateSensor`). The tracker maintains a
 * rolling 3-second timestamp buffer per key and computes Hz on demand,
 * smoothed with an exponential moving average to avoid noisy jumps.
 *
 * `useSensorRate(entity, component)` is a React hook that polls the tracker
 * at 500 ms intervals and returns the current update frequency in Hz.
 */

import { useEffect, useState } from 'react';
import type { BoardStatus } from '@/lib/types';

const RATE_WINDOW_MS = 3000; // rolling window for Hz computation

/** Hide readouts / stop synthetic plot extension if no SENSOR_UPDATE for this long. */
export const SENSOR_DATA_STALE_MS = 1500;

/** Boards / Heartbeats pane only: longer window than sensor grid (lower update rate; avoids flicker). */
export const BOARD_LIVE_TELEMETRY_STALE_MS = 3000;

/**
 * Boards / Heartbeats: hide live connection/state/Hz after BOARD_LIVE_TELEMETRY_STALE_MS without a new
 * hardware heartbeat (uses server `lastHeartbeatMs`). Invalid/missing timestamps do not force stale.
 */
export function isBoardLiveTelemetryStale(b: BoardStatus): boolean {
  const t = b.lastHeartbeatMs;
  if (t == null || typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return false;
  return Date.now() - t >= BOARD_LIVE_TELEMETRY_STALE_MS;
}
const MAX_TIMESTAMPS = 300; // cap buffer size per key
const MAX_KEYS = 500; // cap total keys; sized for a full cal+raw entity set (~200 active keys in production)
const STALE_MS = 2 * 60 * 1000; // prune keys not updated in 2 min
const EMA_ALPHA = 0.3; // smoothing factor (0..1); lower = smoother
let _lastPrune = 0;

const _timestamps: Map<string, number[]> = new Map();
const _lastUpdate: Map<string, number> = new Map();
const _emaRate: Map<string, number> = new Map();

export function recordSensorUpdate(entity: string, component: string): void {
  if (typeof performance === 'undefined') return;
  const key = `${entity}.${component}`;
  const now = performance.now();

  let ts = _timestamps.get(key);
  if (!ts) {
    ts = [];
    _timestamps.set(key, ts);
  }

  ts.push(now);
  _lastUpdate.set(key, Date.now());

  // Prune entries outside the rolling window
  const cutoff = now - RATE_WINDOW_MS;
  let i = 0;
  while (i < ts.length && ts[i] < cutoff) i++;
  if (i > 0) ts.splice(0, i);

  // Hard cap to avoid unbounded growth if window grows
  if (ts.length > MAX_TIMESTAMPS) ts.splice(0, ts.length - MAX_TIMESTAMPS);

  // Periodically prune stale keys to prevent Map growth over long sessions
  if (Date.now() - _lastPrune > 60000) {
    _lastPrune = Date.now();
    const cutoffMs = Date.now() - STALE_MS;
    const toDelete: string[] = [];
    if (_timestamps.size > MAX_KEYS) {
      const byAge = Array.from(_lastUpdate.entries()).sort((a, b) => a[1] - b[1]);
      for (let j = 0; j < _timestamps.size - MAX_KEYS && j < byAge.length; j++) {
        toDelete.push(byAge[j][0]);
      }
    } else {
      for (const [k, ms] of _lastUpdate) {
        if (ms < cutoffMs) toDelete.push(k);
      }
    }
    for (const k of toDelete) {
      _timestamps.delete(k);
      _lastUpdate.delete(k);
      _emaRate.delete(k);
    }
  }
}

export function getSensorRate(entity: string, component: string): number {
  if (typeof performance === 'undefined') return 0;
  const key = `${entity}.${component}`;
  const ts = _timestamps.get(key);
  if (!ts || ts.length < 2) return 0;

  const now = performance.now();
  const cutoff = now - RATE_WINDOW_MS;

  // Count samples within window
  let start = 0;
  while (start < ts.length && ts[start] < cutoff) start++;
  const recent = ts.length - start;
  if (recent < 2) return 0;

  const span = ts[ts.length - 1] - ts[start];
  if (span <= 0) return 0;

  const rawHz = ((recent - 1) / span) * 1000;

  // Apply EMA smoothing to avoid noisy jumps
  const prev = _emaRate.get(key) ?? rawHz;
  const smoothed = EMA_ALPHA * rawHz + (1 - EMA_ALPHA) * prev;
  _emaRate.set(key, smoothed);

  return smoothed;
}

/** True if this exact `entity.component` key had a SENSOR_UPDATE within SENSOR_DATA_STALE_MS. */
export function isSensorKeyFresh(key: string): boolean {
  const t = _lastUpdate.get(key);
  if (t == null || !Number.isFinite(t)) return false;
  return Date.now() - t < SENSOR_DATA_STALE_MS;
}

/**
 * React hook that returns the current update rate (Hz) for a sensor channel,
 * refreshing every `intervalMs` milliseconds (default 500 ms).
 */
export function useSensorRate(
  entity: string,
  component: string,
  intervalMs = 500
): number {
  const [rate, setRate] = useState(0);

  useEffect(() => {
    // Compute immediately on mount
    setRate(getSensorRate(entity, component));

    const id = setInterval(() => {
      setRate(getSensorRate(entity, component));
    }, intervalMs);

    return () => clearInterval(id);
  }, [entity, component, intervalMs]);

  return rate;
}
