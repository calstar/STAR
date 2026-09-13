import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { routeOrthogonal, facing, isHorizontal, turn, turnPlacement } from './route';

const L = Position.Left, R = Position.Right, T = Position.Top, B = Position.Bottom;

/** The points of a path, so a test can talk about shape rather than string. */
function points(d: string): [number, number][] {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)/g)]
    .map(m => [Number(m[1]), Number(m[2])] as [number, number]);
}

/** Every segment is horizontal or vertical. */
function orthogonal(d: string): boolean {
  const p = points(d);
  for (let i = 0; i < p.length - 1; i++) {
    const dx = Math.abs(p[i][0] - p[i + 1][0]);
    const dy = Math.abs(p[i][1] - p[i + 1][1]);
    if (dx > 1e-6 && dy > 1e-6) return false;
  }
  return true;
}

/** Does the first segment leave `a` the way `a` points? */
function leavesCorrectly(d: string, side: Position): boolean {
  const p = points(d);
  const [x0, y0] = p[0];
  // Skip zero-length openers, which a stub route can produce at a corner.
  const next = p.find(([x, y]) => Math.abs(x - x0) > 1e-6 || Math.abs(y - y0) > 1e-6);
  if (!next) return false;
  const step = isHorizontal(side) ? next[0] - x0 : next[1] - y0;
  // The first move must be along the port's own axis, in its own direction.
  const alongAxis = isHorizontal(side)
    ? Math.abs(next[1] - y0) < 1e-6
    : Math.abs(next[0] - x0) < 1e-6;
  return alongAxis && step * facing(side) > 0;
}

/** Does the last segment arrive at `b` from the side `b` points at? */
function arrivesCorrectly(d: string, side: Position): boolean {
  const p = points(d);
  const [x1, y1] = p[p.length - 1];
  const prev = [...p].reverse().find(
    ([x, y]) => Math.abs(x - x1) > 1e-6 || Math.abs(y - y1) > 1e-6);
  if (!prev) return false;
  const step = isHorizontal(side) ? prev[0] - x1 : prev[1] - y1;
  const alongAxis = isHorizontal(side)
    ? Math.abs(prev[1] - y1) < 1e-6
    : Math.abs(prev[0] - x1) < 1e-6;
  return alongAxis && step * facing(side) > 0;
}

describe('a line leaves a port the way the port points', () => {
  // The bug this module exists for: a right-hand port reaching something below
  // and to the left set off left, back across the symbol it came out of.
  it('does not double back over the symbol it came from', () => {
    const { d } = routeOrthogonal(
      { x: 403, y: 290, side: R },
      { x: 370, y: 417, side: T },
    );
    expect(leavesCorrectly(d, R), d).toBe(true);
    expect(arrivesCorrectly(d, T), d).toBe(true);
    expect(orthogonal(d), d).toBe(true);
    // Specifically: the first move is to the right of 403, not to 370.
    expect(points(d)[1][0]).toBeGreaterThan(403);
  });

  const sides = [L, R, T, B];
  const spots: [number, number][] = [
    [0, 0], [200, 0], [-200, 0], [0, 200], [0, -200],
    [200, 200], [-200, 200], [200, -200], [-200, -200],
    [8, 200], [200, 8], [-8, -200], [30, 30], [-30, 30],
  ];

  it('leaves and arrives correctly from every side, everywhere', () => {
    const bad: string[] = [];
    for (const from of sides) {
      for (const to of sides) {
        for (const [dx, dy] of spots) {
          const a = { x: 400, y: 300, side: from };
          const b = { x: 400 + dx, y: 300 + dy, side: to };
          if (dx === 0 && dy === 0) continue;
          const { d } = routeOrthogonal(a, b);
          if (!orthogonal(d)) bad.push(`not orthogonal ${from}->${to} @${dx},${dy}: ${d}`);
          if (!leavesCorrectly(d, from)) bad.push(`leaves wrong ${from}->${to} @${dx},${dy}: ${d}`);
          if (!arrivesCorrectly(d, to)) bad.push(`arrives wrong ${from}->${to} @${dx},${dy}: ${d}`);
        }
      }
    }
    expect(bad, `${bad.length} bad routes:\n${bad.slice(0, 12).join('\n')}`).toEqual([]);
  });
});

describe('the shapes a run takes', () => {
  it('draws a straight line when both ends point along it', () => {
    // A tank over a regulator: down out of one, up into the other.
    const { d, grip } = routeOrthogonal(
      { x: 300, y: 100, side: B },
      { x: 300, y: 400, side: T },
    );
    expect(points(d)).toEqual([[300, 100], [300, 400]]);
    expect(grip).toBeNull();
  });

  it('straightens a run that is a hair out rather than leaning it', () => {
    // A port three pixels off drew a line leaning over its whole length.
    // Both ends move by half the error and the run is vertical.
    const { d } = routeOrthogonal(
      { x: 300, y: 100, side: B },
      { x: 303, y: 400, side: T },
    );
    expect(points(d)).toEqual([[301.5, 100], [301.5, 400]]);
  });

  it('jogs, rather than averages, a run whose ends are a grid step apart', () => {
    // The reported bug: a valve one square to the side of the tank above it
    // got a run straightened to the average x -- landing on neither port.
    const { d } = routeOrthogonal(
      { x: 300, y: 100, side: B },
      { x: 310, y: 400, side: T },
    );
    const p = points(d);
    expect(p[0]).toEqual([300, 100]);
    expect(p[p.length - 1]).toEqual([310, 400]);
    expect(orthogonal(d), d).toBe(true);
  });

  it('will not straighten a run whose ends point across it', () => {
    // Vertically in line, but both ports face sideways. A straight vertical
    // line would run out through the side of each symbol.
    const { d } = routeOrthogonal(
      { x: 300, y: 100, side: R },
      { x: 300, y: 400, side: R },
    );
    expect(points(d).length).toBeGreaterThan(2);
    expect(leavesCorrectly(d, R), d).toBe(true);
  });

  it('turns one corner when the corner is ahead of both ends', () => {
    const { d, grip } = routeOrthogonal(
      { x: 100, y: 100, side: R },
      { x: 300, y: 300, side: T },
    );
    expect(points(d)).toEqual([[100, 100], [300, 100], [300, 300]]);
    expect(grip).toBeNull();
  });

  it('offers a crossbar between two ports that face each other', () => {
    const { d, grip } = routeOrthogonal(
      { x: 100, y: 100, side: R },
      { x: 300, y: 200, side: L },
    );
    expect(points(d)).toEqual([[100, 100], [200, 100], [200, 200], [300, 200]]);
    expect(grip).toEqual({ x: 200, y: 150 });
  });

  it('moves that crossbar by the stored offset', () => {
    const { d } = routeOrthogonal(
      { x: 100, y: 100, side: R },
      { x: 300, y: 200, side: L },
      40,
    );
    expect(points(d)[1][0]).toBe(240);
  });

  it('pins the crossbar clear of both ends when they point the same way', () => {
    // Two right-hand ports: the crossbar cannot sit between them, so it goes
    // out past the further one -- and there is nothing to drag.
    const { d, grip } = routeOrthogonal(
      { x: 100, y: 100, side: R },
      { x: 300, y: 200, side: R },
    );
    expect(grip).toBeNull();
    expect(points(d)[1][0]).toBeGreaterThan(300);
    expect(leavesCorrectly(d, R), d).toBe(true);
    expect(arrivesCorrectly(d, R), d).toBe(true);
  });

  it('routes around two ports that face away from each other', () => {
    const { d } = routeOrthogonal(
      { x: 300, y: 100, side: L },
      { x: 100, y: 200, side: R },
    );
    expect(leavesCorrectly(d, L), d).toBe(true);
    expect(arrivesCorrectly(d, R), d).toBe(true);
  });
});

describe('a run that has to double back', () => {
  it('goes round the symbol rather than through it', () => {
    // A regulator's dome, and the bottle feeding it sitting underneath. Both
    // ports point up and they are eight pixels apart, so the run must come
    // back down past the regulator -- and it used to do that at the same x,
    // straight through the body it had just left.
    const { d } = routeOrthogonal(
      { x: 510, y: 117, side: T },
      { x: 502, y: 257, side: T },
    );
    const xs = points(d).map(([x]) => x);
    // Every intermediate leg is clear of the two ends, not between them.
    expect(Math.max(...xs)).toBeGreaterThan(540);
    expect(leavesCorrectly(d, T), d).toBe(true);
    expect(arrivesCorrectly(d, T), d).toBe(true);
    expect(orthogonal(d), d).toBe(true);
  });

  it('still takes the short way when there is room between them', () => {
    // Far enough apart that the crossbar sits in open space.
    const { d } = routeOrthogonal(
      { x: 100, y: 100, side: T },
      { x: 400, y: 300, side: T },
    );
    expect(points(d).length).toBeLessThanOrEqual(4);
  });
});

describe('turning a symbol turns which way its ports face', () => {
  it('steps a quarter turn clockwise', () => {
    expect(turn(L, 90)).toBe(T);
    expect(turn(T, 90)).toBe(R);
    expect(turn(R, 90)).toBe(B);
    expect(turn(B, 90)).toBe(L);
  });

  it('leaves an unturned symbol alone', () => {
    for (const s of [L, R, T, B]) expect(turn(s, 0)).toBe(s);
  });

  it('comes back round after four', () => {
    for (const s of [L, R, T, B]) {
      expect(turn(s, 360)).toBe(s);
      expect(turn(turn(s, 180), 180)).toBe(s);
      expect(turn(s, 270)).toBe(turn(s, -90));
    }
  });

  it('is what makes a turned valve route straight', () => {
    // A tank above a valve turned ninety degrees. The valve's inlet is drawn
    // on its left and now sits on top, so the run is a plain vertical drop --
    // and used to be a hook, because the port still claimed to face left.
    const inlet = turn(L, 90);
    expect(inlet).toBe(T);
    const { d } = routeOrthogonal(
      { x: 300, y: 100, side: B },
      { x: 300, y: 260, side: inlet },
    );
    expect(points(d)).toEqual([[300, 100], [300, 260]]);
  });
});

describe('where a port sits after the symbol is turned', () => {
  // An engine: 72 across, 120 tall, fuel inlet 18 down its left edge.
  const W = 72, H = 120;

  it('leaves an unturned symbol alone', () => {
    expect(turnPlacement(L, 18, W, H, 0)).toEqual({ side: L, along: 18 });
  });

  it('reverses the direction where a quarter turn reverses the edge', () => {
    // The left edge's top end becomes the top edge's right end, so a port 18
    // down the left is 18 in from the right of a box that is now 120 wide.
    expect(turnPlacement(L, 18, W, H, 90)).toEqual({ side: T, along: H - 18 });
  });

  it('keeps the direction where the turn preserves it', () => {
    expect(turnPlacement(T, 20, W, H, 90)).toEqual({ side: R, along: 20 });
  });

  it('puts a port back where it started after four turns', () => {
    for (const side of [L, R, T, B]) {
      expect(turnPlacement(side, 25, W, H, 360)).toEqual({ side, along: 25 });
    }
  });

  it('keeps a port on the box it belongs to', () => {
    // Whatever the turn, the offset is inside the turned box's own extent.
    for (const rotation of [0, 90, 180, 270]) {
      const quarter = rotation % 180 === 90;
      const [bw, bh] = quarter ? [H, W] : [W, H];
      for (const side of [L, R, T, B]) {
        for (const along of [0, 18, 40]) {
          const out = turnPlacement(side, along, W, H, rotation);
          const extent = out.side === T || out.side === B ? bw : bh;
          expect(out.along, `${side}@${along} r${rotation}`).toBeGreaterThanOrEqual(0);
          expect(out.along, `${side}@${along} r${rotation}`).toBeLessThanOrEqual(extent);
        }
      }
    }
  });
});
