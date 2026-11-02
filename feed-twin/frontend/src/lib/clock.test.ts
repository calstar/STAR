import { describe, expect, it } from 'vitest';
import { holdOn, unionTimes } from './clock';

describe('two runs on one clock', () => {
  // The base run burned 3.9 s; the droop run 4.4 s and was picked second.
  const a = { t: [-0.002, 1, 2, 3, 4.001], v: [0, 900, 880, 860, 0] };
  const b = { t: [-0.001, 1.5, 3, 4.4, 4.6], v: [0, 950, 900, 850, 0] };

  it('covers both runs\' spans, whichever is picked first', () => {
    for (const [first, second] of [
      [a, b],
      [b, a],
    ]) {
      const t = unionTimes([first.t, second.t]);
      expect(t[0]).toBe(-0.002);
      expect(t[t.length - 1]).toBe(4.6);
      expect(t).toEqual([...t].sort((x, y) => x - y));
      expect(new Set(t).size).toBe(t.length);
    }
  });

  it('draws the longer run\'s burnout, and a gap past the shorter run\'s end', () => {
    const t = unionTimes([a.t, b.t]);
    const onB = holdOn(t, b.t, b.v);
    const onA = holdOn(t, a.t, a.v);
    expect(onB[t.indexOf(4.4)]).toBe(850);
    expect(onB[t.indexOf(4.6)]).toBe(0);
    expect(onA[t.indexOf(4.4)]).toBeNaN();
    // Each run reads its own samples exactly, and holds between them.
    expect(a.t.map((x) => onA[t.indexOf(x)])).toEqual(a.v);
    expect(onB[t.indexOf(2)]).toBe(950);
    // Before its first sample a run is a gap, not its first value.
    expect(onB[0]).toBeNaN();
  });
});
