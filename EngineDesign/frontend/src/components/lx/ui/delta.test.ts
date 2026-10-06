import { describe, expect, it } from 'vitest';
import { delta, deltaText } from './delta';

const N = '\u00a0';

describe('delta', () => {
  it('is nothing when either side is missing', () => {
    expect(delta(null, 1, 2)).toBeNull();
    expect(delta(1, undefined, 2)).toBeNull();
    expect(delta(NaN, 1, 2)).toBeNull();
    expect(deltaText(null, { digits: 2 })).toBeNull();
  });

  it('reads a burn time change in the figure\'s own digits, with a true minus', () => {
    expect(deltaText(delta(3.66, 3.55, 2), { digits: 2, unit: 's' })).toBe(`+0.11${N}s`);
    expect(deltaText(delta(6604, 6804, 0), { digits: 0, unit: 'N', mode: 'pct' })).toBe(`\u22122.9${N}%`);
    expect(deltaText(delta(6816, 6804, 0), { digits: 0, unit: 'N', mode: 'both' })).toBe(`+12${N}N (+0.2${N}%)`);
  });

  it('calls a change under the last digit and 0.05 % "same"', () => {
    expect(deltaText(delta(3.551, 3.550, 2), { digits: 2 })).toBe('same');
    // Under the last digit but 0.056 %: not the same number, so the percent says how much.
    expect(deltaText(delta(3.551, 3.549, 2), { digits: 2 })).toBe('+0.1\u00a0%');
    expect(delta(3.56, 3.55, 2)?.same).toBe(false);
  });

  it('has no percent against a zero reference, and falls back to the absolute change', () => {
    const d = delta(2, 0, 0);
    expect(d?.pct).toBeNull();
    expect(deltaText(d, { digits: 0, mode: 'pct' })).toBe('+2');
  });

  it('a change that rounds to zero carries no sign', () => {
    expect(deltaText(delta(100.0004, 100, 2), { digits: 2, mode: 'abs' })).toBe('same');
    expect(deltaText({ diff: -0.001, pct: null, same: false }, { digits: 2 })).toBe('0.00');
  });
});
