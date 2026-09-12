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

import { ALIASES } from './store';
import { SENSOR_DATA_STALE_MS } from './sensor-rate';
import { getWebSocketClient } from './websocket';
import { MessageType } from './types';
import { noteServerTimestamp, newestServerTsMs, serverNowMs } from './plot-time';

// Ring capacity must cover the longest dashboard window (5 min = 300 s) at the
// backend's downsampled rate (~20 pts/s) → 300×20 = 6000; headroom for bursts.
const CACHE_MAX_POINTS  = 16000;

/* ── Gap rendering ────────────────────────────────────────────────────────────
 * How long a drawn line may coast past its last real sample before it breaks.
 *
 * Alignment is sample-and-hold, which used to hold the last value FOREVER — a dead
 * sensor drew a flat line across the plot, indistinguishable from a steady hold. The
 * counter-fix was to blank the whole series once it went stale, which erased real
 * measurements instead. Both are wrong: draw every point that arrived, then stop.
 *
 * The hold is derived per-series from its OWN sample deltas, because sensors here run
 * from ~10 Hz actuators to ~75 Hz PTs and one constant cannot fit both. A trailing EMA
 * rather than a window mean or median, for two reasons:
 *   - the outbox compacts the old end of a window and leaves the new end at full
 *     resolution, so a window-wide mean sits between the two and dashes the old half;
 *   - min/max decimation makes the deltas BIMODAL — mergeWindows() keeps both extremes
 *     with their original timestamps, so a window emits two points milliseconds apart
 *     and then jumps a whole window. A median picks the near-zero mode and renders the
 *     trace as a row of ticks.
 * A trailing EMA is local (it tracks resolution changes as the loop walks) and averages
 * across the bimodal pair. */
const GAP_EMA_ALPHA     = 0.25;
/** Multiple of the mean interval tolerated before breaking. Worst phase of the bimodal
 *  case gives hold ~= 5 x 0.41W ~= 2W, i.e. 2x margin over one decimated window; below
 *  about 3 every throttled trace dashes. */
const GAP_FACTOR        = 5;
/** A 75 Hz PT arrives decimated at ~20 pts/s; one missed envelope must not break it. */
const MIN_HOLD_MS       = 250;
/** Sanity bound so a pathological EMA cannot hold a value across the whole window. */
const MAX_HOLD_MS       = 10_000;
/** Deltas required before the EMA is trusted to size a hold.
 *
 *  The startup transient is the trap: a min/max decimated stream alternates ~5 ms (the
 *  two extremes of one window, kept with their original timestamps) and ~495 ms (the jump
 *  to the next window). Seeded from the first 5 ms delta the EMA reads 5, the hold clamps
 *  to MIN_HOLD_MS, and the very next inter-window jump is mistaken for a dropout. It only
 *  converges to ~215 ms — a comfortably sufficient hold — after several deltas, so until
 *  then fall back to the readout window rather than guess. */
const EMA_WARMUP_DELTAS = 4;
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
/** Mean-interval EMA step; see the gap-rendering constants above. */
function nextEma(ema: number, deltaMs: number): number {
  return ema < 0 ? deltaMs : GAP_EMA_ALPHA * deltaMs + (1 - GAP_EMA_ALPHA) * ema;
}

/** How long this series may coast past its last sample, given the intervals so far. */
function holdMsFor(ema: number, seen: number): number {
  return ema < 0 || seen < EMA_WARMUP_DELTAS
    ? SENSOR_DATA_STALE_MS
    : Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, GAP_FACTOR * ema));
}

/**
 * Timestamps that must exist on the x-axis for this series' holes to be drawn as holes.
 *
 * uPlot joins consecutive points with a straight segment, so a series whose own samples
 * are the time base has no x-position inside its own gap — the hole gets drawn as one
 * long interpolated line, which is the flat-line bug again for single-series plots.
 * Emitting one marker just past the end of each hold gives the mapping somewhere to put
 * a NaN.
 */
function gapMarkers(w: { time: number[]; values: number[] }): number[] {
  const marks: number[] = [];
  let ema = -1;
  let seen = 0;
  for (let k = 1; k < w.time.length; k++) {
    const hold = holdMsFor(ema, seen);
    const d = w.time[k] - w.time[k - 1];
    // +1: the mapping holds while `t - lastSample <= hold`, so a marker exactly ON the
    // boundary is still held and draws no break. One millisecond past it is the first x
    // that is genuinely outside the hold.
    if (d > hold + 1) marks.push(w.time[k - 1] + hold + 1);
    ema = nextEma(ema, d);
    seen++;
  }
  return marks;
}

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

    // Read every series once, then take the time base from the FRESHEST of them — the one
    // whose last sample is newest (ties broken by point count).
    //
    // It used to be "the first key with data", which meant a stalled series silently
    // truncated the grid: co-plotted live series were simply not drawn past the stalled
    // one's last sample. That was invisible while everything got blanked anyway, and it
    // is the reason a stalled sensor could take healthy ones down with it. Reading once
    // also drops the duplicate readWindow the base series used to pay.
    const windows = keys.map((k) => {
      const s = this.findSeries(k);
      return s ? this.readWindow(s, cutoffMs) : null;
    });

    let baseWindow: { time: number[]; values: number[] } | null = null;
    let baseLast = -Infinity;
    for (const w of windows) {
      if (!w || w.time.length === 0) continue;
      const last = w.time[w.time.length - 1];
      if (last > baseLast || (last === baseLast && baseWindow && w.time.length > baseWindow.time.length)) {
        baseWindow = w;
        baseLast = last;
      }
    }
    if (!baseWindow) return null;

    // Splice a marker into every hole so the break has an x to live at (see gapMarkers).
    // Other series hold their value across that x, which is correct: they are still live,
    // it is this one that stopped.
    const marks = new Set<number>();
    for (const w of windows) if (w && w.time.length > 1) for (const m of gapMarkers(w)) marks.add(m);

    let time = baseWindow.time;
    if (marks.size > 0) {
      const lo = time[0], hi = time[time.length - 1];
      const extra = [...marks].filter((m) => m > lo && m < hi);
      if (extra.length > 0) time = [...time, ...extra].sort((a, b) => a - b);
    }
    const len = time.length;

    // No freshness gate here. Readout staleness (SENSOR_DATA_STALE_MS) answers "is this
    // number still current?", which is the right question for a readout and the wrong one
    // for a plot: it blanked complete, correct history because the backend deliberately
    // paces a throttled client at the same 1500 ms the frontend called stale. Plots draw
    // what the cache holds; the per-series hold below is what ends a line honestly.
    const values = windows.map((w) => {
      if (!w || w.time.length === 0) return new Array<number>(len).fill(NaN);

      const out: number[] = new Array(len);
      let j = 0;
      let ema = -1;   // mean inter-sample interval seen so far, ms
      let seen = 0;

      for (let i = 0; i < len; i++) {
        const t = time[i];
        while (j + 1 < w.time.length && w.time[j + 1] <= t) {
          ema = nextEma(ema, w.time[j + 1] - w.time[j]);
          seen++;
          j++;
        }
        // Fewer than two samples gives no interval to measure; fall back to the readout
        // window, the only other statement we have about what "current" means.
        const hold = holdMsFor(ema, seen);
        out[i] = (w.time[j] <= t && t - w.time[j] <= hold) ? w.values[j] : NaN;
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
