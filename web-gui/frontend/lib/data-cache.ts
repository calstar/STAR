/**
 * Background data cache — samples sensor store at 1 Hz so that plots
 * have historical data available even before the window/tab opens.
 *
 * Call `startDataCache()` once at app boot (e.g. TopBar).  Every
 * TimeSeriesPlot calls `getDataCache().getAlignedHistory(...)` on
 * mount to pre-fill its buffer.
 */

import { useSensorStore, ALIASES } from './store';
import { getStartupTime } from './startup-time';
import { getWebSocketClient } from './websocket';
import { MessageType } from './types';
import { getServerTimeNow } from './server-time';

const CACHE_SAMPLE_HZ = 30; // 30 Hz to match backend broadcast rate
const CACHE_MAX_SECONDS = 300; // 5 minutes of history
const CACHE_MAX_POINTS = CACHE_MAX_SECONDS * CACHE_SAMPLE_HZ;

export interface CachedSeries {
  time: number[];
  values: number[];
}

class SensorDataCache {
  private cache: Map<string, CachedSeries> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private onHistoricalDataCallbacks: Set<() => void> = new Set();

  /** Register a callback to be invoked whenever HISTORICAL_DATA is loaded from the backend. */
  onHistoricalData(cb: () => void): () => void {
    this.onHistoricalDataCallbacks.add(cb);
    return () => this.onHistoricalDataCallbacks.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.interval = setInterval(() => this.sample(), 1000 / CACHE_SAMPLE_HZ);

    // Listen for bulk historical data from backend connection
    const ws = getWebSocketClient();
    ws.on(MessageType.HISTORICAL_DATA, (payload: unknown) => {
      try {
        const data = payload as Record<string, { time: number[]; values: number[] }>;
        const frontendNow = (getServerTimeNow() - getStartupTime()) / 1000;
        let count = 0;
        for (const [key, series] of Object.entries(data)) {
          if (series.time && series.values && series.time.length > 0) {
            // Remap backend timestamps so the most recent historical point aligns with
            // the current frontend time. This prevents non-monotonic time arrays when
            // live data (at frontend-relative time) gets appended after pre-fill.
            const backendLatest = series.time[series.time.length - 1];
            const offset = frontendNow - backendLatest;
            const remappedTime = series.time.map(t => t + offset);
            this.cache.set(key, { time: remappedTime, values: [...series.values] });
            count++;
          }
        }
        if (count > 0) {
          console.log(`[DataCache] Loaded historical data for ${count} entities from backend`);
          this.onHistoricalDataCallbacks.forEach(cb => { try { cb(); } catch (_) { } });
        }
      } catch (err) {
        console.error('[DataCache] Failed to parse historical data:', err);
      }
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.started = false;
  }

  private sample(): void {
    try {
      const now = (getServerTimeNow() - getStartupTime()) / 1000;
      const state = useSensorStore.getState();
      if (!state || !state.sensorData) return;
      const sensorData = state.sensorData;

      for (const [key, value] of Object.entries(sensorData)) {
        if (value === null || value === undefined || !isFinite(value)) continue;

        let series = this.cache.get(key);
        if (!series) {
          series = { time: [], values: [] };
          this.cache.set(key, series);
        }

        // Only add if time has advanced (avoid duplicates)
        if (series.time.length === 0 || series.time[series.time.length - 1] < now) {
          series.time.push(now);
          series.values.push(value);
        } else {
          // Update last value if same timestamp
          series.values[series.values.length - 1] = value;
        }

        if (series.time.length > CACHE_MAX_POINTS) {
          series.time = series.time.slice(-CACHE_MAX_POINTS);
          series.values = series.values.slice(-CACHE_MAX_POINTS);
        }
      }
    } catch (err) {
      console.error('[DataCache] Error sampling:', err);
    }
  }

  /** Manually add a data point (called from WebSocket handler) */
  addDataPoint(entity: string, component: string, value: number): void {
    if (!isFinite(value)) return;
    const key = `${entity}.${component}`;
    const now = (getServerTimeNow() - getStartupTime()) / 1000;

    let series = this.cache.get(key);
    if (!series) {
      series = { time: [], values: [] };
      this.cache.set(key, series);
    }

    // Spike rejection: prevent obvious spikes from entering time series (bar uses latest, so unaffected)
    if (series.values.length > 0) {
      const prev = series.values[series.values.length - 1];
      if (isFinite(prev)) {
        if (component === 'pressure_psi') {
          const maxJump = entity.includes('HP_PT') || entity.includes('GSE_Mid') || entity.includes('GSE_High') || entity.includes('GN2_High') ? 500 : 1000;
          if (Math.abs(value - prev) > maxJump) value = prev;
        } else if (prev !== 0 && Math.abs(value / prev) > 10) {
          value = prev;  // ratio filter for other components
        }
      }
    }

    // Always add new point - allow some time tolerance for batching
    const lastTime = series.time.length > 0 ? series.time[series.time.length - 1] : -Infinity;
    const timeDiff = now - lastTime;

    if (timeDiff >= 0.05) { // At least 50ms between points (20 Hz max)
      series.time.push(now);
      series.values.push(value);
    } else if (timeDiff >= -0.1 && timeDiff < 0.05) {
      // Update last value if within 100ms (same batch)
      if (series.values.length > 0) {
        series.values[series.values.length - 1] = value;
      }
    }

    if (series.time.length > CACHE_MAX_POINTS) {
      series.time = series.time.slice(-CACHE_MAX_POINTS);
      series.values = series.values.slice(-CACHE_MAX_POINTS);
    }
  }

  /** Get cached history for a single entity.component key. */
  getHistory(key: string): CachedSeries | null {
    const series = this.cache.get(key);
    if (!series || series.time.length === 0) return null;
    return { time: [...series.time], values: [...series.values] };
  }

  /**
   * Find cached series for a key, checking aliases if direct lookup fails.
   */
  private findCachedSeries(key: string): CachedSeries | null {
    // Try direct lookup first
    let series = this.cache.get(key);
    if (series && series.time.length > 0) return series;

    // Check forward aliases (canonical → fallbacks)
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        series = this.cache.get(fb);
        if (series && series.time.length > 0) return series;
      }
    }

    // Check reverse aliases (PT_CHX → canonical)
    // If key is a fallback (e.g., PT_Cal.PT_CH1.pressure_psi), find the canonical entity
    for (const [canonical, fallbackList] of Object.entries(ALIASES)) {
      if (fallbackList.includes(key)) {
        // This key is a fallback for canonical, so check if canonical exists in cache
        series = this.cache.get(canonical);
        if (series && series.time.length > 0) return series;
        // Also check if any of canonical's fallbacks exist
        for (const fb of fallbackList) {
          series = this.cache.get(fb);
          if (series && series.time.length > 0) return series;
        }
      }
    }

    return null;
  }

  /**
   * Build pre-filled time + values arrays from cache for a set of entities.
   * Returns data suitable for direct assignment to dataRef in TimeSeriesPlot.
   */
  getAlignedHistory(
    entities: string[],
    componentMap: string[],
    windowSeconds: number,
  ): { time: number[]; values: number[][] } | null {
    const now = (getServerTimeNow() - getStartupTime()) / 1000;
    const cutoff = now - windowSeconds;

    const keys = entities.map((e, i) => `${e}.${componentMap[i]}`);

    // Find any series that has data to use as time base (check aliases)
    let baseSeries: CachedSeries | undefined;
    let baseKey: string | undefined;
    for (const k of keys) {
      const s = this.findCachedSeries(k);
      if (s && s.time.length > 0) {
        baseSeries = s;
        baseKey = k;
        break;
      }
    }
    if (!baseSeries || !baseKey) {
      // Debug: log cache state
      const cacheKeys = Array.from(this.cache.keys());
      if (cacheKeys.length > 0) {
        console.log(`[DataCache] Cache has ${cacheKeys.length} keys, but none match requested:`, keys);
      }
      return null;
    }

    // Find start index within window
    let startIdx = 0;
    while (startIdx < baseSeries.time.length && baseSeries.time[startIdx] < cutoff) startIdx++;

    const time = baseSeries.time.slice(startIdx);
    if (time.length === 0) return null;

    const len = time.length;
    // Time-based alignment: for each t in time, use value from each series at most recent time <= t.
    // Index-based slicing causes spikes when series have different lengths/sampling.
    const values = keys.map((key) => {
      const s = this.findCachedSeries(key);
      if (!s || s.time.length === 0) return new Array(len).fill(NaN);
      const out: number[] = [];
      let idx = 0;
      for (let i = 0; i < len; i++) {
        const t = time[i];
        if (i > 0 && t < time[i - 1]) idx = 0;
        while (idx + 1 < s.time.length && s.time[idx + 1] <= t) idx++;
        out.push(s.time[idx] <= t ? s.values[idx] : NaN);
      }
      return out;
    });

    return { time, values };
  }
}

// Singleton
let _instance: SensorDataCache | null = null;

export function getDataCache(): SensorDataCache {
  if (!_instance) {
    _instance = new SensorDataCache();
  }
  return _instance;
}

export function startDataCache(): void {
  getDataCache().start();
}
