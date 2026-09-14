import { describe, expect, it } from 'vitest';
import { lineAt } from './lineHit';

describe('the line under a point', () => {
  it('measures against the pipe as drawn, not the straight line between ends', () => {
    // An L: out to the right, then down. Its two ends are (0,0) and (200,200),
    // and the point just below the top run is nowhere near the diagonal
    // between those ends -- which is exactly what the graph-level hit test
    // measures, and exactly what it gets wrong.
    const lines = [{ id: 'e1', d: 'M 0,0 L 200,0 L 200,200' }];
    expect(lineAt(lines, { x: 100, y: 4 })).toMatchObject({ id: 'e1', at: { x: 100, y: 0 } });
    // ...and a point on that diagonal is not on the pipe at all.
    expect(lineAt(lines, { x: 100, y: 100 })).toBeNull();
  });

  it('snaps to the pipe, so a junction lands on it', () => {
    expect(lineAt([{ id: 'e1', d: 'M 0,0 L 200,0' }], { x: 50, y: -9 })?.at)
      .toEqual({ x: 50, y: 0 });
  });

  it('takes the nearest of several', () => {
    const lines = [
      { id: 'near', d: 'M 0,0 L 100,0' },
      { id: 'far',  d: 'M 0,10 L 100,10' },
    ];
    expect(lineAt(lines, { x: 50, y: 3 })?.id).toBe('near');
    expect(lineAt(lines, { x: 50, y: 7 })?.id).toBe('far');
  });

  it('claims nothing beyond the tolerance', () => {
    const lines = [{ id: 'e1', d: 'M 0,0 L 200,0' }];
    expect(lineAt(lines, { x: 100, y: 40 })).toBeNull();
    expect(lineAt(lines, { x: 100, y: 40 }, 60)).toMatchObject({ id: 'e1' });
  });

  it('claims nothing at all when there is nothing drawn', () => {
    expect(lineAt([], { x: 0, y: 0 })).toBeNull();
  });
});
