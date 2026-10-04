import { describe, expect, it } from 'vitest';
import { linearTicks, logTicks, timeStep, timeTicks, xTickLabels, spanRange } from './axis';

describe('timeStep', () => {
  it('is the same for every chart over one burn, whatever its width', () => {
    // A 3.7 s burn on a hero chart, a half-width chart and a small multiple.
    const steps = [1100, 520, 330, 260].map((px) => timeStep(3.7, px));
    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).toBe(1);
  });

  it('keeps an axis to seven ticks or fewer, on 1, 2 or 5 × 10ⁿ', () => {
    for (const span of [0.3, 1.2, 2, 3.7, 4.7, 9, 37, 180]) {
      const s = timeStep(span, 2000);
      const ticks = span / s + 1;
      expect(ticks, `${span}`).toBeLessThanOrEqual(7.000001);
      const m = s / 10 ** Math.floor(Math.log10(s) + 1e-9);
      expect([1, 2, 5].some((x) => Math.abs(x - m) < 1e-9), `${span} -> ${s}`).toBe(true);
    }
  });

  it('coarsens only when the chart is too narrow for the span step', () => {
    expect(timeStep(3.7, 120)).toBeGreaterThan(timeStep(3.7, 600));
    // With room for the span step, width changes nothing.
    expect(timeStep(1.2, 300)).toBe(timeStep(1.2, 1500));
  });
});

describe('timeTicks and xTickLabels', () => {
  it('prints one number of decimals across the axis, the unit on the last tick only', () => {
    const t = timeTicks(-0.3, 1.25, 600);
    const labels = xTickLabels(t.ticks, t.digits, 's');
    const decimals = labels.map((l) => (l.replace(/\u00a0s$/, '').split('.')[1] ?? '').length);
    expect(new Set(decimals).size).toBe(1);
    expect(labels[labels.length - 1]).toMatch(/\u00a0s$/);
    expect(labels.slice(0, -1).some((l) => l.includes('s'))).toBe(false);
  });

  it('falls on round values only', () => {
    const t = timeTicks(-0.47, 4.21, 900);
    for (const v of t.ticks) expect(Math.abs(v / t.step - Math.round(v / t.step))).toBeLessThan(1e-9);
    expect(t.ticks[0]).toBeGreaterThanOrEqual(-0.47);
    expect(t.ticks[t.ticks.length - 1]).toBeLessThanOrEqual(4.21);
  });

  it('uses a true minus sign', () => {
    const t = timeTicks(-2, 2, 800);
    expect(xTickLabels(t.ticks, t.digits, 's')[0]).toBe('−2');
  });
});

describe('logTicks', () => {
  it('marks every decade, and 2 and 5 between them when a decade has room', () => {
    expect(logTicks(1, 1000, 200).ticks).toEqual([1, 10, 100, 1000]);
    expect(logTicks(1, 100, 600).ticks).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });

  it('prints the decimals a tick needs and no more', () => {
    expect(logTicks(0.1, 10, 600).labels).toEqual(['0.1', '0.2', '0.5', '1', '2', '5', '10']);
  });

  it('never leaves a short axis with one tick', () => {
    expect(logTicks(12, 40, 100).ticks.length).toBeGreaterThanOrEqual(2);
    expect(logTicks(0, 10, 100).ticks).toEqual([]);
  });
});

describe('linearTicks', () => {
  it('gives the step and its decimals', () => {
    const t = linearTicks(0.1, 0.9, 4);
    expect(t.step).toBeCloseTo(0.2, 12);
    expect(t.digits).toBe(1);
  });
});

describe('spanRange: every time chart on a page spans the page', () => {
  it('widens a firing-only chart to the page span, so its 0 s tick and cursor line up with the rest', () => {
    // Pc exists from Fire (0) to burnout; the page runs from T-0 at -0.45 s.
    expect(spanRange(0, 3.47, [-0.45, 3.47])).toEqual([-0.45, 3.47]);
  });
  it('keeps data that runs past the page span', () => {
    expect(spanRange(-1, 4, [-0.45, 3.47])).toEqual([-1, 4]);
  });
  it('a chart with a cursor of its own spans its data', () => {
    expect(spanRange(0.1, 3.4, null)).toEqual([0.1, 3.4]);
  });
  it('a single point gets half a second either side', () => {
    expect(spanRange(2, 2, null)).toEqual([1.5, 2.5]);
  });
});
