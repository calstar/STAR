import { describe, expect, it } from 'vitest';
import { nearestIndex, valueAt } from './search';
import { createTimeStore, FOCUS_MS, type TimeClock, type TimeEvent } from './store';

/** A clock the test drives: frames run when `frame(ms)` is called, timers when `advance(ms)` is. */
function fakeClock(reduced = false) {
  let id = 0;
  let now = 0;
  const frames = new Map<number, (ts: number) => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const clock: TimeClock = {
    raf: (cb) => {
      frames.set(++id, cb);
      return id;
    },
    caf: (i) => {
      frames.delete(i);
    },
    setTimeout: (cb, ms) => {
      timers.set(++id, { at: now + ms, cb });
      return id;
    },
    clearTimeout: (i) => {
      timers.delete(i);
    },
    reducedMotion: () => reduced,
  };
  return {
    clock,
    pendingFrames: () => frames.size,
    /** Run one animation frame at `now + ms`. */
    frame(ms = 16) {
      now += ms;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(now);
    },
    advance(ms: number) {
      now += ms;
      for (const [k, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(k);
          t.cb();
        }
      }
    },
  };
}

/** 10 ms samples from −1 s to 4 s. */
const TS = Array.from({ length: 501 }, (_, i) => Number((-1 + i * 0.01).toFixed(2)));

const EVENTS: TimeEvent[] = [
  { t: 3.52, key: 'dry_lox', label: 'LOX dry', kind: 'dry' },
  { t: -0.5, key: 'lead', label: 'Fuel lead', kind: 'lead' },
  { t: 0, key: 't0', label: 'T−0', kind: 't0' },
  { t: 0, key: 'fire', label: 'Fire', kind: 'fire' },
  { t: 0.12, key: 'ign', label: 'Ignition', kind: 'ignition' },
  // Keyed unlike its kind, so End is shown to find burnout by kind.
  { t: 3.6, key: 'bo', label: 'Burnout', kind: 'burnout' },
];

function loaded(reduced = false) {
  const c = fakeClock(reduced);
  const store = createTimeStore({ clock: c.clock });
  store.setSeries(TS);
  store.setEvents(EVENTS);
  return { store, c };
}

describe('nearestIndex', () => {
  it('finds the nearest sample, ties to the earlier one, and clamps off the ends', () => {
    const ts = [0, 1, 2, 4];
    expect(nearestIndex(ts, 0)).toBe(0);
    expect(nearestIndex(ts, 0.49)).toBe(0);
    expect(nearestIndex(ts, 0.51)).toBe(1);
    expect(nearestIndex(ts, 0.5)).toBe(0);
    expect(nearestIndex(ts, 2.9)).toBe(2);
    expect(nearestIndex(ts, 3.1)).toBe(3);
    expect(nearestIndex(ts, -5)).toBe(0);
    expect(nearestIndex(ts, 99)).toBe(3);
    expect(nearestIndex([], 1)).toBe(-1);
    expect(nearestIndex(ts, Number.NaN)).toBe(0);
  });

  it('agrees with a linear scan on a long irregular axis', () => {
    const ts: number[] = [];
    let t = -2;
    for (let i = 0; i < 997; i++) ts.push((t += 0.003 + ((i * 7919) % 13) * 0.001));
    for (let k = 0; k < 400; k++) {
      const q = -2.5 + k * 0.05;
      let best = 0;
      for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - q) < Math.abs(ts[best] - q)) best = i;
      expect(nearestIndex(ts, q)).toBe(best);
    }
  });

  it('the store answers for its own series and the cursor by default', () => {
    const { store } = loaded();
    store.focus(1.234, 'x');
    expect(store.nearestIndex()).toBe(223); // −1 + 2.23
    expect(store.nearestIndex(-7)).toBe(0);
  });
});

describe('valueAt', () => {
  it('interpolates, and is null outside the samples or across a gap', () => {
    const ts = [0, 1, 2, 3];
    const v = [0, 10, null, 30];
    expect(valueAt(ts, v, 0.25)).toBeCloseTo(2.5);
    expect(valueAt(ts, v, 1)).toBe(10);
    expect(valueAt(ts, v, 1.5)).toBeNull();
    expect(valueAt(ts, v, -0.1)).toBeNull();
    expect(valueAt(ts, v, 3.1)).toBeNull();
  });
});

describe('setT', () => {
  it('coalesces writes to one notification per frame, holding the latest', () => {
    const { store, c } = loaded();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setT(1);
    store.setT(1.5);
    store.setT(2);
    expect(calls).toBe(0);
    expect(store.get().t).toBe(0);
    c.frame();
    expect(calls).toBe(1);
    expect(store.get().t).toBe(2);
  });

  it('clamps to the series and stops playback', () => {
    const { store, c } = loaded();
    store.setT(99);
    c.frame();
    expect(store.get().t).toBe(4);
    store.setPlaying(true);
    store.setT(1);
    expect(store.get()).toMatchObject({ playing: false, t: 1 });
  });
});

describe('step', () => {
  it('moves by samples from the cursor, clamped to the ends', () => {
    const { store, c } = loaded();
    store.setT(0);
    c.frame();
    store.step(1);
    c.frame();
    expect(store.get().t).toBe(0.01);
    store.step(10);
    c.frame();
    expect(store.get().t).toBe(0.11);
    store.step(-1000);
    c.frame();
    expect(store.get().t).toBe(-1);
    store.step(5000);
    c.frame();
    expect(store.get().t).toBe(4);
  });

  it('accumulates presses that land inside one frame', () => {
    const { store, c } = loaded();
    store.setT(0);
    c.frame();
    store.step(1);
    store.step(1);
    store.step(1);
    c.frame();
    expect(store.get().t).toBe(0.03);
  });

  it('snaps an off-sample cursor to a sample first', () => {
    const { store, c } = loaded();
    store.setT(0.014);
    c.frame();
    store.step(1);
    c.frame();
    expect(store.get().t).toBe(0.02);
  });
});

describe('nextEvent', () => {
  it('walks events in time order, skipping ones at the cursor', () => {
    const { store, c } = loaded();
    store.setT(-1);
    c.frame();
    const seen: string[] = [];
    for (let k = 0; k < 10; k++) {
      const e = store.nextEvent(1);
      c.frame();
      if (!e) break;
      seen.push(e.key);
      expect(store.get().t).toBe(e.t);
    }
    // T−0 and Fire share t = 0: one stop, at the first of them.
    expect(seen).toEqual(['lead', 't0', 'ign', 'dry_lox', 'bo']);
    expect(store.nextEvent(1)).toBeNull();
  });

  it('walks back the same way', () => {
    const { store, c } = loaded();
    store.setT(4);
    c.frame();
    const seen: string[] = [];
    let e;
    while ((e = store.nextEvent(-1))) {
      c.frame();
      seen.push(e.key);
    }
    expect(seen).toEqual(['bo', 'dry_lox', 'ign', 'fire', 'lead']);
  });

  it('home is T−0 and end is burnout', () => {
    const { store, c } = loaded();
    store.home();
    c.frame();
    expect(store.get().t).toBe(0);
    store.end();
    c.frame();
    expect(store.get().t).toBe(3.6);
  });

  it('without a burnout event, end falls back to the first tank dry, then the last sample', () => {
    const { store, c } = loaded();
    store.setEvents(EVENTS.filter((e) => e.kind !== 'burnout'));
    store.end();
    c.frame();
    expect(store.get().t).toBe(3.52);
    store.setEvents([]);
    store.end();
    c.frame();
    expect(store.get().t).toBe(4);
    store.home();
    c.frame();
    expect(store.get().t).toBe(-1);
  });
});

describe('focus', () => {
  it('moves the cursor at once, stamps a new seq each time, and clears itself', () => {
    const { store, c } = loaded();
    store.focus(2.5, 'chug');
    const a = store.get().focus;
    expect(store.get().t).toBe(2.5);
    expect(a).toMatchObject({ t: 2.5, key: 'chug' });
    store.focus(2.5, 'chug');
    const b = store.get().focus;
    expect(b!.seq).toBeGreaterThan(a!.seq);
    c.advance(FOCUS_MS - 1);
    expect(store.get().focus).not.toBeNull();
    c.advance(2);
    expect(store.get().focus).toBeNull();
  });

  it('a newer focus is not cleared by the older one\'s timer', () => {
    const { store, c } = loaded();
    store.focus(1, 'a');
    c.advance(FOCUS_MS - 100);
    store.focus(2, 'b');
    c.advance(200);
    expect(store.get().focus).toMatchObject({ key: 'b' });
  });

  it('clamps into the burn and stops playback', () => {
    const { store } = loaded();
    store.setPlaying(true);
    store.focus(50, 'x');
    expect(store.get()).toMatchObject({ t: 4, playing: false });
  });
});

describe('playback', () => {
  it('runs at real time times the speed and stops at the end', () => {
    const { store, c } = loaded();
    store.setT(3);
    c.frame();
    store.setSpeed(0.5);
    store.setPlaying(true);
    c.frame(0); // the first frame only sets the clock
    c.frame(100);
    expect(store.get().t).toBeCloseTo(3.05, 9);
    for (let k = 0; k < 40; k++) c.frame(100);
    expect(store.get()).toMatchObject({ t: 4, playing: false });
    expect(c.pendingFrames()).toBe(0);
  });

  it('play at the end starts from the beginning', () => {
    const { store, c } = loaded();
    store.setT(4);
    c.frame();
    store.setPlaying(true);
    expect(store.get()).toMatchObject({ t: -1, playing: true });
  });

  it('a long frame (a background tab) is capped', () => {
    const { store, c } = loaded();
    store.setPlaying(true);
    c.frame(0);
    c.frame(5000);
    expect(store.get().t).toBeCloseTo(0.1, 9);
  });

  it('autoplay respects reduced motion; Play still works', () => {
    const r = loaded(true);
    r.store.autoplay();
    expect(r.store.get().playing).toBe(false);
    r.store.setPlaying(true);
    expect(r.store.get().playing).toBe(true);
    const n = loaded(false);
    n.store.autoplay();
    expect(n.store.get().playing).toBe(true);
  });

  it('does nothing without a series', () => {
    const c = fakeClock();
    const store = createTimeStore({ clock: c.clock });
    store.setPlaying(true);
    expect(store.get().playing).toBe(false);
    store.step(3);
    expect(store.nextEvent(1)).toBeNull();
  });
});

describe('setSeries', () => {
  it('keeps the cursor when it is inside the new run and pulls it in when not', () => {
    const { store, c } = loaded();
    store.setT(2);
    c.frame();
    store.setSeries([0, 1, 2, 3]);
    expect(store.get().t).toBe(2);
    store.setSeries([0, 0.5, 1]);
    expect(store.get().t).toBe(1);
    expect(store.get().range).toEqual([0, 1]);
  });
});
