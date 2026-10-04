import { describe, expect, it } from 'vitest';
import { followCursor } from './follow';
import { createTimeStore, type TimeClock } from './store';

/** Frames run only when the test says so. */
function frames() {
  let id = 0;
  const due = new Map<number, (ts: number) => void>();
  const clock: Partial<TimeClock> = {
    raf: (cb) => { due.set(++id, cb); return id; },
    caf: (i) => { due.delete(i); },
    reducedMotion: () => true,
  };
  return { clock, run() { const cbs = [...due.values()]; due.clear(); for (const cb of cbs) cb(0); } };
}

describe('followCursor: a view with its own clock moves with the page', () => {
  const page = () => {
    const f = frames();
    const s = createTimeStore({ clock: f.clock });
    s.setSeries([-0.45, 0, 1, 2, 3.47]);
    return { s, f };
  };

  it('starts on the page cursor and follows it', () => {
    const { s: from, f } = page();
    from.setT(1.75);
    from.flush();
    const to = createTimeStore({ clock: f.clock });
    to.setSeries([0, 5, 10, 25]);
    const off = followCursor(from, to);
    expect(to.get().t).toBe(1.75);
    from.setT(3);
    f.run();
    f.run();
    expect(to.get().t).toBe(3);
    off();
    from.setT(2);
    f.run();
    f.run();
    expect(to.get().t).toBe(3);
  });

  it('keeps the view inside its own span (before Fire the climb sits at liftoff)', () => {
    const { s: from, f } = page();
    from.setT(-0.3);
    from.flush();
    const to = createTimeStore({ clock: f.clock });
    to.setSeries([0, 5, 10, 25]);
    followCursor(from, to);
    expect(to.get().t).toBe(0);
  });

  it('a hand scrub of the view holds until the page cursor moves again', () => {
    const { s: from, f } = page();
    from.setT(1);
    from.flush();
    const to = createTimeStore({ clock: f.clock });
    to.setSeries([0, 5, 10, 25]);
    followCursor(from, to);
    to.setT(20);
    to.flush();
    // The page publishes something that is not a cursor move (the playback speed): the view stays.
    let heard = 0;
    from.subscribe(() => { heard++; });
    from.setSpeed(2);
    f.run();
    expect(heard).toBeGreaterThan(0);
    expect(to.get().t).toBe(20);
    from.setT(2);
    f.run();
    f.run();
    expect(to.get().t).toBe(2);
  });

  it('maps the page clock onto the view clock', () => {
    const { s: from, f } = page();
    from.setT(2);
    from.flush();
    const to = createTimeStore({ clock: f.clock });
    to.setSeries([0, 5, 10, 25]);
    followCursor(from, to, (t) => t + 1);
    expect(to.get().t).toBe(3);
  });
});
