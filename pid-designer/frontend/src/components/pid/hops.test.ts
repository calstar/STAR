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
    expect(crossingsOf([P(100, 0), P(100, 200)], [[P(93, 100), P(200, 100)]])).toEqual([]); // too near its end for a hop
  });

  it('is drawn as a semicircle in the line, bulging the same way both ways up', () => {
    const down = pathWithHops(vertical, [P(100, 100)]);
    const up = pathWithHops([P(100, 200), P(100, 0)], [P(100, 100)]);
    expect(down).toBe('M 100,0 L 100,95 A 5 5 0 0 1 100,105 L 100,200');
    expect(up).toBe('M 100,200 L 100,105 A 5 5 0 0 0 100,95 L 100,0');
  });

  it('draws nothing special when there is nothing to hop', () => {
    expect(pathWithHops(horizontal, [])).toBe('M 0,100 L 200,100');
  });
});
