/**
 * Background data cache — ring-buffer storage per sensor so plots
 * have historical data available even before the window/tab opens.
 *
 * Architecture:
 *  - Pre-allocated Float64Array ring buffers — zero heap allocations on write.
 *  - GlobalStateSubscriber owns the single SENSOR_UPDATE WS subscription and
 *    calls addDataPoint(); DataCache.start() handles HISTORICAL_DATA only.
 *  - sample() still runs at 10 Hz from Zustand store as a fallback in case
 *    GlobalStateSubscriber hasn't fired yet (e.g. rapid reconnects).
 *  - getAlignedHistory() allocates once per call (unavoidable for uPlot).
 */

import { useSensorStore, ALIASES } from './store';
import { getStartupTime } from './startup-time';
import { getWebSocketClient } from './websocket';
import { MessageType } from './types';
import { getServerTimeNow } from './server-time';

const CACHE_MAX_SECONDS = 60;
const CACHE_MAX_POINTS  = 2000; // 10 Hz * 200 s
const CACHE_SAMPLE_HZ   = 10;
const CACHE_MAX_KEYS    = 80;
const CACHE_STALE_MS    = 2 * 60 * 1000;

// ── Ring buffer series ────────────────────────────────────────────────────────
interface RingSeries {
  tBuf:   Float64Array; // timestamps (T+ seconds from startup)
  vBuf:   Float64Array; // values
  head:   number;       // next write index (mod CACHE_MAX_POINTS)
  len:    number;       // fill count (0..CACHE_MAX_POINTS)
  lastMs: number;       // wall-clock ms of last write (for stale pruning)
}

// ── Cache class ───────────────────────────────────────────────────────────────
class SensorDataCache {
  private cache: Map<string, RingSeries> = new Map();
  private sampleInterval: ReturnType<typeof setInterval> | null = null;
  private pruneInterval:  ReturnType<typeof setInterval> | null = null;
  private started = false;
  private onHistoricalDataCallbacks: Set<() => void> = new Set();

  /** Register a callback invoked whenever HISTORICAL_DATA loads from the backend. */
  onHistoricalData(cb: () => void): () => void {
    this.onHistoricalDataCallbacks.add(cb);
    return () => this.onHistoricalDataCallbacks.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.sampleInterval = setInterval(() => this.sample(), 1000 / CACHE_SAMPLE_HZ);
    this.pruneInterval  = setInterval(() => this.pruneStaleKeys(), 60_000);

    const ws = getWebSocketClient();
    ws.on(MessageType.HISTORICAL_DATA, (payload: unknown) => {
      try {
        const data = payload as Record<string, { time: number[]; values: number[] }>;
        const frontendNow = (getServerTimeNow() - getStartupTime()) / 1000;
        let count = 0;
        for (const [key, series] of Object.entries(data)) {
          if (!series.time?.length || !series.values?.length) continue;
          // Remap so most-recent historical point aligns with current frontend time,
          // preventing non-monotonic time arrays when live data is appended.
          const backendLatest = series.time[series.time.length - 1];
          const offset = frontendNow - backendLatest;
          const s = this.getOrCreate(key);
          // Reset ring and bulk-load all points.
          s.head = 0; s.len = 0;
          for (let i = 0; i < series.time.length; i++) {
            this.ringWrite(s, series.time[i] + offset, series.values[i]);
          }
          count++;
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
    if (this.sampleInterval) { clearInterval(this.sampleInterval); this.sampleInterval = null; }
    if (this.pruneInterval)  { clearInterval(this.pruneInterval);  this.pruneInterval  = null; }
    this.started = false;
  }

  // ── Ring buffer primitives ──────────────────────────────────────────────────

  private getOrCreate(key: string): RingSeries {
    let s = this.cache.get(key);
    if (!s) {
      s = { tBuf: new Float64Array(CACHE_MAX_POINTS), vBuf: new Float64Array(CACHE_MAX_POINTS), head: 0, len: 0, lastMs: 0 };
      this.cache.set(key, s);
    }
    return s;
  }

  private ringWrite(s: RingSeries, t: number, v: number): void {
    s.tBuf[s.head] = t;
    s.vBuf[s.head] = v;
    s.head = (s.head + 1) % CACHE_MAX_POINTS;
    if (s.len < CACHE_MAX_POINTS) s.len++;
    s.lastMs = Date.now();
  }

  /** Oldest slot index in the ring. */
  private tail(s: RingSeries): number {
    return s.len < CACHE_MAX_POINTS ? 0 : s.head;
  }

  private lastVal(s: RingSeries): number {
    if (s.len === 0) return NaN;
    return s.vBuf[(s.head - 1 + CACHE_MAX_POINTS) % CACHE_MAX_POINTS];
  }

  private lastTime(s: RingSeries): number {
    if (s.len === 0) return -Infinity;
    return s.tBuf[(s.head - 1 + CACHE_MAX_POINTS) % CACHE_MAX_POINTS];
  }

  /** Last n values in chronological order (newest last). */
  private lastNValues(s: RingSeries, n: number): number[] {
    const count = Math.min(n, s.len);
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = s.vBuf[(s.head - count + i + CACHE_MAX_POINTS) % CACHE_MAX_POINTS];
    }
    return out;
  }

  /**
   * Read a time-windowed slice of the ring buffer as plain arrays.
   * Returns null if the series has no data within the window.
   * One allocation per call — only called at render rate (~10 Hz).
   */
  private readWindow(s: RingSeries, cutoff: number): { time: number[]; values: number[] } | null {
    if (s.len === 0) return null;
    const t = this.tail(s);

    // Linear scan to find first index >= cutoff (at most CACHE_MAX_POINTS = 2000 iterations).
    let startOffset = 0;
    while (startOffset < s.len && s.tBuf[(t + startOffset) % CACHE_MAX_POINTS] < cutoff) {
      startOffset++;
    }
    const count = s.len - startOffset;
    if (count <= 0) return null;

    const time   = new Array<number>(count);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const idx = (t + startOffset + i) % CACHE_MAX_POINTS;
      time[i]   = s.tBuf[idx];
      values[i] = s.vBuf[idx];
    }
    return { time, values };
  }

  // ── Stale key pruning ───────────────────────────────────────────────────────

  private pruneStaleKeys(): void {
    const now = Date.now();
    if (this.cache.size <= CACHE_MAX_KEYS) {
      for (const [key, s] of this.cache) {
        if (now - s.lastMs > CACHE_STALE_MS) this.cache.delete(key);
      }
    } else {
      const byAge = Array.from(this.cache.entries()).sort((a, b) => a[1].lastMs - b[1].lastMs);
      const toRemove = this.cache.size - CACHE_MAX_KEYS;
      for (let i = 0; i < toRemove && i < byAge.length; i++) this.cache.delete(byAge[i][0]);
    }
  }

  // ── 10 Hz background sampler (fallback) ────────────────────────────────────

  private sample(): void {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const now   = (getServerTimeNow() - getStartupTime()) / 1000;
      const state = useSensorStore.getState();
      if (!state?.sensorData) return;
      for (const [key, value] of Object.entries(state.sensorData)) {
        if (value === null || value === undefined || !isFinite(value)) continue;
        const s = this.getOrCreate(key);
        if (this.lastTime(s) < now) {
          this.ringWrite(s, now, value);
        } else {
          // Same timestamp — update value in place.
          const prev = (s.head - 1 + CACHE_MAX_POINTS) % CACHE_MAX_POINTS;
          s.vBuf[prev] = value;
          s.lastMs = Date.now();
        }
      }
    } catch (err) {
      console.error('[DataCache] Error sampling:', err);
    }
  }

  // ── Public write API ────────────────────────────────────────────────────────

  private _lastAddPerKey: Record<string, number> = {};

  /** Add a data point (called by GlobalStateSubscriber on SENSOR_UPDATE). Throttled to 10 Hz. */
  addDataPoint(entity: string, component: string, value: number): void {
    if (!isFinite(value)) return;
    const key   = `${entity}.${component}`;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last  = this._lastAddPerKey[key] ?? 0;
    if (nowMs - last < 100) return; // 10 Hz max per key
    this._lastAddPerKey[key] = nowMs;

    const now = (getServerTimeNow() - getStartupTime()) / 1000;
    const s   = this.getOrCreate(key);

    // Spike rejection — runs on the most recent ring values, no allocation.
    const prev = this.lastVal(s);
    if (isFinite(prev)) {
      if (component === 'pressure_psi') {
        const maxJump = entity.includes('HP_PT') || entity.includes('GSE_Mid') ||
                        entity.includes('GSE_High') || entity.includes('GN2_High') ? 500 : 1000;
        if (Math.abs(value - prev) > maxJump) { value = prev; }
        else {
          const recent = this.lastNValues(s, 5).filter(v => isFinite(v));
          if (recent.length >= 2) {
            const sorted = [...recent].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            if (Math.abs(value - median) > 15) value = prev; // 15 PSI deviation cap
          }
        }
      } else if (component !== 'temperature_c' && component !== 'force_lbf') {
        if (prev !== 0 && Math.abs(value / prev) > 10) value = prev;
      }
    }

    const lt = this.lastTime(s);
    if (now >= lt) {
      this.ringWrite(s, now, value);
    } else if (now >= lt - 0.1) {
      // Within 100ms of last — update last value in place.
      const idx = (s.head - 1 + CACHE_MAX_POINTS) % CACHE_MAX_POINTS;
      s.vBuf[idx] = value;
      s.lastMs = Date.now();
    }
  }

  // ── Public read API ─────────────────────────────────────────────────────────

  /**
   * Find cached series for a key, checking forward and reverse aliases.
   */
  private findSeries(key: string): RingSeries | null {
    let s = this.cache.get(key);
    if (s && s.len > 0) return s;

    // Forward aliases: canonical → fallbacks
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        s = this.cache.get(fb);
        if (s && s.len > 0) return s;
      }
    }

    // Reverse aliases: if this key is a fallback for some canonical
    for (const [canonical, fallbackList] of Object.entries(ALIASES)) {
      if (fallbackList.includes(key)) {
        s = this.cache.get(canonical);
        if (s && s.len > 0) return s;
        for (const fb of fallbackList) {
          s = this.cache.get(fb);
          if (s && s.len > 0) return s;
        }
      }
    }
    return null;
  }

  /**
   * Build aligned time + values arrays for a set of entity/component pairs.
   * Uses the first series with data as the time base; aligns others via
   * nearest-neighbour lookup. One allocation per call (called at render rate).
   */
  getAlignedHistory(
    entities: string[],
    componentMap: string[],
    windowSeconds: number,
  ): { time: number[]; values: number[][] } | null {
    const now    = (getServerTimeNow() - getStartupTime()) / 1000;
    const cutoff = now - windowSeconds;
    const keys   = entities.map((e, i) => `${e}.${componentMap[i]}`);

    // Find time base — first series with data in the window.
    let baseWindow: { time: number[]; values: number[] } | null = null;
    for (const k of keys) {
      const s = this.findSeries(k);
      if (!s) continue;
      const w = this.readWindow(s, cutoff);
      if (w && w.time.length > 0) { baseWindow = w; break; }
    }
    if (!baseWindow) return null;

    const time = baseWindow.time;
    const len  = time.length;

    const values = keys.map((key) => {
      const s = this.findSeries(key);
      if (!s) return new Array<number>(len).fill(NaN);
      const w = this.readWindow(s, cutoff);
      if (!w) return new Array<number>(len).fill(NaN);

      const isPressure = key.endsWith('.pressure_psi');
      const out: number[] = new Array(len);
      let j = 0;
      let lastPushed = NaN;

      for (let i = 0; i < len; i++) {
        const t = time[i];
        while (j + 1 < w.time.length && w.time[j + 1] <= t) j++;
        let val = w.time[j] <= t ? w.values[j] : NaN;
        if (isPressure && val === 0 && lastPushed > 0) val = NaN; // spurious zero → gap
        out[i] = val;
        if (Number.isFinite(val)) lastPushed = val;
      }
      return out;
    });

    return { time, values };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _instance: SensorDataCache | null = null;

export function getDataCache(): SensorDataCache {
  if (!_instance) _instance = new SensorDataCache();
  return _instance;
}

export function startDataCache(): void {
  getDataCache().start();
}
