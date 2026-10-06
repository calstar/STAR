import { describe, expect, it } from 'vitest';
import { CONTOUR_FRAME, contourLayout, niceStep } from './contourScale';

// The 6500 N contour: face at -154.4 mm, exit at +90.1 mm, bore radius 63.5 mm.
const X0 = -154.4, X1 = 90.1, R = 63.5;
const F = CONTOUR_FRAME;

function pxPerUnit(l: ReturnType<typeof contourLayout>) {
  return {
    x: l.plotW / (l.xDomain[1] - l.xDomain[0]),
    y: l.plotH / (l.yDomain[1] - l.yDomain[0]),
  };
}

describe('contourLayout', () => {
  it.each([400, 866, 1200, 1800])('is true scale at %i px wide', (w) => {
    for (const full of [true, false]) {
      const l = contourLayout(X0, X1, R, full, w);
      const s = pxPerUnit(l);
      expect(s.x).toBeCloseTo(l.scale, 9);
      expect(s.y).toBeCloseTo(l.scale, 9);
    }
  });

  it('spaces the ticks the same number of pixels on both axes', () => {
    const l = contourLayout(X0, X1, R, true, 1200);
    const dx = (l.xTicks[1] - l.xTicks[0]) * l.scale;
    const dy = (l.yTicks[1] - l.yTicks[0]) * l.scale;
    expect(dx).toBeCloseTo(dy, 9);
    expect(dx).toBeGreaterThanOrEqual(60);
  });

  it('always fills the width; a short, wide part sits centred with the height capped', () => {
    const l = contourLayout(0, 154, 82.5, true, 1200);     // the 6500 N chamber over its sleeve
    expect(l.width).toBe(1200);
    expect(l.plotW).toBe(1200 - F.left - F.right - F.yAxis);
    expect(l.plotH).toBeLessThanOrEqual(300);
    expect(0.5 * (l.xDomain[0] + l.xDomain[1])).toBeCloseTo(77, 9);
    expect(l.xDomain[1] - l.xDomain[0]).toBeGreaterThan(154);
    const long = contourLayout(-154, 90, 63.5, false, 1200);   // a long part sets the scale by its length
    expect(long.plotH).toBeLessThan(300);
    expect(long.xDomain[1] - long.xDomain[0]).toBeCloseTo(244 * 1.06, 6);
  });

  it('keeps the whole contour in view', () => {
    const l = contourLayout(X0, X1, R, true, 866);
    expect(l.xDomain[0]).toBeLessThan(X0);
    expect(l.xDomain[1]).toBeGreaterThan(X1);
    expect(l.yDomain[1]).toBeGreaterThan(R);
    expect(l.yDomain[0]).toBeLessThan(-R);
    expect(contourLayout(X0, X1, R, false, 866).yDomain[0]).toBe(0);
  });

  it('picks 1-2-5 steps', () => {
    expect([niceStep(0.3), niceStep(24.4), niceStep(7), niceStep(51)]).toEqual([0.5, 50, 10, 100]);
  });
});
