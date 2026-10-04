import { clamp, nearestIndex } from './search';

/**
 * The one time cursor every Burn page reads.
 *
 * A tiny external store (read with `useSyncExternalStore` in React, or subscribed to directly by
 * the charts, which move their cursor layer without a React render). Scrubbing writes are
 * coalesced to one notification per animation frame; playback advances in real time times the
 * speed and stops at the end of the burn.
 */

/** A moment on the timeline. `kind` sets which label survives when two crowd each other. */
export interface TimeEvent {
  t: number;
  key: string;
  label: string;
  /** 't0' | 'lead' | 'fire' | 'ignition' | 'min' | 'dry' | 'burnout' | 'end' | 'warn', or another. */
  kind: string;
}

/** A point someone asked to be shown (a margin bar clicked); `seq` changes on every request. */
export interface TimeFocus {
  t: number;
  key: string;
  seq: number;
}

export interface TimeState {
  /** The cursor [s, burn clock: Fire = 0]. */
  t: number;
  playing: boolean;
  /** Playback rate: 1 is real time. */
  speed: number;
  focus: TimeFocus | null;
  /** The burn's sample times, ascending (shared, never mutated). */
  series: readonly number[];
  /** Sorted by time. */
  events: readonly TimeEvent[];
  /** [first, last] sample time, or null before a run is loaded. */
  range: readonly [number, number] | null;
}

export interface TimeStore {
  get(): TimeState;
  subscribe(fn: () => void): () => void;
  /** Move the cursor (stops playback). Notifies once per animation frame however often called. */
  setT(t: number): void;
  setPlaying(playing: boolean): void;
  togglePlaying(): void;
  /** Start playback unless the person asked for reduced motion. For a page that wants to run on load. */
  autoplay(): void;
  setSpeed(speed: number): void;
  /** Move `n` samples (negative is back). */
  step(n: number): void;
  /** Jump to the next (`1`) or previous (`-1`) event at a different time; null when there is none. */
  nextEvent(dir: 1 | -1): TimeEvent | null;
  /** Jump to `t` and ask every view to flash `key` there. */
  focus(t: number, key: string): void;
  /** T−0 (or the first sample). */
  home(): void;
  /** Burnout (or the last sample). */
  end(): void;
  setSeries(ts: readonly number[]): void;
  setEvents(events: readonly TimeEvent[]): void;
  /** Index into the store's series nearest `t` (default: the cursor); -1 with no series. */
  nearestIndex(t?: number): number;
  /** Publish a pending cursor move now instead of on the next frame. */
  flush(): void;
  /** Stop playback and drop timers; the store is dead afterwards. */
  destroy(): void;
}

/** What the store needs from the browser, injectable so tests run without one. */
export interface TimeClock {
  raf(cb: (ts: number) => void): number;
  caf(id: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  reducedMotion(): boolean;
}

/** The speeds the timeline offers. */
export const SPEEDS = [0.25, 0.5, 1, 2] as const;

/** How long a focus request stays up [ms] (views flash for this long). */
export const FOCUS_MS = 1600;

/** The longest frame playback will integrate [s]: a background tab must not jump the burn. */
const MAX_FRAME_S = 0.1;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function browserClock(): TimeClock {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    raf: (cb) => (w?.requestAnimationFrame ? w.requestAnimationFrame(cb) : (setTimeout(() => cb(Date.now()), 16) as unknown as number)),
    caf: (id) => (w?.cancelAnimationFrame ? w.cancelAnimationFrame(id) : clearTimeout(id)),
    setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
    reducedMotion: () => !!w?.matchMedia?.(REDUCED_MOTION).matches,
  };
}

/** Event kinds that mean T−0 and burnout, for Home and End. */
const T0_KINDS = new Set(['t0']);
const BURNOUT_KINDS = new Set(['burnout']);
const DRY_KINDS = new Set(['end', 'dry']);

export function createTimeStore(opts: { clock?: Partial<TimeClock>; t?: number; speed?: number } = {}): TimeStore {
  const clock: TimeClock = { ...browserClock(), ...opts.clock };
  let state: TimeState = {
    t: opts.t ?? 0,
    playing: false,
    speed: opts.speed ?? 1,
    focus: null,
    series: [],
    events: [],
    range: null,
  };
  const listeners = new Set<() => void>();
  let pending: number | null = null;
  let frame: number | null = null;
  let playFrame: number | null = null;
  let lastTs: number | null = null;
  let focusTimer: number | null = null;
  let seq = 0;
  let dead = false;

  const publish = (patch: Partial<TimeState>) => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };

  const bound = (t: number) => (state.range ? clamp(t, state.range[0], state.range[1]) : t);
  const current = () => pending ?? state.t;

  const flush = () => {
    if (frame !== null) {
      clock.caf(frame);
      frame = null;
    }
    if (pending === null) return;
    const t = pending;
    pending = null;
    if (t !== state.t) publish({ t });
  };

  const stopPlayback = () => {
    if (playFrame !== null) clock.caf(playFrame);
    playFrame = null;
    lastTs = null;
  };

  const tick = (ts: number) => {
    playFrame = null;
    if (dead || !state.playing || !state.range) return;
    const dt = lastTs === null ? 0 : Math.min(Math.max((ts - lastTs) / 1000, 0), MAX_FRAME_S);
    lastTs = ts;
    const end = state.range[1];
    const t = Math.min(state.t + dt * state.speed, end);
    if (t >= end) {
      stopPlayback();
      publish({ t: end, playing: false });
      return;
    }
    if (t !== state.t) publish({ t });
    playFrame = clock.raf(tick);
  };

  const setPlaying = (playing: boolean) => {
    if (dead || playing === state.playing) return;
    if (!playing) {
      stopPlayback();
      flush();
      publish({ playing: false });
      return;
    }
    if (!state.range) return;
    flush();
    // Play at the end starts again from the beginning; looping is off.
    const atEnd = state.t >= state.range[1] - 1e-9;
    stopPlayback();
    publish({ playing: true, ...(atEnd ? { t: state.range[0] } : {}) });
    playFrame = clock.raf(tick);
  };

  const setT = (t: number) => {
    if (dead || !Number.isFinite(t)) return;
    if (state.playing) {
      stopPlayback();
      pending = null;
      if (frame !== null) clock.caf(frame);
      frame = null;
      publish({ t: bound(t), playing: false });
      return;
    }
    pending = bound(t);
    if (frame === null) {
      // A clock may call back synchronously; then there is no frame left to wait for.
      let ran = false;
      const id = clock.raf(() => {
        ran = true;
        frame = null;
        flush();
      });
      if (!ran) frame = id;
    }
  };

  const index = (t: number) => nearestIndex(state.series, t);

  const sortedEvents = (events: readonly TimeEvent[]) =>
    [...events].filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setT,
    setPlaying,
    togglePlaying: () => setPlaying(!state.playing),
    autoplay() {
      if (!clock.reducedMotion()) setPlaying(true);
    },
    setSpeed(speed) {
      if (!(speed > 0) || !Number.isFinite(speed) || speed === state.speed) return;
      publish({ speed });
    },
    step(n) {
      const ts = state.series;
      if (ts.length === 0 || !Number.isFinite(n)) return;
      const i = clamp(index(current()) + Math.trunc(n), 0, ts.length - 1);
      setT(ts[i]);
    },
    nextEvent(dir) {
      const t = current();
      // A jump lands exactly on the event, so "at a different time" needs only rounding slack.
      const span = state.range ? state.range[1] - state.range[0] : 1;
      const eps = 1e-9 * Math.max(1, Math.abs(span));
      const inRange = (e: TimeEvent) => !state.range || (e.t >= state.range[0] - eps && e.t <= state.range[1] + eps);
      const ev = state.events.filter(inRange);
      const hit = dir > 0 ? ev.find((e) => e.t > t + eps) : [...ev].reverse().find((e) => e.t < t - eps);
      if (!hit) return null;
      setT(hit.t);
      return hit;
    },
    focus(t, key) {
      if (dead || !Number.isFinite(t)) return;
      stopPlayback();
      pending = null;
      if (frame !== null) clock.caf(frame);
      frame = null;
      const at = bound(t);
      publish({ t: at, playing: false, focus: { t: at, key, seq: ++seq } });
      // A newer focus replaces the older one's timer, so the older cannot clear it.
      if (focusTimer !== null) clock.clearTimeout(focusTimer);
      focusTimer = clock.setTimeout(() => {
        focusTimer = null;
        if (!dead) publish({ focus: null });
      }, FOCUS_MS);
    },
    home() {
      const e = state.events.find((x) => T0_KINDS.has(x.kind) || x.key === 't0');
      if (e) setT(e.t);
      else if (state.range) setT(state.range[0]);
    },
    end() {
      const burnout = [...state.events].reverse().find((x) => BURNOUT_KINDS.has(x.kind) || x.key === 'burnout');
      const dry = state.events.find((x) => DRY_KINDS.has(x.kind));
      const e = burnout ?? dry;
      if (e) setT(e.t);
      else if (state.range) setT(state.range[1]);
    },
    setSeries(ts) {
      if (dead) return;
      const range: readonly [number, number] | null = ts.length ? [ts[0], ts[ts.length - 1]] : null;
      const t = range ? clamp(current(), range[0], range[1]) : current();
      pending = null;
      if (frame !== null) clock.caf(frame);
      frame = null;
      if (!range && state.playing) stopPlayback();
      publish({ series: ts, range, t, ...(!range ? { playing: false } : {}) });
    },
    setEvents(events) {
      if (dead) return;
      publish({ events: sortedEvents(events) });
    },
    nearestIndex: (t) => index(t ?? current()),
    flush,
    destroy() {
      dead = true;
      stopPlayback();
      if (frame !== null) clock.caf(frame);
      if (focusTimer !== null) clock.clearTimeout(focusTimer);
      frame = null;
      focusTimer = null;
      listeners.clear();
    },
  };
}
