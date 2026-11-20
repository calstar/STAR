/**
 * Per-client sensor outbox — bounds what a slow WebSocket client costs the
 * backend, and bounds how far behind it can fall.
 *
 * The problem this replaces: broadcast() handed every message to ws.send() and
 * never looked at ws.bufferedAmount, so a client that stopped draining had every
 * subsequent frame queued in the backend's heap without limit. Worse than the
 * memory, a FIFO queue guarantees *completeness* and therefore gives up
 * *currency* without bound — the tablet renders a smooth, plausible plot that is
 * minutes old, with no gap and no stale badge to give it away. For live
 * telemetry, correct means current.
 *
 * So this is not a queue. It is a staging area that throws away *resolution*
 * instead of *time*:
 *
 *  - Sensor samples arrive as min/max windows (the shape EnvelopeAccumulator
 *    already produces) and land in a tiered ladder: level 0 holds the newest at
 *    full resolution; when a level overflows, its two OLDEST windows merge into
 *    one that is appended to the next level up. A window therefore only ever
 *    merges with a same-resolution neighbour and is never re-merged repeatedly,
 *    which is what keeps old data from collapsing into a single useless span.
 *  - Merging keeps the smaller min and the larger max WITH THEIR ORIGINAL
 *    TIMESTAMPS, so a pressure spike survives any number of compactions at its
 *    true time. Resolution degrades around it; the peak does not move.
 *  - Before each flush, squeeze() compacts until the dump fits a latency budget
 *    derived from the client's measured drain rate. Whatever does not fit is
 *    compacted away rather than delayed, which is what pins lag near the budget
 *    instead of letting it scale with how bad the link is.
 *
 * Only SENSOR_UPDATE data belongs here. Control and event messages
 * (NOTIFICATION, STATE_UPDATE, SESSION_UPDATE, ACTUATOR_UPDATE, ...) must keep
 * going out directly: sensor samples are idempotent and the next supersedes the
 * last, which is what makes them safe to compact, but a state transition or an
 * abort notification is not, and they are low-rate anyway.
 */

import { minMaxToPoints, type EnvelopePoint } from './gui-stream.js';

/** One min/max window over [t0, t1]. Timestamps are the real sample times of
 *  the extremes, not window boundaries — that is what survives merging. */
export interface OutboxWindow {
  t0: number;
  t1: number;
  min: number;
  minTs: number;
  max: number;
  maxTs: number;
}

export interface OutboxSeriesFlush {
  key: string;
  entity: string;
  component: string;
  points: EnvelopePoint[];
}

export interface OutboxConfig {
  /** Windows held per level before the two oldest merge upward. */
  levelCapacity: number;
  /** Number of resolution tiers. Total coverage is
   *  windowMs * levelCapacity * (2^levelCount - 1). */
  levelCount: number;
  /** Serialized cost of one point, used to size squeeze() against a byte
   *  budget. Approximate on purpose — it only has to track reality well enough
   *  to pick a compaction depth. */
  bytesPerPoint: number;
}

export const DEFAULT_OUTBOX_CONFIG: OutboxConfig = {
  levelCapacity: 8,
  levelCount: 10,
  bytesPerPoint: 135,
};

interface Series {
  entity: string;
  component: string;
  /** levels[i] holds windows of resolution (base << i), ordered oldest-first.
   *  Higher levels hold strictly older data than lower ones. */
  levels: OutboxWindow[][];
}

/** Merge two adjacent windows, `a` older than `b`. Extremes keep their own
 *  timestamps; the span widens to cover both. */
export function mergeWindows(a: OutboxWindow, b: OutboxWindow): OutboxWindow {
  const minFrom = a.min <= b.min ? a : b;
  const maxFrom = a.max >= b.max ? a : b;
  return {
    t0: a.t0,
    t1: b.t1,
    min: minFrom.min,
    minTs: minFrom.minTs,
    max: maxFrom.max,
    maxTs: maxFrom.maxTs,
  };
}

export class ClientOutbox {
  private series = new Map<string, Series>();
  private cfg: OutboxConfig;

  /** Points that entered the outbox since the last stats reset — the
   *  denominator for resolutionPct. The client only ever sees the numerator,
   *  which is why this number cannot be computed in the browser. */
  private producedPoints = 0;
  private deliveredPoints = 0;
  private lastSqueezeDropped = false;

  constructor(cfg: Partial<OutboxConfig> = {}) {
    this.cfg = { ...DEFAULT_OUTBOX_CONFIG, ...cfg };
  }

  /**
   * Stage one closed window's points for this client. Points are the envelope's
   * output for a single window (1 or 2 of them, chronological), which is
   * reduced back to a window here so the ladder has something to merge.
   */
  push(key: string, entity: string, component: string, points: EnvelopePoint[]): void {
    if (points.length === 0) return;
    this.producedPoints += points.length;

    let lo = points[0];
    let hi = points[0];
    for (const p of points) {
      if (p.value < lo.value) lo = p;
      if (p.value > hi.value) hi = p;
    }
    this.pushWindow(key, entity, component, {
      t0: points[0].tMs,
      t1: points[points.length - 1].tMs,
      min: lo.value, minTs: lo.tMs,
      max: hi.value, maxTs: hi.tMs,
    });
  }

  private pushWindow(key: string, entity: string, component: string, w: OutboxWindow): void {
    let s = this.series.get(key);
    if (!s) {
      s = {
        entity, component,
        levels: Array.from({ length: this.cfg.levelCount }, () => [] as OutboxWindow[]),
      };
      this.series.set(key, s);
    }
    s.entity = entity;
    s.component = component;
    s.levels[0].push(w);

    // Cascade: a level over capacity merges its two oldest upward. The merged
    // window is older than everything left in this level and newer than
    // everything already in the level above, so it appends.
    const top = this.cfg.levelCount - 1;
    for (let i = 0; i < top; i++) {
      while (s.levels[i].length > this.cfg.levelCapacity) {
        const a = s.levels[i].shift()!;
        const b = s.levels[i].shift()!;
        s.levels[i + 1].push(mergeWindows(a, b));
      }
    }
    // The top level has nowhere to promote to: oldest data finally falls off.
    while (s.levels[top].length > this.cfg.levelCapacity) s.levels[top].shift();
  }

  /** Total windows held across every series. */
  get windowsHeld(): number {
    let n = 0;
    for (const s of this.series.values()) for (const lv of s.levels) n += lv.length;
    return n;
  }

  get seriesCount(): number {
    return this.series.size;
  }

  /** Approximate serialized size of a flush right now. */
  estimatedBytes(): number {
    let points = 0;
    for (const s of this.series.values()) {
      for (const lv of s.levels) {
        for (const w of lv) points += (w.min === w.max && w.minTs === w.maxTs) ? 1 : 2;
      }
    }
    return points * this.cfg.bytesPerPoint;
  }

  /**
   * Compact until a flush fits `budgetBytes`, by promoting pairs up the ladder.
   *
   * Never squeezes a series below one window: a client must always receive
   * something current for every stream, so below roughly one point per key the
   * lag floor is the link's, not ours.
   */
  squeeze(budgetBytes: number): void {
    this.lastSqueezeDropped = false;
    if (this.series.size === 0) return;
    if (this.estimatedBytes() <= budgetBytes) return;

    // Every series is fed at the same rate, so an even per-series allowance is
    // both fair and cheap to compute (no repeated global scans).
    const perSeriesPoints = Math.max(
      1,
      Math.floor(budgetBytes / (this.series.size * this.cfg.bytesPerPoint)),
    );
    const maxWindows = Math.max(1, Math.floor(perSeriesPoints / 2));

    for (const s of this.series.values()) {
      if (this.compactSeriesTo(s, maxWindows)) this.lastSqueezeDropped = true;
    }
  }

  /** Compact until the series holds at most `maxWindows`. Returns true if
   *  anything was merged. */
  private compactSeriesTo(s: Series, maxWindows: number): boolean {
    let merged = false;
    const count = () => s.levels.reduce((n, lv) => n + lv.length, 0);
    const top = this.cfg.levelCount - 1;

    while (count() > Math.max(1, maxWindows)) {
      let did = false;
      // Prefer a same-level merge: it keeps the ladder's shape, so what is left
      // stays fine-grained at the recent end.
      for (let i = 0; i < top; i++) {
        if (s.levels[i].length >= 2) {
          const a = s.levels[i].shift()!;
          const b = s.levels[i].shift()!;
          s.levels[i + 1].push(mergeWindows(a, b));
          did = true;
          break;
        }
      }
      // Every level down to one window and still over budget: merge the two
      // oldest across the level boundary. Squeezing this hard is a deliberate
      // request to shed old detail, so collapsing the tail is the right answer
      // — and it is the only way to reach the true floor of one window.
      if (!did) did = this.mergeOldestPair(s);
      if (!did) break;
      merged = true;
    }
    return merged;
  }

  /** Merge the two oldest windows regardless of level. Oldest-first order is
   *  highest level, then index 0, so the pair is always adjacent in time. */
  private mergeOldestPair(s: Series): boolean {
    const at: Array<{ lv: number; idx: number }> = [];
    for (let i = s.levels.length - 1; i >= 0 && at.length < 2; i--) {
      for (let j = 0; j < s.levels[i].length && at.length < 2; j++) at.push({ lv: i, idx: j });
    }
    if (at.length < 2) return false;
    const [a, b] = at;
    const m = mergeWindows(s.levels[a.lv][a.idx], s.levels[b.lv][b.idx]);
    s.levels[b.lv].splice(b.idx, 1);   // remove the newer of the pair first
    s.levels[a.lv].splice(a.idx, 1, m);
    return true;
  }

  /**
   * Serialize and clear. Emits **oldest first** — highest level down to level 0,
   * oldest-first within each level — because the browser's data cache drops any
   * point older than its ring head (frontend/lib/data-cache.ts). Sending the
   * newest first to go live sooner would make the client reject the history
   * behind it.
   */
  drain(): OutboxSeriesFlush[] {
    const out: OutboxSeriesFlush[] = [];
    for (const [key, s] of this.series) {
      const points: EnvelopePoint[] = [];
      for (let i = s.levels.length - 1; i >= 0; i--) {
        for (const w of s.levels[i]) points.push(...minMaxToPoints(w.min, w.minTs, w.max, w.maxTs));
      }
      if (points.length > 0) {
        out.push({ key, entity: s.entity, component: s.component, points });
        this.deliveredPoints += points.length;
      }
    }
    this.series.clear();
    return out;
  }

  /** Newest sample time held, or null when empty — the basis for lagMs. */
  newestTimestamp(): number | null {
    let newest: number | null = null;
    for (const s of this.series.values()) {
      const lv0 = s.levels[0];
      const w = lv0.length > 0 ? lv0[lv0.length - 1] : null;
      if (w && (newest === null || w.t1 > newest)) newest = w.t1;
    }
    return newest;
  }

  /** Delivered ÷ produced since the last reset, 0..1. Needs the produced count,
   *  which exists only here — the client cannot know what it never received. */
  resolutionRatio(): number {
    if (this.producedPoints === 0) return 1;
    return Math.min(1, this.deliveredPoints / this.producedPoints);
  }

  get squeezeDroppedLast(): boolean {
    return this.lastSqueezeDropped;
  }

  resetStats(): void {
    this.producedPoints = 0;
    this.deliveredPoints = 0;
  }
}

/** Socket queue below this counts as drained. Not a "low water mark": flushing
 *  while the socket still holds a backlog lets that backlog grow without bound,
 *  which is the original bug one layer down. Simulated with a 32 KB mark the
 *  socket queue climbed 42 -> 93 -> 152 KB and kept going. */
export const SOCKET_IDLE_BYTES = 4 * 1024;

/** How far behind a dashboard is ever allowed to run. The single knob: it
 *  states an operational requirement directly, unlike a window count. */
export const DEFAULT_TARGET_LAG_MS = 1500;

/** Beyond this the link is in trouble, not merely throttled. Twice the currency budget,
 *  because the pacer only flushes on a full drain and its own design test allows up to
 *  2x TARGET between flushes — so anything past that is not normal pacing. */
export const STARVED_LAG_MS = DEFAULT_TARGET_LAG_MS * 2;

/**
 * What to tell the operator about one client's link.
 *
 * A pure function on purpose. The status used to be assigned only at the END of a
 * successful flush, after the `shouldFlush` gate and an empty-drain check had both been
 * passed — so a client too backed-up to flush AT ALL kept its optimistic seed
 * (throttled: false, lagMs: 0, resolutionPct: 100) and the badge showed green
 * "Connected — Live data at full resolution". The more starved a client was, the
 * healthier it reported. Deciding from observations instead of from having flushed is
 * what fixes that, and being pure is what makes it testable — a setInterval is not.
 */
export function linkStatus(o: {
  /** Newest sample actually put on this socket, or null if nothing ever has been. */
  lastDeliveredTsMs: number | null;
  nowMs: number;
  resolutionRatio: number;
  squeezeDropped: boolean;
  starvedLagMs?: number;
}): { throttled: boolean; lagMs: number; resolutionPct: number } {
  const starved = o.starvedLagMs ?? STARVED_LAG_MS;
  // Nothing delivered yet is the connect race, not starvation: a client that has just
  // opened has no lag to report and must not be flagged before it has had a chance.
  const lagMs = o.lastDeliveredTsMs === null
    ? 0
    : Math.max(0, o.nowMs - o.lastDeliveredTsMs);
  return {
    lagMs,
    // squeezeDropped catches ordinary throttling; the lag term is the backstop for the
    // client that cannot flush at all and so never sets it.
    throttled: o.squeezeDropped || lagMs > starved,
    resolutionPct: Math.round(Math.min(1, Math.max(0, o.resolutionRatio)) * 100),
  };
}

/**
 * Decides when a client flushes and how big the dump may be.
 *
 * The flush interval is not chosen — it is however long the socket takes to
 * drain the previous dump, which is exactly the client's throughput. That
 * measurement sets the byte budget, so resolution (not currency) absorbs a slow
 * link.
 */
export class FlushPacer {
  private rateBps: number;
  private pendingBytes = 0;
  private pendingSince = 0;

  constructor(
    private readonly targetLagMs = DEFAULT_TARGET_LAG_MS,
    initialRateBps = 1_000_000,
  ) {
    this.rateBps = initialRateBps;
  }

  /** Bytes the next dump may occupy, from the measured drain rate. */
  get budgetBytes(): number {
    return Math.max(1, Math.round(this.rateBps * (this.targetLagMs / 1000)));
  }

  get measuredRateBps(): number {
    return this.rateBps;
  }

  /** True when the socket has finished the last dump and may take another. */
  shouldFlush(bufferedAmount: number, nowMs: number): boolean {
    const idle = bufferedAmount < SOCKET_IDLE_BYTES;
    if (idle && this.pendingBytes > 0) {
      // The dump we handed over has drained: elapsed time over bytes is this
      // client's real throughput, end to end.
      const elapsedMs = Math.max(1, nowMs - this.pendingSince);
      const observed = (this.pendingBytes * 1000) / elapsedMs;
      this.rateBps = 0.7 * this.rateBps + 0.3 * observed;
      this.pendingBytes = 0;
    }
    return idle;
  }

  noteFlush(bytes: number, nowMs: number): void {
    this.pendingBytes = bytes;
    this.pendingSince = nowMs;
  }
}
