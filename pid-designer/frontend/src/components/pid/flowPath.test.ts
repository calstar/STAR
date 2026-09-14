import { describe, expect, it } from 'vitest';
import { buildElements, buildWalls, wallPoints } from './flowPath';
import type { LineSegment } from './segments';

const P = (v: number, u = 'mm') => ({ value: v, unit: u, source: 'measured' as const });

const seg = (over: Partial<LineSegment> = {}): LineSegment => ({
  id: 's1', method: 'itemised', bore: P(10), length: P(1, 'm'), fittings: [], ...over,
});

describe('what the picture is made of', () => {
  it('is a bare run of tube when nothing is fitted', () => {
    const els = buildElements([seg()]);
    expect(els).toHaveLength(1);
    expect(els[0].kind).toBe('tube');
    expect(els[0].rStart).toBe(5);
  });

  it('puts tube between the fittings, in the order they are listed', () => {
    const els = buildElements([seg({
      fittings: [{ id: 'a', kind: 'elbow_90', count: 2, lengthMm: 20 }],
    })]);
    // tube, elbow, tube, elbow, tube
    expect(els.map(e => e.kind)).toEqual(['tube', 'fitting', 'tube', 'fitting', 'tube']);
  });

  it('expands a count, so three elbows are three turns', () => {
    const els = buildElements([seg({
      fittings: [{ id: 'a', kind: 'elbow_90', count: 3, lengthMm: 20 }],
    })]);
    expect(els.filter(e => e.turn).length).toBe(3);
  });

  it('draws a bore change between segments as the taper it is', () => {
    const els = buildElements([
      seg({ id: 's1', bore: P(10) }),
      seg({ id: 's2', bore: P(6) }),
    ]);
    const t = els.find(e => e.kind === 'transition')!;
    expect(t.label).toBe('reducer');
    expect(t.rStart).toBe(5);
    expect(t.rEnd).toBe(3);
  });

  it('takes the fittings out of an overall length, but not a tube length', () => {
    const fittings = [{ id: 'a', kind: 'elbow_90' as const, count: 2, lengthMm: 50 }];
    const overall = buildElements([seg({ lengthBasis: 'overall', fittings })]);
    const tube = buildElements([seg({ lengthBasis: 'tube', fittings })]);
    const sum = (els: ReturnType<typeof buildElements>) =>
      els.filter(e => e.kind === 'tube').reduce((n, e) => n + e.length, 0);
    expect(sum(overall)).toBeCloseTo(900, 6);   // 1000 − 2 × 50
    expect(sum(tube)).toBeCloseTo(1000, 6);
  });

  it('marks an assumed length rather than pretending it was stated', () => {
    const els = buildElements([seg({
      fittings: [{ id: 'a', kind: 'tee_run', count: 1 }],   // no lengthMm
    })]);
    expect(els.find(e => e.kind === 'fitting')!.assumed).toBe(true);
  });

  it('draws nothing from a segment whose loss is a measured number', () => {
    // The fittings are not what is being modelled there, so showing them
    // would claim the solve uses them.
    const els = buildElements([seg({
      method: 'measured_K',
      fittings: [{ id: 'a', kind: 'elbow_90', count: 4, lengthMm: 20 }],
    })]);
    expect(els.filter(e => e.kind === 'fitting')).toEqual([]);
  });
});

describe('the centreline', () => {
  it('runs straight when nothing turns', () => {
    const w = buildWalls(buildElements([seg()]));
    expect(w.stations.every(s => Math.abs(s.y) < 1e-9)).toBe(true);
    expect(w.length).toBeCloseTo(1000, 6);
  });

  it('turns through a bend, and by its angle', () => {
    const w = buildWalls(buildElements([seg({
      fittings: [{ id: 'a', kind: 'elbow_90', count: 1, lengthMm: 20 }],
    })]));
    const last = w.stations[w.stations.length - 1];
    expect(Math.abs(Math.abs(last.heading) - Math.PI / 2)).toBeLessThan(1e-6);
  });

  it('alternates the way it turns, so the path cannot spiral onto itself', () => {
    const w = buildWalls(buildElements([seg({
      fittings: [{ id: 'a', kind: 'elbow_90', count: 2, lengthMm: 20 }],
    })]));
    // Two opposite 90° turns come back to the original heading.
    const last = w.stations[w.stations.length - 1];
    expect(Math.abs(last.heading)).toBeLessThan(1e-6);
  });

  it('offsets both walls by the radius, so a reducer looks like one', () => {
    const els = buildElements([seg({ id: 's1', bore: P(10) }), seg({ id: 's2', bore: P(4) })]);
    const w = buildWalls(els);
    const { left, right } = wallPoints(w.stations);
    const width = (i: number) => Math.hypot(left[i][0] - right[i][0], left[i][1] - right[i][1]);
    expect(width(0)).toBeCloseTo(10, 6);
    expect(width(left.length - 1)).toBeCloseTo(4, 6);
  });

  it('survives a segment with nothing filled in', () => {
    const w = buildWalls(buildElements([{ id: 's', fittings: [] }]));
    expect(w.stations.length).toBeGreaterThan(0);
    expect(Number.isFinite(w.length)).toBe(true);
  });
});
