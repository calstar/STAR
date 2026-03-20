/**
 * Lightweight per-channel update rate tracker.
 *
 * Call `recordSensorUpdate(entity, component)` every time a sensor value
 * arrives (e.g. inside store.ts `updateSensor`). The tracker maintains a
 * rolling 2-second timestamp buffer per key and computes Hz on demand.
 *
 * `useSensorRate(entity, component)` is a React hook that polls the tracker
 * at 500 ms intervals and returns the current update frequency in Hz.
 */

import { useEffect, useState } from 'react';

const RATE_WINDOW_MS = 2000; // rolling window for Hz computation
const MAX_TIMESTAMPS = 200; // cap buffer size per key
const MAX_KEYS = 80; // cap total keys to prevent lag buildup
const STALE_MS = 2 * 60 * 1000; // prune keys not updated in 2 min
let _lastPrune = 0;

const _timestamps: Map<string, number[]> = new Map();
const _lastUpdate: Map<string, number> = new Map();

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

  return ((recent - 1) / span) * 1000;
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
