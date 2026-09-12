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
import { serverNowMs } from '@/lib/plot-time';

const RATE_WINDOW_MS = 3000; // rolling window for Hz computation

/** Hide READOUTS if the newest sample is older than this. Plots no longer use it —
 *  data-cache.ts ends each line at its own last sample instead (see its gap constants).
 *
 *  Measured on the SERVER timeline, not local arrival time. The comment here used to
 *  claim that alone protected a throttled client from blinking. It does not:
 *  serverNowMs() advances on EVERY inbound envelope and on the 1 Hz CONNECTION_STATUS
 *  broadcast, not on sensor samples, so its "now" edge keeps moving while the samples
 *  lag — which reduces this check to `lagMs < 1500`. The backend meanwhile paces a
 *  throttled client to a lag target of exactly 1500 ms (DEFAULT_TARGET_LAG_MS), so the
 *  two numbers met with zero margin and every burst crossed the line. Hence the
 *  allowance below, which is the margin that was missing. */
export const SENSOR_DATA_STALE_MS = 1500;

/** Extra staleness budget for THIS client's measured delivery lag, from
 *  CONNECTION_STATUS. Pushed in by the store (see setDeliveryLagAllowanceMs) rather than
 *  read from it: store.ts imports this module, so the dependency may not run the other
 *  way. */
let _deliveryLagAllowanceMs = 0;

/**
 * Record this client's reported delivery lag as extra staleness budget.
 *
 * 2x because the pacer only flushes once the socket has fully drained, so the newest
 * sample's age sawtooths between `lagMs` and `lagMs + drainInterval`; the outbox's own
 * design test allows up to 2x the target between flushes. +250 ms covers ordinary jitter,
 * and the whole thing is capped so a pathological report cannot disable staleness.
 */
export function setDeliveryLagAllowanceMs(lagMs: number | null | undefined): void {
  // No usable report means no claim about this link, so no allowance — distinct from a
  // REPORTED lag of 0, which is a healthy link that still deserves the jitter margin.
  if (typeof lagMs !== 'number' || !Number.isFinite(lagMs) || lagMs < 0) {
    _deliveryLagAllowanceMs = 0;
    return;
  }
  _deliveryLagAllowanceMs = Math.min(5000, 2 * lagMs + 250);
}

/** The staleness window in force right now: the base plus this link's allowance. */
export function staleWindowMs(): number {
  return SENSOR_DATA_STALE_MS + _deliveryLagAllowanceMs;
}

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

export function recordSensorUpdate(entity: string, component: string, sampleTsMs?: number): void {
  if (typeof performance === 'undefined') return;
  const key = `${entity}.${component}`;
  const now = performance.now();

  let ts = _timestamps.get(key);
  if (!ts) {
    ts = [];
    _timestamps.set(key, ts);
  }

  ts.push(now);
  // Freshness keys off the sample's own server timestamp so a throttled client
  // reads live. Rate (the ts[] buffer above) stays on the local monotonic clock:
  // Hz is about delivery cadence, which is a different question.
  _lastUpdate.set(key, Number.isFinite(sampleTsMs) && (sampleTsMs as number) > 0
    ? (sampleTsMs as number)
    : Date.now());

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

/** Test helper: this module holds cross-test state (rate buffers, last-update stamps and
 *  the delivery-lag allowance). Precedent: resetPlotTimeForTests, resetEncoderAcceptTimestampsForTests. */
export function resetSensorRateForTests(): void {
  _timestamps.clear();
  _lastUpdate.clear();
  _emaRate.clear();
  _deliveryLagAllowanceMs = 0;
  _lastPrune = 0;
}

/** True if this exact `entity.component` key's newest sample is younger than the current
 *  staleness window (base + this link's delivery-lag allowance) on the server timeline. */
export function isSensorKeyFresh(key: string): boolean {
  const t = _lastUpdate.get(key);
  if (t == null || !Number.isFinite(t)) return false;
  return serverNowMs() - t < staleWindowMs();
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
