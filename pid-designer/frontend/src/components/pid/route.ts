import { Position } from '@xyflow/react';

/**
 * Orthogonal routing between two ports.
 *
 * A P&ID is drawn with square corners, and a line leaves a port the way the
 * port points. That second half is the one that was missing: the router used
 * to turn a corner at the target's coordinate regardless of which way either
 * end faced, so a line leaving a valve's right-hand port to reach something
 * below and to the left set off *left*, back across the valve it had just come
 * out of, before turning down.
 *
 * The rule here is one sentence: **every segment touching an end runs in the
 * direction that end faces.** Everything below is that rule applied to the
 * three shapes a run can take.
 */

/** One end of a run: where it is, and which way it points. */
export interface End {
  x: number;
  y: number;
  side: Position;
}

export interface Route {
  d: string;
  /** The middle segment, when there is one to drag. Null when the shape has no
   *  crossbar — a plain corner has nothing a reader could usefully move. */
  grip: { x: number; y: number } | null;
}

/**
 * How far a line runs straight out of a port before it is allowed to turn.
 *
 * Enough to read as "it leaves this way" at the zoom a bay is drawn at, and
 * short enough not to collide with a symbol sitting one grid square away.
 */
const STUB = 16;

/**
 * Two ends this close on the perpendicular axis are treated as in line.
 *
 * Ports sit at 0, 30 and 60 across a 60-pixel symbol and the grid is 10, so
 * two symbols stacked deliberately can still be a few pixels out. Snapping the
 * run to their average is straight; joining the points is a line that leans.
 */
// Four, not ten. At ten, two ports a whole grid step apart -- a tank's
// outlet over a valve placed one square to the side -- were "straightened"
// by moving both ends half the error, so the run landed on neither port.
// A step apart is a decision; the run jogs to honour it. Snap-on-drop is
// what lines symbols up (snap.ts), so what remains is rounding.
const ALIGNED = 4;

/**
 * How far to the side a detour goes to clear the symbol it is leaving.
 *
 * A symbol is sixty across and its ports sit on the edge, so half of one is
 * thirty from the port. Two ports pointing the same way and nearly in line --
 * a regulator's dome and the bottle feeding it, sitting under it -- otherwise
 * got a run that went up, across by a few pixels, and back down straight
 * through the regulator body.
 */
const CLEAR = 44;

export const isHorizontal = (p: Position) =>
  p === Position.Left || p === Position.Right;

/** +1 for right/down, -1 for left/up: the way a port points, as a sign. */
export const facing = (p: Position): 1 | -1 =>
  p === Position.Right || p === Position.Bottom ? 1 : -1;

export function routeOrthogonal(a: End, b: End, offset = 0): Route {
  const aH = isHorizontal(a.side);
  const bH = isHorizontal(b.side);
  const as = facing(a.side);
  const bs = facing(b.side);

  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);

  // ── In line, and pointing along the run ──────────────────────────────────
  //
  // Only when both ends face along it. Two ports that happen to be vertically
  // aligned but both point sideways still need to leave sideways, and drawing
  // the straight line between them would run out of the side of each symbol.
  if (dx <= ALIGNED && dy > dx && !aH && !bH
      && (b.y - a.y) * as > 0 && (a.y - b.y) * bs > 0) {
    const x = (a.x + b.x) / 2;
    return { d: `M ${x},${a.y} L ${x},${b.y}`, grip: null };
  }
  if (dy <= ALIGNED && dx > dy && aH && bH
      && (b.x - a.x) * as > 0 && (a.x - b.x) * bs > 0) {
    const y = (a.y + b.y) / 2;
    return { d: `M ${a.x},${y} L ${b.x},${y}`, grip: null };
  }

  // ── One end horizontal, one vertical: a corner, if the corner is ahead ───
  if (aH !== bH) {
    const h = aH ? a : b;                 // the end that leaves sideways
    const v = aH ? b : a;                 // the end that leaves up or down
    const hs = aH ? as : bs;
    const vs = aH ? bs : as;
    // The natural corner sits at the vertical end's x and the horizontal
    // end's y. It only works if it is on the side each end actually faces.
    const ahead = (v.x - h.x) * hs > 0 && (h.y - v.y) * vs > 0;
    if (ahead) {
      const d = aH
        ? `M ${a.x},${a.y} L ${b.x},${a.y} L ${b.x},${b.y}`
        : `M ${a.x},${a.y} L ${a.x},${b.y} L ${b.x},${b.y}`;
      return { d, grip: null };
    }
    // Otherwise stub out of both ends first and join the stubs. Four segments,
    // and every one of them leaves an end the way that end points.
    const hx = h.x + hs * STUB;
    const vy = v.y + vs * STUB;
    const d = aH
      ? `M ${a.x},${a.y} L ${hx},${a.y} L ${hx},${vy} L ${b.x},${vy} L ${b.x},${b.y}`
      : `M ${a.x},${a.y} L ${a.x},${vy} L ${hx},${vy} L ${hx},${b.y} L ${b.x},${b.y}`;
    return { d, grip: null };
  }

  // ── Both horizontal, or both vertical: a crossbar between them ───────────
  //
  // Where the crossbar can go depends on which way the two ends point. Facing
  // each other, it goes between them and the reader can slide it. Facing the
  // same way, or facing apart with no room in between, it has to clear both
  // ends instead -- and then it is not a free crossbar any more, so there is
  // nothing to offer a drag handle for.
  // Two ends pointing the same way and nearly in line have to double back,
  // and doing that at the same coordinate draws the return leg through the
  // symbol. Send those round the side instead.
  const perp = aH ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
  const doublesBack = as === bs && perp < CLEAR;

  if (aH) {
    const mid = doublesBack ? null : crossbar(a.x, as, b.x, bs, offset);
    if (mid) {
      const d = `M ${a.x},${a.y} L ${mid.at},${a.y} L ${mid.at},${b.y} L ${b.x},${b.y}`;
      return { d, grip: mid.free ? { x: mid.at, y: (a.y + b.y) / 2 } : null };
    }
    // Facing apart, with nothing between them: out of both ends, and round.
    const ax = a.x + as * STUB;
    const bx = b.x + bs * STUB;
    const my = aside(a.y, b.y);
    return {
      d: `M ${a.x},${a.y} L ${ax},${a.y} L ${ax},${my} L ${bx},${my} L ${bx},${b.y} L ${b.x},${b.y}`,
      grip: null,
    };
  }
  const mid = doublesBack ? null : crossbar(a.y, as, b.y, bs, offset);
  if (mid) {
    return {
      d: `M ${a.x},${a.y} L ${a.x},${mid.at} L ${b.x},${mid.at} L ${b.x},${b.y}`,
      grip: mid.free ? { x: (a.x + b.x) / 2, y: mid.at } : null,
    };
  }
  const ay = a.y + as * STUB;
  const by = b.y + bs * STUB;
  const mx = aside(a.x, b.x);
  return {
    d: `M ${a.x},${a.y} L ${a.x},${ay} L ${mx},${ay} L ${mx},${by} L ${b.x},${by} L ${b.x},${b.y}`,
    grip: null,
  };
}

/**
 * A line to run round on, on the axis the two ends do *not* leave along.
 *
 * Their midpoint, unless they share it -- two symbols stacked exactly would
 * otherwise get a "detour" that retraces the line it just drew.
 */
function aside(a: number, b: number): number {
  // Far apart, the midpoint is between the two symbols and clear of both.
  // Close together, it is *inside* them, so go round instead.
  return Math.abs(a - b) > 2 * CLEAR ? (a + b) / 2 : Math.max(a, b) + CLEAR;
}

/**
 * Where the crossbar sits on a same-axis run, and whether it may be moved.
 *
 * It must be ahead of both ends: `(at - a)·as > 0` and `(at - b)·bs > 0`. When
 * the two point at each other with room in between, every position in that gap
 * satisfies both and the midpoint is as good a default as any -- so that one is
 * free to drag. In every other arrangement exactly one side of both ends works,
 * and the crossbar is pinned just past the further of them.
 */
function crossbar(
  a: number, as: number, b: number, bs: number, offset: number,
): { at: number; free: boolean } | null {
  // Pointing at each other with room between: anywhere in the gap works, so
  // the midpoint is the default and the reader may slide it.
  if (as > 0 && bs < 0 && b - a > 2 * STUB) {
    return { at: (a + b) / 2 + offset, free: true };
  }
  if (as < 0 && bs > 0 && a - b > 2 * STUB) {
    return { at: (a + b) / 2 + offset, free: true };
  }
  // Pointing the same way: one side of both ends works. Out past the further.
  if (as === bs) {
    return { at: as > 0 ? Math.max(a, b) + STUB : Math.min(a, b) - STUB, free: false };
  }
  // Pointing apart, or at each other with no room. No single crossbar can be
  // ahead of both, and pretending otherwise is what drew a line back through
  // the symbol it came from. The caller routes round instead.
  return null;
}

/** The four sides, clockwise, so a quarter turn is one step along. */
const CLOCKWISE = [Position.Top, Position.Right, Position.Bottom, Position.Left];

/**
 * Which side a port ends up on once its symbol has been turned.
 *
 * A rotation moves a port on screen, and until this existed it did not move
 * the port's *facing*: React Flow still had a rotated valve's inlet down as
 * left-facing, so the router sent the line off sideways from a port that was
 * now on the top. The coordinates were right and the direction was not, which
 * is the whole of why rotated symbols drew hooks.
 */
export function turn(side: Position, rotation = 0): Position {
  const steps = Math.round(((rotation % 360) + 360) % 360 / 90) % 4;
  return CLOCKWISE[(CLOCKWISE.indexOf(side) + steps) % 4];
}

/**
 * Where a port sits after its symbol is turned.
 *
 * `turn` says which side a port ends up on; this says whereabouts along that
 * side. A tank's three bottom ports and an engine's two inlets are placed a
 * measured distance along their edge, and a quarter turn does not just move
 * the edge -- it can reverse the direction the distance is measured in. The
 * left edge's top end becomes the top edge's *right* end.
 *
 * `along` is pixels from the box's top-left corner, down or across the edge.
 * The returned `along` is in the turned box, whose width and height have
 * swapped for an odd number of quarter turns.
 */
export function turnPlacement(
  side: Position, along: number, w: number, h: number, rotation = 0,
): { side: Position; along: number } {
  const steps = Math.round(((rotation % 360) + 360) % 360 / 90) % 4;

  // The port as a point in the unturned box.
  let x = side === Position.Right ? w : side === Position.Left ? 0 : along;
  let y = side === Position.Bottom ? h : side === Position.Top ? 0 : along;
  let bw = w, bh = h;

  // One quarter turn clockwise: (x, y) in a bw x bh box becomes (bh - y, x).
  for (let i = 0; i < steps; i++) {
    const nx = bh - y, ny = x;
    [x, y] = [nx, ny];
    [bw, bh] = [bh, bw];
  }

  const turned = turn(side, rotation);
  return {
    side: turned,
    along: turned === Position.Top || turned === Position.Bottom ? x : y,
  };
}

// ── Explicit routing ─────────────────────────────────────────────────────────
//
// Everything above decides a shape from two ends. Everything below is for a
// run somebody has taken hold of: the corners it goes through are stored on
// the line, any segment can be moved, and the two ends still leave their
// ports the way the ports face.

export type Pt = { x: number; y: number };

const EPS = 1e-6;

const samePt = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/** The corners of an M/L path, in order. Arcs (hops) are skipped, which is
 *  right: a hop is drawn on a segment, not a corner in it. */
export function pathPoints(d: string): Pt[] {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]) }));
}

export function pointsToPath(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
}

/**
 * Drop repeated points and the middle of any three in a line.
 *
 * "In a line" includes a spike -- out along an axis and back along it -- so a
 * segment dragged until it lies on its neighbour merges into it rather than
 * leaving a zero-width tooth.
 */
export function simplifyPoints(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;
    out.push({ x: p.x, y: p.y });
  }
  let i = 1;
  while (i < out.length - 1) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const sameX = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS;
    const sameY = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
    if (sameX || sameY) out.splice(i, 1);
    else i++;
  }
  // A spike can leave two equal neighbours behind; one more pass clears it.
  for (let k = out.length - 2; k >= 0; k--) if (samePt(out[k], out[k + 1])) out.splice(k + 1, 1);
  return out;
}

/** A unit vector from a to b, or null when they coincide. */
export function direction(a: Pt, b: Pt): Pt | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len < EPS ? null : { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/** The point a port's stub ends at: `STUB` out of the port, the way it faces. */
export function stubOf(e: End): Pt {
  return isHorizontal(e.side)
    ? { x: e.x + facing(e.side) * STUB, y: e.y }
    : { x: e.x, y: e.y + facing(e.side) * STUB };
}

/**
 * The corners between two points that are not in line: one.
 *
 * It continues the axis the run arrived on when the next point is ahead on
 * it, and turns across first when it is behind -- which is what keeps the
 * run from doubling straight back along a port's stub and out through the
 * symbol it just left. Horizontal-first when there is no arrival.
 */
function elbow(p: Pt, q: Pt, arrived: Pt | null, after?: Pt): Pt[] {
  const dx = Math.abs(p.x - q.x) > EPS;
  const dy = Math.abs(p.y - q.y) > EPS;
  if (!dx && !dy) return [q];
  const horizontalArrival = arrived ? Math.abs(arrived.x) > Math.abs(arrived.y) : true;
  const ahead = arrived ? (q.x - p.x) * arrived.x + (q.y - p.y) * arrived.y : 1;
  if (!dx || !dy) {
    // In line with the arrival. Straight on if it is ahead; if it is
    // *behind* -- a corner dragged past the port it leaves from -- step
    // across by a stub first, or the run would turn round and go back
    // through the symbol. Across toward wherever the run goes next, and
    // the corner itself is not visited: it sits in the port's own column,
    // inside the symbol, and what it meant was the level it was dragged to.
    if (arrived && ahead < -EPS) {
      let side = 1;
      if (after) side = horizontalArrival ? (after.y >= p.y ? 1 : -1) : (after.x >= p.x ? 1 : -1);
      const c1 = horizontalArrival ? { x: p.x, y: p.y + side * STUB } : { x: p.x + side * STUB, y: p.y };
      const c2 = horizontalArrival ? { x: q.x, y: c1.y } : { x: c1.x, y: q.y };
      return [c1, c2];
    }
    return [q];
  }
  const horizontalFirst = arrived ? (horizontalArrival ? ahead > 0 : ahead <= 0) : true;
  return horizontalFirst ? [{ x: q.x, y: p.y }, q] : [{ x: p.x, y: q.y }, q];
}

/**
 * A run through the corners somebody placed.
 *
 * The ends are still the router's business -- each leaves its port along the
 * port's own axis for `STUB` before anything else is allowed to happen --
 * and every pair of points after that is joined orthogonally, so a waypoint
 * that is off both axes of its neighbour gets one corner put in on the way.
 * The corners people set are honoured exactly; only the joins between them
 * are computed.
 */
export function routeThrough(a: End, b: End, waypoints: Pt[]): Route {
  const raw: Pt[] = [stubOf(a), ...waypoints, stubOf(b)];
  const out: Pt[] = [{ x: a.x, y: a.y }];
  let arrived: Pt | null = isHorizontal(a.side) ? { x: facing(a.side), y: 0 } : { x: 0, y: facing(a.side) };
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    const p = out[out.length - 1];
    for (const r of elbow(p, q, arrived, raw[i + 1])) {
      const last = out[out.length - 1];
      if (samePt(last, r)) continue;
      arrived = direction(last, r);
      out.push(r);
    }
  }
  // The last piece is the port's own stub, drawn straight whatever came
  // before it: a run that reached the stub from the far side -- a tee seated
  // closer to a port than a stub is long -- is a spike the simplifier folds
  // away, not a corner to step round.
  out.push({ x: b.x, y: b.y });
  return { d: pointsToPath(simplifyPoints(out)), grip: null };
}

export function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return len;
}

/** Where a point falls on a polyline: the nearest point, how far along, which
 *  segment, and which way that segment runs. */
export interface OnPolyline {
  point: Pt;
  /** Fraction of the way along, by length, in [0, 1]. */
  t: number;
  /** Index of the segment the point is on. */
  segment: number;
  dir: Pt;
  /** Distance from the query point. */
  dist: number;
}

export function nearestOnPolyline(pts: Pt[], p: Pt): OnPolyline | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { point: pts[0], t: 0, segment: 0, dir: { x: 1, y: 0 }, dist: Math.hypot(p.x - pts[0].x, p.y - pts[0].y) };
  const total = polylineLength(pts) || 1;
  let best: OnPolyline | null = null;
  let before = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + u * dx, y: a.y + u * dy };
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    const len = Math.sqrt(len2);
    if (!best || dist < best.dist) {
      best = { point: q, t: (before + u * len) / total, segment: i, dir: direction(a, b) ?? { x: 1, y: 0 }, dist };
    }
    before += len;
  }
  return best;
}

/** The point a fraction of the way along a polyline, and the segment it is on. */
export function pointAt(pts: Pt[], t: number): { point: Pt; segment: number; dir: Pt } | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { point: pts[0], segment: 0, dir: { x: 1, y: 0 } };
  const target = Math.max(0, Math.min(1, t)) * polylineLength(pts);
  let before = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = direction(a, b);
    if (!dir) continue;
    if (before + len >= target - EPS || i === pts.length - 2) {
      const u = len < EPS ? 0 : Math.max(0, Math.min(1, (target - before) / len));
      return { point: { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) }, segment: i, dir };
    }
    before += len;
  }
  const last = pts[pts.length - 1];
  return { point: last, segment: pts.length - 2, dir: direction(pts[pts.length - 2], last) ?? { x: 1, y: 0 } };
}

/**
 * Move segment `i` across its own axis and keep both ends of the run where
 * they are.
 *
 * Only the component of `delta` across the segment is used: a horizontal
 * segment moves up or down, never along. A segment that touches one of the
 * ends cannot simply shift, because the end is a port -- so the port's stub
 * stays and a corner goes in after it. Drag the one segment of a straight
 * run and you get a jog with a stub at each end, which is the only shape
 * that move can have.
 */
export function dragSegment(pts: Pt[], i: number, delta: Pt): Pt[] {
  if (i < 0 || i >= pts.length - 1) return pts;
  const p = pts[i], q = pts[i + 1];
  const dir = direction(p, q);
  if (!dir) return pts;
  const horizontal = Math.abs(dir.y) < EPS;
  const shift = horizontal ? { x: 0, y: delta.y } : { x: delta.x, y: 0 };
  if (Math.abs(shift.x) < EPS && Math.abs(shift.y) < EPS) return pts;

  const first = i === 0;
  const last = i === pts.length - 2;
  const moved: Pt[] = [];
  if (first) {
    const s = { x: p.x + dir.x * STUB, y: p.y + dir.y * STUB };
    moved.push(p, s, { x: s.x + shift.x, y: s.y + shift.y });
  } else {
    moved.push({ x: p.x + shift.x, y: p.y + shift.y });
  }
  if (last) {
    const s = { x: q.x - dir.x * STUB, y: q.y - dir.y * STUB };
    moved.push({ x: s.x + shift.x, y: s.y + shift.y }, s, q);
  } else {
    moved.push({ x: q.x + shift.x, y: q.y + shift.y });
  }
  const out = [...pts];
  out.splice(i, 2, ...moved);
  return simplifyPoints(out);
}

/**
 * Put a detour into segment `i`: the `2·STUB` of it centred on `at` moves
 * across by `delta` and the rest stays. For getting a run round something
 * that is in its way.
 */
export function jogSegment(pts: Pt[], i: number, at: Pt, delta: Pt): Pt[] {
  if (i < 0 || i >= pts.length - 1) return pts;
  const p = pts[i], q = pts[i + 1];
  const dir = direction(p, q);
  if (!dir) return pts;
  const horizontal = Math.abs(dir.y) < EPS;
  const shift = horizontal ? { x: 0, y: delta.y } : { x: delta.x, y: 0 };
  if (Math.abs(shift.x) < EPS && Math.abs(shift.y) < EPS) return pts;
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  const along = Math.max(STUB, Math.min(Math.max(STUB, len - STUB),
    (at.x - p.x) * dir.x + (at.y - p.y) * dir.y));
  const g1 = { x: p.x + dir.x * (along - STUB), y: p.y + dir.y * (along - STUB) };
  const g2 = { x: p.x + dir.x * (along + STUB), y: p.y + dir.y * (along + STUB) };
  const out = [...pts];
  out.splice(i + 1, 0, g1, { x: g1.x + shift.x, y: g1.y + shift.y }, { x: g2.x + shift.x, y: g2.y + shift.y }, g2);
  return simplifyPoints(out);
}

/** The corners of a run between its two ends: what `routeThrough` stores. */
export function waypointsOf(pts: Pt[]): Pt[] {
  return pts.slice(1, -1);
}

/**
 * The closest point on a path to `p`.
 *
 * Clamped to each segment and the best one kept, so a junction always sits on
 * the pipe -- including exactly on a corner, which is where people aim when
 * they want to branch at a bend.
 */
export function nearestOnPath(d: string, p: Pt): Pt {
  return nearestOnPolyline(pathPoints(d), p)?.point ?? p;
}

/**
 * The face of a junction that points at (fx, fy).
 *
 * A junction is a 10 px dot with four ports, and which one a line attaches to
 * decides which way it leaves. Choosing by direction is what keeps the two
 * halves of a split line collinear with the run they replaced.
 */
export function faceTowards(fx: number, fy: number, jx: number, jy: number): string {
  const dx = fx - jx;
  const dy = fy - jy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l';
  return dy >= 0 ? 'b' : 't';
}
