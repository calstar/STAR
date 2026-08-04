/**
 * Rolling in-memory history of broadcast sensor points, used to answer
 * HISTORICAL_DATA on connect and QUERY_HISTORICAL backfills.
 *
 * Timestamps are absolute epoch milliseconds (the same timestamps carried in
 * SENSOR_UPDATE payloads) — clients merge by timestamp, no rebasing.
 *
 * Ring buffers grow geometrically up to maxPoints so sparse/event streams
 * cost KBs, not the full ring. Pure module (no server imports) so it is
 * unit-testable without the stack.
 */

export interface HistoryCacheOptions {
  maxPoints: number;  // per-series ring capacity ceiling
  maxKeys: number;    // LRU eviction bound across series
  staleMs: number;    // series with no writes for this long are pruned
  initialPoints?: number; // starting ring capacity (default 2048)
}

export interface HistoryQuery {
  /** Restrict to these entity.component keys; omit for all. */
  keys?: string[];
  /** Only points strictly newer than this epoch-ms timestamp. */
  sinceMs?: number;
}

export interface HistorySeriesData {
  time: number[];   // epoch ms, ascending
  values: number[];
}

interface Ring {
  tBuf: Float64Array;
  vBuf: Float64Array;
  head: number;   // next write index
  len: number;    // fill count 0..tBuf.length
  lastMs: number; // wall-clock of last write (staleness)
}

export class HistoryCache {
  private series = new Map<string, Ring>();
  private readonly initialPoints: number;

  constructor(private opts: HistoryCacheOptions) {
    this.initialPoints = Math.min(opts.initialPoints ?? 2048, opts.maxPoints);
  }

  get size(): number {
    return this.series.size;
  }

  record(key: string, tMs: number, value: number): void {
    let s = this.series.get(key);
    if (!s) {
      s = {
        tBuf: new Float64Array(this.initialPoints),
        vBuf: new Float64Array(this.initialPoints),
        head: 0, len: 0, lastMs: 0,
      };
      this.series.set(key, s);
    }

    const cap = s.tBuf.length;
    // Overwrite last entry on identical timestamp; otherwise advance the ring.
    const lastIdx = (s.head - 1 + cap) % cap;
    if (s.len > 0 && s.tBuf[lastIdx] === tMs) {
      s.vBuf[lastIdx] = value;
    } else {
      if (s.len === cap && cap < this.opts.maxPoints) this.grow(key, s);
      const g = this.series.get(key)!; // grow() may have replaced the ring
      g.tBuf[g.head] = tMs;
      g.vBuf[g.head] = value;
      g.head = (g.head + 1) % g.tBuf.length;
      if (g.len < g.tBuf.length) g.len++;
      s = g;
    }
    s.lastMs = Date.now();
  }

  /** Read one series as plain ascending arrays (allocates; connect/query only). */
  read(key: string): HistorySeriesData | null {
    const s = this.series.get(key);
    if (!s || s.len === 0) return null;
    return unroll(s);
  }

  /**
   * Build the HISTORICAL_DATA payload. No query → every series (legacy
   * full-dump behavior). maxSendPoints trims each series to its newest N.
   */
  buildPayload(query: HistoryQuery | undefined, maxSendPoints: number): Record<string, HistorySeriesData> {
    const payload: Record<string, HistorySeriesData> = {};
    const wantedKeys = query?.keys?.length ? query.keys : null;
    const sinceMs = typeof query?.sinceMs === 'number' && Number.isFinite(query.sinceMs)
      ? query.sinceMs : null;

    const keys = wantedKeys ?? Array.from(this.series.keys());
    for (const key of keys) {
      const s = this.series.get(key);
      if (!s || s.len === 0) continue;
      let { time, values } = unroll(s);

      if (sinceMs !== null) {
        // time is ascending — find first index strictly after sinceMs.
        let lo = 0, hi = time.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (time[mid] <= sinceMs) lo = mid + 1; else hi = mid;
        }
        if (lo >= time.length) continue;
        if (lo > 0) { time = time.slice(lo); values = values.slice(lo); }
      }

      if (time.length > maxSendPoints) {
        const start = time.length - maxSendPoints;
        time = time.slice(start);
        values = values.slice(start);
      }
      payload[key] = { time, values };
    }
    return payload;
  }

  /** Stale/LRU eviction; call periodically. */
  prune(nowMs = Date.now()): void {
    if (this.series.size <= this.opts.maxKeys) {
      for (const [key, s] of this.series) {
        if (nowMs - s.lastMs > this.opts.staleMs) this.series.delete(key);
      }
      return;
    }
    const byAge = Array.from(this.series.entries()).sort((a, b) => a[1].lastMs - b[1].lastMs);
    const toRemove = this.series.size - this.opts.maxKeys;
    for (let i = 0; i < toRemove && i < byAge.length; i++) {
      this.series.delete(byAge[i][0]);
    }
  }

  private grow(key: string, s: Ring): void {
    const newCap = Math.min(s.tBuf.length * 4, this.opts.maxPoints);
    const { time, values } = unroll(s);
    const tBuf = new Float64Array(newCap);
    const vBuf = new Float64Array(newCap);
    tBuf.set(time);
    vBuf.set(values);
    this.series.set(key, { tBuf, vBuf, head: time.length % newCap, len: time.length, lastMs: s.lastMs });
  }
}

function unroll(s: Ring): { time: number[]; values: number[] } {
  const cap = s.tBuf.length;
  const len = s.len;
  const tail = len < cap ? 0 : s.head;
  const time: number[] = new Array(len);
  const values: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const idx = (tail + i) % cap;
    time[i] = s.tBuf[idx];
    values[i] = s.vBuf[idx];
  }
  return { time, values };
}
