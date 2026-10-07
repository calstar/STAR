import { describe, expect, it } from 'vitest';
import {
  axisWidth,
  decadeSplits,
  fmtLogTick,
  fmtReading,
  fmtTick,
  logRange,
} from '../components/DaqPlot';

/** Ticks from lo to hi by incr, the way uPlot lays a linear axis. */
const ticks = (lo: number, hi: number, incr: number): number[] => {
  const out: number[] = [];
  for (let v = lo; v <= hi + incr * 1e-6; v += incr) out.push(Number(v.toPrecision(12)));
  return out;
};

describe('linear ticks are told apart', () => {
  // Axes these panels and the console actually draw.
  const cases: [string, number, number, number][] = [
    ['mass balance, kg', 0, 0.06, 0.005],
    ['mass balance at 0.025 kg steps', 0, 0.075, 0.025],
    ['guard energy at 2.5 kJ steps', 0, 20000, 2500],
    ['a flat mass error', 0.035, 0.037, 0.0005],
    ['iterations', 0, 10, 2.5],
    ['bottle psig', 0, 4500, 500],
    ['tank psig near lockup', 380, 420, 10],
    ['O/F', 1, 2, 0.25],
    ['guard energy, small', -2e-12, 1e-12, 5e-13],
    ['an all-zero panel', 0, 1e-9, 2e-10],
    ['guard energy, J', 0, 12000, 2000],
  ];
  for (const [name, lo, hi, incr] of cases) {
    it(`${name}: every tick distinct, none reads 0.00`, () => {
      const labels = ticks(lo, hi, incr).map((v) => fmtTick(v, incr));
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels).not.toContain('0.00');
      for (const l of labels) expect(l.length).toBeLessThanOrEqual(9);
    });
  }

  it('reads zero as 0, whatever the spacing', () => {
    expect(fmtTick(0, 5e-13)).toBe('0');
    expect(fmtTick(1e-30, 0.5)).toBe('0');
  });
});

describe('log axes', () => {
  it('puts whole decades on a wide axis, never a wall of lines', () => {
    const splits = decadeSplits(1e-16, 1e-4);
    expect(splits.length).toBeLessThanOrEqual(7);
    for (const v of splits) expect(Math.log10(v)).toBeCloseTo(Math.round(Math.log10(v)), 9);
  });

  it('labels a narrow axis more than once, all distinct', () => {
    const splits = decadeSplits(1e-5, 1e-4);
    expect(splits.length).toBeGreaterThanOrEqual(3);
    const labels = splits.map(fmtLogTick);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('prints 1, 10, 100 plainly and tiny values as exponents', () => {
    expect([1, 10, 100].map(fmtLogTick)).toEqual(['1', '10', '100']);
    expect(fmtLogTick(1e-9)).toBe('1e−9');
    expect(fmtLogTick(5e-5)).toBe('5e−5');
    expect(fmtLogTick(1000)).toBe('1000');
    expect(fmtLogTick(10000)).toBe('1e4');
  });

  it('has no range for a series with nothing above zero', () => {
    expect(logRange([[0, 0, 0], [-1, 0]])).toBeNull();
  });

  it('spans whole decades around the positive samples, at least one', () => {
    expect(logRange([[0, 2e-6, 7e-5]])).toEqual([1e-6, 1e-4]);
    const [lo, hi] = logRange([[1e-5, 1e-5]])!;
    expect(hi / lo).toBeCloseTo(10);
  });
});

describe('readings under the cursor', () => {
  it('keep their significant figures', () => {
    expect(fmtReading(6.34e-5)).toBe('6.34e−5');
    expect(fmtReading(1640.12)).toBe('1,640');
    expect(fmtReading(7246.4)).toBe('7,246');
    expect(fmtReading(0.0366)).toBe('0.0366');
    expect(fmtReading(1.7612)).toBe('1.761');
    expect(fmtReading(0)).toBe('0');
  });
});

describe('the y axis fits its labels', () => {
  it('widens for a long label and never shrinks below a floor', () => {
    expect(axisWidth(['−1.8e−12'])).toBeGreaterThanOrEqual(8 * 7);
    expect(axisWidth(['0'])).toBe(44);
  });
});

describe('exponent labels', () => {
  it('drop zero mantissa digits so neighbours look alike', () => {
    expect(fmtTick(1e-9, 5e-10)).toBe('1e−9');
    expect(fmtTick(5e-10, 5e-10)).toBe('5e−10');
    expect(fmtTick(1.5e-9, 5e-10)).toBe('1.5e−9');
  });
});

describe('decimals come from the step', () => {
  it('prints a 0.025 step exactly, not rounded to 0.03', () => {
    expect([0, 0.025, 0.05].map((v) => fmtTick(v, 0.025))).toEqual(['0', '0.025', '0.050']);
  });
});

import { niceRange } from '../components/DaqPlot';

describe('linear axis ends', () => {
  it('sit on whole ticks above the data, so the top is labelled', () => {
    const [lo, hi] = niceRange(0, 0.0199);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0.0199);
    expect(Math.abs(hi / 0.005 - Math.round(hi / 0.005))).toBeLessThan(1e-9);
  });

  it('keeps a pressure plot on round numbers', () => {
    expect(niceRange(0, 578)).toEqual([0, 600]);
    expect(niceRange(0, 4500)[1]).toBeGreaterThan(4500);
  });

  it('never returns an empty range', () => {
    const [a, b] = niceRange(0, 0);
    expect(b).toBeGreaterThan(a);
  });
});
