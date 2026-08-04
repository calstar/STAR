/**
 * Shared plotting helpers for the uPlot time-series components
 * (TimeSeriesPlot, DerivedTimeSeriesPlot). One time base, one axis
 * convention, one Y-scaling policy.
 *
 * X convention: data and scales are epoch ms (server timeline, see
 * plot-time.ts). The axis *displays* T+ seconds relative to a t0 resolved at
 * render time — so a missionStartTime change relabels the axis without
 * touching data.
 */

import type uPlot from 'uplot';
import { useSensorStore } from './store';
import { firstSeenServerTsMs, serverNowMs } from './plot-time';

// ── T+ display transform ──────────────────────────────────────────────────────

/** T+ zero (epoch ms): backend missionStartTime, else first data seen. */
export function tPlusZeroMs(): number {
  const mission = useSensorStore.getState().missionStartTime;
  if (mission !== null && mission > 0) return mission;
  return firstSeenServerTsMs() ?? serverNowMs();
}

/** uPlot x-axis values formatter: epoch ms → whole T+ seconds. */
export function tPlusAxisValues(_u: uPlot, vals: (number | null)[]): string[] {
  const t0 = tPlusZeroMs();
  return vals.map((v) => (v == null ? '' : Math.round((v - t0) / 1000).toString()));
}

/** Scrolling x-window [now − windowSeconds, now] in epoch ms. */
export function xWindowMs(windowSeconds: number): [number, number] {
  const now = serverNowMs();
  return [now - windowSeconds * 1000, now];
}

// ── Value formatting / Y scaling ─────────────────────────────────────────────

export function fmtAxisVal(val: number): string {
  if (!isFinite(val)) return '';
  const abs = Math.abs(val);
  if (abs >= 1e9) return (val / 1e9).toFixed(1) + 'G';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(1) + 'K';
  if (abs >= 100) return val.toFixed(0);
  if (abs >= 1) return val.toFixed(1);
  return val.toFixed(2);
}

/** Padded Y range so flat lines are always visible. */
export function smartYRange(dataMin: number, dataMax: number): [number, number] {
  if (dataMin === dataMax) {
    const margin = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.05;
    return [dataMin - margin, dataMax + margin];
  }
  const span = dataMax - dataMin;
  const pad = Math.max(span * 0.12, Math.abs(dataMax) * 0.001);
  return [dataMin - pad, dataMax + pad];
}

/**
 * Rate-limited Y autoscale with hysteresis: recomputes at most every
 * intervalMs and only applies when the change is significant, so the axis
 * doesn't shake under noisy data while the x-scale scrolls at render rate.
 * Use with uPlot y-scale { auto: false }.
 */
export class YAxisHysteresis {
  private last: [number, number] | null = null;
  private lastUpdateMs = 0;

  constructor(private intervalMs = 1500) {}

  /** Returns the range to apply via setScale('y', …), or null to keep current. */
  update(seriesValues: number[][], nowMs: number): [number, number] | null {
    if (nowMs - this.lastUpdateMs < this.intervalMs) return null;
    this.lastUpdateMs = nowMs;

    let mn = Infinity, mx = -Infinity;
    for (const series of seriesValues) {
      for (const v of series) {
        if (isFinite(v)) {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
    }
    if (!isFinite(mn) || !isFinite(mx)) return null;

    const proposed = smartYRange(mn, mx);
    if (this.last) {
      const span = this.last[1] - this.last[0];
      const thr = Math.max(span * 0.20, 2.0);
      const changed = Math.abs(proposed[0] - this.last[0]) >= thr ||
                      Math.abs(proposed[1] - this.last[1]) >= thr;
      if (!changed) return null;
    }
    this.last = proposed;
    return proposed;
  }
}
