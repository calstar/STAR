import { describe, expect, it } from 'vitest';
import { crossingsOf, pathWithHops } from './hops';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });

describe('where lines cross', () => {
  const vertical = [P(100, 0), P(100, 200)];
  const horizontal = [P(0, 100), P(200, 100)];

  it('is found on the vertical line, and only there', () => {
    expect(crossingsOf(vertical, [horizontal])).toEqual([P(100, 100)]);
    expect(crossingsOf(horizontal, [vertical])).toEqual([]);
  });

  it('is not a line ending on another, or one running alongside', () => {
    expect(crossingsOf([P(100, 0), P(100, 100)], [horizontal])).toEqual([]);     // ends on it: a tee's business
    expect(crossingsOf([P(100, 0), P(100, 200)], [[P(100, 50), P(100, 150)]])).toEqual([]);
  });

  it('is hopped near the end of the line it crosses, bulging away from that end', () => {
    // Seven pixels from the end of the horizontal line. This used to be left
    // as a plain cross -- any crossing within two radii of any end or corner
    // was -- and a plain cross reads as a joint. The arc only needs room on
    // the side it bulges to, and there are a hundred pixels on the other.
    expect(crossingsOf([P(100, 0), P(100, 200)], [[P(93, 100), P(200, 100)]])).toEqual([P(100, 100)]);
    expect(crossingsOf([P(100, 0), P(100, 200)], [[P(0, 100), P(107, 100)]])).toEqual([{ x: 100, y: 100, bulge: -1 }]);
    // Exactly two radii is room enough.
    expect(crossingsOf([P(100, 0), P(100, 200)], [[P(0, 100), P(110, 100)]])).toEqual([P(100, 100)]);
  });

  it('bulges away from where the hopping line itself turns', () => {
    // The vertical turns right six pixels past the crossing: an arc to the
    // right would sit in the elbow of its own corner and read as a kink.
    expect(crossingsOf([P(100, 0), P(100, 106), P(200, 106)], [horizontal])).toEqual([{ x: 100, y: 100, bulge: -1 }]);
    expect(crossingsOf([P(100, 0), P(100, 106), P(0, 106)], [horizontal])).toEqual([P(100, 100)]);
  });

  it('is made smaller where there is less room than a full hop, not left out', () => {
    // Three pixels from the vertical's end: a three-pixel hop.
    expect(crossingsOf([P(100, 0), P(100, 103)], [horizontal])).toEqual([{ x: 100, y: 100, r: 3 }]);
    // Two crossings six apart on one vertical share the gap between them.
    expect(crossingsOf(vertical, [horizontal, [P(0, 106), P(200, 106)]]))
      .toEqual([{ x: 100, y: 100, r: 3 }, { x: 100, y: 106, r: 3 }]);
    // Under a pixel of room on every side is no room at all.
    expect(crossingsOf([P(100, 0), P(100, 100.5)], [horizontal])).toEqual([]);
  });

  it('is one hop where two lines cross the vertical at the same point', () => {
    // Two runs lying on one another -- a header drawn over itself, two lines
    // meeting end to end -- are crossed once. Counted twice, the two hops
    // shared no room between them and both were left out.
    expect(crossingsOf(vertical, [horizontal, [P(50, 100), P(150, 100)]])).toEqual([P(100, 100)]);
  });

  it('is drawn when its radius reaches exactly to the end of the line hopping', () => {
    // Five pixels of vertical past the crossing is room for a full hop,
    // and the path draws it rather than a plain cross.
    const short = [P(100, 0), P(100, 105)];
    const hops = crossingsOf(short, [horizontal]);
    expect(hops).toEqual([P(100, 100)]);
    expect(pathWithHops(short, hops)).toBe('M 100,0 L 100,95 A 5 5 0 0 1 100,105 L 100,105');
    expect(pathWithHops([P(100, 95), P(100, 200)], [P(100, 100)])).toBe('M 100,95 L 100,95 A 5 5 0 0 1 100,105 L 100,200');
  });

  it('is drawn as a semicircle in the line, bulging the same way both ways up', () => {
    const down = pathWithHops(vertical, [P(100, 100)]);
    const up = pathWithHops([P(100, 200), P(100, 0)], [P(100, 100)]);
    expect(down).toBe('M 100,0 L 100,95 A 5 5 0 0 1 100,105 L 100,200');
    expect(up).toBe('M 100,200 L 100,105 A 5 5 0 0 0 100,95 L 100,0');
  });

  it('is drawn to the side, and at the size, the crossing says', () => {
    expect(pathWithHops(vertical, [{ x: 100, y: 100, bulge: -1 }])).toBe('M 100,0 L 100,95 A 5 5 0 0 0 100,105 L 100,200');
    expect(pathWithHops([P(100, 200), P(100, 0)], [{ x: 100, y: 100, bulge: -1 }])).toBe('M 100,200 L 100,105 A 5 5 0 0 1 100,95 L 100,0');
    expect(pathWithHops(vertical, [{ x: 100, y: 100, r: 3 }])).toBe('M 100,0 L 100,97 A 3 3 0 0 1 100,103 L 100,200');
  });

  it('draws nothing special when there is nothing to hop', () => {
    expect(pathWithHops(horizontal, [])).toBe('M 0,100 L 200,100');
  });
});
