import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import {
  arcsOf, dragSegment, facing, isHorizontal, jogSegment, nearestOnPolyline, pathPoints, pointAt, pointAtArc,
  routeOrthogonal, routeThrough, simplifyPoints, sliceByArc, stubOf, waypointsOf,
} from './route';
import type { Box, End, Pt } from './route';

/**
 * A sweep runs thousands of routes: well inside a test's usual five seconds
 * alone, but not always on a machine busy with other work.
 */
const SWEEP_MS = 30_000;

const L = Position.Left, R = Position.Right, B = Position.Bottom, T = Position.Top;
const P = (x: number, y: number): Pt => ({ x, y });

function orthogonal(pts: Pt[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    if (Math.abs(pts[i].x - pts[i + 1].x) > 1e-6 && Math.abs(pts[i].y - pts[i + 1].y) > 1e-6) return false;
  }
  return true;
}

describe('a run routed by hand', () => {
  it('leaves each port the way the port faces, then goes through the corners', () => {
    const d = routeThrough({ x: 0, y: 0, side: R }, { x: 400, y: 200, side: L }, [P(100, 0), P(100, 200)]).d;
    const pts = pathPoints(d);
    expect(orthogonal(pts)).toBe(true);
    expect(pts[0]).toEqual(P(0, 0));
    expect(pts[1].y).toBe(0);                       // leaves rightward
    expect(pts).toContainEqual(P(100, 0));
    expect(pts).toContainEqual(P(100, 200));
    expect(pts[pts.length - 1]).toEqual(P(400, 200));
    expect(pts[pts.length - 2].y).toBe(200);        // arrives leftward
  });

  it('puts one corner in for a waypoint off both axes of its neighbour', () => {
    const d = routeThrough({ x: 0, y: 0, side: R }, { x: 300, y: 100, side: L }, [P(150, 60)]).d;
    expect(orthogonal(pathPoints(d))).toBe(true);
  });

  it('is a straight line when the two ports face each other in line', () => {
    const d = routeThrough({ x: 0, y: 0, side: R }, { x: 300, y: 0, side: L }, []).d;
    expect(pathPoints(d)).toEqual([P(0, 0), P(300, 0)]);
  });

  it('still leaves a downward port downward when the corner is above it', () => {
    const d = routeThrough({ x: 0, y: 0, side: B }, { x: 200, y: -100, side: L }, []).d;
    const pts = pathPoints(d);
    expect(pts[1]).toEqual(stubOf({ x: 0, y: 0, side: B }));
    expect(pts[1].y).toBeGreaterThan(0);
    expect(orthogonal(pts)).toBe(true);
  });
});

describe('a corner dragged past the port it leaves from', () => {
  it('steps across first rather than turning round through the symbol', () => {
    // An upward port whose first corner has been dragged below it: the run
    // must still leave upward, step sideways, and only then come down.
    const d = routeThrough({ x: 0, y: 0, side: Position.Top }, { x: 200, y: 60, side: L }, [P(0, 60)]).d;
    const pts = pathPoints(d);
    expect(pts[0]).toEqual(P(0, 0));
    expect(pts[1]).toEqual(P(0, -16));
    expect(pts[2].y).toBe(-16);                      // across, not back down the same line
    expect(pts[2].x).toBeGreaterThan(0);             // toward where the run goes next
    expect(orthogonal(pts)).toBe(true);
    for (let i = 0; i < pts.length - 1; i++) {
      // No segment passes down through the port's column below it.
      if (pts[i].x === 0 && pts[i + 1].x === 0) expect(Math.max(pts[i].y, pts[i + 1].y)).toBeLessThanOrEqual(0);
    }
  });
});

describe('a port closer than a stub', () => {
  it('is reached straight, not stepped round', () => {
    // A tee seated 11 px from the port: the run overshoots the tee's stub
    // and comes back, which is a spike to fold away, not a corner to turn.
    const d = routeThrough({ x: 210, y: 323, side: B }, { x: 221, y: 339, side: L }, [P(210, 339)]).d;
    expect(pathPoints(d)).toEqual([P(210, 323), P(210, 339), P(221, 339)]);
  });
});

describe('simplifying corners', () => {
  it('drops repeats, collinear middles and spikes', () => {
    expect(simplifyPoints([P(0, 0), P(0, 0), P(50, 0), P(100, 0)])).toEqual([P(0, 0), P(100, 0)]);
    expect(simplifyPoints([P(0, 0), P(50, 0), P(20, 0), P(20, 40)])).toEqual([P(0, 0), P(20, 0), P(20, 40)]);
  });
});

describe('moving a segment', () => {
  const run = [P(0, 0), P(100, 0), P(100, 80), P(200, 80)];

  it('moves a middle segment across, and only across', () => {
    const out = dragSegment(run, 1, P(30, 0));           // the vertical one, x 100 -> 130
    expect(out).toEqual([P(0, 0), P(130, 0), P(130, 80), P(200, 80)]);
    expect(dragSegment(run, 1, P(0, 30))).toEqual(run);  // along it is nothing
  });

  it('keeps a port where it is by adding a stub and a corner', () => {
    const out = dragSegment(run, 0, P(0, 20));           // the first, horizontal one, down 20
    expect(out[0]).toEqual(P(0, 0));
    expect(out[1]).toEqual(P(16, 0));                    // the stub stays
    expect(out).toContainEqual(P(16, 20));
    expect(out).toContainEqual(P(100, 20));
    expect(out[out.length - 1]).toEqual(P(200, 80));
    expect(orthogonal(out)).toBe(true);
  });

  it('turns a straight run into a jog with a stub at each end', () => {
    const out = dragSegment([P(0, 0), P(200, 0)], 0, P(0, 40));
    expect(out).toEqual([P(0, 0), P(16, 0), P(16, 40), P(184, 40), P(184, 0), P(200, 0)]);
  });

  it('can put a detour into a segment without moving the rest of it', () => {
    const out = jogSegment([P(0, 0), P(200, 0)], 0, P(100, 0), P(0, -30));
    expect(out).toEqual([P(0, 0), P(84, 0), P(84, -30), P(116, -30), P(116, 0), P(200, 0)]);
  });
});

describe('a point along a run', () => {
  const run = [P(0, 0), P(100, 0), P(100, 100)];

  it('is found from the nearest point, with the segment and its direction', () => {
    const near = nearestOnPolyline(run, P(100, 40))!;
    expect(near.point).toEqual(P(100, 40));
    expect(near.segment).toBe(1);
    expect(near.dir).toEqual(P(0, 1));
    expect(near.t).toBeCloseTo(0.7);
  });

  it('round-trips through the fraction', () => {
    const near = nearestOnPolyline(run, P(60, 12))!;
    expect(near.point).toEqual(P(60, 0));
    expect(pointAt(run, near.t)!.point).toEqual(P(60, 0));
  });

  it('lands exactly on a corner rather than beside it', () => {
    expect(nearestOnPolyline(run, P(104, -3))!.point).toEqual(P(100, 0));
  });
});

describe('what a route has to clear', () => {
  it('goes round a tee by the tee, not by a symbol', () => {
    // Two upward ends nearly in line, both on tees: the return leg steps
    // aside by a tee's clearance, not a symbol's forty-four.
    const tee = (x: number, y: number): import('./route').End => ({ x, y, side: Position.Top, clear: 14 });
    const d = routeThrough(tee(100, 100), tee(110, 100), []).d;
    const xs = pathPoints(d).map(p => p.x);
    expect(Math.max(...xs)).toBeLessThan(100 + 44);
    const dSymbol = routeThrough({ x: 100, y: 100, side: Position.Top }, { x: 110, y: 100, side: Position.Top }, []).d;
    void dSymbol;
  });
});

// ── Stored corners, and ends that have moved since ──────────────────────────

/** What an end on a tee carries: `J_END` in junctions.ts. */
const TEE = { clear: 14, stub: 6 };
const drawn = (a: End, b: End, corners: Pt[]) => pathPoints(routeThrough(a, b, corners).d);

/** Does the run leave `a` and reach `b` along the ways their ports face? */
function leavesAndArrives(run: Pt[], a: End, b: End): boolean {
  const step = (p: Pt, q: Pt) => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) });
  const fa = isHorizontal(a.side) ? { x: facing(a.side), y: 0 } : { x: 0, y: facing(a.side) };
  const fb = isHorizontal(b.side) ? { x: -facing(b.side), y: 0 } : { x: 0, y: -facing(b.side) };
  const first = step(run[0], run[1]), last = step(run[run.length - 2], run[run.length - 1]);
  return first.x === fa.x && first.y === fa.y && last.x === fb.x && last.y === fb.y;
}

describe('a hand-routed run whose ends have moved', () => {
  // A straight run between two ports pulled down by its grip: the corners
  // stored are the two stub ends and the level it was pulled to.
  const pulled = [P(16, 0), P(16, 40), P(184, 40), P(184, 0)];

  it('keeps the level it was given when an end moves across', () => {
    expect(drawn({ x: 0, y: 10, side: R }, { x: 200, y: 0, side: L }, pulled))
      .toEqual([P(0, 10), P(16, 10), P(16, 40), P(184, 40), P(184, 0), P(200, 0)]);
    expect(drawn({ x: 0, y: 0, side: R }, { x: 200, y: -10, side: L }, pulled))
      .toEqual([P(0, 0), P(16, 0), P(16, 40), P(184, 40), P(184, -10), P(200, -10)]);
  });

  it('moves a corner the port has passed out to the end of its stub', () => {
    // The source moved thirty to the right: its stored stub end is now
    // behind the port, and drawn as stored the run hooked back through the
    // symbol before it could turn.
    expect(drawn({ x: 30, y: 0, side: R }, { x: 200, y: 0, side: L }, pulled))
      .toEqual([P(30, 0), P(46, 0), P(46, 40), P(184, 40), P(184, 0), P(200, 0)]);
    expect(drawn({ x: 0, y: 0, side: R }, { x: 170, y: 0, side: L }, pulled))
      .toEqual([P(0, 0), P(16, 0), P(16, 40), P(154, 40), P(154, 0), P(170, 0)]);
  });

  it('moves a corner out to the stub once its leg would barely show past the handle', () => {
    // A port nudged toward its first corner: a pixel of leg, then a turn,
    // reads as leaving the port sideways, and the column after it ran down
    // the symbol's face. Six pixels -- three past the handle -- still shows.
    const corners = [P(60, 0), P(60, 100)];
    const b: End = { x: 300, y: 100, side: L };
    expect(drawn({ x: 54, y: 0, side: R }, b, corners)).toEqual([P(54, 0), P(60, 0), P(60, 100), P(300, 100)]);
    expect(drawn({ x: 55, y: 0, side: R }, b, corners)).toEqual([P(55, 0), P(71, 0), P(71, 100), P(300, 100)]);
    expect(drawn({ x: 59, y: 0, side: R }, b, corners)).toEqual([P(59, 0), P(75, 0), P(75, 100), P(300, 100)]);
  });

  it('moves a corner an end has landed on out to the stub, like one a hair in front', () => {
    // Tidied away as a corner on an end, the run lost its turn, and for that
    // one position of the end the crossbar jumped to the router's midpoint.
    const corners = [P(100, 0), P(100, 100)];
    const a: End = { x: 0, y: 0, side: R };
    expect(drawn(a, { x: 106, y: 100, side: L }, corners)).toEqual([P(0, 0), P(100, 0), P(100, 100), P(106, 100)]);
    expect(drawn(a, { x: 105, y: 100, side: L }, corners)).toEqual([P(0, 0), P(89, 0), P(89, 100), P(105, 100)]);
    expect(drawn(a, { x: 100, y: 100, side: L }, corners)).toEqual([P(0, 0), P(84, 0), P(84, 100), P(100, 100)]);
    expect(drawn(a, { x: 90, y: 100, side: L }, corners)).toEqual([P(0, 0), P(74, 0), P(74, 100), P(90, 100)]);
    expect(drawn({ x: 60, y: 0, side: R }, { x: 300, y: 100, side: L }, [P(60, 0), P(60, 100)]))
      .toEqual([P(60, 0), P(76, 0), P(76, 100), P(300, 100)]);
  });

  it('keeps a corner a tee\'s stub along its leg, where the tee\'s pipe put it', () => {
    // A tee sits fourteen along its pipe from a corner, its anchor eight
    // out from its centre: six to the corner, the tee's whole stub.
    expect(drawn({ x: 0, y: 0, side: R, ...TEE }, { x: 100, y: 50, side: L }, [P(6, 0), P(6, 50)]))
      .toEqual([P(0, 0), P(6, 0), P(6, 50), P(100, 50)]);
    // One nearer than that goes out to the tee's own stub, not a symbol's.
    expect(drawn({ x: 0, y: 0, side: R, ...TEE }, { x: 100, y: 50, side: L }, [P(3, 0), P(3, 50)]))
      .toEqual([P(0, 0), P(6, 0), P(6, 50), P(100, 50)]);
  });

  it('reaches the target from outside when the target moved past the last corner', () => {
    // A Z's crossbar stored at x 100; the target then moved to x 80. The
    // last leg used to run from the crossbar back through the target's body
    // and into its port from inside.
    const run = drawn({ x: 0, y: 0, side: R }, { x: 80, y: 100, side: L }, [P(100, 0), P(100, 100)]);
    expect(run).toEqual([P(0, 0), P(64, 0), P(64, 100), P(80, 100)]);
  });

  it('joins the last corner to the target from the target\'s side', () => {
    // The last stored corner is past the target, and its leg runs along the
    // run rather than across the target's axis. Joined onward from the
    // corner, the run went down and back left into the port, through the
    // symbol; joined from the target's stub, it keeps the level and comes
    // down to the port from outside.
    expect(drawn({ x: 0, y: 0, side: R }, { x: 200, y: 100, side: L }, [P(150, 50), P(250, 50)]))
      .toEqual([P(0, 0), P(150, 0), P(150, 50), P(184, 50), P(184, 100), P(200, 100)]);
  });

  it('steps round a port by that end\'s own clearance', () => {
    // A corner in line with a port and behind it: the run steps across
    // before coming back, by a tee's fourteen for a tee and a symbol's
    // forty-four for a symbol -- not a flat sixteen, which is a notch at a
    // tee and not enough to clear a symbol.
    const tee = drawn({ x: 0, y: 0, side: T, ...TEE }, { x: 200, y: 120, side: L }, [P(0, 30), P(50, 80)]);
    expect(tee.slice(0, 3)).toEqual([P(0, 0), P(0, -6), P(14, -6)]);
    const sym = drawn({ x: 0, y: 0, side: T }, { x: 200, y: 120, side: L }, [P(0, 30), P(50, 80)]);
    expect(sym.slice(0, 3)).toEqual([P(0, 0), P(0, -16), P(44, -16)]);
  });

  it('folds a back-step in the middle of the run instead of stepping round it', () => {
    // Only a port's own leg may not double back. In the middle, a corner
    // behind the one before is a spike, and used to be drawn as a notch.
    expect(drawn({ x: 0, y: 0, side: R }, { x: 300, y: 30, side: L }, [P(100, 0), P(150, 60), P(150, 30)]))
      .toEqual([P(0, 0), P(150, 0), P(150, 30), P(300, 30)]);
  });

  it('routes itself when it has no corners', () => {
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 300, y: 100, side: L };
    expect(routeThrough(a, b, []).d).toBe(routeOrthogonal(a, b).d);
  });

  it('is drawn by the router, not in a knot, once an end has moved past a detour beside it', () => {
    // A detour put in just past the source's stub: up, across nine pixels,
    // and down to the target's level. The source then moved twenty to the
    // right, so its stub ends beyond the detour's far side; drawn as stored,
    // the run came back across its own first leg.
    const corners = [P(76, 30), P(76, -10), P(85, -10), P(85, 70)];
    const b: End = { x: 110, y: 70, side: L };
    const moved: End = { x: 80, y: 30, side: R };
    expect(drawn(moved, b, corners)).toEqual(pathPoints(routeOrthogonal(moved, b).d));
    // The corners are kept, not forgotten: back where it was, the detour is
    // drawn again.
    expect(drawn({ x: 60, y: 30, side: R }, b, corners))
      .toEqual([P(60, 30), P(76, 30), P(76, -10), P(85, -10), P(85, 70), P(110, 70)]);
  });

  it('is drawn by the router when corners left behind a port would take it through a symbol it knows', () => {
    // The same detour, the source moved thirty: the column at 85 is now
    // behind the port, and runs down through the symbol the port is on.
    const corners = [P(76, 30), P(76, -10), P(85, -10), P(85, 70)];
    const b: End = { x: 110, y: 70, side: L };
    const a: End = { x: 90, y: 30, side: R };
    const body: Box = { x: 27, y: 0, w: 60, h: 60 };
    // Told nothing about the symbol, the router cannot know.
    expect(drawn(a, b, corners)).toEqual([P(90, 30), P(106, 30), P(106, -10), P(85, -10), P(85, 70), P(110, 70)]);
    expect(drawn({ ...a, body }, b, corners)).toEqual(pathPoints(routeOrthogonal({ ...a, body }, b).d));
  });

  it('keeps its corners from a port whose handle sits inside its own symbol', () => {
    // No line leaves such a port without crossing the symbol, the router's
    // own included, so crossing it is no reason to give the corners up.
    const a: End = { x: 50, y: 0, side: R, body: { x: 0, y: -30, w: 100, h: 60 } };
    const b: End = { x: 300, y: 100, side: L };
    expect(drawn(a, b, [P(150, 0), P(150, 100)])).toEqual([P(50, 0), P(150, 0), P(150, 100), P(300, 100)]);
  });

  it('takes corners measured a hair off the ends as on them', () => {
    // A hand run stored from measured handles: every coordinate is a few
    // hundred-thousandths out. Compared exactly, the first leg turned by a
    // hair, set off the other way, and drew a dip and a diagonal.
    const run = drawn(
      { x: 163.00002, y: 129.99997, side: R }, { x: 397.00001, y: 130.00004, side: L },
      [P(179.00001, 130.00001), P(179, 170.00003), P(381.00002, 169.99999), P(380.99998, 130)],
    );
    expect(run).toHaveLength(6);
    for (let i = 0; i + 1 < run.length; i++) expect(run[i].x === run[i + 1].x || run[i].y === run[i + 1].y).toBe(true);
    expect(run[1].y).toBe(run[0].y);
    expect(run[2].y).toBeGreaterThan(160);
  });
});

describe('what a segment edit may do near a port', () => {
  it('will not move a leg behind a port\'s stub', () => {
    // Two right-hand ports stacked: the U's upright is at the stubs' end.
    // Dragged left it would be inside both symbols, and was drawn as a hook.
    const U = pathPoints(routeOrthogonal({ x: 60, y: 30, side: R }, { x: 60, y: 230, side: R }).d);
    expect(dragSegment(U, 1, P(-10, 0))).toEqual(U);
    expect(dragSegment(U, 1, P(10, 0))).toEqual([P(60, 30), P(86, 30), P(86, 230), P(60, 230)]);
    // A crossbar dragged past either port stops at that port's stub.
    const Z = [P(0, 0), P(100, 0), P(100, 80), P(200, 80)];
    expect(dragSegment(Z, 1, P(150, 0))).toEqual([P(0, 0), P(184, 0), P(184, 80), P(200, 80)]);
    expect(dragSegment(Z, 1, P(-150, 0))).toEqual([P(0, 0), P(16, 0), P(16, 80), P(200, 80)]);
    // Those two go so far that the corner lands at or past the port, and the
    // drawing would put it back out at the stub whether the drag stopped
    // there or not. Let go short of the stub, with a leg of 10 or 14 px that
    // shows, the corner stays where it is put -- so it is the drag that has
    // to stop at the stub, and from either end.
    for (const dx of [86, 90]) {
      expect(dragSegment(Z, 1, P(dx, 0))).toEqual([P(0, 0), P(184, 0), P(184, 80), P(200, 80)]);
      expect(dragSegment(Z, 1, P(-dx, 0))).toEqual([P(0, 0), P(16, 0), P(16, 80), P(200, 80)]);
    }
  });

  it('shows the router\'s route when an edit takes every corner out', () => {
    // Two tees facing up, one forty above the other: the router goes round.
    // Dragging the far upright onto the near one's column folds the run
    // flat, which stores no corners -- and a line with none is drawn by the
    // router, round again, not up through the far tee's dot.
    const a: End = { x: 0, y: 0, side: T, ...TEE }, b: End = { x: 0, y: -40, side: T, ...TEE };
    const loop = pathPoints(routeOrthogonal(a, b).d);
    expect(loop).toEqual([P(0, 0), P(0, -6), P(14, -6), P(14, -46), P(0, -46), P(0, -40)]);
    expect(dragSegment(loop, 2, P(-14, 0), { ends: { a, b } })).toEqual(loop);
  });

  it('will not tie the run in a knot, and goes as far as it can short of one', () => {
    // The last upright of a hand-routed run dragged back past the first:
    // the leg into the target would cross the run's own first upright. It
    // goes as far as that upright, merges into it, and stays there however
    // much further the pointer goes. (It used to refuse the whole move,
    // which put the segment back where the drag began: see below.)
    const run = [P(0, 0), P(100, 0), P(100, 100), P(200, 100), P(200, 50), P(300, 50)];
    const met = [P(0, 0), P(100, 0), P(100, 50), P(300, 50)];
    expect(dragSegment(run, 3, P(-100, 0))).toEqual(met);
    expect(dragSegment(run, 3, P(-150, 0))).toEqual(met);
    // A detour out of the first upright pushed out past the last would
    // cross it twice: it stops a pixel short of it.
    expect(jogSegment(run, 1, P(100, 50), P(150, 0))).toEqual([
      P(0, 0), P(100, 0), P(100, 34), P(199, 34), P(199, 66), P(100, 66), P(100, 100), P(200, 100), P(200, 50), P(300, 50),
    ]);
    // Short of that, it moves.
    expect(dragSegment(run, 3, P(-50, 0)))
      .toEqual([P(0, 0), P(100, 0), P(100, 100), P(150, 100), P(150, 50), P(300, 50)]);
  });

  it('stops where the knot would begin, not back where the drag began', () => {
    // A drag is worked out afresh from where it started on every move of
    // the pointer. Refused outright once the pointer passed the point of a
    // knot, the segment jumped the whole way back to its start mid-drag.
    const base = [P(0, 0), P(100, 0), P(100, 100), P(60, 100), P(60, 200), P(0, 200)];
    expect(dragSegment(base, 2, P(0, -95))).toEqual([P(0, 0), P(100, 0), P(100, 5), P(60, 5), P(60, 200), P(0, 200)]);
    for (const dy of [-105, -140]) {
      const run = dragSegment(base, 2, P(0, dy));
      expect(run, `by ${dy}`).not.toEqual(base);
      expect(Math.min(...run.map(p => p.y)), `by ${dy}`).toBe(0);
    }
  });

  it('keeps a tee\'s own stub when told it is one', () => {
    expect(dragSegment([P(0, 0), P(200, 0)], 0, P(0, 40), { a: 6 }))
      .toEqual([P(0, 0), P(6, 0), P(6, 40), P(184, 40), P(184, 0), P(200, 0)]);
  });

  it('moves the whole segment when there is no room on it for a detour', () => {
    // Forty pixels between two ports: a detour thirty-two long fits only by
    // starting inside a stub, which hooked at the port.
    expect(jogSegment([P(60, 30), P(100, 30)], 0, P(80, 30), P(0, 10)))
      .toEqual([P(60, 30), P(76, 30), P(76, 40), P(84, 40), P(84, 30), P(100, 30)]);
  });

  it('starts a detour no nearer a port than the end of its stub', () => {
    expect(jogSegment([P(0, 0), P(200, 0)], 0, P(20, 0), P(0, 30)))
      .toEqual([P(0, 0), P(16, 0), P(16, 30), P(48, 30), P(48, 0), P(200, 0)]);
  });

  it('shows while dragging exactly what is drawn when it lets go', () => {
    // Every segment of every shape between every pair of sides, symbol and
    // tee ends, dragged and jogged both ways: the corners the edit stores,
    // routed, are the run the edit returned.
    const sides = [L, R, T, B];
    const spots: [number, number][] = [[300, 0], [300, 150], [150, 300], [0, 200], [-200, 100], [110, 40], [40, 110], [70, 30]];
    const bad: string[] = [];
    let n = 0;
    for (const sa of sides) for (const sb of sides) for (const [dx, dy] of spots) for (const kind of ['SS', 'ST', 'TS', 'TT']) {
      const a: End = { x: 0, y: 0, side: sa, ...(kind[0] === 'T' ? TEE : {}) };
      const b: End = { x: dx, y: dy, side: sb, ...(kind[1] === 'T' ? TEE : {}) };
      const base = pathPoints(routeOrthogonal(a, b).d);
      const stubs = { ends: { a, b } };
      const wasFine = base.length < 2 || leavesAndArrives(base, a, b);
      for (let i = 0; i + 1 < base.length; i++) {
        const mid = P((base[i].x + base[i + 1].x) / 2, (base[i].y + base[i + 1].y) / 2);
        for (const k of [-60, -17, -8, 8, 17, 60]) for (const jog of [false, true]) {
          const next = jog ? jogSegment(base, i, mid, P(k, k), stubs) : dragSegment(base, i, P(k, k), stubs);
          const run = drawn(a, b, waypointsOf(next));
          n++;
          const same = run.length === next.length && run.every((p, j) => Math.abs(p.x - next[j].x) < 1e-6 && Math.abs(p.y - next[j].y) < 1e-6);
          if (!same && bad.length < 8) bad.push(`${kind} ${sa}->${sb} @${dx},${dy} ${jog ? 'jog' : 'drag'} ${i} by ${k}: edit ${JSON.stringify(next)} drawn ${JSON.stringify(run)}`);
          if (wasFine && run.length > 1 && !leavesAndArrives(run, a, b) && bad.length < 8) bad.push(`${kind} ${sa}->${sb} @${dx},${dy} ${jog ? 'jog' : 'drag'} ${i} by ${k}: leaves or arrives wrong: ${JSON.stringify(run)}`);
        }
      }
    }
    expect(n).toBeGreaterThan(5000);
    expect(bad, bad.join('\n')).toEqual([]);
  }, SWEEP_MS);
});

describe('a line reshaped by hand, again and again, whose ends then move', () => {
  /** A repeatable stream of numbers in [0, 1). */
  function stream(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }
  /**
   * Two ports facing each other with their anchors level: the run between
   * them goes straight across, its legs of no length under the handles
   * (route.test.ts), so it neither leaves nor arrives along a leg.
   */
  function legsHidden(a: End, b: End): boolean {
    if (isHorizontal(a.side) !== isHorizontal(b.side) || facing(a.side) !== -facing(b.side)) return false;
    const gap = (isHorizontal(a.side) ? b.x - a.x : b.y - a.y) * facing(a.side);
    return gap > -6 && gap < 0.5;
  }
  const fine = (run: Pt[], a: End, b: End) => orthogonal(run) && !knotted(run) && (legsHidden(a, b) || leavesAndArrives(run, a, b));
  /** Two segments of a run that are not neighbours meeting at all. */
  function knotted(run: Pt[]): boolean {
    for (let i = 0; i + 1 < run.length; i++) for (let j = i + 2; j + 1 < run.length; j++) {
      const [p, q, r, s] = [run[i], run[i + 1], run[j], run[j + 1]];
      if (Math.max(p.x, q.x) >= Math.min(r.x, s.x) && Math.max(r.x, s.x) >= Math.min(p.x, q.x)
        && Math.max(p.y, q.y) >= Math.min(r.y, s.y) && Math.max(r.y, s.y) >= Math.min(p.y, q.y)) return true;
    }
    return false;
  }

  it('is drawn as each edit showed it, square, untangled, and out of and into its ports the way they face', () => {
    // Symbols and tees a few grid squares apart, any sides; four drags or
    // detours on random segments by random amounts; then the far end moved
    // a grid square or three, the way a nudge or a drag moves it.
    const next = stream(99);
    const sides = [L, R, T, B];
    const bad: string[] = [];
    let n = 0;
    for (let trial = 0; trial < 600; trial++) {
      const a: End = { x: 0, y: 0, side: sides[Math.floor(next() * 4)], ...(next() < 0.3 ? TEE : {}) };
      const b: End = {
        x: Math.round((next() - 0.5) * 40) * 10, y: Math.round((next() - 0.5) * 40) * 10,
        side: sides[Math.floor(next() * 4)], ...(next() < 0.3 ? TEE : {}),
      };
      if (Math.abs(b.x) < 70 && Math.abs(b.y) < 70) continue;          // the two symbols on top of each other
      let run = pathPoints(routeOrthogonal(a, b).d);
      const stubs = { ends: { a, b } };
      for (let e = 0; e < 4; e++) {
        const i = Math.floor(next() * (run.length - 1));
        const k = P(Math.round((next() - 0.5) * 16) * 10, Math.round((next() - 0.5) * 16) * 10);
        const mid = P((run[i].x + run[i + 1].x) / 2, (run[i].y + run[i + 1].y) / 2);
        const edited = next() < 0.5 ? dragSegment(run, i, k, stubs) : jogSegment(run, i, mid, k, stubs);
        run = drawn(a, b, waypointsOf(edited));
        n++;
        const label = `${JSON.stringify([a, b])} edit ${e}: ${JSON.stringify(edited)}`;
        if (JSON.stringify(run) !== JSON.stringify(edited)) bad.push(`drawn differently from the edit: ${label} -> ${JSON.stringify(run)}`);
        else if (!fine(run, a, b)) bad.push(`knotted or the wrong way: ${label}`);
      }
      const corners = waypointsOf(run);
      for (const [dx, dy] of [[10, 0], [-10, 0], [0, 10], [0, -10], [20, 20], [-30, 10]]) {
        const moved = { ...b, x: b.x + dx, y: b.y + dy };
        const now = drawn(a, moved, corners);
        n++;
        if (!fine(now, a, moved)) {
          bad.push(`knotted or the wrong way after a move: ${JSON.stringify([a, moved, corners])} -> ${JSON.stringify(now)}`);
        }
      }
    }
    expect(n).toBeGreaterThan(4000);
    expect(bad.slice(0, 3), bad.slice(0, 3).join('\n')).toEqual([]);
  }, SWEEP_MS);
});

describe('distance along a run', () => {
  const run = [P(0, 0), P(100, 0), P(100, 100), P(200, 100)];

  it('says how far along each point is', () => {
    expect(arcsOf(run)).toEqual([0, 100, 200, 300]);
    expect(nearestOnPolyline(run, P(104, 40))!.s).toBe(140);
  });

  it('finds the point a distance along, held to the ends', () => {
    expect(pointAtArc(run, 150)!.point).toEqual(P(100, 50));
    expect(pointAtArc(run, 100)!.segment).toBe(0);          // on a corner: the segment before it
    expect(pointAtArc(run, -20)!.point).toEqual(P(0, 0));
    expect(pointAtArc(run, 999)!.point).toEqual(P(200, 100));
  });

  it('cuts out the piece between two distances, corners by where they are along it', () => {
    expect(sliceByArc(run, 50, 250)).toEqual([P(50, 0), P(100, 0), P(100, 100), P(150, 100)]);
    expect(sliceByArc(run, 250, 50)).toEqual([P(150, 100), P(100, 100), P(100, 0), P(50, 0)]);
    // A cut standing on a corner: the corner is the cut, on neither side as a corner.
    expect(sliceByArc(run, 100, 250)).toEqual([P(100, 0), P(100, 100), P(150, 100)]);
    expect(sliceByArc(run, 0, 100)).toEqual([P(0, 0), P(100, 0)]);
  });
});
