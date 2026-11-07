import { describe, expect, it } from 'vitest';
import { dashPeriod, isFlowing, readingAnchor } from './schematic';

describe('flow animation', () => {
  it('does not animate a line that is not really flowing', () => {
    // A dash creeping along a shut line reads as flow, and on a schematic that
    // is a lie somebody acts on.
    expect(isFlowing(0)).toBe(false);
    expect(isFlowing(1e-6)).toBe(false);
    expect(isFlowing(0.5)).toBe(true);
  });

  it('animates reverse flow too', () => {
    expect(isFlowing(-0.5)).toBe(true);
  });

  it('clamps the dash speed at both ends', () => {
    expect(dashPeriod(1e-9)).toBeLessThanOrEqual(2.0);
    expect(dashPeriod(1e9)).toBeGreaterThanOrEqual(0.25);
    // And is monotone in between: more flow is never a slower dash.
    expect(dashPeriod(2.0)).toBeLessThan(dashPeriod(0.2));
  });
});

describe('where a live reading sits', () => {
  const pt = (labelOffset?: { x: number; y: number }) => ({
    position: { x: 100, y: 200 },
    measured: { width: 60, height: 60 },
    data: labelOffset ? { labelOffset } : {},
  });

  it('sits over the symbol, centred, when the tag is drawn below or beside it', () => {
    expect(readingAnchor(pt())).toEqual({ x: 130, y: 197 });
    expect(readingAnchor(pt({ x: 51, y: 20 }))).toEqual({ x: 130, y: 197 });
  });

  it('sits over the tag when the tag was dragged above the symbol, never on it', () => {
    // LE4 (3)'s FU-PT-R carries its tag at y -19.8: the chip read "F 545 R".
    const at = readingAnchor(pt({ x: -13, y: -19.8 }));
    expect(at.x).toBe(130);
    expect(at.y).toBeCloseTo(200 - 19.8 - 3, 9);
  });
});
