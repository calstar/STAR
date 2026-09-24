import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { J_ANCHOR, J_CLEAR, J_END, J_HALF, J_STUB, isJunction } from './junctions';
import type { EndLookup } from './junctions';
import { drawnRoute, routesItself } from './lineRoute';
import { BoxGrid, boxGrid, perPage } from './routeGrid';
import type { Obstacles } from './routeGrid';
import type { LineData } from './lineRoute';
import { pageOf } from './pages';
import { AXIS_EPS, GRID, STUB, segmentEntersBox, simplifyPoints } from './route';
import type { Box, End, Pt } from './route';

/**
 * Lines that would be drawn on top of each other are drawn a grid step apart.
 *
 * Every line routes itself from its own two ends, and nothing else: that is
 * what keeps routing cheap and a line's shape its own business. But it also
 * means two lines between the same two columns of symbols put their
 * crossbars at the same midpoint, and two lines leaving the same side of one
 * symbol turn at the same stub's length -- so they are drawn on top of each
 * other, for twenty pixels or for a hundred and forty, with no hop and no dot.
 * On a drawing whose whole point is which symbol feeds which, that reads as a
 * bus joining all four, or as the wrong two symbols joined straight across a
 * plain four-way cross.
 *
 * So once the lines on a page are routed, this moves the middles of the ones
 * that coincide. What it decides:
 *
 * - **Only a line that routes itself moves** (`TrackLine.free`: no corners of
 *   its own and not a pipe's). A person's corners are drawn where they were
 *   put, a pipe's lines draw their slices of the one route their pipe was
 *   given, which the tees on it were seated on, and a branch the reseat sent
 *   round the lines about it draws that way round, which was priced as it
 *   stands. None of them ever moves; the lines that can, move off them.
 * - **Only its middle moves.** A segment touching an end runs out of its port
 *   the way the port faces, and stays exactly as it was. Each segment between
 *   two others may move across itself by whole grid steps (`GRID`, up to three),
 *   and only while the segments either side keep their direction and length:
 *   a leg out of a port never shorter than its stub (the line's legal gap), one
 *   between two corners never shorter than a grid step. So a moved line still
 *   leaves and arrives the way its ports face and turns where it turned, a
 *   little further along.
 * - **Who moves.** Lines that cannot move are placed first, and so are the
 *   stubs of every line that can -- the first stretch of a leg out of a port,
 *   which no placement shortens. Then the rest, by id: a line yields to every
 *   line placed before it and to nothing placed after it, so the order is
 *   fixed by what the lines are, not by when they were drawn. Of parallel
 *   feeds stepping down between two columns, the later ones turn a step
 *   earlier each, a staircase. Two lines whose first leg across leaves the
 *   same side at the same level -- out of one tank's lid, a manifold's
 *   outlets, a row of tees -- nest, whichever comes first: the one from the
 *   port further back along the way they turn passes over the end of the
 *   other's stub, which is turning on it, so it is the one that moves, and it
 *   moves out, the only way its own stub lets it. And one whose middle came
 *   to lie along a leg out of an end of a line placed after it -- a leg the
 *   later line cannot move, of which only the stub was known -- is placed
 *   again once every line is, and moves off it.
 * - **Where it moves to** is the placement of its middle segments that costs
 *   least (`bestOffsets`): lying along another line, or turning on it, costs
 *   most; running into a symbol more still; crossing another line a little
 *   (a hop is honest, if busier). A line clear of everything placed before
 *   it is not moved at all, and a moved one no further than it has to be.
 * - **A tee's dot is a joint, whoever's it is.** The lines of a pipe stop at
 *   the faces of the tees riding it, so the run has a gap where each dot is
 *   drawn, and an open end's line stops at its face the same way; nor is a
 *   dot in the way of routing (a tee is not an obstacle). So a line moved
 *   across a pipe through that gap crossed nothing, got no hop, and was
 *   drawn straight through the dot -- which reads as a four-way joint, the
 *   very thing this is here to stop. So passing through a dot, or near
 *   enough to it that its hop would, costs what turning on a line does,
 *   for every line but the ones that end there; and a line routed through
 *   one is moved off it, like a line routed along another.
 *
 * It reads only the routes the lines were given, never what it drew last
 * time, so drawing a moved line again changes nothing and nothing loops; and
 * it is a function of the set of lines alone, so it draws the same whatever
 * order the lines reported in. Nothing it decides is stored: it is how the
 * lines are drawn, not where they are, and the graph feed-twin reads is
 * untouched.
 */

/** The offsets a middle segment is tried at, nearest first, and so preferred on a tie. */
const STEPS = [0, -GRID, GRID, -2 * GRID, 2 * GRID, -3 * GRID, 3 * GRID];
/** The furthest a segment is moved, and so how far round it a placement has to look. */
const REACH = 3 * GRID;
/** Parallel lines nearer than half a grid step read as one line. */
export const APART = GRID / 2;
/** How short a segment between two corners may be made, unless it already is. */
const MIN_LEG = GRID;
/** Two coordinates this close are one (measured ports carry sub-pixel noise). */
const TOL = AXIS_EPS;
/**
 * How near a tee's centre a segment may pass before it reads as going
 * through the dot: the dot as drawn (`J_HALF`, and the 2 px ring its shadow
 * puts round it) and half a grid step clear of that -- which is also as far
 * as a hop's arc bulges, so a line crossing the run this far out is not
 * hopped into the dot either. Worked out when asked, not when this module
 * loads: junctions.ts reaches this module (through attach.ts and
 * edgeGeometry.ts) before its own constants are set, and a sum of what is
 * not there yet is NaN, which no segment is ever nearer than.
 */
export const dotReach = () => J_HALF + 2 + APART;

// What each thing a placement does costs. Lying along another line, or
// turning on it, is what this is here to stop; running into a symbol is
// never worth it; a crossing is honest -- it is hopped -- but busier.
const OVERLAP = 1000;
const OVERLAP_PX = 10;
const TOUCH = 1000;
const CROSS = 40;
const BODY = 100000;

/** One line, as it routes itself or as it is stored. */
export interface TrackLine {
  id: string;
  /** Its route: what it is given, never what this draws it as. */
  pts: Pt[];
  /**
   * Its two ends, as the router had them (a tee's carrying `J_END`, which is
   * also how the dot it sits on is known). Without them a line never moves.
   */
  a?: End;
  b?: End;
  /** May its middle be moved off another line? A line that routes itself may; a pipe's or a person's may not. */
  free?: boolean;
}

/** The symbols on the page, filed by where they are (`routeGrid.BoxGrid` is one). */
export interface Sheet {
  overlapping(x0: number, y0: number, x1: number, y1: number): Box[];
  /** All of them, where the sheet can say: what tells two sheets with the same symbols apart from two without. */
  readonly boxes?: Box[];
}

// ── Dots ────────────────────────────────────────────────────────────────────

/** A tee or an open end, as the lines that end on it are priced for passing it: its dot and the reach round it. */
interface Dot extends Box {
  /** The lines that end on it, which may. */
  lines: string[];
}

/** Is this end on a tee's face? Every such end carries a tee's routing (`J_END`), and no symbol's does. */
const onTee = (e: End | undefined): e is End => !!e && e.clear === J_CLEAR && e.stub === J_STUB;

const OUT: Record<string, Pt> = {
  [Position.Left]: { x: -1, y: 0 }, [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 }, [Position.Bottom]: { x: 0, y: 1 },
};

/** The centre of the dot an end on a tee's face leaves: `J_ANCHOR` back from the face, against the way it faces. */
function dotBehind(e: End): Pt {
  const u = OUT[e.side] ?? { x: 0, y: 0 };
  return { x: e.x - u.x * J_ANCHOR, y: e.y - u.y * J_ANCHOR };
}

/**
 * Every dot the lines end on, once each, with the lines that end there. Two
 * ends on one tee find it within a pixel of each other (the faces are
 * measured); they are one dot.
 */
function dotsOf(lines: readonly TrackLine[]): Dot[] {
  const reach = dotReach();
  const found = new Map<string, Dot[]>();
  const out: Dot[] = [];
  for (const line of lines) {
    for (const e of [line.a, line.b]) {
      if (!onTee(e)) continue;
      const c = dotBehind(e);
      const rx = Math.round(c.x), ry = Math.round(c.y);
      let dot: Dot | undefined;
      for (let i = -1; i <= 1 && !dot; i++) {
        for (let j = -1; j <= 1 && !dot; j++) {
          dot = found.get(`${rx + i},${ry + j}`)?.find(d =>
            Math.abs(d.x + reach - c.x) <= 1 && Math.abs(d.y + reach - c.y) <= 1);
        }
      }
      if (dot) { if (!dot.lines.includes(line.id)) dot.lines.push(line.id); continue; }
      dot = { x: c.x - reach, y: c.y - reach, w: 2 * reach, h: 2 * reach, lines: [line.id] };
      const key = `${rx},${ry}`;
      const list = found.get(key);
      if (list) list.push(dot); else found.set(key, [dot]);
      out.push(dot);
    }
  }
  return out;
}

/** Does the segment from p to q pass through the dot's reach? */
const throughDot = (p: Pt, q: Pt, d: Dot) => segmentEntersBox(p, q, d, 0);

// ── Segments, and what one does to another ─────────────────────────────────

/** An axis-aligned segment: horizontal at y = `at` over x in [lo, hi], or vertical at x = `at`. */
interface Span {
  h: boolean;
  at: number;
  lo: number;
  hi: number;
}

interface Seg extends Span {
  line: string;
  /** Where it was filed, so what is near comes back in the same order every time. */
  seq: number;
  /** Is it part of a line drawn somewhere other than its own route? */
  moved: boolean;
  /** Taken away: a line's stubs, once the whole line is placed. */
  gone: boolean;
  /** The last look that found it, so a look finds each segment once. */
  seen: number;
}

function spanOf(p: Pt, q: Pt): Span | null {
  if (Math.abs(p.y - q.y) <= TOL) return { h: true, at: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) };
  if (Math.abs(p.x - q.x) <= TOL) return { h: false, at: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) };
  return null;
}

const NONE = 0, CROSSING = 1, TOUCHING = 2, LYING = 3;

/**
 * What segment `s` does to segment `t` of another line: nothing; crosses it;
 * lies along it (nearer than `APART` reads as along it); or touches it -- a
 * corner or an end of one on the other, or within `APART` of it, which reads
 * as a joint. Two lines meeting end to end on one line meet at a corner of
 * one of them -- unless both ends are ports, which nothing here moves -- and
 * that corner is on the other line: a touch.
 */
function relation(s: Span, t: Span): { kind: number; cost: number } {
  if (s.h === t.h) {
    if (Math.abs(s.at - t.at) >= APART) return { kind: NONE, cost: 0 };
    const over = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo);
    return over > TOL ? { kind: LYING, cost: OVERLAP + OVERLAP_PX * over } : { kind: NONE, cost: 0 };
  }
  // One across the other: how far each one's line passes beyond the other's ends.
  const beyondS = Math.max(s.lo - t.at, t.at - s.hi, 0);
  const beyondT = Math.max(t.lo - s.at, s.at - t.hi, 0);
  if (beyondS >= APART || beyondT >= APART) return { kind: NONE, cost: 0 };
  const inS = Math.min(t.at - s.lo, s.hi - t.at);
  const inT = Math.min(s.at - t.lo, t.hi - s.at);
  if (inS > TOL && inT > TOL) return { kind: CROSSING, cost: CROSS };
  return { kind: TOUCHING, cost: TOUCH };
}

const CELL = 128;
/** A cell's key: exact for any drawing within a few million pixels of the origin. */
const cellKey = (cx: number, cy: number) => cx * 67108864 + cy;

/** The segments placed so far, filed by where they are. */
class Segments {
  private readonly cells = new Map<number, Seg[]>();
  private seq = 0;
  private look = 0;

  add(line: string, s: Span, moved: boolean): Seg {
    const seg: Seg = { h: s.h, at: s.at, lo: s.lo, hi: s.hi, line, moved, seq: this.seq++, gone: false, seen: 0 };
    const x0 = s.h ? s.lo : s.at, x1 = s.h ? s.hi : s.at, y0 = s.h ? s.at : s.lo, y1 = s.h ? s.at : s.hi;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = cellKey(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(seg); else this.cells.set(k, [seg]);
      }
    }
    return seg;
  }

  remove(segs: Seg[]) {
    for (const s of segs) s.gone = true;
  }

  /** Every segment of another line than `skip` whose box meets the rectangle, in filing order. */
  near(x0: number, y0: number, x1: number, y1: number, skip: string): Seg[] {
    const look = ++this.look;
    const hit: Seg[] = [];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const s of list) {
          if (s.seen === look || s.gone || s.line === skip) continue;
          s.seen = look;
          const a0 = s.h ? s.lo : s.at, a1 = s.h ? s.hi : s.at, b0 = s.h ? s.at : s.lo, b1 = s.h ? s.at : s.hi;
          if (a0 <= x1 && a1 >= x0 && b0 <= y1 && b1 >= y0) hit.push(s);
        }
      }
    }
    return hit.length > 1 ? hit.sort((p, q) => p.seq - q.seq) : hit;
  }

  /** The same, around a span, grown by `by` every way. */
  around(s: Span, by: number, skip: string): Seg[] {
    return s.h ? this.near(s.lo - by, s.at - by, s.hi + by, s.at + by, skip) : this.near(s.at - by, s.lo - by, s.at + by, s.hi + by, skip);
  }
}

// ── A line that may move ────────────────────────────────────────────────────

/** A line's route, and everything about it that does not depend on where its middle goes. */
interface Plan {
  line: TrackLine;
  p: Pt[];
  spans: Span[];
  /** Each segment's signed length along itself, first point to second. */
  len: number[];
  /** How short each may become: a leg out of a port its stub, one between corners a grid step. */
  min: number[];
  /** The offsets each segment may take; the two touching the ends take none. */
  dom: number[][];
  near: Seg[][];
  boxes: Box[][];
  /** The dots near each segment that it may not pass through: every one but those the line ends on. */
  dots: Dot[][];
  /** What each segment can meet at each offset: `near`, `boxes` and `dots`, cut down to that line across. */
  at: Map<number, { segs: Seg[]; boxes: Box[]; dots: Dot[] }>[];
}

const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

function planOf(line: TrackLine): Plan | null {
  if (!line.free || !line.a || !line.b) return null;
  const p = simplifyPoints(line.pts);
  const n = p.length - 1;
  if (n < 3) return null;                              // a straight line or an L has no middle
  const spans: Span[] = [];
  for (let i = 0; i < n; i++) {
    const s = spanOf(p[i], p[i + 1]);
    if (!s) return null;                                // never drawn; never moved
    if (i > 0 && s.h === spans[i - 1].h) return null;
    spans.push(s);
  }
  const len = spans.map((s, i) => (s.h ? p[i + 1].x - p[i].x : p[i + 1].y - p[i].y));
  const min = len.map((l, i) => {
    const stub = i === 0 ? line.a!.stub ?? STUB : i === n - 1 ? line.b!.stub ?? STUB : MIN_LEG;
    return Math.min(stub, Math.abs(l));
  });
  const dom = spans.map((_, i) => (i === 0 || i === n - 1 ? [0] : STEPS));
  const plan: Plan = { line, p, spans, len, min, dom, near: [], boxes: [], dots: [], at: spans.map(() => new Map()) };
  // Worth planning only if some middle segment has somewhere to go on its own.
  const room = spans.some((_, i) => i > 0 && i < n - 1 && STEPS.some(o => o !== 0
    && fits(plan, i - 1, len[i - 1] + o) && fits(plan, i + 1, len[i + 1] - o)));
  return room ? plan : null;
}

/** May segment `i` have signed length `l`? The same direction, and no shorter than it may be. */
const fits = (plan: Plan, i: number, l: number) =>
  sign(l) === sign(plan.len[i]) && Math.abs(l) >= plan.min[i] - 1e-9;

/** Point `j` of the route with the segment before it moved by `before` and the one after by `after`. */
function pointAt(plan: Plan, j: number, before: number, after: number): Pt {
  let { x, y } = plan.p[j];
  if (before && j > 0) { if (plan.spans[j - 1].h) y += before; else x += before; }
  if (after && j < plan.spans.length) { if (plan.spans[j].h) y += after; else x += after; }
  return { x, y };
}

/**
 * What segment `i` can meet moved by `o`, wherever its neighbours put its
 * ends: the lines along it within `APART`, the lines across it, the symbols
 * it would be inside, and the dots it would pass through -- worked out once
 * per offset, since every placement of the neighbours asks again.
 */
function within(plan: Plan, i: number, o: number) {
  let here = plan.at[i].get(o);
  if (here) return here;
  const s = plan.spans[i], pos = s.at + o;
  const lo = s.lo - REACH - APART, hi = s.hi + REACH + APART;
  here = {
    segs: plan.near[i].filter(t => (t.h === s.h
      ? Math.abs(t.at - pos) < APART && t.hi >= lo && t.lo <= hi
      : t.at >= lo && t.at <= hi && pos >= t.lo - APART && pos <= t.hi + APART)),
    boxes: plan.boxes[i].filter(bx => (s.h ? pos > bx.y && pos < bx.y + bx.h : pos > bx.x && pos < bx.x + bx.w)),
    dots: plan.dots[i].filter(d => (s.h ? pos > d.y && pos < d.y + d.h : pos > d.x && pos < d.x + d.w)),
  };
  plan.at[i].set(o, here);
  return here;
}

/** What segment `i` costs moved by `o`, with its neighbours moved by `before` and `after`. */
function segmentCost(plan: Plan, i: number, before: number, o: number, after: number): number {
  if (!fits(plan, i, plan.len[i] + after - before)) return Infinity;
  const P = pointAt(plan, i, before, o), Q = pointAt(plan, i + 1, o, after);
  const s = spanOf(P, Q)!;
  const here = within(plan, i, o);
  let c = 0;
  for (const t of here.segs) c += relation(s, t).cost;
  for (const bx of here.boxes) if (segmentEntersBox(P, Q, bx, 1)) c += BODY;
  for (const d of here.dots) if (throughDot(P, Q, d)) c += TOUCH;
  return c;
}

/**
 * The cheapest placement of a line's middle segments: an offset for each,
 * found segment by segment -- a segment's cost depends only on its own offset
 * and its two neighbours', which set where it starts and stops -- so every
 * combination is weighed without trying each one. Ties go to the offset
 * tried first -- none, then one step, then two -- segment by segment from the
 * far end, so the same lines always draw the same way, and never further
 * from where they were routed than they need to be.
 */
function bestOffsets(plan: Plan): number[] {
  const n = plan.spans.length;
  const V = [0];
  let cost: number[][] = [[0]];
  const backs: number[][][] = [];
  for (let i = 0; i < n; i++) {
    const dPrev = i === 0 ? V : plan.dom[i - 1], dCur = plan.dom[i], dNext = i + 1 < n ? plan.dom[i + 1] : V;
    const next = dCur.map(() => dNext.map(() => Infinity));
    const back = dCur.map(() => dNext.map(() => -1));
    for (let a = 0; a < dPrev.length; a++) {
      for (let b = 0; b < dCur.length; b++) {
        const sofar = cost[a][b];
        if (sofar === Infinity) continue;
        for (let c = 0; c < dNext.length; c++) {
          const v = sofar + segmentCost(plan, i, dPrev[a], dCur[b], dNext[c]);
          if (v < next[b][c] - 1e-9) { next[b][c] = v; back[b][c] = a; }
        }
      }
    }
    backs.push(back);
    cost = next;
  }
  const offsets = new Array<number>(n).fill(0);
  if (cost[0][0] === Infinity) return offsets;
  let b = 0, c = 0;
  for (let i = n - 1; i >= 0; i--) {
    offsets[i] = plan.dom[i][b];
    const a = backs[i][b][c];
    c = b;
    b = a;
  }
  return offsets;
}

/**
 * Placements already worked out, by everything they depend on: the route,
 * how far each segment may shrink, and every segment and symbol it could
 * meet. A drag moves a few lines; the lines that had to move elsewhere on
 * the page meet exactly what they met before and are not worked out again.
 */
const placements = new Map<string, number[]>();
const PLACEMENTS = 1024;

function remembered(plan: Plan): number[] {
  let key = `${plan.p.map(q => `${q.x},${q.y}`).join(' ')}|${plan.min.join(',')}`;
  plan.near.forEach((segs, i) => {
    key += `|${i}:`;
    for (const t of segs) key += `${t.h ? 'h' : 'v'}${t.at},${t.lo},${t.hi},${t.moved ? 1 : 0};`;
    for (const bx of plan.boxes[i]) key += `b${bx.x},${bx.y},${bx.w},${bx.h};`;
    for (const d of plan.dots[i]) key += `d${d.x},${d.y};`;
  });
  let offsets = placements.get(key);
  if (!offsets) {
    if (placements.size >= PLACEMENTS) placements.clear();
    offsets = bestOffsets(plan);
    placements.set(key, offsets);
  }
  return offsets;
}

/** The route with its middle segments moved. */
function moved(plan: Plan, offsets: number[]): Pt[] {
  const out = plan.p.map((_, j) => pointAt(plan, j, j > 0 ? offsets[j - 1] : 0, j < offsets.length ? offsets[j] : 0));
  return simplifyPoints(out);
}

/**
 * Does the line as routed lie on or turn on a line already placed, cross one
 * that was moved there, or pass through a dot? Only then is it worth moving:
 * a line clear of everything placed before it is drawn exactly as routed.
 */
function troubled(plan: Plan): boolean {
  for (let i = 0; i < plan.spans.length; i++) {
    for (const t of plan.near[i]) {
      const k = relation(plan.spans[i], t).kind;
      if (k === LYING || k === TOUCHING || (k === CROSSING && t.moved)) return true;
    }
    if (plan.dots[i].some(d => throughDot(plan.p[i], plan.p[i + 1], d))) return true;
  }
  return false;
}

// ── The pass ───────────────────────────────────────────────────────────────

const byIdOrder = (u: TrackLine, v: TrackLine) => (u.id < v.id ? -1 : u.id > v.id ? 1 : 0);

/**
 * How every line on one page is drawn: its own route (the same array) where
 * nothing is in its way, and otherwise its route with its middle moved off
 * the lines placed before it. `sheet` is the page's symbols, which a moved
 * segment keeps out of.
 */
export function separate(lines: readonly TrackLine[], sheet?: Sheet | Box[]): Map<string, Pt[]> {
  const all = [...new Map(lines.map(l => [l.id, l])).values()].sort(byIdOrder);
  const out = new Map<string, Pt[]>();
  const segs = new Segments();
  const plans: Plan[] = [];
  // What is known before anything moves: every line that cannot move, and
  // the stubs of every one that can, which no placement shortens. A line
  // whose first leg across passes over the end of another's stub -- two
  // lines out of one side of a tank, the one from the port further back --
  // turns on it, so it is the one that moves, and it moves out, the only way
  // its own stub can go: the two nest, whichever is placed first.
  const cores = new Map<string, Seg[]>();
  for (const line of all) {
    out.set(line.id, line.pts);
    const plan = planOf(line);
    if (!plan) {
      const p = simplifyPoints(line.pts);
      for (let i = 0; i + 1 < p.length; i++) {
        const s = spanOf(p[i], p[i + 1]);
        if (s) segs.add(line.id, s, false);
      }
      continue;
    }
    plans.push(plan);
    const n = plan.spans.length;
    const core = (end: Pt, i: number, stub: number): Span => {
      const s = plan.spans[i];
      const reach = Math.min(stub, Math.abs(plan.len[i]));
      const from = s.h ? end.x : end.y;
      const to = from + sign(i === 0 ? plan.len[i] : -plan.len[i]) * reach;
      return { h: s.h, at: s.at, lo: Math.min(from, to), hi: Math.max(from, to) };
    };
    cores.set(line.id, [
      segs.add(line.id, core(plan.p[0], 0, line.a!.stub ?? STUB), false),
      segs.add(line.id, core(plan.p[n], n - 1, line.b!.stub ?? STUB), false),
    ]);
  }
  const grid = !sheet ? null : Array.isArray(sheet) ? boxGrid(sheet) : sheet;
  // Every tee and open end, which no line but its own may pass through.
  const dots = dotsOf(all);
  const dotGrid = dots.length ? new BoxGrid(dots) : null;
  /** What of `g` is round a span, grown by `by` every way. */
  const round = <T extends Box>(g: Sheet | null, s: Span, by: number): T[] => {
    if (!g) return [];
    const x0 = s.h ? s.lo : s.at, x1 = s.h ? s.hi : s.at, y0 = s.h ? s.at : s.lo, y1 = s.h ? s.at : s.hi;
    return g.overlapping(x0 - by, y0 - by, x1 + by, y1 + by) as T[];
  };
  const dotsRound = (s: Span, by: number, id: string) => round<Dot>(dotGrid, s, by).filter(d => !d.lines.includes(id));

  /** Where a line's middle goes, placed against everything filed now. */
  const place = (plan: Plan): Pt[] => {
    const id = plan.line.id;
    plan.near = plan.spans.map(s => segs.around(s, REACH + APART, id));
    plan.boxes = plan.spans.map(s => round<Box>(grid, s, REACH));
    plan.dots = plan.spans.map(s => dotsRound(s, REACH, id));
    plan.at = plan.spans.map(() => new Map());
    const offsets = remembered(plan);
    return offsets.some(o => o !== 0) ? moved(plan, offsets) : plan.line.pts;
  };
  const file = (plan: Plan, drawn: Pt[]): Seg[] => {
    const p = drawn === plan.line.pts ? plan.p : drawn;
    const filed: Seg[] = [];
    const shifted = drawn !== plan.line.pts;
    for (let i = 0; i + 1 < p.length; i++) filed.push(segs.add(plan.line.id, spanOf(p[i], p[i + 1])!, shifted));
    return filed;
  };

  // Then each line that can move, by id: it yields to every line placed
  // before it, and to nothing placed after it.
  const filed = new Map<string, Seg[]>();
  for (const plan of plans) {
    const id = plan.line.id;
    // A first, narrow look -- what the route as it stands touches -- and only
    // for a line that has to move, the wide one: everything it could reach.
    plan.near = plan.spans.map(s => segs.around(s, APART, id));
    plan.dots = plan.spans.map(s => dotsRound(s, 0, id));
    const drawn = troubled(plan) ? place(plan) : plan.line.pts;
    segs.remove(cores.get(id)!);
    filed.set(id, file(plan, drawn));
    out.set(id, drawn);
  }

  // A second look, for a line whose middle lies along a line placed after it,
  // or turns on one. All it knew of that line when it was placed were its
  // stubs; but a leg out of an end is often far longer than its stub -- a
  // branch's first leg down from its tee runs half the way to the symbol it
  // feeds -- and the line placed after it cannot move a leg out of an end.
  // So a feed whose crossbar fell on a branch's first leg was drawn along it
  // for as far as the two ran together, whichever way the branch's own
  // crossbar went. Placed again against every line as it now is, it moves
  // off it; a line with nothing after it in its way is left as it was.
  const rank = new Map(plans.map((plan, i) => [plan.line.id, i]));
  plans.forEach((plan, i) => {
    const id = plan.line.id;
    const drawn = out.get(id)!;
    const p = drawn === plan.line.pts ? plan.p : drawn;
    let late = false;
    for (let k = 0; k + 1 < p.length && !late; k++) {
      const s = spanOf(p[k], p[k + 1])!;
      late = segs.around(s, APART, id).some(t => (rank.get(t.line) ?? -1) > i && relation(s, t).kind >= TOUCHING);
    }
    if (!late) return;
    segs.remove(filed.get(id)!);
    const again = place(plan);
    filed.set(id, file(plan, again));
    out.set(id, again);
  });
  return out;
}

/**
 * One line of a drawing as the pass takes it: routed as it routes itself
 * (`drawnRoute`), with its ends as the canvas gives them to it -- a tee's
 * carrying `J_END` -- and whether it may move. Null when an end cannot be
 * looked up.
 */
export function trackLineOf(e: Edge, byId: Map<string, Node>, endOf: EndLookup, obstacles?: Obstacles): TrackLine | null {
  const pts = drawnRoute(e, byId, endOf, obstacles);
  if (!pts) return null;
  const s = byId.get(e.source)!, t = byId.get(e.target)!;
  const a0 = endOf(s, e.sourceHandle)!, b0 = endOf(t, e.targetHandle)!;
  return {
    id: e.id, pts,
    a: isJunction(s) ? { ...a0, ...J_END } : a0,
    b: isJunction(t) ? { ...b0, ...J_END } : b0,
    free: routesItself(e.data as LineData | undefined, s, e.sourceHandle, t, e.targetHandle),
  };
}

/**
 * Every line of a drawing as the canvas draws it: each routed as it routes
 * itself (`drawnRoute`), then each page's lines separated. For tests, and for
 * anything that needs the drawing without the page to read it from.
 */
export function drawnScene(nodes: Node[], edges: Edge[], endOf: EndLookup, obstacles?: Obstacles): Map<string, Pt[]> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const pages = new Map<string, TrackLine[]>();
  for (const e of edges) {
    const line = trackLineOf(e, byId, endOf, obstacles);
    if (!line) continue;
    const page = pageOf(byId.get(e.source)!.data as { page?: string });
    const list = pages.get(page);
    if (list) list.push(line); else pages.set(page, [line]);
  }
  const out = new Map<string, Pt[]>();
  for (const [page, lines] of pages) {
    for (const [id, pts] of separate(lines, perPage(nodes, obstacles)(page))) out.set(id, pts);
  }
  return out;
}

/** A drawing: what a change is made to, and what it makes. */
interface Drawing { nodes: readonly Node[]; edges: readonly Edge[] }

/**
 * How the lines on one page of a drawing will be drawn once a change has
 * been made to it -- for a preview, which makes the change on a copy to show
 * what letting go will draw. Worked out on its own, a new line is routed as
 * it routes itself; but once the page has it, it is moved off the lines
 * around it, and may move one of them, so the route alone is not what
 * letting go draws.
 *
 * `page` is the page's lines as the canvas has them now, each as it
 * published itself (`edgeGeometry.publishedLines`). A line of `after` that
 * `before` does not have, or has as another object, or with an end on a
 * node that has since changed, is routed afresh; every other line is taken
 * as the page has it, which is exactly what the canvas will draw it from. A
 * line the page has and `after` does not is gone. With nothing on the page
 * -- no canvas, as in a test -- every line is routed afresh. The symbols
 * are the page's, as the canvas has them: a change made by a drop moves no
 * symbol.
 */
export function drawnAfter(
  before: Drawing, after: { nodes: Node[]; edges: Edge[] }, onPage: string,
  endOf: EndLookup, obstacles?: Obstacles, page: readonly TrackLine[] = [],
): Map<string, Pt[]> {
  const had = new Map(before.edges.map(e => [e.id, e]));
  const hadNode = new Map(before.nodes.map(n => [n.id, n]));
  const byId = new Map(after.nodes.map(n => [n.id, n]));
  const published = new Map(page.map(l => [l.id, l]));
  const lines: TrackLine[] = [];
  for (const e of after.edges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t || pageOf(s.data as { page?: string }) !== onPage) continue;
    const same = had.get(e.id) === e && hadNode.get(e.source) === s && hadNode.get(e.target) === t;
    const line = (same ? published.get(e.id) : undefined) ?? trackLineOf(e, byId, endOf, obstacles);
    if (line) lines.push(line);
  }
  return separate(lines, perPage(after.nodes, obstacles)(onPage));
}
