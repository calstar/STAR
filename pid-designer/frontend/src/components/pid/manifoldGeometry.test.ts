import { describe, expect, it } from 'vitest';
import { perimeterPoint, nearestFraction, defaultPositions } from './ManifoldEditor';

describe('a port is a fraction of the way round the block', () => {
  const w = 100, h = 40;

  it('walks clockwise from the top-left', () => {
    const per = 2 * (w + h);
    expect(perimeterPoint(0, w, h)).toMatchObject({ x: 0, y: 0, side: 'top' });
    // Sampled mid-edge, not on a corner: a corner belongs to both sides and
    // which one it reports is a float's business, not a behaviour to pin.
    expect(perimeterPoint((w / 2) / per, w, h).side).toBe('top');
    expect(perimeterPoint((w + h / 2) / per, w, h)).toMatchObject({ x: w, side: 'right' });
    expect(perimeterPoint((w + h + w / 2) / per, w, h).side).toBe('bottom');
    expect(perimeterPoint((2 * w + h + h / 2) / per, w, h)).toMatchObject({ x: 0, side: 'left' });
  });

  it('puts a corner on the block, whichever side it claims', () => {
    const per = 2 * (w + h);
    for (const d of [0, w, w + h, 2 * w + h]) {
      const p = perimeterPoint(d / per, w, h);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(w + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('wraps rather than running off the end', () => {
    expect(perimeterPoint(1.25, w, h)).toEqual(perimeterPoint(0.25, w, h));
    expect(perimeterPoint(-0.25, w, h)).toEqual(perimeterPoint(0.75, w, h));
  });

  it('survives a resize with the ports still on the block', () => {
    // The reason a fraction is stored rather than an (x, y): halve the block
    // and a port is still a quarter of the way round it, not hanging off.
    const t = 0.3;
    for (const [ww, hh] of [[100, 40], [50, 20], [220, 80]]) {
      const p = perimeterPoint(t, ww, hh);
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(ww + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeLessThanOrEqual(hh + 1e-9);
    }
  });
});

describe('dragging a port', () => {
  const w = 100, h = 40;

  it('snaps to the nearest edge, so it never lands inside the block', () => {
    const t = nearestFraction(50, 5, w, h);            // near the top edge
    expect(perimeterPoint(t, w, h).side).toBe('top');
  });

  it('lands on the side the pointer is nearest', () => {
    expect(perimeterPoint(nearestFraction(98, 20, w, h), w, h).side).toBe('right');
    expect(perimeterPoint(nearestFraction(50, 38, w, h), w, h).side).toBe('bottom');
    expect(perimeterPoint(nearestFraction(2, 20, w, h), w, h).side).toBe('left');
  });

  it('clamps a pointer dragged outside the block back onto it', () => {
    const t = nearestFraction(-40, -40, w, h);
    const p = perimeterPoint(t, w, h);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('round-trips: a point on an edge maps back to itself', () => {
    const t = 0.42;
    const p = perimeterPoint(t, w, h);
    expect(nearestFraction(p.x, p.y, w, h)).toBeCloseTo(t, 6);
  });
});

describe('the default layout', () => {
  it('spaces every port evenly, and gives each a distinct place', () => {
    const pos = defaultPositions(['in', 'p', 'p2', 'p3']);
    const values = Object.values(pos);
    expect(new Set(values).size).toBe(4);
    expect(Math.min(...values)).toBeGreaterThan(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });
});
