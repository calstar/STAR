import { describe, expect, it } from 'vitest';
import { colormapRGB, luminance } from './colormap';
import { contourSegments } from './contour';
import { cellEdges, contourLevels, fromPx, toPx, xyScales } from './xyScale';
import type { XYData } from './xyTypes';

describe('contourSegments', () => {
  const x = [0, 1, 2, 3];
  const y = [0, 1, 2];
  it('traces a ramp\'s level as a straight line at the right place', () => {
    // z = x: the 1.25 level is the vertical line x = 1.25.
    const z = x.map((xi) => y.map(() => xi));
    const segs = contourSegments(x, y, z, 1.25);
    expect(segs.length).toBe(2);
    for (const [x0, , x1] of segs) {
      expect(x0).toBeCloseTo(1.25, 12);
      expect(x1).toBeCloseTo(1.25, 12);
    }
  });

  it('draws nothing in a cell with a missing corner, or for a level off the field', () => {
    const z = x.map((xi) => y.map((_, j) => (xi === 1 && j === 1 ? null : xi)));
    expect(contourSegments(x, y, z, 1.5).length).toBe(0);
    expect(contourSegments(x, y, x.map((xi) => y.map(() => xi)), 9).length).toBe(0);
  });

  it('splits a saddle into two segments that do not cross', () => {
    const segs = contourSegments([0, 1], [0, 1], [[1, 0], [0, 1]], 0.5);
    expect(segs.length).toBe(2);
  });
});

describe('xyScales', () => {
  const base: XYData = { series: [{ key: 's', label: '', color: '--lx-text', x: [-1, 1], y: [-0.2, 0.2] }], xUnit: '', yUnit: '' };

  it('makes one unit as long on both axes with equalAspect', () => {
    const { x, y } = xyScales({ ...base, equalAspect: true }, 400, 200);
    expect((x.hi - x.lo) / 400).toBeCloseTo((y.hi - y.lo) / 200, 9);
  });

  it('runs a heat layer\'s axes exactly over its cells, and a time axis on the shared rule', () => {
    const heat = { x: [0, 0.5, 1, 1.5, 2], y: [10, 20, 30], z: [[1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]], unit: 'K' };
    const { x, y } = xyScales({ ...base, series: [], heat, timeAxis: 'x', xUnit: 's' }, 600, 200);
    expect([x.lo, x.hi]).toEqual([-0.25, 2.25]);
    expect([y.lo, y.hi]).toEqual([5, 35]);
    expect(x.labels[x.labels.length - 1]).toMatch(/\u00a0s$/);
  });

  it('puts the x name and unit on the last tick and none on y', () => {
    const { x, y } = xyScales({ ...base, xName: 'O/F', yName: 'Pc', yUnit: 'psia' }, 400, 200);
    expect(x.labels[x.labels.length - 1]).toMatch(/\u00a0O\/F$/);
    expect(y.labels.some((l) => l.includes('psia'))).toBe(false);
  });

  it('maps a log axis and back', () => {
    const { x } = xyScales({ ...base, series: [{ key: 's', label: '', color: '', x: [1, 1000], y: [0, 1] }], xLog: true }, 300, 200);
    expect(toPx(x, 10, 0, 300)).toBeCloseTo(100, 6);
    expect(fromPx(x, 200, 0, 300)).toBeCloseTo(100, 6);
    expect(Number.isNaN(toPx(x, 0, 0, 300))).toBe(true);
  });
});

describe('cellEdges and contourLevels', () => {
  it('centres cells on an uneven grid', () => {
    expect(cellEdges([0, 1, 3])).toEqual([-0.5, 0.5, 2, 4]);
  });
  it('picks round levels strictly inside the field', () => {
    const levels = contourLevels({ x: [0, 1], y: [0, 1], z: [[230, 233], [234, 237]], unit: 's', contours: { count: 6 } });
    expect(levels.length).toBeGreaterThan(2);
    for (const v of levels) {
      expect(v).toBeGreaterThan(230);
      expect(v).toBeLessThan(237);
    }
  });
});

describe('colormaps', () => {
  it('run one way in lightness, so order reads without the colourbar', () => {
    for (const name of ['viridis', 'magma'] as const) {
      let last = -1;
      for (let k = 0; k <= 20; k++) {
        const l = luminance(colormapRGB(name, k / 20));
        expect(l, `${name} ${k}`).toBeGreaterThan(last);
        last = l;
      }
    }
  });
  it('clamps and treats NaN as the low end', () => {
    expect(colormapRGB('viridis', -1)).toEqual(colormapRGB('viridis', 0));
    expect(colormapRGB('viridis', 2)).toEqual([0xfd, 0xe7, 0x25]);
    expect(colormapRGB('magma', Number.NaN)).toEqual([0, 0, 4]);
  });
});
