import { describe, expect, it } from 'vitest';
import { alignmentShift, SNAP_TOLERANCE } from './snap';

const at = (id: string, xs: number[], ys: number[]) => ({ id, xs, ys });

describe('dropping a symbol lines its ports up', () => {
  it('closes the gap the grid cannot', () => {
    // The reported case, in numbers. A rotary valve is 60 wide so its centre
    // port is 30 from the origin; an engine is 72, so its top port is at 36.
    // Both origins snap to 10, so the ports are always 6 out — at every
    // position, forever.
    const valve = at('ROT', [100 + 30], [200]);
    const engine = at('ENG', [100 + 36], [400]);
    const { dx } = alignmentShift(engine, [valve]);
    expect(dx).toBe(-6);
    expect(engine.xs[0] + dx).toBe(valve.xs[0]);
  });

  it('leaves a symbol alone when its ports already line up', () => {
    const a = at('a', [130], [200]);
    const b = at('b', [130], [400]);
    expect(alignmentShift(b, [a])).toEqual({ dx: 0, dy: 0 });
  });

  it('will not drag something across a deliberate offset', () => {
    // One grid square across is a decision, not a near miss.
    const a = at('a', [130], [200]);
    const b = at('b', [140], [400]);
    expect(alignmentShift(b, [a]).dx).toBe(0);
  });

  it('reaches every pair there can be, from the nearest square', () => {
    // Both origins sit on the ten grid, so whatever two symbols' port offsets
    // are, the nearest square leaves them at most five apart. The tolerance
    // has to cover five and stop short of ten.
    for (let residual = 0; residual <= 5; residual++) {
      const { dx } = alignmentShift(at('m', [100 + residual], [0]), [at('o', [100], [0])]);
      expect(Math.abs(dx), `residual ${residual}`).toBe(residual);
    }
    expect(alignmentShift(at('m', [110], [0]), [at('o', [100], [0])]).dx).toBe(0);
  });

  it('takes the nearest alignment, not the first one found', () => {
    const far = at('far', [137], [0]);
    const near = at('near', [132], [0]);
    const moved = at('m', [134], [0]);
    expect(alignmentShift(moved, [far, near]).dx).toBe(-2);
  });

  it('decides each axis on its own', () => {
    // Lined up vertically with one neighbour, horizontally with another --
    // which is what a real bay looks like.
    const above = at('above', [133], [500]);
    const beside = at('beside', [900], [297]);
    const moved = at('m', [130], [300]);
    expect(alignmentShift(moved, [above, beside])).toEqual({ dx: 3, dy: -3 });
  });

  it('considers every port, not just the first', () => {
    // A tank's second outlet is what lines up, not its first.
    const target = at('t', [220], [0]);
    const tank = at('tank', [180, 200, 223], [0]);
    expect(alignmentShift(tank, [target]).dx).toBe(-3);
  });

  it('does nothing when there is nothing to line up with', () => {
    expect(alignmentShift(at('m', [130], [300]), [])).toEqual({ dx: 0, dy: 0 });
  });

  it('never moves further than the tolerance', () => {
    const moved = at('m', [100], [100]);
    for (let gap = 0; gap <= 30; gap++) {
      const { dx } = alignmentShift(moved, [at('o', [100 + gap], [0])]);
      expect(Math.abs(dx)).toBeLessThan(SNAP_TOLERANCE + 1);
      expect(Math.abs(dx)).toBe(gap <= SNAP_TOLERANCE ? gap : 0);
    }
  });
});
