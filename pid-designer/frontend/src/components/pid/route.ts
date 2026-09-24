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

/** A rectangle in flow coordinates: a symbol's body, or anything else a line keeps out of. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One end of a run: where it is, and which way it points. */
export interface End {
  x: number;
  y: number;
  side: Position;
  /**
   * How far to the side a detour has to go to clear whatever this end is
   * on. Unset means a symbol (see `CLEAR`). A tee is a ten-pixel dot and
   * says so, or every branch between two tees that had to go round went
   * round by a symbol's width.
   */
  clear?: number;
  /**
   * How far a line runs straight out of this end before it may turn.
   * Unset means a symbol's port (see `STUB`). A tee's is shorter: two tees
   * on runs thirty pixels apart otherwise had no room between their two
   * sixteen-pixel stubs for the one crossbar that joins them, and the
   * router went round both instead.
   */
  stub?: number;
  /**
   * How far behind its anchor a leg may run without it showing. Unset means
   * `INSET`, which is what both kinds of end have: a measured symbol handle's
   * outer edge sits three pixels beyond the body, and a tee's anchor three
   * beyond its dot. Two ends facing each other whose anchors overlap by less
   * than their two insets are still joined straight, or by a Z, because the
   * few pixels the legs run backwards are under the handles.
   */
  inset?: number;
  /**
   * The box of the symbol this end is a port of. With it the router knows
   * where the body actually is -- a tank's lid port is a hundred pixels from
   * the tank's far end, not sixty -- and never draws a line back through
   * it. Unset, it assumes the usual: a sixty-pixel symbol with the port in
   * the middle of its edge, or a tee's ten-pixel dot.
   */
  body?: Box;
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
export const STUB = 16;

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
export const ALIGNED = 4;

/**
 * The grid the canvas puts symbols on (React Flow's snap), and open ends,
 * new tees, the steps lines are moved apart by, and a tank's end ports.
 * One number: a copy of it anywhere that disagreed would take those off the
 * grid the symbols are on, and put a kink back into every run between them.
 */
export const GRID = 10;

/**
 * `at`, a point on the path `pts`, moved along the leg it is on to the
 * nearest grid line -- when that is still on the leg. Where a pointer puts
 * a new tee: read off the screen at any zoom but one, a pointer's place on
 * the drawing is a fraction of a pixel, and a tee put there was off the grid
 * the symbols it meets are on, so a line to it from one of them jogged by
 * the fraction, and a symbol lined up with it went off the grid with it.
 */
export function gridAlong(pts: Pt[], at: Pt): Pt {
  const near = nearestOnPolyline(pts, at);
  if (!near) return at;
  const a = pts[near.segment], b = pts[near.segment + 1];
  if (!b) return at;
  const p = near.point;
  const within = (v: number, u: number, w: number) => v >= Math.min(u, w) - 1e-9 && v <= Math.max(u, w) + 1e-9;
  if (Math.abs(a.y - b.y) < AXIS_EPS) {
    const x = Math.round(p.x / GRID) * GRID;
    return within(x, a.x, b.x) ? { x, y: p.y } : p;
  }
  if (Math.abs(a.x - b.x) < AXIS_EPS) {
    const y = Math.round(p.y / GRID) * GRID;
    return within(y, a.y, b.y) ? { x: p.x, y } : p;
  }
  return p;
}

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

/** How far behind its anchor a leg may run unseen; see `End.inset`. */
const INSET = 3;

/**
 * How much of a stored corner's leg has to show past the handle for the
 * corner to be kept where it was put. Less, and the line reads as leaving
 * its port sideways (`fitCorners`).
 */
const SHOW = 3;

/**
 * Two coordinates closer than this are the same coordinate.
 *
 * Ends come from React Flow measuring handles in the DOM, through the
 * viewport's scale, in single precision: a valve's outlet and the corner a
 * run left it at, which the drawing means to be one number, differ by a few
 * hundred-thousandths of a pixel. Compared exactly, that difference decided
 * which way a run turned, and drew a sixteen-pixel dip and a diagonal that
 * nobody had asked for. Half a pixel is far below anything a person draws on
 * purpose and far above anything a measurement gets wrong.
 */
export const AXIS_EPS = 0.5;

/**
 * What a corner costs when shapes are compared, in pixels of length. Every
 * chooser prices a route this way -- length plus this a corner (`routeCost`)
 * -- so they agree about which of two shapes is better.
 */
export const CORNER = 12;

/** What a drawn run costs when shapes are compared: its length, and `CORNER` a corner. */
export function routeCost(pts: Pt[]): number {
  return polylineLength(pts) + CORNER * Math.max(0, pts.length - 2);
}

/** The body the router assumes for a port when it is not told one. */
const SYMBOL = 60;
/** A tee's dot, across. */
const DOT = 10;
/** How far clear of a body a detour runs, beyond the body itself. */
const MARGIN = 4;
/**
 * What each pixel costs by which a leg out of a port falls short of its
 * stub, when shapes are compared. Shortening a stub is how a line gets out
 * through a gap narrower than one -- a valve one grid square off a tank --
 * and it should be the answer only when a full stub does not fit.
 */
const SHORT = 3;
/** What running down a channel too narrow for a margin costs, in pixels of length. */
const SCRAPE = 30;

export const isHorizontal = (p: Position) =>
  p === Position.Left || p === Position.Right;

/** +1 for right/down, -1 for left/up: the way a port points, as a sign. */
export const facing = (p: Position): 1 | -1 =>
  p === Position.Right || p === Position.Bottom ? 1 : -1;

/** The way a port points, as a unit vector. */
const unit = (p: Position): Pt =>
  (isHorizontal(p) ? { x: facing(p), y: 0 } : { x: 0, y: facing(p) });

const near = (u: number, v: number) => Math.abs(u - v) < AXIS_EPS;

/**
 * An end that needs less clearance than a symbol is a tee's dot -- the one
 * kind of end that says so (`J_END`).
 */
const isDot = (e: End) => (e.clear ?? CLEAR) < CLEAR;

/**
 * The box the thing an end belongs to occupies.
 *
 * `End.body` when the caller knows it. Otherwise the body's near edge is
 * the end's inset behind the anchor, and the port sits in the middle of that
 * edge -- which is exactly right for an ordinary symbol and for a tee, and
 * close enough near the port for anything else.
 */
function bodyOf(e: End): Box {
  if (e.body) return e.body;
  const f = unit(e.side);
  const inset = e.inset ?? INSET;
  const size = isDot(e) ? DOT : SYMBOL;
  if (isHorizontal(e.side)) {
    const edge = e.x - f.x * inset;
    return { x: f.x > 0 ? edge - size : edge, y: e.y - size / 2, w: size, h: size };
  }
  const edge = e.y - f.y * inset;
  return { x: e.x - size / 2, y: f.y > 0 ? edge - size : edge, w: size, h: size };
}

/**
 * Does an axis-aligned segment pass through the inside of a box?
 *
 * Shrunk by `inset` first, so a line running along a symbol's edge, or
 * starting on a port's handle, is not "inside" it.
 */
export function segmentEntersBox(p: Pt, q: Pt, b: Box, inset = AXIS_EPS): boolean {
  const x0 = b.x + inset, x1 = b.x + b.w - inset, y0 = b.y + inset, y1 = b.y + b.h - inset;
  if (x0 >= x1 || y0 >= y1) return false;
  if (near(p.y, q.y)) return p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1;
  if (near(p.x, q.x)) return p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1;
  // A diagonal is never drawn; judge it by its bounding box, which is the
  // conservative answer.
  return Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1;
}

/** The sign of each axis of the way p goes to q, or null when they coincide. */
function stepOf(p: Pt, q: Pt): Pt | null {
  const dx = near(p.x, q.x) ? 0 : Math.sign(q.x - p.x);
  const dy = near(p.y, q.y) ? 0 : Math.sign(q.y - p.y);
  return dx || dy ? { x: dx, y: dy } : null;
}

const sameStep = (d: Pt | null, e: Pt) => !!d && d.x === e.x && d.y === e.y;

/**
 * Where two non-adjacent segments of one path meet: a run that crosses
 * itself, or runs back over itself, is a knot whichever way it is drawn.
 */
function selfCrossings(pts: Pt[]): number {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let j = i + 2; j + 1 < pts.length; j++) {
      const [p1, p2, q1, q2] = [pts[i], pts[i + 1], pts[j], pts[j + 1]];
      const lo = (u: number, v: number) => Math.min(u, v) - AXIS_EPS / 2;
      const hi = (u: number, v: number) => Math.max(u, v) + AXIS_EPS / 2;
      if (hi(p1.x, p2.x) < lo(q1.x, q2.x) || hi(q1.x, q2.x) < lo(p1.x, p2.x)) continue;
      if (hi(p1.y, p2.y) < lo(q1.y, q2.y) || hi(q1.y, q2.y) < lo(p1.y, p2.y)) continue;
      n++;
    }
  }
  return n;
}

/**
 * How many things are wrong with a candidate shape: it leaves or reaches a
 * port the wrong way, crosses itself, or runs through either end's own body.
 * Zero is a shape that can be drawn.
 */
function faults(pts: Pt[], a: End, b: End): number {
  if (pts.length < 2) return 99;
  let n = 0;
  if (!sameStep(stepOf(pts[0], pts[1]), unit(a.side))) n++;
  const fb = unit(b.side);
  if (!sameStep(stepOf(pts[pts.length - 2], pts[pts.length - 1]), { x: -fb.x, y: -fb.y })) n++;
  return n + selfCrossings(pts) + bodyEntries(pts, a, b);
}

/** How many of a shape's segments run into either end's own body. */
const bodyEntries = (pts: Pt[], a: End, b: End) => entries(pts, [bodyOf(a), bodyOf(b)]);

interface Shape { pts: Pt[]; grip: Pt | null }
interface Candidate { pts: Pt[]; extra?: number }

/**
 * The best of several shapes for the same two ends.
 *
 * Fewest faults first, then the cheapest by length plus `CORNER` a corner
 * plus whatever the candidate carries for a stub it shortened. Equal ones
 * keep the order they were offered in, so the same ends always draw the same
 * shape and the choice never flickers from one frame to the next.
 */
function pick(cands: Candidate[], a: End, b: End): Pt[] {
  let best: { pts: Pt[]; f: number; c: number } | null = null;
  for (const cand of cands) {
    const pts = simplifyPoints(cand.pts);
    const f = faults(pts, a, b);
    const c = routeCost(pts) + (cand.extra ?? 0);
    if (!best || f < best.f || (f === best.f && c < best.c - 1e-9)) best = { pts, f, c };
  }
  return best!.pts;
}

/**
 * A copy of `b` with any coordinate within `AXIS_EPS` of `a`'s made equal
 * to it: two measurements of one number are one number.
 */
function alignTo(a: End, b: End): End {
  const x = near(a.x, b.x) ? a.x : b.x;
  const y = near(a.y, b.y) ? a.y : b.y;
  return x === b.x && y === b.y ? b : { ...b, x, y };
}

/**
 * The other crossbars a run between two ends facing each other can be drawn
 * with, as offsets from the middle (`routeOrthogonal`'s `offset`): at the
 * end of either end's stub, the furthest the crossbar can go either way.
 * None when the two do not face each other across room for a crossbar that
 * can move. What a line with a choice of crossbar -- a branch, say, whose
 * crossbar in the middle lies along its own pipe -- is priced on besides.
 */
export function crossbarOffsets(a: End, b0: End): number[] {
  const b = alignTo(a, b0);
  const aH = isHorizontal(a.side), bH = isHorizontal(b.side);
  const as = facing(a.side), bs = facing(b.side);
  if (aH !== bH || as !== -bs) return [];
  const pa = aH ? a.x : a.y, pb = aH ? b.x : b.y;
  const perp = Math.abs(aH ? a.y - b.y : a.x - b.x);
  if (perp <= ALIGNED) return [];
  const sa = a.stub ?? STUB, sb = b.stub ?? STUB;
  if ((pb - pa) * as <= sa + sb) return [];
  const mid = (pa + pb) / 2;
  return [pa + as * sa - mid, pb - as * sb - mid].filter(o => Math.abs(o) > AXIS_EPS);
}

export function routeOrthogonal(a: End, b: End, offset = 0): Route {
  const s = shapeOf(a, alignTo(a, b), offset);
  // A Z between ends whose anchors are level has legs of no length; drawn
  // as they are, they are corners on top of each other.
  return { d: pointsToPath(simplifyPoints(s.pts)), grip: s.grip };
}

function shapeOf(a: End, b: End, offset: number): Shape {
  const aH = isHorizontal(a.side);
  const bH = isHorizontal(b.side);
  const as = facing(a.side);
  const bs = facing(b.side);
  const sa = a.stub ?? STUB;
  const sb = b.stub ?? STUB;

  // The plain shapes below never reach the body the router assumes for an
  // end -- sixty across with the port in the middle, or a tee's dot -- but a
  // body the caller measured can be anywhere behind the port: a port near
  // the top of a tall tank's side has a hundred and fifty pixels of tank
  // below it, and the U out past it ran straight through. So when an end
  // says where its body is, a plain shape that runs into it has to compete
  // with the ways round, and the best of them is drawn.
  const told = !!(a.body || b.body);
  const plain = (s: Shape, round: () => Candidate[]): Shape =>
    (!told || bodyEntries(simplifyPoints(s.pts), a, b) === 0 ? s : { pts: pick([{ pts: s.pts }, ...round()], a, b), grip: null });

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
      const corner = { x: v.x, y: h.y };
      return plain({ pts: [pt(a), corner, pt(b)], grip: null }, () => cornerWays(a, b, h, v));
    }
    return { pts: pick(cornerWays(a, b, h, v), a, b), grip: null };
  }

  // ── Both horizontal, or both vertical ─────────────────────────────────────
  //
  // "Along" is the axis the two ends leave by, "across" the other one.
  const at = (along: number, across: number): Pt => (aH ? { x: along, y: across } : { x: across, y: along });
  const pa = aH ? a.x : a.y, pb = aH ? b.x : b.y;
  const qa = aH ? a.y : a.x, qb = aH ? b.y : b.x;
  const perp = Math.abs(qa - qb);
  const ia = a.inset ?? INSET, ib = b.inset ?? INSET;

  // Pointing at each other. The gap between them may be generous, tight, or
  // even a few pixels negative -- anchors that overlap by less than their
  // two insets -- and every one of those is a straight line or a Z, never a
  // loop: a loop is what the old rule drew whenever the gap was shorter
  // than the two stubs, and it crossed itself on the way back. In line, by
  // as much as the two insets: two symbols butted edge to edge, or a tee's
  // dot touching the open end its branch runs to, overlap by exactly that,
  // and the short line between them is hidden under the two ends, where a
  // loop round them hung off both.
  const overlap = -(pb - pa) * as;
  if (as === -bs && (overlap < ia + ib || (perp <= ALIGNED && overlap <= ia + ib + AXIS_EPS))) {
    if (perp <= ALIGNED) {
      // Level both ways -- two handles on top of each other -- the join
      // between the two anchors is the whole line. Lined up at one
      // coordinate, its two ends were one point, and a line of one point
      // draws nothing and cannot be pressed.
      if (pb === pa) return { pts: [pt(a), pt(b)], grip: null };
      const across = lineUp(a, b, qa, qb);
      return { pts: [at(pa, across), at(pb, across)], grip: null };
    }
    const bar = crossbar(pa, as, pb, sa, sb, offset);
    const pts = [pt(a), at(bar.at, qa), at(bar.at, qb), pt(b)];
    if (!bar.free) {
      const round = besideEachOther(a, b, aH, at, (pb - pa) * as, perp);
      if (round) return { pts: round, grip: null };
    }
    return plain({ pts, grip: bar.free ? at(bar.at, (qa + qb) / 2) : null }, () => asideWays(a, b, aH, at));
  }

  // Pointing the same way: the crossbar goes out past whichever is further
  // on, each end keeping its own stub. Unless the one further on is in the
  // way -- the other's leg would run up the side of it, and through it when
  // the two are nearly in line -- in which case the run goes round.
  if (as === bs) {
    const lead = (pb - pa) * as;
    const ahead = lead > 0 ? b : a;
    const doublesBack = Math.abs(lead) > (ahead.inset ?? INSET) && perp < (ahead.clear ?? CLEAR);
    if (!doublesBack) {
      const bar = as > 0 ? Math.max(pa + sa, pb + sb) : Math.min(pa - sa, pb - sb);
      return plain({ pts: [pt(a), at(bar, qa), at(bar, qb), pt(b)], grip: null }, () => asideWays(a, b, aH, at));
    }
  }

  // Facing apart, or doubling back: out of both ends, and round.
  return { pts: pick(asideWays(a, b, aH, at), a, b), grip: null };
}

const pt = (e: End): Pt => ({ x: e.x, y: e.y });

/**
 * Where a run whose two ends are a hair out of line is drawn.
 *
 * Across a tee and a symbol, at the symbol's coordinate: the tee's dot is
 * ten across and takes up the difference unseen, where moving the symbol's
 * end would draw a line that stops short of its port. Between two symbols,
 * or two tees, the average: neither has more right to it than the other.
 */
function lineUp(a: End, b: End, qa: number, qb: number): number {
  const ca = a.clear ?? CLEAR, cb = b.clear ?? CLEAR;
  if (ca < cb) return qb;
  if (cb < ca) return qa;
  return (qa + qb) / 2;
}

/**
 * Where the crossbar of a Z between two ends facing each other sits, and
 * whether it may be moved.
 *
 * With more room between them than their two stubs, anywhere in the gap
 * works, the midpoint is the default, and the reader may slide it -- but
 * never out of the gap: a crossbar dragged in a drawing saved before
 * corners were stored carries its offset still, and when an end moved
 * toward it that offset put the crossbar behind a port. So the offset is
 * held between the two stub ends. With less room, the two legs share what
 * there is equally, and there is nothing to slide.
 */
function crossbar(
  a: number, as: number, b: number, sa: number, sb: number, offset: number,
): { at: number; free: boolean } {
  const mid = (a + b) / 2;
  if ((b - a) * as > sa + sb) {
    const lo = Math.min(a + as * sa, b - as * sb);
    const hi = Math.max(a + as * sa, b - as * sb);
    return { at: Math.max(lo, Math.min(hi, mid + offset)), free: true };
  }
  return { at: mid, free: false };
}

/**
 * Two symbols side by side, their ports facing each other across a gap too
 * tight for the legs of a Z to show: the way round, if it is cheaper.
 *
 * A Z in a tight gap shares the gap between its two legs, and with a few
 * pixels of gap the legs are a pixel or two -- under the handles -- and the
 * crossbar runs the whole way across right along both symbols' faces. When
 * the two bodies overlap across, that is still the only honest shape: the
 * way round loops back over its own stubs. But symbols clear of each other
 * across have a channel between them, and the way round -- out of each
 * port by a full stub and across down the channel -- is an S that leaves
 * and arrives the way both ports face. So the two are priced alike, the Z
 * charged `SHORT` for every pixel its legs fall short of their stubs, and
 * the S is drawn when it comes out cheaper: for two symbols, when the Z's
 * legs would be under about four pixels. The price is the whole of the
 * rule. Bodies overlapping across leave no channel, and every way round
 * them is too long ever to win.
 *
 * Only between two symbols. A tee sits on a run, `J_ANCHOR` behind its
 * anchor, and the way round from a tee in a tight gap takes the other
 * end's stub straight across that run.
 */
function besideEachOther(
  a: End, b: End, horizontal: boolean, at: (along: number, across: number) => Pt, gap: number, perp: number,
): Pt[] | null {
  if (isDot(a) || isDot(b)) return null;
  const sa = a.stub ?? STUB, sb = b.stub ?? STUB;
  const leg = gap / 2;
  const z = Math.abs(gap) + perp + 2 * CORNER + SHORT * (Math.max(0, sa - leg) + Math.max(0, sb - leg));
  let best: { pts: Pt[]; c: number } | null = null;
  for (const cand of asideWays(a, b, horizontal, at)) {
    const pts = simplifyPoints(cand.pts);
    if (faults(pts, a, b)) continue;
    const c = routeCost(pts) + (cand.extra ?? 0);
    if (c < z - 1e-9 && (!best || c < best.c - 1e-9)) best = { pts, c };
  }
  return best?.pts ?? null;
}

/**
 * The band, across the axis an end leaves by, that its body occupies, with a
 * margin: a detour inside it runs through the body or scrapes it.
 */
function band(e: End, horizontal: boolean, margin = MARGIN): [number, number] {
  const b = bodyOf(e);
  return horizontal ? [b.y - margin, b.y + b.h + margin] : [b.x - margin, b.x + b.w + margin];
}

/**
 * The ways round, for two ends on the same axis that cannot be joined by
 * one crossbar: out of both stubs, across to a level clear of both, and
 * back.
 *
 * The level is chosen, not fixed. Beyond both on the high side, each end
 * cleared by its own clearance -- a tee's is a fraction of a symbol's; the
 * same on the low side; and the channel between the two bodies when there
 * is one, which is usually the short way and was never tried. `pick` throws
 * out a level that sends the run through either body, or across itself, and
 * draws the shortest of the rest. Ties go to the high side, offered first,
 * so a drawing does not flip sides from one frame to the next.
 */
function asideWays(a: End, b: End, horizontal: boolean, at: (along: number, across: number) => Pt): Candidate[] {
  const qa = horizontal ? a.y : a.x, qb = horizontal ? b.y : b.x;
  const ca = a.clear ?? CLEAR, cb = b.clear ?? CLEAR;
  const levels = [{ m: Math.max(qa + ca, qb + cb), extra: 0 }, { m: Math.min(qa - ca, qb - cb), extra: 0 }];
  // The channel between the two bodies, down its middle, when it is wide
  // enough to keep a margin from both. A channel narrower than that is taken
  // only as a last resort: a run scraping the side of a symbol reads as part
  // of it, and a longer way round usually exists.
  for (const margin of [MARGIN, 0]) {
    const [a0, a1] = band(a, horizontal, margin), [b0, b1] = band(b, horizontal, margin);
    const gap = a1 <= b0 ? [a1, b0] : b1 <= a0 ? [b1, a0] : null;
    if (gap) { levels.push({ m: (gap[0] + gap[1]) / 2, extra: margin ? 0 : SCRAPE }); break; }
  }
  const cands: Candidate[] = [];
  for (const la of stubsOut(a, b, horizontal)) {
    for (const lb of stubsOut(b, a, horizontal)) {
      for (const { m, extra } of levels) {
        cands.push({
          pts: [pt(a), at(la.at, qa), at(la.at, m), at(lb.at, m), at(lb.at, qb), pt(b)],
          extra: la.extra + lb.extra + extra,
        });
      }
    }
  }
  return cands;
}

/**
 * Where an end's leg may stop, along the axis it leaves by: at its stub,
 * or -- when the other end's body is right in front of it, nearer than a
 * stub -- halfway into the gap, at a price per pixel short (`SHORT`).
 */
function stubsOut(e: End, other: End, horizontal: boolean): { at: number; extra: number }[] {
  const f = facing(e.side), s = e.stub ?? STUB;
  const pe = horizontal ? e.x : e.y;
  const out = [{ at: pe + f * s, extra: 0 }];
  const ob = bodyOf(other);
  const edge = horizontal ? (f > 0 ? ob.x : ob.x + ob.w) : (f > 0 ? ob.y : ob.y + ob.h);
  const gap = (edge - pe) * f;
  if (gap > 0 && gap < s) out.push({ at: (pe + edge) / 2, extra: SHORT * (s - gap / 2) });
  return out;
}

/**
 * One end leaving sideways and one up or down, where the plain corner is
 * behind one of them.
 *
 * Out of the sideways end to a column, along to a row, and into the other
 * end: three corners. The column is the sideways end's stub, or beside the
 * other end's body, or -- when the other body is right in front of it --
 * halfway into the gap; the row likewise. Every pairing is offered and
 * `pick` draws the best, which is what stops a regulator's top port reaching
 * a valve below-left by running down through the regulator, and gets a vent
 * valve one grid square off a tank out through the gap instead of into the
 * tank.
 */
function cornerWays(a: End, b: End, h: End, v: End): Candidate[] {
  const hs = facing(h.side), vs = facing(v.side);
  const sh = h.stub ?? STUB, sv = v.stub ?? STUB;
  const hBody = bodyOf(h), vBody = bodyOf(v);
  // Columns ahead of the sideways end, and rows ahead of the other.
  const xs: { at: number; extra: number }[] = [{ at: h.x + hs * sh, extra: 0 }];
  const ys: { at: number; extra: number }[] = [{ at: v.y + vs * sv, extra: 0 }];
  const [vx0, vx1] = band(v, false), [hy0, hy1] = band(h, true);
  for (const x of [vx0, vx1]) xs.push({ at: x, extra: 0 });
  for (const y of [hy0, hy1]) ys.push({ at: y, extra: 0 });
  // Halfway into a gap narrower than a stub, when the other body is what
  // stands in front of the port.
  const gapX = hs > 0 ? vBody.x : vBody.x + vBody.w;
  if ((gapX - h.x) * hs > 0 && (gapX - h.x) * hs < sh) xs.push({ at: (h.x + gapX) / 2, extra: 0 });
  const gapY = vs > 0 ? hBody.y : hBody.y + hBody.h;
  if ((gapY - v.y) * vs > 0 && (gapY - v.y) * vs < sv) ys.push({ at: (v.y + gapY) / 2, extra: 0 });

  const cands: Candidate[] = [];
  for (const X of xs) {
    const legH = (X.at - h.x) * hs;
    // The two full stubs are always on offer, so there is always a shape.
    if (legH <= 0 && X !== xs[0]) continue;
    for (const Y of ys) {
      const legV = (Y.at - v.y) * vs;
      if (legV <= 0 && Y !== ys[0]) continue;
      const extra = SHORT * (Math.max(0, sh - legH) + Math.max(0, sv - legV));
      const pts = h === a
        ? [pt(a), { x: X.at, y: a.y }, { x: X.at, y: Y.at }, { x: b.x, y: Y.at }, pt(b)]
        : [pt(a), { x: a.x, y: Y.at }, { x: X.at, y: Y.at }, { x: X.at, y: b.y }, pt(b)];
      cands.push({ pts, extra });
    }
  }
  return cands;
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

/** For arithmetic that must not divide by nothing; not for comparing positions. */
const EPS = 1e-9;

const samePt = (a: Pt, b: Pt) => near(a.x, b.x) && near(a.y, b.y);

/** The corners of an M/L path, in order. Arcs (hops) are skipped, which is
 *  right: a hop is drawn on a segment, not a corner in it. */
export function pathPoints(d: string): Pt[] {
  const num = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)';
  return [...d.matchAll(new RegExp(`[ML]\\s*${num},${num}`, 'gi'))]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]) }));
}

export function pointsToPath(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
}

/**
 * A coordinate-snapper: every value within `AXIS_EPS` of one already seen
 * becomes that one. Seeded with the values that must not move (a run's two
 * ends), so it is the in-between points that give way.
 */
function snapper(fixed: number[]): (v: number) => number {
  const reps = [...fixed];
  return v => {
    for (const r of reps) if (Math.abs(v - r) < AXIS_EPS) return r;
    reps.push(v);
    return v;
  };
}

/**
 * Drop repeated points and the middle of any three in a line.
 *
 * "In a line" includes a spike -- out along an axis and back along it -- so a
 * segment dragged until it lies on its neighbour merges into it rather than
 * leaving a zero-width tooth.
 *
 * Coordinates within `AXIS_EPS` of each other are made one first, the two
 * ends' own values winning, so a run that was straight to the eye comes out
 * exactly straight: a sub-pixel jog left in would be a diagonal on screen,
 * or decide which way the next corner turns.
 */
export function simplifyPoints(pts: Pt[]): Pt[] {
  if (pts.length === 0) return [];
  const first = pts[0], last = pts[pts.length - 1];
  const sx = snapper([first.x, last.x]), sy = snapper([first.y, last.y]);
  const out: Pt[] = [];
  for (const p of pts) {
    const q = { x: sx(p.x), y: sy(p.y) };
    if (out.length && samePt(out[out.length - 1], q)) continue;
    out.push(q);
  }
  let i = 1;
  while (i < out.length - 1) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const sameX = a.x === b.x && b.x === c.x;
    const sameY = a.y === b.y && b.y === c.y;
    if (sameX || sameY) {
      out.splice(i, 1);
      if (i < out.length && samePt(out[i - 1], out[i])) out.splice(i, 1);
      i = Math.max(1, i - 1);
    } else i++;
  }
  // A spike can leave two equal neighbours behind; one more pass clears it.
  for (let k = out.length - 2; k >= 0; k--) if (samePt(out[k], out[k + 1])) out.splice(k + 1, 1);
  return out;
}

/**
 * A unit vector from a to b, or null when they coincide.
 *
 * Within `AXIS_EPS` of an axis it is that axis exactly: a segment measured
 * a hundred-thousandth of a pixel off vertical is vertical.
 */
export function direction(a: Pt, b: Pt): Pt | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const onX = Math.abs(dx) >= AXIS_EPS, onY = Math.abs(dy) >= AXIS_EPS;
  if (!onX && !onY) return null;
  if (!onY) return { x: Math.sign(dx), y: 0 };
  if (!onX) return { x: 0, y: Math.sign(dy) };
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len };
}

/** The point a port's stub ends at: `STUB` out of the port, the way it faces. */
export function stubOf(e: End): Pt {
  const s = e.stub ?? STUB;
  return isHorizontal(e.side)
    ? { x: e.x + facing(e.side) * s, y: e.y }
    : { x: e.x, y: e.y + facing(e.side) * s };
}

/**
 * The corners between two points that are not in line: one.
 *
 * It continues the axis the run arrived on when the next point is ahead on
 * it, and turns across first when it is behind. Two points in line are
 * joined straight, whichever way that goes: a corner in the middle of a run
 * that doubles back on its neighbour is a spike, and `simplifyPoints` folds
 * it away. Only the leg out of a port may not do that (see `stepOut`).
 */
function elbow(p: Pt, q: Pt, arrived: Pt): Pt[] {
  const dx = !near(p.x, q.x), dy = !near(p.y, q.y);
  if (!dx && !dy) return [];
  if (!dx || !dy) return [q];
  const horizontalArrival = arrived.x !== 0;
  const ahead = (q.x - p.x) * arrived.x + (q.y - p.y) * arrived.y;
  const horizontalFirst = horizontalArrival ? ahead > 0 : ahead <= 0;
  return horizontalFirst ? [{ x: q.x, y: p.y }, q] : [{ x: p.x, y: q.y }, q];
}

/**
 * The join from the end of a port's stub to the first corner.
 *
 * The one place a run may not double back: a corner in line with the port
 * and behind the stub would send the line back through the symbol it came
 * out of. So it steps across first, by that end's own clearance -- a tee's
 * fourteen, a symbol's forty-four -- toward wherever the run goes next, and
 * the corner itself is not visited: it sits in the port's own column, inside
 * the symbol, and what it meant was the level it was dragged to.
 */
function stepOut(p: Pt, u: Pt, q: Pt, after: Pt, clear: number): Pt[] {
  const d = stepOf(p, q);
  if (d && (d.x === 0 || d.y === 0) && d.x === -u.x && d.y === -u.y) {
    const horizontal = u.x !== 0;
    const side = horizontal ? (after.y >= p.y ? 1 : -1) : (after.x >= p.x ? 1 : -1);
    const c1 = horizontal ? { x: p.x, y: p.y + side * clear } : { x: p.x + side * clear, y: p.y };
    const c2 = horizontal ? { x: q.x, y: c1.y } : { x: c1.x, y: q.y };
    return [c1, c2];
  }
  return elbow(p, q, u);
}

/**
 * The join from the last corner to the end of the target's stub, worked
 * out from the target's side.
 *
 * The line has to reach the stub coming from outside -- never moving away
 * from the port, or the stub folds back over it and the last leg enters the
 * port from behind, through the symbol. Of the two one-corner joins, the one
 * that arrives properly is taken; one that also does not reverse the leg it
 * leaves along is preferred. In line and pointing the wrong way, it steps
 * round by the target's clearance. `strict` says the leg it leaves along is
 * a port's own stub, which may not be reversed either.
 */
function stepIn(p: Pt, u: Pt, strict: boolean, q: Pt, fb: Pt, clear: number): Pt[] | null {
  const away = (d: Pt | null) => sameStep(d, fb);
  const back = (d: Pt | null) => sameStep(d, { x: -u.x, y: -u.y });
  const d = stepOf(p, q);
  if (!d) return away(u) ? null : [];
  if (d.x === 0 || d.y === 0) {
    if (!away(d) && !(strict && back(d))) return [q];
    // Straight back along a port's own stub: nothing honest to draw.
    if (!away(d)) return null;
    // In line with the target and beyond it: round the target, by its
    // clearance, on the side the run was already heading.
    const n = d.x === 0 ? { x: u.x !== 0 ? u.x : 1, y: 0 } : { x: 0, y: u.y !== 0 ? u.y : 1 };
    if (strict && back(n)) return null;
    return [{ x: p.x + n.x * clear, y: p.y + n.y * clear }, { x: q.x + n.x * clear, y: q.y + n.y * clear }, q];
  }
  const options = [[{ x: q.x, y: p.y }, q], [{ x: p.x, y: q.y }, q]].map(route => {
    const first = stepOf(p, route[0]), lastStep = stepOf(route[0], q);
    return { route, ok: !away(lastStep) && !(strict && back(first)), spike: back(first), onward: sameStep(first, u) };
  }).filter(o => o.ok);
  if (!options.length) return null;
  options.sort((x, y) => (+x.spike - +y.spike) || (+y.onward - +x.onward));
  return options[0].route;
}

/** How far `p` is out in front of an end, along the way it faces. */
const aheadOf = (e: End, p: Pt) => {
  const f = unit(e.side);
  return (p.x - e.x) * f.x + (p.y - e.y) * f.y;
};
/** Is `p` on the line out of an end, along the way it faces? */
const onAxis = (e: End, p: Pt) => (isHorizontal(e.side) ? near(p.y, e.y) : near(p.x, e.x));

/**
 * Stored corners, fitted to where the ends are now.
 *
 * Corners are stored as absolute points, and the first and last of them
 * were put there against where the ports were at the time: the first on the
 * start port's axis, the last on the end port's. Move a port and, drawn as
 * stored, the run grows a hook at that end, or its last leg runs back
 * through the symbol. So they are read as what they meant -- "leave along
 * this port, turn at this level" -- and fitted again:
 *
 *  - the first corner is put back on the start port's axis, and the last on
 *    the end port's (with the corner sharing the leg, so the leg stays
 *    square);
 *  - one that is no longer out in front of its port, or so little that its
 *    leg barely shows past the handle (`SHOW`), is moved out to the end of
 *    the port's stub, again with the corner sharing its leg. A port nudged
 *    toward its first corner used to leave by a pixel and turn, which reads
 *    as leaving sideways, and the column after it ran down the symbol's
 *    face.
 *
 * A corner further out than that is left where it is, however much short of
 * the stub: a run that leaves a port by a short leg on purpose -- a slice of
 * a pipe whose tee sits near a corner, a Z sharing a narrow gap -- has to be
 * drawn as stored.
 *
 * Null when the two ends' corners can no longer both be in front of their
 * ports by that much: the routing no longer fits between them, and the line
 * routes itself (`routeThrough`).
 */
function fitCorners(a: End, b: End, c: Pt[]): Pt[] | null {
  const pts = c.map(p => ({ ...p }));
  const n = pts.length;
  const aH = isHorizontal(a.side), bH = isHorizontal(b.side);
  const acrossA: 'x' | 'y' = aH ? 'y' : 'x', alongA: 'x' | 'y' = aH ? 'x' : 'y';
  const acrossB: 'x' | 'y' = bH ? 'y' : 'x', alongB: 'x' | 'y' = bH ? 'x' : 'y';
  // Which corner is each port's turn off its own axis: the first one when
  // the leg after it runs across the port's axis, the last likewise. A
  // lone corner between two ports at right angles is both.
  const ownA = n === 1 ? aH !== bH : near(pts[0][alongA], pts[1][alongA]);
  const ownB = n === 1 ? aH !== bH : near(pts[n - 1][alongB], pts[n - 2][alongB]);

  if (ownA) pts[0][acrossA] = a[acrossA];
  if (ownB) pts[n - 1][acrossB] = b[acrossB];

  const clamp = (e: End, i: number, j: number, along: 'x' | 'y') => {
    if (aheadOf(e, pts[i]) >= shown(e) - AXIS_EPS) return;
    const to = stubOf(e)[along];
    const was = pts[i][along];
    pts[i][along] = to;
    if (j >= 0 && j < n && near(pts[j][along], was)) pts[j][along] = to;
  };
  if (ownA) clamp(a, 0, n > 1 ? 1 : -1, alongA);
  if (ownB) clamp(b, n - 1, n > 1 ? n - 2 : -1, alongB);

  if (ownA && (!onAxis(a, pts[0]) || aheadOf(a, pts[0]) < shown(a) - AXIS_EPS)) return null;
  if (ownB && (!onAxis(b, pts[n - 1]) || aheadOf(b, pts[n - 1]) < shown(b) - AXIS_EPS)) return null;
  return pts;
}

/**
 * The shortest leg out of an end that shows (`SHOW`) past its handle -- or
 * the end's whole stub, when that is shorter: a tee's is six, and a corner
 * six along a tee's leg is where its pipe put it.
 */
const shown = (e: End) => Math.min(e.stub ?? STUB, (e.inset ?? INSET) + SHOW);

/**
 * Stored corners with an end standing exactly on its own turn: that corner
 * moved out to the end of the end's stub, and the corner sharing its leg
 * with it, as `fitCorners` moves a corner a hair in front of its port.
 * Tidied away as a corner on an end instead, the run lost its turn, and for
 * that one position of the end was drawn by the router somewhere else.
 */
function offEnds(a: End, b: End, c: Pt[]): Pt[] {
  const pts = c.map(p => ({ ...p }));
  const lift = (e: End, i: number, j: number, far: End) => {
    if (i < 0 || i >= pts.length || !samePt(pts[i], e)) return;
    const next = j >= 0 && j < pts.length ? pts[j] : null;
    // Its own turn only: where the run goes next is off the end's axis.
    if (onAxis(e, next ?? far)) return;
    const along: 'x' | 'y' = isHorizontal(e.side) ? 'x' : 'y';
    const to = stubOf(e)[along];
    if (next && near(next[along], pts[i][along])) next[along] = to;
    pts[i][along] = to;
  };
  lift(a, 0, 1, b);
  lift(b, pts.length - 1, pts.length - 2, a);
  return pts;
}

/**
 * Stored corners with the noise taken out: repeats, corners sitting on an
 * end, and the middle of three in a line dropped.
 */
function tidyCorners(a: Pt, b: Pt, c: Pt[]): Pt[] {
  const all = [a, ...c.filter(p => !samePt(p, a) && !samePt(p, b)), b];
  const out: Pt[] = [];
  for (const p of all) if (!out.length || !samePt(out[out.length - 1], p)) out.push(p);
  let i = 1;
  while (i < out.length - 1) {
    const [p, q, r] = [out[i - 1], out[i], out[i + 1]];
    if ((near(p.x, q.x) && near(q.x, r.x)) || (near(p.y, q.y) && near(q.y, r.y))) {
      out.splice(i, 1);
      i = Math.max(1, i - 1);
    } else i++;
  }
  return out.slice(1, -1);
}

/** Does a drawn run leave `a` and reach `b` the way their ports face, square all the way? */
function leavesAndArrives(pts: Pt[], a: End, b: End): boolean {
  if (pts.length < 2) return false;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (!near(pts[i].x, pts[i + 1].x) && !near(pts[i].y, pts[i + 1].y)) return false;
  }
  const fb = unit(b.side);
  return sameStep(stepOf(pts[0], pts[1]), unit(a.side))
    && sameStep(stepOf(pts[pts.length - 2], pts[pts.length - 1]), { x: -fb.x, y: -fb.y });
}

/**
 * The run through corners the router put down, exactly as they are, while
 * they still fit: the first on the start port's axis and in front of it, the
 * last likewise for the end, every leg square, and nothing crossing itself.
 * Null once they do not, when the line is drawn as `routeThrough` fits them.
 *
 * `routeThrough` fits corners to where the ports are now, and moves one that
 * is barely in front of its port out to the end of the port's stub -- right
 * for corners a person placed, which a moved port has walked up to. But the
 * router itself leaves a port by less than a stub where the gap in front of
 * it is narrower, and a pipe's slices carry what the router drew: refitted,
 * a slice was drawn a few pixels off the path the pipe's tees were placed
 * on, and inside the symbol the pipe had been routed round.
 */
export function throughAsStored(a: End, b: End, corners: Pt[]): Pt[] | null {
  if (!corners.length) return null;
  const first = corners[0], last = corners[corners.length - 1];
  if (!onAxis(a, first) || aheadOf(a, first) <= AXIS_EPS) return null;
  if (!onAxis(b, last) || aheadOf(b, last) <= AXIS_EPS) return null;
  const pts = [pt(a), ...corners.map(p => ({ ...p })), pt(b)];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (!near(pts[i].x, pts[i + 1].x) && !near(pts[i].y, pts[i + 1].y)) return null;
  }
  const run = simplifyPoints(pts);
  return selfCrossings(run) ? null : run;
}

/**
 * A run through the corners somebody placed.
 *
 * The ends are still the router's business: each leaves its port along the
 * port's own axis, and the corners are fitted to where the ports are now
 * (`fitCorners`), so a stored corner follows the port it belongs to rather
 * than growing a hook when the port moves. Every pair of points after that
 * is joined orthogonally, so a waypoint that is off both axes of its
 * neighbour gets one corner put in on the way; the last join is worked out
 * from the target's side, so the line always reaches the target from
 * outside. Only the legs out of a port are kept from doubling back (they
 * step round, by that end's clearance); a corner in the middle of a run
 * that doubles back is a spike, and folds away.
 *
 * With no corners, or corners that no longer fit between the ends, the run
 * routes itself (`routeOrthogonal`). So does a run that the stored corners
 * would send across itself: an end moved past a detour somebody put in
 * beside it leaves that detour on the far side of the port, and drawn as
 * stored the run loops back over its own first leg. The corners are kept --
 * move the end back and they are drawn again -- but a knot is never drawn.
 */
export function routeThrough(a0: End, b0: End, waypoints: Pt[]): Route {
  const run = waypoints.length ? threaded(a0, b0, waypoints) : null;
  if (!run || run === KNOT) return routeOrthogonal(a0, b0);
  return { d: pointsToPath(run), grip: null };
}

/** What `threaded` says of stored corners that can only be drawn crossing themselves. */
const KNOT = 'knot' as const;

/**
 * The run through stored corners, as `routeThrough` draws it: the points,
 * or null when the corners no longer fit between the ends, or `KNOT` when
 * they fit but the run through them crosses itself. Either way the line is
 * drawn by the router instead; the difference matters to a segment edit,
 * which goes only as far as it can without tying a knot (`asFarAs`).
 */
function threaded(a0: End, b0: End, waypoints: Pt[]): Pt[] | typeof KNOT | null {
  // Measurements of one number are one number: the corners take the ends'
  // own coordinates, and their stubs', wherever they are within a hair.
  const sx = snapper([a0.x]), sy = snapper([a0.y]);
  const a: End = a0;
  const b: End = { ...b0, x: sx(b0.x), y: sy(b0.y) };
  for (const s of [stubOf(a), stubOf(b)]) { sx(s.x); sy(s.y); }
  const stored = tidyCorners(pt(a), pt(b), offEnds(a, b, waypoints.map(p => ({ x: sx(p.x), y: sy(p.y) }))));
  const corners = stored.length ? fitCorners(a, b, stored) : null;
  const pts = corners && thread(a, b, corners);
  if (!pts || !leavesAndArrives(pts, a, b)) return null;
  if (selfCrossings(pts)) return KNOT;
  // An end moved past the corners beyond its stub leaves them behind the
  // port, and the run goes back through the symbol to reach them. Where the
  // caller says where the symbols are, that is judged against the router's
  // own route: a port whose handle sits inside its symbol cannot be left
  // without entering it, and that is no reason to give up the corners.
  const told = [a0.body, b0.body].filter((x): x is Box => !!x);
  if (told.length && entries(pts, told) > entries(pathPoints(routeOrthogonal(a0, b0).d), told)) return KNOT;
  return pts;
}

/** How many of a run's segments pass through the inside of any of the boxes. */
function entries(pts: Pt[], boxes: Box[]): number {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) for (const bx of boxes) if (segmentEntersBox(pts[i], pts[i + 1], bx)) n++;
  return n;
}

/** The run from `a` through fitted corners to `b`, or null when it cannot be joined up. */
function thread(a: End, b: End, c: Pt[]): Pt[] | null {
  const fa = unit(a.side), fb = unit(b.side);
  const out: Pt[] = [pt(a)];
  let arrived = fa;
  // Still on a's own leg: nothing may turn back along it.
  let onOwnLeg = true;
  const push = (r: Pt) => {
    const last = out[out.length - 1];
    const d = stepOf(last, r);
    if (!d) return;
    if (!sameStep(d, fa)) onOwnLeg = false;
    arrived = d;
    out.push(r);
  };

  // Out of a: straight to the first corner when it is on the port's axis
  // and in front of it (how far in front is `fitCorners`' business);
  // otherwise out along the stub first.
  const first = c[0];
  if (onAxis(a, first) && aheadOf(a, first) >= AXIS_EPS) push(first);
  else {
    push(stubOf(a));
    for (const r of stepOut(out[out.length - 1], fa, first, c[1] ?? stubOf(b), a.clear ?? CLEAR)) push(r);
  }
  // Through the rest.
  for (let i = 1; i < c.length; i++) for (const r of elbow(out[out.length - 1], c[i], arrived)) push(r);
  // Into b: straight from the last corner when it is on b's axis and in
  // front of it, otherwise to b's stub, joined from b's side.
  const last = out[out.length - 1];
  if (onAxis(b, last) && aheadOf(b, last) >= AXIS_EPS) push(pt(b));
  else {
    const via = stepIn(last, arrived, onOwnLeg, stubOf(b), fb, b.clear ?? CLEAR);
    if (!via) return null;
    for (const r of via) push(r);
    push(pt(b));
  }
  return simplifyPoints(out);
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
  /** How far along, in pixels of length (`t` times the length). */
  s: number;
  /** Index of the segment the point is on. */
  segment: number;
  dir: Pt;
  /** Distance from the query point. */
  dist: number;
}

export function nearestOnPolyline(pts: Pt[], p: Pt): OnPolyline | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { point: pts[0], t: 0, s: 0, segment: 0, dir: { x: 1, y: 0 }, dist: Math.hypot(p.x - pts[0].x, p.y - pts[0].y) };
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
      const s = before + u * len;
      best = { point: q, t: s / total, s, segment: i, dir: direction(a, b) ?? { x: 1, y: 0 }, dist };
    }
    before += len;
  }
  return best;
}

// ── Distance along a run ─────────────────────────────────────────────────────
//
// A pipe is cut into lines at its tees, and what each line keeps of the
// pipe's corners is decided by length along the pipe, not by a straight-line
// distance: a corner twenty pixels from a tee as the crow flies can be two
// hundred along the pipe, round a bend. These say where things are in those
// terms.

/**
 * How far along a polyline each of its points is: nought for the first, the
 * whole length for the last.
 */
export function arcsOf(pts: Pt[]): number[] {
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    out.push(s);
  }
  return out;
}

/**
 * The point `s` pixels along a polyline, held to its two ends, and the
 * segment it is on. A point exactly on a corner is on the segment before it,
 * as with `pointAt`.
 */
export function pointAtArc(pts: Pt[], s: number): { point: Pt; segment: number; dir: Pt } | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { point: pts[0], segment: 0, dir: { x: 1, y: 0 } };
  const target = Math.max(0, Math.min(polylineLength(pts), s));
  let before = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = direction(a, b);
    if (!dir) { before += len; continue; }
    if (before + len >= target - EPS || i === pts.length - 2) {
      const u = len < EPS ? 0 : Math.max(0, Math.min(1, (target - before) / len));
      return { point: { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) }, segment: i, dir };
    }
    before += len;
  }
  const last = pts[pts.length - 1];
  return { point: last, segment: pts.length - 2, dir: direction(pts[pts.length - 2], last) ?? { x: 1, y: 0 } };
}

/** The point a fraction of the way along a polyline, and the segment it is on. */
export function pointAt(pts: Pt[], t: number): { point: Pt; segment: number; dir: Pt } | null {
  return pointAtArc(pts, Math.max(0, Math.min(1, t)) * polylineLength(pts));
}

/**
 * The piece of a polyline between two distances along it: the point at
 * `s0`, every corner strictly between, and the point at `s1` -- in the order
 * asked for, so `s1 < s0` gives the piece reversed.
 *
 * This is what a line between two tees on a pipe draws, and why a corner
 * is judged by where it is along the pipe: one that falls within half a
 * pixel of a cut belongs to neither side, since the cut is standing on it.
 */
export function sliceByArc(pts: Pt[], s0: number, s1: number): Pt[] {
  if (pts.length < 2) return pts.map(p => ({ ...p }));
  if (s1 < s0) return sliceByArc(pts, s1, s0).reverse();
  const arcs = arcsOf(pts);
  const inner = pts.filter((_, i) => arcs[i] > s0 + AXIS_EPS && arcs[i] < s1 - AXIS_EPS);
  return [pointAtArc(pts, s0)!.point, ...inner.map(p => ({ ...p })), pointAtArc(pts, s1)!.point];
}

/**
 * What the segment edits need to know about the run's two ends.
 *
 * `a` and `b` are each end's own stub -- a symbol's port is `STUB`, a tee's
 * face its own shorter one; unset is a symbol. `ends` are the ends
 * themselves, when the caller has them: an edited run is fitted to them
 * exactly as `routeThrough` will draw the corners it stores. Without them
 * they are read off the run: where it starts and ends, and the way its first
 * and last legs go.
 */
export interface SegmentStubs {
  a?: number;
  b?: number;
  ends?: { a: End; b: End };
}

const stubA = (o: SegmentStubs) => o.a ?? o.ends?.a.stub ?? STUB;
const stubB = (o: SegmentStubs) => o.b ?? o.ends?.b.stub ?? STUB;

/** A side from the way a leg leaves it. */
const sideOf = (d: Pt): Position =>
  (d.x > 0 ? Position.Right : d.x < 0 ? Position.Left : d.y > 0 ? Position.Bottom : Position.Top);

/**
 * The two ends a drawn run joins. Given, or read off the run; null when the
 * run's own legs are too short to say which way its ports face (a Z whose
 * legs run under the handles).
 */
function endsOf(pts: Pt[], o: SegmentStubs): { a: End; b: End } | null {
  if (o.ends) return o.ends;
  const n = pts.length;
  if (n < 2) return null;
  const legA = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  const legB = Math.hypot(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y);
  const da = direction(pts[0], pts[1]), db = direction(pts[n - 1], pts[n - 2]);
  if (!da || !db || (da.x && da.y) || (db.x && db.y) || legA < INSET || legB < INSET) return null;
  // A stub shorter than a symbol's is a tee's, which is cleared by its dot and a little.
  const end = (p: Pt, d: Pt, stub: number | undefined): End => ({
    x: p.x, y: p.y, side: sideOf(d),
    ...(stub !== undefined ? { stub } : {}),
    ...(stub !== undefined && stub < STUB ? { clear: DOT + MARGIN } : {}),
  });
  return { a: end(pts[0], da, o.a), b: end(pts[n - 1], db, o.b) };
}

/**
 * An edited run as it will be drawn: the corners it stores, put through
 * `routeThrough` with the run's ends. An edit can fold a run back on itself
 * -- a segment dragged onto the level of a port's leg merges into it and
 * reverses it -- and whatever `routeThrough` makes of the stored corners is
 * what is on the screen after the drag, so that is what the drag shows.
 *
 * Null for an edit that would tie the run in a knot -- a segment dragged
 * across another part of its own run. `routeThrough` would draw that line
 * by the router, and storing what it drew would throw away every other
 * corner somebody placed; so the edit goes only as far as it can without
 * one (`asFarAs`).
 */
function asDrawn(out: Pt[], pts: Pt[], o: SegmentStubs): Pt[] | null {
  const next = simplifyPoints(out);
  const ends = endsOf(pts, o);
  if (!ends) return next;
  // An edit that straightens the run out stores no corners, and a line with
  // none is the router's -- which is not always the straight line: two ends
  // facing the same way, one in front of the other, go round.
  if (next.length < 3) return pathPoints(routeOrthogonal(ends.a, ends.b).d);
  const run = threaded(ends.a, ends.b, waypointsOf(next));
  if (run === KNOT) return null;
  return run ?? pathPoints(routeOrthogonal(ends.a, ends.b).d);
}

/**
 * How far a segment may be moved across without the leg before it, or the
 * leg after it, running back past a port's stub.
 *
 * The leg out of a port and the segment after it are at right angles, so
 * moving that segment across lengthens or shortens the port's leg. Short of
 * the stub, the next corner is the port's own, drawn inside it -- the line
 * hooks at the port. A leg already shorter than the stub (a tight Z) may not
 * get shorter still. `which` says which end's leg is moved. Null when the two
 * ends' limits leave no room at all.
 */
function clampAcross(
  pts: Pt[], i: number, shift: Pt, o: SegmentStubs, which = { a: true, b: true },
): Pt | null {
  const n = pts.length;
  let s = { ...shift };
  const limits: { u: Pt; min: number; max: number }[] = [];
  const legOf = (p: Pt, q: Pt, stub: number, sign: 1 | -1) => {
    const u = direction(p, q);
    if (!u || (u.x !== 0 && u.y !== 0)) return;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const floor = Math.min(stub, len);
    // The port's leg becomes len + sign * (shift . u) long.
    if (sign > 0) limits.push({ u, min: floor - len, max: Infinity });
    else limits.push({ u, min: -Infinity, max: len - floor });
  };
  if (which.a && i === 1) legOf(pts[0], pts[1], stubA(o), 1);
  if (which.b && i === n - 3) legOf(pts[n - 2], pts[n - 1], stubB(o), -1);
  for (const { u, min, max } of limits) {
    const along = s.x * u.x + s.y * u.y;
    const to = Math.max(min, Math.min(max, along));
    if (to !== along) s = { x: s.x + u.x * (to - along), y: s.y + u.y * (to - along) };
  }
  // Two limits that cannot both hold: the segment stays where it is.
  for (const { u, min, max } of limits) {
    const along = s.x * u.x + s.y * u.y;
    if (along < min - EPS || along > max + EPS) return null;
  }
  return s;
}

const still = (s: Pt | null) => !s || (Math.abs(s.x) < AXIS_EPS && Math.abs(s.y) < AXIS_EPS);

/**
 * An edit taken as far toward `shift` as it will go without tying the run
 * in a knot.
 *
 * `edit` moves the segment by a shift across it and returns the run, or
 * null for a knot. A drag recomputes the edit from where it started on every
 * move of the pointer, so refusing the whole of a move that went too far
 * sent the segment back to where the drag began -- a jump of the whole
 * distance, mid-drag. Instead the segment stops at the last whole pixel
 * short of the knot and waits there, as it does against a port's stub.
 */
function asFarAs(pts: Pt[], shift: Pt, edit: (s: Pt) => Pt[] | null): Pt[] {
  const whole = edit(shift);
  if (whole) return whole;
  const len = Math.hypot(shift.x, shift.y);
  const by = (k: number) => edit({ x: (shift.x * k) / len, y: (shift.y * k) / len });
  let lo = 0, hi = Math.ceil(len);
  let best: Pt[] = pts;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const run = by(mid);
    if (run) { lo = mid; best = run; } else hi = mid;
  }
  return best;
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
 *
 * No leg is moved behind a port's stub (`clampAcross`), a move is taken no
 * further than it can go without tying the run in a knot (`asFarAs`), and
 * the result is the run as `routeThrough` will draw the corners it stores
 * (`asDrawn`): what the drag shows is what is drawn when it lets go.
 */
export function dragSegment(pts: Pt[], i: number, delta: Pt, stubs: SegmentStubs = {}): Pt[] {
  if (i < 0 || i >= pts.length - 1) return pts;
  const p = pts[i], q = pts[i + 1];
  const dir = direction(p, q);
  if (!dir || (dir.x !== 0 && dir.y !== 0)) return pts;
  const horizontal = dir.y === 0;
  const across = horizontal ? { x: 0, y: delta.y } : { x: delta.x, y: 0 };
  const shift = clampAcross(pts, i, across, stubs);
  if (!shift || still(shift)) return pts;
  return asFarAs(pts, shift, s => moveSegment(pts, i, s, stubs));
}

/** `dragSegment` by a shift already held clear of the stubs: the run, or null for a knot. */
function moveSegment(pts: Pt[], i: number, shift: Pt, stubs: SegmentStubs): Pt[] | null {
  if (still(shift)) return pts;
  const p = pts[i], q = pts[i + 1];
  const dir = direction(p, q)!;
  const first = i === 0;
  const last = i === pts.length - 2;
  const sa = stubA(stubs), sb = stubB(stubs);
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  // A port's own segment keeps its stub, so it has to be longer than that.
  if ((first ? sa : 0) + (last ? sb : 0) >= len) return pts;
  const moved: Pt[] = [];
  if (first) {
    const s = { x: p.x + dir.x * sa, y: p.y + dir.y * sa };
    moved.push(p, s, { x: s.x + shift.x, y: s.y + shift.y });
  } else {
    moved.push({ x: p.x + shift.x, y: p.y + shift.y });
  }
  if (last) {
    const s = { x: q.x - dir.x * sb, y: q.y - dir.y * sb };
    moved.push({ x: s.x + shift.x, y: s.y + shift.y }, s, q);
  } else {
    moved.push({ x: q.x + shift.x, y: q.y + shift.y });
  }
  const out = [...pts];
  out.splice(i, 2, ...moved);
  return asDrawn(out, pts, stubs);
}

/**
 * Put a detour into segment `i`: the `2·STUB` of it centred on `at` moves
 * across by `delta` and the rest stays. For getting a run round something
 * that is in its way.
 *
 * The detour keeps clear of a port's stub at either end of the segment. One
 * that reaches the corner after a port's leg moves that corner, and is held
 * off the stub as a drag is; and on a segment too short to hold a detour at
 * all -- a short straight between two ports -- the whole segment moves
 * instead (`dragSegment`), since a detour squeezed in there would start
 * inside a port and hook.
 */
export function jogSegment(pts: Pt[], i: number, at: Pt, delta: Pt, stubs: SegmentStubs = {}): Pt[] {
  if (i < 0 || i >= pts.length - 1) return pts;
  const p = pts[i], q = pts[i + 1];
  const dir = direction(p, q);
  if (!dir || (dir.x !== 0 && dir.y !== 0)) return pts;
  const horizontal = dir.y === 0;
  let shift: Pt | null = horizontal ? { x: 0, y: delta.y } : { x: delta.x, y: 0 };
  if (still(shift)) return pts;
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  const lo = STUB + (i === 0 ? stubA(stubs) : 0);
  const hi = len - STUB - (i === pts.length - 2 ? stubB(stubs) : 0);
  if (hi < lo) return dragSegment(pts, i, delta, stubs);
  const along = Math.max(lo, Math.min(hi, (at.x - p.x) * dir.x + (at.y - p.y) * dir.y));
  const fromP = along - STUB < AXIS_EPS, toQ = len - (along + STUB) < AXIS_EPS;
  if (fromP && toQ) return dragSegment(pts, i, delta, stubs);
  if (fromP || toQ) shift = clampAcross(pts, i, shift, stubs, { a: fromP, b: toQ });
  if (!shift || still(shift)) return pts;
  const g1 = { x: p.x + dir.x * (along - STUB), y: p.y + dir.y * (along - STUB) };
  const g2 = { x: p.x + dir.x * (along + STUB), y: p.y + dir.y * (along + STUB) };
  return asFarAs(pts, shift, s => {
    if (still(s)) return pts;
    const out = [...pts];
    out.splice(i + 1, 0, g1, { x: g1.x + s.x, y: g1.y + s.y }, { x: g2.x + s.x, y: g2.y + s.y }, g2);
    return asDrawn(out, pts, stubs);
  });
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
