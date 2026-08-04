/**
 * Background data cache — ring-buffer storage per sensor so plots have
 * historical data available even before the window/tab opens.
 *
 * Architecture (post time-refactor):
 *  - Points are keyed on the SERVER timestamp carried in each message
 *    (epoch ms) — never on arrival time. See plot-time.ts for the time base.
 *  - The cache is a CACHE: the backend's history is the source of truth.
 *    HISTORICAL_DATA is MERGED by timestamp (never wipe-and-rebase), so
 *    reconnects backfill gaps instead of destroying local history.
 *  - GlobalStateSubscriber owns the single SENSOR_UPDATE WS subscription and
 *    calls addDataPoint(entity, component, value, timestampMs).
 *  - Pre-allocated Float64Array ring buffers — zero heap allocations on write.
 *  - getAlignedHistory() allocates once per call (unavoidable for uPlot).
 */

import { ALIASES, isSensorStreamFresh } from './store';
import { getWebSocketClient } from './websocket';
import { MessageType } from './types';
import { noteServerTimestamp, newestServerTsMs, serverNowMs } from './plot-time';

// Ring capacity must cover the longest dashboard window (5 min = 300 s) at the
// backend's downsampled rate (~20 pts/s) → 300×20 = 6000; headroom for bursts.
const CACHE_MAX_POINTS  = 16000;
// The stack routinely publishes >80 entity.component streams. A low key cap causes
// live series eviction and "dead" plots until a backfill reloads them.
const CACHE_MAX_KEYS    = 2000;
// Keep inactive series around longer so slower/episodic channels do not disappear.
const CACHE_STALE_MS    = 30 * 60 * 1000;
// Reconnect backfills re-request a little overlap so no gap survives dedupe.
const BACKFILL_OVERLAP_MS = 5000;

// ── Ring buffer series ────────────────────────────────────────────────────────
interface RingSeries {
  tBuf:   Float64Array; // timestamps (epoch ms, ascending)
  vBuf:   Float64Array; // values
  head:   number;       // next write index (mod CACHE_MAX_POINTS)
  len:    number;       // fill count (0..CACHE_MAX_POINTS)
  lastMs: number;       // wall-clock ms of last write (for stale pruning)
}

// ── Cache class ───────────────────────────────────────────────────────────────
class SensorDataCache {
  private cache: Map<string, RingSeries> = new Map();
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private onHistoricalDataCallbacks: Set<() => void> = new Set();

  /** Register a callback invoked whenever HISTORICAL_DATA merges from the backend. */
  onHistoricalData(cb: () => void): () => void {
    this.onHistoricalDataCallbacks.add(cb);
    return () => this.onHistoricalDataCallbacks.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pruneInterval = setInterval(() => this.pruneStaleKeys(), 60_000);

    const ws = getWebSocketClient();

    // Reconnect backfills: only ask for what we don't have yet (plus overlap).
    ws.setHistoricalQueryProvider(() => {
      const newest = newestServerTsMs();
      return newest !== null ? { sinceMs: newest - BACKFILL_OVERLAP_MS } : {};
    });

    ws.on(MessageType.HISTORICAL_DATA, (payload: unknown) => {
      try {
        const data = payload as Record<string, { time: number[]; values: number[] }>;
        let mergedSeries = 0;
        for (const [key, series] of Object.entries(data)) {
          if (!series?.time?.length || !series?.values?.length) continue;
          if (this.mergeSeries(key, series.time, series.values) > 0) mergedSeries++;
        }
        if (mergedSeries > 0) {
          console.log(`[DataCache] Merged historical data for ${mergedSeries} series from backend`);
          this.onHistoricalDataCallbacks.forEach(cb => { try { cb(); } catch (_) { } });
        }
      } catch (err) {
        console.error('[DataCache] Failed to merge historical data:', err);
      }
    });
  }

  stop(): void {
    if (this.pruneInterval) { clearInterval(this.pruneInterval); this.pruneInterval = null; }
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

  private lastTime(s: RingSeries): number {
    if (s.len === 0) return -Infinity;
    return s.tBuf[(s.head - 1 + CACHE_MAX_POINTS) % CACHE_MAX_POINTS];
  }

  /**
   * Merge an ascending epoch-ms series into the ring: points at-or-before the
   * newest cached timestamp are skipped (already have them / live path won),
   * the rest are appended. Returns the number of points appended.
   */
  private mergeSeries(key: string, time: number[], values: number[]): number {
    const s = this.getOrCreate(key);
    const last = this.lastTime(s);

    // Binary search: first index strictly newer than what we hold.
    let lo = 0, hi = Math.min(time.length, values.length);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (time[mid] <= last) lo = mid + 1; else hi = mid;
    }

    let appended = 0;
    for (let i = lo; i < Math.min(time.length, values.length); i++) {
      const t = time[i], v = values[i];
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      this.ringWrite(s, t, v);
      appended++;
      noteServerTimestamp(t);
    }
    return appended;
  }

  // ── Stale key pruning ───────────────────────────────────────────────────────

  private pruneStaleKeys(): void {
    const now = Date.now();
    for (const [key, s] of this.cache) {
      if (now - s.lastMs > CACHE_STALE_MS) this.cache.delete(key);
    }
    // Emergency bound only (protect against unbounded growth in pathological cases).
    if (this.cache.size > CACHE_MAX_KEYS) {
      const byAge = Array.from(this.cache.entries()).sort((a, b) => a[1].lastMs - b[1].lastMs);
      const toRemove = this.cache.size - CACHE_MAX_KEYS;
      for (let i = 0; i < toRemove && i < byAge.length; i++) this.cache.delete(byAge[i][0]);
    }
  }

  // ── Public write API ────────────────────────────────────────────────────────

  /**
   * Add a live data point (called by GlobalStateSubscriber on SENSOR_UPDATE).
   * timestampMs is the server timestamp from the message payload — the
   * backend already rate-controls streams, so no client-side throttle.
   */
  addDataPoint(entity: string, component: string, value: number, timestampMs: number): void {
    if (!isFinite(value) || !Number.isFinite(timestampMs) || timestampMs <= 0) return;
    noteServerTimestamp(timestampMs);
    const key = `${entity}.${component}`;
    const s   = this.getOrCreate(key);
    const lt  = this.lastTime(s);

    if (timestampMs > lt) {
      this.ringWrite(s, timestampMs, value);
    } else if (timestampMs === lt) {
      // Same-instant update wins (matches backend history semantics).
      const idx = (s.head - 1 + CACHE_MAX_POINTS) % CACHE_MAX_POINTS;
      s.vBuf[idx] = value;
      s.lastMs = Date.now();
    }
    // Strictly older than the ring head: drop (out-of-order stragglers are
    // covered by the next backfill merge, which inserts nothing older either —
    // rings must stay ascending for windowed reads).
  }

  // ── Public read API ─────────────────────────────────────────────────────────

  /**
   * Read a time-windowed slice of the ring buffer as plain arrays.
   * Returns null if the series has no data within the window.
   * One allocation per call — called at plot render rate.
   */
  private readWindow(s: RingSeries, cutoffMs: number): { time: number[]; values: number[] } | null {
    if (s.len === 0) return null;
    const t = this.tail(s);

    // Linear scan to find first index >= cutoff (at most CACHE_MAX_POINTS iterations).
    let startOffset = 0;
    while (startOffset < s.len && s.tBuf[(t + startOffset) % CACHE_MAX_POINTS] < cutoffMs) {
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

  // ── Reverse alias index (rebuilt lazily when ALIASES size changes) ───────────
  // Maps fallback key → canonical key for O(1) reverse lookup instead of O(n) scan.
  private reverseAliasIndex: Map<string, string> = new Map();
  private reverseAliasBuiltSize = 0;

  private ensureReverseAliasIndex(): void {
    const aliasEntries = Object.entries(ALIASES);
    if (aliasEntries.length === this.reverseAliasBuiltSize) return;
    this.reverseAliasIndex.clear();
    for (const [canonical, fallbacks] of aliasEntries) {
      for (const fb of fallbacks) {
        if (!this.reverseAliasIndex.has(fb)) {
          this.reverseAliasIndex.set(fb, canonical);
        }
      }
    }
    this.reverseAliasBuiltSize = aliasEntries.length;
  }

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

    // Reverse alias: O(1) lookup via pre-built index
    this.ensureReverseAliasIndex();
    const canonical = this.reverseAliasIndex.get(key);
    if (canonical) {
      s = this.cache.get(canonical);
      if (s && s.len > 0) return s;
      const cFallbacks = ALIASES[canonical];
      if (cFallbacks) {
        for (const fb of cFallbacks) {
          s = this.cache.get(fb);
          if (s && s.len > 0) return s;
        }
      }
    }
    return null;
  }

  /**
   * Build aligned time + values arrays for a set of entity/component pairs.
   * Times are epoch ms. Uses the first series with data as the time base;
   * aligns others via nearest-neighbour lookup. One allocation per call.
   */
  getAlignedHistory(
    entities: string[],
    componentMap: string[],
    windowSeconds: number,
  ): { time: number[]; values: number[][] } | null {
    const cutoffMs = serverNowMs() - windowSeconds * 1000;
    const keys     = entities.map((e, i) => `${e}.${componentMap[i]}`);

    // Find time base — first series with data in the window.
    let baseWindow: { time: number[]; values: number[] } | null = null;
    for (const k of keys) {
      const s = this.findSeries(k);
      if (!s) continue;
      const w = this.readWindow(s, cutoffMs);
      if (w && w.time.length > 0) { baseWindow = w; break; }
    }
    if (!baseWindow) return null;

    const time = baseWindow.time;
    const len  = time.length;

    const values = keys.map((key, idx) => {
      const entity = entities[idx];
      const comp = componentMap[idx];
      if (!isSensorStreamFresh(entity, comp)) {
        return new Array<number>(len).fill(NaN);
      }
      const s = this.findSeries(key);
      if (!s) return new Array<number>(len).fill(NaN);
      const w = this.readWindow(s, cutoffMs);
      if (!w) return new Array<number>(len).fill(NaN);

      const out: number[] = new Array(len);
      let j = 0;

      for (let i = 0; i < len; i++) {
        const t = time[i];
        while (j + 1 < w.time.length && w.time[j + 1] <= t) j++;
        out[i] = w.time[j] <= t ? w.values[j] : NaN;
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
