import { describe, expect, it } from 'vitest';
import { extent, niceRange, tickCount } from './scale';

describe('extent', () => {
  it('skips nulls and non-finite values and includes the extras', () => {
    expect(extent([[3, null, 7, Number.NaN], [5, Infinity]])).toEqual([3, 7]);
    expect(extent([[3, 4]], [10])).toEqual([3, 10]);
    expect(extent([[null, null]])).toBeNull();
    expect(extent([], [2])).toEqual([2, 2]);
  });
});

describe('niceRange', () => {
  it('rounds the ends out to whole ticks', () => {
    const r = niceRange(368, 592, 4);
    expect(r.lo).toBeLessThanOrEqual(368);
    expect(r.hi).toBeGreaterThanOrEqual(592);
    expect(r.ticks[0]).toBe(r.lo);
    expect(r.ticks[r.ticks.length - 1]).toBe(r.hi);
    for (const t of r.ticks) expect(Number.isInteger(t / r.step + 1e-9) || Math.abs(t / r.step - Math.round(t / r.step)) < 1e-6).toBe(true);
    expect(r.digits).toBe(0);
  });

  it('gives a fractional axis the decimals its step needs', () => {
    const r = niceRange(0.12, 0.31, 4);
    expect(r.step).toBeCloseTo(0.05, 12);
    expect(r.digits).toBe(2);
    expect(r.lo).toBeCloseTo(0.1, 12);
    expect(r.hi).toBeCloseTo(0.35, 12);
  });

  it('opens a flat line into a span around it', () => {
    const r = niceRange(500, 500, 4);
    expect(r.lo).toBeLessThan(500);
    expect(r.hi).toBeGreaterThan(500);
    const z = niceRange(0, 0, 4);
    expect(z.lo).toBeLessThan(0);
    expect(z.hi).toBeGreaterThan(0);
  });

  it('honours a pinned end', () => {
    const r = niceRange(12, 47, 4, [0, null]);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThanOrEqual(47);
    expect(r.ticks[0]).toBe(0);
  });

  it('handles reversed and non-finite input without throwing', () => {
    const r = niceRange(10, 2, 4);
    expect(r.lo).toBeLessThanOrEqual(2);
    expect(r.hi).toBeGreaterThanOrEqual(10);
    const n = niceRange(Number.NaN, 5);
    expect(n.hi).toBeGreaterThan(n.lo);
  });
});

describe('niceRange, over many spans', () => {
  it('always starts and ends on a tick, with every tick one step apart', () => {
    const cases: [number, number, number][] = [
      [1.375, 1.405, 2], [368, 592, 4], [0.12, 0.31, 3], [-3.3, 14.2, 5], [16.2, 40, 4], [5420, 6810, 3], [0, 578, 6], [0.0013, 0.0021, 4],
    ];
    for (const [lo, hi, n] of cases) {
      const r = niceRange(lo, hi, n);
      expect(r.ticks[0], `${lo}..${hi}`).toBeCloseTo(r.lo, 9);
      expect(r.ticks[r.ticks.length - 1], `${lo}..${hi}`).toBeCloseTo(r.hi, 9);
      for (let k = 1; k < r.ticks.length; k++) expect(r.ticks[k] - r.ticks[k - 1]).toBeCloseTo(r.step, 9);
      expect(r.lo).toBeLessThanOrEqual(lo);
      expect(r.hi).toBeGreaterThanOrEqual(hi);
    }
  });
});

describe('tickCount', () => {
  it('fits the space, between 2 and 8', () => {
    expect(tickCount(200, 40)).toBe(5);
    expect(tickCount(20, 40)).toBe(2);
    expect(tickCount(2000, 40)).toBe(8);
  });
});
