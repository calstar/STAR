import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { gridAlong, pathPoints, polylineLength, routeCost, routeOrthogonal, routeThrough, facing, isHorizontal, turn, turnPlacement } from './route';
import type { Box, End, Pt } from './route';
import { routeAuto } from './routeGrid';

/**
 * A sweep runs thousands of routes: well inside a test's usual five seconds
 * alone, but not always on a machine busy with other work.
 */
const SWEEP_MS = 30_000;

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
          // Ports facing each other with their anchors level have legs of no
          // length: the run goes straight across between them, under the
          // handles (see 'joins ports facing each other...' below). This
          // used to be a loop out of both ports and back; that rule changed
          // on purpose, so those pairs are not held to leaving along a leg.
          if (legsHidden(a, b)) continue;
          if (!leavesCorrectly(d, from)) bad.push(`leaves wrong ${from}->${to} @${dx},${dy}: ${d}`);
          if (!arrivesCorrectly(d, to)) bad.push(`arrives wrong ${from}->${to} @${dx},${dy}: ${d}`);
        }
      }
    }
    expect(bad, `${bad.length} bad routes:\n${bad.slice(0, 12).join('\n')}`).toEqual([]);
  });
});

/**
 * Two ports facing each other whose anchors are level, or overlap by less
 * than the three pixels each handle hides: the legs out of them run under
 * the handles. Level means level to the half pixel the router treats as one
 * coordinate.
 */
function legsHidden(a: End, b: End): boolean {
  if (isHorizontal(a.side) !== isHorizontal(b.side) || facing(a.side) !== -facing(b.side)) return false;
  const gap = (isHorizontal(a.side) ? b.x - a.x : b.y - a.y) * facing(a.side);
  return gap > -6 && gap < 0.5;
}

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

// ── Shapes decided by how much room there is ────────────────────────────────

const P = (x: number, y: number): Pt => ({ x, y });
const pts = (d: string): Pt[] => pathPoints(d);
const corners = (d: string) => Math.max(0, pathPoints(d).length - 2);
/** What an end on a tee carries: `J_END` in junctions.ts. */
const TEE = { clear: 14, stub: 6 };

/** Does a drawn run pass through the inside of a box (its edge, and a pixel in, excepted)? */
function through(run: Pt[], b: Box, inset = 1): boolean {
  const x0 = b.x + inset, x1 = b.x + b.w - inset, y0 = b.y + inset, y1 = b.y + b.h - inset;
  for (let i = 0; i + 1 < run.length; i++) {
    const p = run[i], q = run[i + 1];
    if (p.y === q.y && p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1) return true;
    if (p.x === q.x && p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1) return true;
  }
  return false;
}

describe('ports facing each other with little or no room between them', () => {
  it('joins them by a Z whose legs share the gap, not by a loop', () => {
    // Twenty apart and forty out of line: less room than two stubs. The old
    // rule sent this out of both ports and round, in a loop whose return leg
    // crossed its own first stub.
    const r = routeOrthogonal({ x: 0, y: 0, side: R }, { x: 20, y: 40, side: L });
    expect(pts(r.d)).toEqual([P(0, 0), P(10, 0), P(10, 40), P(20, 40)]);
    expect(r.grip).toBeNull();
  });

  it('offers the crossbar to drag only when a stub fits either side of it', () => {
    expect(routeOrthogonal({ x: 0, y: 0, side: R }, { x: 32, y: 40, side: L }).grip).toBeNull();
    expect(routeOrthogonal({ x: 0, y: 0, side: R }, { x: 40, y: 40, side: L }).grip).toEqual(P(20, 20));
  });

  it('never leaves a spur where the two stubs end level', () => {
    // Down out of one and up into the other, thirty-two apart: the stubs
    // meet. The old rule went round, out past the second end and back
    // along its own line.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: B }, { x: 60, y: 32, side: T }).d))
      .toEqual([P(0, 0), P(0, 16), P(60, 16), P(60, 32)]);
  });

  it('joins ports facing each other whose anchors are level, or overlap by less than their insets', () => {
    // A tee on a header and a tank lid ten pixels under the header: the
    // tee's anchor is a pixel below the lid's. Each end hides three pixels
    // of leg, so the crossbar runs between the two at the midpoint.
    const tee: End = { x: 330, y: 108, side: B, ...TEE };
    const lid: End = { x: 280, y: 107, side: T };
    expect(pts(routeOrthogonal(tee, lid).d)).toEqual([P(330, 108), P(330, 107.5), P(280, 107.5), P(280, 107)]);
    // Two symbols side by side, their facing ports level: the six-pixel
    // channel between the bodies is the whole route.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: R }, { x: 0, y: 40, side: L }).d)).toEqual([P(0, 0), P(0, 40)]);
  });

  it('joins ends level both ways by the short line between them, never a single point', () => {
    // Two handles on top of each other, facing: lined up at one coordinate,
    // the two ends were one point, a path of one point draws nothing, and a
    // connection nobody can see cannot be pressed either.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: R }, { x: 0, y: 3, side: L }).d)).toEqual([P(0, 0), P(0, 3)]);
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: T }, { x: -4, y: 0, side: B }).d)).toEqual([P(0, 0), P(-4, 0)]);
    expect(pts(routeThrough({ x: 0, y: 0, side: R }, { x: 0, y: 3, side: L }, []).d)).toEqual([P(0, 0), P(0, 3)]);
  });

  it('reads how much leg an end hides from End.inset', () => {
    // The same tee and lid with nothing to hide a leg under really do face
    // apart, and have to go round.
    const tee: End = { x: 330, y: 108, side: B, ...TEE, inset: 0 };
    const lid: End = { x: 280, y: 107, side: T, inset: 0 };
    expect(corners(routeOrthogonal(tee, lid).d)).toBe(4);
  });

  it('joins ends that overlap by exactly their insets: symbols butted together, a tee touching an open end', () => {
    // Two 60 px symbols edge to edge, the ports between them facing: each
    // anchor three pixels into the other. They went round in a loop through
    // both bodies.
    expect(pts(routeOrthogonal({ x: 163, y: 130, side: R }, { x: 157, y: 130, side: L }).d)).toEqual([P(163, 130), P(157, 130)]);
    // A tee whose dot touches the open end its branch goes down to: centres
    // ten apart, the facing anchors six into each other. A square loop hung
    // off the two dots.
    const d = routeOrthogonal({ x: 510, y: 558, side: B, ...TEE }, { x: 510, y: 552, side: T, ...TEE }).d;
    expect(pts(d)).toEqual([P(510, 558), P(510, 552)]);
    // Measured a hair further in, the same.
    expect(corners(routeOrthogonal({ x: 163.00001, y: 130, side: R }, { x: 157, y: 130, side: L }).d)).toBe(0);
  });

  it('still goes round ends that overlap by more than that', () => {
    const d = routeOrthogonal({ x: 0, y: 0, side: R }, { x: -7, y: 40, side: L }).d;
    expect(corners(d)).toBe(4);
    expect(leavesCorrectly(d, R), d).toBe(true);
    expect(arrivesCorrectly(d, L), d).toBe(true);
  });
});

describe('two symbols side by side, facing each other across a tight gap', () => {
  it('goes out of both ports and down the channel between them, rather than leaving sideways', () => {
    // Two valves a row apart, ten pixels between the bodies: the top of the
    // lower one to the bottom of the upper. The Z shared a four-pixel gap
    // between its legs -- two pixels each, under the handles -- and ran its
    // crossbar the whole way across, five pixels off both faces.
    expect(pts(routeOrthogonal({ x: 30, y: 97, side: T }, { x: 230, y: 93, side: B }).d))
      .toEqual([P(30, 97), P(30, 81), P(130, 81), P(130, 109), P(230, 109), P(230, 93)]);
    // Anchors overlapping by a pixel or two: the same.
    expect(corners(routeOrthogonal({ x: 30, y: 97, side: T }, { x: 230, y: 99, side: B }).d)).toBe(4);
  });

  it('keeps the Z once its legs show', () => {
    // Ten pixels between the anchors: five-pixel legs, and the Z is shorter.
    expect(pts(routeOrthogonal({ x: 30, y: 100, side: T }, { x: 230, y: 90, side: B }).d))
      .toEqual([P(30, 100), P(30, 95), P(230, 95), P(230, 90)]);
  });

  it('keeps the Z when the two bodies overlap across, or one end is a tee', () => {
    // Overlapping across there is no channel, and the way round loops back
    // over its own stubs. A tee sits on a run, and the way round from it
    // takes the other end's stub straight across that run.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: R }, { x: 4, y: 40, side: L }).d))
      .toEqual([P(0, 0), P(2, 0), P(2, 40), P(4, 40)]);
    expect(pts(routeOrthogonal({ x: 30, y: 97, side: T, ...TEE }, { x: 230, y: 93, side: B }).d))
      .toEqual([P(30, 97), P(30, 95), P(230, 95), P(230, 93)]);
  });
});

describe('the ways round, priced', () => {
  it('keeps a full stub when shortening one only saves length', () => {
    // A port facing left, to one facing up a hundred to the left and a
    // little above: the row just clear of the first symbol's body is the
    // shorter way in, but it would bring the run in two pixels above the
    // second port. Each pixel short of a stub is charged for.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: L }, { x: -100, y: -32, side: T }).d))
      .toEqual([P(0, 0), P(-16, 0), P(-16, -48), P(-100, -48), P(-100, -32)]);
  });

  it('goes down a channel too narrow for a margin when every way round runs through a body', () => {
    // Two ports facing apart, their bodies five pixels apart across. Round
    // either side, the run comes back through one of them; down the narrow
    // channel between them it touches neither.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: L }, { x: 10, y: -65, side: R }).d))
      .toEqual([P(0, 0), P(-16, 0), P(-16, -32.5), P(26, -32.5), P(26, -65), P(10, -65)]);
  });
});

describe('a crossbar moved in a drawing saved before corners were stored', () => {
  // Such a line carries its crossbar as an offset from the midpoint, and
  // the offset outlives the geometry it was dragged against.
  it('stays between the two stubs whatever offset it carries', () => {
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 200, y: 100, side: L };
    expect(pts(routeOrthogonal(a, b, 500).d)[1]).toEqual(P(184, 0));
    expect(pts(routeOrthogonal(a, b, -500).d)[1]).toEqual(P(16, 0));
  });

  it('is pulled back into the gap when an end moves toward it', () => {
    // Forty right of the middle, from when the ends were further apart; the
    // target is now a hundred away, so that is behind its port.
    const d = routeOrthogonal({ x: 0, y: 0, side: R }, { x: 100, y: 100, side: L }, 40).d;
    expect(pts(d)).toEqual([P(0, 0), P(84, 0), P(84, 100), P(100, 100)]);
  });
});

describe('what a shape costs', () => {
  it('is its length and twelve a corner, as every chooser prices it', () => {
    expect(routeCost([P(0, 0), P(100, 0)])).toBe(100);
    expect(routeCost([P(0, 0), P(50, 0), P(50, 40), P(100, 40)])).toBe(140 + 24);
    expect(routeCost([])).toBe(0);
  });
});

describe('going round', () => {
  it('clears each end by its own clearance, and takes the shorter side', () => {
    // A tee facing left, a symbol facing right beside it, thirty lower. Over
    // the top clears the tee by a tee's fourteen and the symbol's port by a
    // symbol's forty-four; the old rule had one clearance for both, a
    // symbol's, and always went round the bottom.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: L, ...TEE }, { x: 100, y: 30, side: R }).d))
      .toEqual([P(0, 0), P(-6, 0), P(-6, -14), P(116, -14), P(116, 30), P(100, 30)]);
  });

  it('goes down the channel between two bodies when there is one', () => {
    // Up out of one, down out of the other, eighty apart: there are twenty
    // pixels between the two bodies. The old rule only took the midpoint
    // when the ends were more than two clearances apart, and went round the
    // far side of both.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: T }, { x: 80, y: 100, side: B }).d))
      .toEqual([P(0, 0), P(0, -16), P(40, -16), P(40, 116), P(80, 116), P(80, 100)]);
  });

  it('doubles back only when the end ahead is too close to pass', () => {
    // Both up, twenty out of line, a tee a hundred above a symbol. Twenty
    // clears the tee, which is the end in the way, so a plain U over the top
    // does; the old rule took the symbol's forty-four and went round.
    expect(pts(routeOrthogonal({ x: 0, y: 0, side: T, ...TEE }, { x: 20, y: 100, side: T }).d))
      .toEqual([P(0, 0), P(0, -6), P(20, -6), P(20, 100)]);
    // With the symbol ahead, twenty is inside it: round, clear of its body.
    const d = routeOrthogonal({ x: 0, y: 0, side: T }, { x: 20, y: 100, side: T, ...TEE }).d;
    expect(through(pts(d), { x: -30, y: 3, w: 60, h: 60 })).toBe(false);
    expect(leavesCorrectly(d, T), d).toBe(true);
    expect(arrivesCorrectly(d, T), d).toBe(true);
  });
});

describe('lining up a run that is a hair out', () => {
  it('draws at the symbol when the other end is a tee', () => {
    // The tee's dot is ten across and takes up the difference unseen;
    // moving the symbol's end instead drew a line stopping short of its port.
    const sym: End = { x: 300, y: 100, side: B };
    const tee: End = { x: 303, y: 400, side: T, ...TEE };
    expect(pts(routeOrthogonal(sym, tee).d)).toEqual([P(300, 100), P(300, 400)]);
    expect(pts(routeOrthogonal({ ...tee, y: 100, side: B }, { ...sym, y: 400, side: T }).d))
      .toEqual([P(300, 100), P(300, 400)]);
  });
});

describe('ends measured off the page', () => {
  it('treats coordinates a measurement apart as one', () => {
    // Handle bounds come back through the viewport's scale a few
    // hundred-thousandths of a pixel out. Compared exactly, that decided
    // which way a run turned, and a straight run grew a dip and a diagonal.
    const noise = [0, 2e-5, -3e-5, 4.7e-6];
    const cases: [End, End][] = [
      [{ x: 163, y: 130, side: R }, { x: 397, y: 130, side: L }],
      [{ x: 163, y: 130, side: R }, { x: 397, y: 230, side: L }],
      [{ x: 163, y: 130, side: R }, { x: 300, y: 230, side: T }],
      [{ x: 300, y: 100, side: B }, { x: 300, y: 300, side: T }],
      [{ x: 100, y: 100, side: T }, { x: 100, y: 100.00002, side: T }],
      [{ x: 0, y: 0, side: R }, { x: 0, y: 40, side: L }],
    ];
    for (const [a, b] of cases) {
      const clean = pts(routeOrthogonal(a, b).d);
      for (const n of noise) for (const m of noise) {
        const run = pts(routeOrthogonal({ ...a, x: a.x + n, y: a.y - m }, { ...b, x: b.x - m, y: b.y + n }).d);
        const label = `${a.side}->${b.side} ${n},${m}: ${JSON.stringify(run)}`;
        expect(run.length, label).toBe(clean.length);
        for (let i = 0; i + 1 < run.length; i++) {
          expect(run[i].x === run[i + 1].x || run[i].y === run[i + 1].y, label).toBe(true);
        }
      }
    }
  });

  it('draws a line all the way to both of its ports, whatever it passes a hair off them', () => {
    // Levels within half a pixel of each other are drawn as one, and the one
    // that stands for them has to be the port's: a corner a quarter of a
    // pixel off the far port, met first on the way, took the far end with it
    // and left the line stopping short of where it is joined. The ends here
    // are well apart, so nothing else about a route may move them.
    const ends = (d: string, a: End, b: End) => {
      const run = pts(d);
      expect([run[0], run[run.length - 1]], d).toEqual([P(a.x, a.y), P(b.x, b.y)]);
    };
    // Up out of a symbol and across to a tee: the crossbar's end, a
    // fraction short of the tee's column, is met before the tee.
    const sym: End = { x: 350, y: 309.794, side: T }, tee: End = { x: 380.298, y: 330, side: L, ...TEE };
    ends(routeOrthogonal(sym, tee).d, sym, tee);
    // A hand-routed line whose first port's stub ends a quarter of a pixel
    // above the second port, through corners stored a hair off both.
    const a: End = { x: 200, y: 10.25, side: B }, b: End = { x: 40, y: 26.5, side: R };
    ends(routeThrough(a, b, [P(120, 10.45), P(120, 26.3)]).d, a, b);
    // A searched route's grid lines are rounded to hundredths, so each
    // fractional port has a grid line a few thousandths off it.
    for (let i = 0; i < 40; i++) {
      const s: End = { x: 60 + i * 0.137, y: 40 + i * 0.291, side: R }, t: End = { x: 300 + i * 0.173, y: 200 + i * 0.419, side: L };
      const wall: Box = { x: 160, y: 20, w: 60, h: 260 };
      ends(routeAuto(s, t, [{ x: s.x - 63, y: s.y - 30, w: 60, h: 60 }, { x: t.x + 3, y: t.y - 30, w: 60, h: 60 }, wall]).d, s, t);
    }
  });
});

describe('a body the router is told about', () => {
  it('keeps a run out of it, however far behind the port it reaches', () => {
    // A port near the top of a tall tank's side. The body the router
    // assumes is sixty across, centred on the port; the tank goes on for a
    // hundred and sixty below that, and the U out to a symbol below ran
    // straight through it.
    const tank: Box = { x: 0, y: 0, w: 60, h: 200 };
    const a: End = { x: -3, y: 10, side: L, body: tank };
    const b: End = { x: 100, y: 150, side: L };
    expect(through(pts(routeOrthogonal({ ...a, body: undefined }, b).d), tank)).toBe(true);
    const d = routeOrthogonal(a, b).d;
    expect(through(pts(d), tank), d).toBe(false);
    expect(leavesCorrectly(d, L), d).toBe(true);
    expect(arrivesCorrectly(d, L), d).toBe(true);
  });
});

// ── Every pair of ends ───────────────────────────────────────────────────────

/**
 * The box behind a port: `along` wide on the port's edge, `deep` back from
 * it, its near edge three pixels behind the anchor (a measured handle's
 * outer edge), the port `k` of the way along. Worked out here, not by the
 * router, so the router is not marked against its own idea of a body.
 */
function boxBehind(x: number, y: number, side: Position, along: number, deep: number, k: number): Box {
  const off = along * k;
  switch (side) {
    case T: return { x: x - off, y: y + 3, w: along, h: deep };
    case B: return { x: x - off, y: y - 3 - deep, w: along, h: deep };
    case L: return { x: x + 3, y: y - off, w: deep, h: along };
    default: return { x: x - 3 - deep, y: y - off, w: deep, h: along };
  }
}

type Kind = 'symbol' | 'tee' | 'tank';
/** An end of each kind, and the body it is on. A tank's body is told to the router. */
function endOf(kind: Kind, x: number, y: number, side: Position): { end: End; body: Box } {
  if (kind === 'tee') return { end: { x, y, side, ...TEE }, body: boxBehind(x, y, side, 10, 10, 0.5) };
  if (kind === 'tank') {
    const body = boxBehind(x, y, side, 60, 100, 0.25);
    return { end: { x, y, side, body }, body };
  }
  return { end: { x, y, side }, body: boxBehind(x, y, side, 60, 60, 0.5) };
}

const overlaps = (p: Box, q: Box, m = 2) =>
  p.x - m < q.x + q.w + m && q.x - m < p.x + p.w + m && p.y - m < q.y + q.h + m && q.y - m < p.y + p.h + m;
const within = (p: Pt, b: Box, m = 2) => p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m;
const stepOf = (p: Pt, q: Pt): Pt => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) });

/** Everything wrong with a drawn run between two ends. */
function wrongWith(run: Pt[], a: End, b: End, bodies: Box[]): string[] {
  const out: string[] = [];
  // Two ends apart are joined by a line with some length to it: a path of
  // one point draws nothing and cannot be pressed. (Two ends on one spot
  // have nothing to join.)
  const apart = a.x !== b.x || a.y !== b.y;
  if (apart && (run.length < 2 || polylineLength(run) === 0)) out.push('nothing drawn');
  const steps = run.slice(0, -1).map((p, i) => stepOf(p, run[i + 1]));
  if (steps.some(s => s.x !== 0 && s.y !== 0)) out.push('diagonal');
  if (steps.some(s => s.x === 0 && s.y === 0)) out.push('zero-length segment');
  for (let i = 0; i + 1 < steps.length; i++) {
    if (steps[i].x === -steps[i + 1].x && steps[i].y === -steps[i + 1].y) out.push('spike');
  }
  // Two segments that are not neighbours meeting at all: a knot.
  for (let i = 0; i + 1 < run.length; i++) for (let j = i + 2; j + 1 < run.length; j++) {
    const [p, q, r, s] = [run[i], run[i + 1], run[j], run[j + 1]];
    if (Math.max(p.x, q.x) >= Math.min(r.x, s.x) && Math.max(r.x, s.x) >= Math.min(p.x, q.x)
      && Math.max(p.y, q.y) >= Math.min(r.y, s.y) && Math.max(r.y, s.y) >= Math.min(p.y, q.y)) out.push('crosses itself');
  }
  if (!legsHidden(a, b) && steps.length) {
    const fa = { x: isHorizontal(a.side) ? facing(a.side) : 0, y: isHorizontal(a.side) ? 0 : facing(a.side) };
    const fb = { x: isHorizontal(b.side) ? -facing(b.side) : 0, y: isHorizontal(b.side) ? 0 : -facing(b.side) };
    const first = steps[0], last = steps[steps.length - 1];
    if (first.x !== fa.x || first.y !== fa.y) out.push('leaves the wrong way');
    if (last.x !== fb.x || last.y !== fb.y) out.push('arrives the wrong way');
  }
  if (bodies.some(bx => through(run, bx))) out.push('through an end');
  return out;
}

describe('every pair of ends, everywhere', () => {
  // Offsets on the grid and off it, close in where the shapes change.
  const OFFS = [-160, -100, -60, -40, -25, -16, -10, -6, -3, 0, 3, 6, 10, 16, 25, 40, 60, 100, 160];
  const SIDES = [T, R, B, L];
  const KINDS: Kind[] = ['symbol', 'tee', 'tank'];

  it('draws every one square, untangled, out of and into its ports the way they face, and clear of both bodies', () => {
    const bad: string[] = [];
    let n = 0;
    for (const ka of KINDS) for (const kb of KINDS) for (const sa of SIDES) for (const sb of SIDES) {
      for (const dx of OFFS) for (const dy of OFFS) {
        const A = endOf(ka, 0, 0, sa), B2 = endOf(kb, dx, dy, sb);
        if (overlaps(A.body, B2.body) || within(A.end, B2.body) || within(B2.end, A.body)) continue;
        const bodies = [A.body, B2.body];
        for (const [how, d] of [
          ['routeOrthogonal', routeOrthogonal(A.end, B2.end).d],
          ['routeAuto', routeAuto({ ...A.end, body: A.body }, { ...B2.end, body: B2.body }, []).d],
        ] as const) {
          n++;
          const wrong = wrongWith(pts(d), A.end, B2.end, bodies);
          if (wrong.length && bad.length < 10) bad.push(`${how} ${ka}.${sa} -> ${kb}.${sb} @${dx},${dy}: ${wrong.join(', ')}: ${d}`);
        }
      }
    }
    expect(n).toBeGreaterThan(50000);
    expect(bad, bad.join('\n')).toEqual([]);
  }, SWEEP_MS);
});

describe('a point on a line put on the grid', () => {
  it('is moved along the leg it is on to the nearest grid line, and never off the leg', () => {
    // Read off the screen at a fit-view zoom, a pointer is a fraction of a pixel.
    const run = [P(163, 360), P(500, 360)];
    expect(gridAlong(run, P(239.197, 360.4))).toEqual(P(240, 360));
    const down = [P(60, 30), P(233.5, 30), P(233.5, 200)];
    expect(gridAlong(down, P(233.9, 121.3))).toEqual(P(233.5, 120));
    // The grid line is past the end of the leg: left where it is.
    expect(gridAlong([P(61, 30), P(64, 30)], P(62.4, 30))).toEqual(P(62.4, 30));
  });
});
