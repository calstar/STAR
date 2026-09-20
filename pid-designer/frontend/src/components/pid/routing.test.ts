import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import {
  dragSegment, jogSegment, nearestOnPolyline, pathPoints, pointAt, routeThrough, simplifyPoints, stubOf,
} from './route';
import type { Pt } from './route';

const L = Position.Left, R = Position.Right, B = Position.Bottom;
void Position.Top;
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
