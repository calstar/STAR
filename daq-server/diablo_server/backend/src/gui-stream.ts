/**
 * GUI stream downsampling — bounds the per-stream rate of SENSOR_UPDATE
 * messages sent to browser clients.
 *
 * Two modes, selected by config.toml [gui].downsample_mode:
 *  - "throttle": legacy behavior — first sample per BROADCAST_MIN_MS window
 *    is broadcast, the rest are dropped. Kept intact as the revert path.
 *  - "envelope": per-key min/max envelope — each window emits the extreme
 *    samples with their real timestamps, so short transients (ignition
 *    spikes, valve slam) survive downsampling instead of vanishing between
 *    throttle slots.
 *
 * Pure module (no server/socket imports) so it is unit-testable without the
 * stack. server.ts owns wiring: sample sanitation, broadcast, history.
 */

export type DownsampleMode = 'envelope' | 'throttle';

export interface GuiStreamConfig {
  mode: DownsampleMode;
  /** Target broadcast budget per stream. Envelope mode emits up to 2 points
   *  per window, so windows/sec = pointsPerSecond / 2. */
  pointsPerSecond: number;
}

export const DEFAULT_GUI_STREAM_CONFIG: GuiStreamConfig = {
  mode: 'envelope',
  pointsPerSecond: 20,
};

/** Parse the [gui] section of config.toml (already TOML-parsed). Unknown or
 *  invalid values fall back to defaults so a bad config edit cannot take the
 *  stream down. */
export function parseGuiStreamConfig(config: unknown): GuiStreamConfig {
  const gui = (config as { gui?: Record<string, unknown> } | null | undefined)?.gui;
  const out = { ...DEFAULT_GUI_STREAM_CONFIG };
  if (!gui || typeof gui !== 'object') return out;

  const mode = gui.downsample_mode;
  if (mode === 'envelope' || mode === 'throttle') out.mode = mode;

  const pps = Number(gui.points_per_second);
  if (Number.isFinite(pps) && pps >= 2 && pps <= 1000) out.pointsPerSecond = pps;

  return out;
}

export function envelopeWindowMs(cfg: GuiStreamConfig): number {
  // pointsPerSecond / 2 windows per second → window length in ms.
  return 2000 / cfg.pointsPerSecond;
}

export interface EnvelopePoint {
  tMs: number;
  value: number;
}

export interface FlushedSeries {
  key: string;
  entity: string;
  component: string;
  points: EnvelopePoint[];
}

interface KeyWindow {
  entity: string;
  component: string;
  startMs: number;
  min: number;
  minTs: number;
  max: number;
  maxTs: number;
  count: number;
}

/**
 * Per-key min/max window accumulator.
 *
 * Windows are anchored at the first sample after the previous emission, so no
 * global clock alignment is needed. Emission happens either when a sample
 * arrives past the window end (add() returns the closed window's points) or
 * via flushOlderThan() on a timer, so trickling/stopping streams do not hold
 * their last window hostage.
 */
export class EnvelopeAccumulator {
  private windows = new Map<string, KeyWindow>();

  constructor(private windowMs: number) {}

  /** Change window length (config reload). Existing windows keep their start;
   *  they will close under the new length on the next add/flush. */
  setWindowMs(windowMs: number): void {
    this.windowMs = windowMs;
  }

  getWindowMs(): number {
    return this.windowMs;
  }

  /**
   * Feed one sample. Returns the points to broadcast now: empty while the
   * current window is still accumulating, or the closed window's min/max when
   * this sample starts a new window.
   */
  add(key: string, entity: string, component: string, tMs: number, value: number): EnvelopePoint[] {
    const w = this.windows.get(key);
    if (!w) {
      this.windows.set(key, {
        entity, component,
        startMs: tMs,
        min: value, minTs: tMs,
        max: value, maxTs: tMs,
        count: 1,
      });
      return [];
    }

    if (tMs < w.startMs + this.windowMs) {
      // Accumulate into the open window. <=/>= so a later equal extreme keeps
      // the earliest timestamp (stable ordering).
      if (value < w.min) { w.min = value; w.minTs = tMs; }
      if (value > w.max) { w.max = value; w.maxTs = tMs; }
      w.count++;
      return [];
    }

    // Sample belongs to a new window — close the old one and start fresh.
    const out = emitWindow(w);
    this.windows.set(key, {
      entity, component,
      startMs: tMs,
      min: value, minTs: tMs,
      max: value, maxTs: tMs,
      count: 1,
    });
    return out;
  }

  /**
   * Close and emit every window that has been open longer than windowMs (plus
   * a small grace so we don't race a sample in flight). Call from a timer with
   * the backend's wall clock; sample timestamps are sanitized to the same
   * clock upstream.
   */
  flushOlderThan(nowMs: number, graceMs = 50): FlushedSeries[] {
    const out: FlushedSeries[] = [];
    for (const [key, w] of this.windows) {
      if (nowMs - w.startMs >= this.windowMs + graceMs) {
        out.push({ key, entity: w.entity, component: w.component, points: emitWindow(w) });
        this.windows.delete(key);
      }
    }
    return out;
  }

  /** Number of currently open windows (diagnostics/tests). */
  get openWindowCount(): number {
    return this.windows.size;
  }
}

/** Min/max of a closed window as chronologically ordered points.
 *  Single distinct sample → one point. If min and max share the same
 *  millisecond but differ in value, the second point is nudged +1 ms so
 *  same-timestamp dedupe layers (history ring, client cache) keep both. */
function emitWindow(w: KeyWindow): EnvelopePoint[] {
  if (w.count === 1 || (w.min === w.max && w.minTs === w.maxTs)) {
    return [{ tMs: w.minTs, value: w.min }];
  }
  const first: EnvelopePoint = w.minTs <= w.maxTs
    ? { tMs: w.minTs, value: w.min }
    : { tMs: w.maxTs, value: w.max };
  const second: EnvelopePoint = w.minTs <= w.maxTs
    ? { tMs: w.maxTs, value: w.max }
    : { tMs: w.minTs, value: w.min };
  if (second.tMs === first.tMs) second.tMs = first.tMs + 1;
  return [first, second];
}
