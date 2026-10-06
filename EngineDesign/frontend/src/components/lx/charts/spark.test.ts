import { describe, expect, it } from 'vitest';
import { sparkGeometry } from './spark';

describe('sparkGeometry', () => {
  it('maps the ends of time and value onto the padded box', () => {
    const g = sparkGeometry([0, 1, 2], [10, 20, 30], 104, 24, { pad: 2 });
    expect(g.x(0)).toBe(2);
    expect(g.x(2)).toBe(102);
    expect(g.y(30)).toBe(2);
    expect(g.y(10)).toBe(22);
    expect(g.d).toBe('M2.0 22.0L52.0 12.0L102.0 2.0');
  });

  it('breaks the line at a gap', () => {
    const g = sparkGeometry([0, 1, 2, 3, 4], [1, 2, null, 4, 5], 100, 20);
    expect(g.d.match(/M/g)).toHaveLength(2);
    expect(g.points).toBe(4);
  });

  it('thins 2000 samples to at most four a column and keeps the extremes', () => {
    const t = Array.from({ length: 2000 }, (_, i) => i * 0.002);
    const v = t.map((x, i) => Math.sin(x * 40) * 10 + (i === 1234 ? 50 : 0));
    const g = sparkGeometry(t, v, 96, 24, { pad: 0 });
    expect(g.points).toBeLessThanOrEqual(4 * 97);
    // The spike survives the thinning: some point sits at the top edge.
    expect(g.d).toMatch(/ 0\.0(?:L|M|$)/);
  });

  it('opens a flat line so it sits mid-cell, and widens for an included band', () => {
    const flat = sparkGeometry([0, 1], [5, 5], 100, 20, { pad: 0 });
    expect(flat.y(5)).toBe(10);
    const banded = sparkGeometry([0, 1], [5, 6], 100, 20, { pad: 0, include: [0, 10] });
    expect(banded.y(10)).toBe(0);
    expect(banded.y(0)).toBe(20);
  });
});
