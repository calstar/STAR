import { describe, expect, it } from 'vitest';
import { selectSnapshot } from './hooks';
import { nearestIndex } from './search';
import { createTimeStore, type TimeState } from './store';

const idle = { raf: () => 1, caf: () => {}, reducedMotion: () => false };

describe('selectSnapshot', () => {
  it('keeps the old slice while the selected value is equal, so React does not render', () => {
    const store = createTimeStore({ clock: idle });
    store.setSeries([0, 0.01, 0.02, 0.03]);
    const index = selectSnapshot(store, (s: TimeState) => nearestIndex(s.series, s.t));
    const range = selectSnapshot(store, (s: TimeState) => ({ lo: s.range?.[0], hi: s.range?.[1] }),
                                 (a, b) => a.lo === b.lo && a.hi === b.hi);
    const r0 = range();
    expect(index()).toBe(0);
    store.setT(0.004); // still sample 0
    store.flush();
    expect(index()).toBe(0);
    expect(range()).toBe(r0); // same reference: equal slice
    store.setT(0.021);
    store.flush();
    expect(index()).toBe(2);
    store.setSeries([0, 1]);
    expect(range()).not.toBe(r0);
  });

  it('returns the same value for repeated reads of one state', () => {
    const store = createTimeStore({ clock: idle });
    let calls = 0;
    const get = selectSnapshot(store, (s) => {
      calls++;
      return { t: s.t };
    });
    const a = get();
    expect(get()).toBe(a);
    expect(calls).toBe(1);
  });
});
