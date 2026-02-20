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

const CACHE_SAMPLE_HZ = 10; // 10 Hz to match backend broadcast rate
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

  start(): void {
    if (this.started) return;
    this.started = true;
    this.interval = setInterval(() => this.sample(), 1000 / CACHE_SAMPLE_HZ);
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
      const now = (Date.now() - getStartupTime()) / 1000;
      const state = useSensorStore.getState();
      if (!state || !state.sensorData) return;
      const sensorData = state.sensorData;

      for (const [key, value] of Object.entries(sensorData)) {
        if (!isFinite(value)) continue;

        let series = this.cache.get(key);
        if (!series) {
          series = { time: [], values: [] };
          this.cache.set(key, series);
        }
        series.time.push(now);
        series.values.push(value);

        if (series.time.length > CACHE_MAX_POINTS) {
          series.time = series.time.slice(-CACHE_MAX_POINTS);
          series.values = series.values.slice(-CACHE_MAX_POINTS);
        }
      }
    } catch (err) {
      console.error('[DataCache] Error sampling:', err);
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

    // Check aliases
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        series = this.cache.get(fb);
        if (series && series.time.length > 0) return series;
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
    const now = (Date.now() - getStartupTime()) / 1000;
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
    if (!baseSeries || !baseKey) return null;

    // Find start index within window
    let startIdx = 0;
    while (startIdx < baseSeries.time.length && baseSeries.time[startIdx] < cutoff) startIdx++;

    const time = baseSeries.time.slice(startIdx);
    if (time.length === 0) return null;

    const len = time.length;
    const values = keys.map((key) => {
      const s = this.findCachedSeries(key);
      if (!s) return new Array(len).fill(NaN);
      const sliced = s.values.slice(startIdx, startIdx + len);
      while (sliced.length < len) sliced.push(NaN);
      return sliced;
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

