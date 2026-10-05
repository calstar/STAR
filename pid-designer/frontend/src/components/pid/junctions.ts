import type { Edge, Node, XYPosition } from '@xyflow/react';
import { Position } from '@xyflow/react';
import { AXIS_EPS, arcsOf, direction, nearestOnPolyline, pointAtArc, simplifyPoints } from './route';
import type { End, Pt } from './route';
import type { PIDNodeData } from './types';

/**
 * A tee is a point in a pipe, and it stays one.
 *
 * A junction used to be a node with a position like any other, and that was
 * the whole of what made it feel broken: move the tank at one end of a run
 * and its tees stayed behind on the canvas, so the two halves of the line
 * re-routed around a point that was no longer on it and the run grew a kink
 * it never had. A tee dragged by hand could be put anywhere at all, off the
 * pipe included.
 *
 * Then each tee rode the run between its own two neighbours, and that was
 * the next thing wrong: every tee routed its own piece of the pipe afresh, so
 * two tees on one Z disagreed about where the bend was, a new tee moved the
 * bend, and a tee dragged along the pipe shoved the next one.
 *
 * So the unit is the *pipe* (`pipes.ts`): the chain of lines through riding
 * tees between two things that are not riding tees. A pipe is routed once,
 * every tee on it sits on that one path, and each line draws exactly its own
 * slice of it. A tee keeps its place on the drawing when the pipe changes
 * under it -- it is put on the nearest point of the new path -- and where it
 * may sit is one rule (`legalSpot`): on a bend or a tee's reach clear of one,
 * never inside a port's stub, never on top of another tee. What this file
 * holds is the vocabulary those share: faces, ends, and that rule.
 */

export type Face = 't' | 'b' | 'l' | 'r';

export interface Along {
  /** How far along the pipe, as a fraction of its length from `from`. */
  t: number;
  /** The faces the pipe enters and leaves by. Anything else on the tee is a branch. */
  in: Face;
  out: Face;
  /**
   * What is on each end of the pipe: the node on the `in` side and the node
   * on the `out` side. A different pair is a different pipe -- a part went
   * into one of its lines, or a tee was taken out -- and it is how a tee
   * knows its own orientation along the pipe.
   */
  from?: string;
  to?: string;
  /**
   * Where the pipe's two end anchors were when the tee was last put down.
   * Kept with the tee so that picking a whole bay up moves it too
   * (`graphOps.translateSubgraph`); a tee's place is never worked out from
   * it -- the tee keeps its place on the drawing, not a fraction of a pipe.
   */
  ends?: { a: Pt; b: Pt };
  /**
   * Where the tee was last put down on purpose -- split into a line, slid by
   * hand, or seated while its pipe's ends were where they were then -- and
   * where the pipe's two end anchors were at the time, `a` at `from` as in
   * `ends`. While the pipe's ends are back there, the tee goes back there
   * too, when that is a legal spot on its pipe (`pipes.placeTees`).
   *
   * `ends` cannot say this: every seat that moves the tee rewrites it. An end
   * dragged far out and then exactly back found its tee where the far drag
   * had left it -- off the grid, on a leg the drag had bent the pipe into --
   * and the pipe drawn around it in its far shape, because each seat keeps a
   * tee where it is and draws the pipe to keep it there. A drawing put back
   * as it was is drawn as it was. Moved with the tee by whatever picks it up
   * whole, as `ends` is.
   */
  home?: { a: Pt; b: Pt; at: Pt };
  /**
   * Where the corner an elbow tee sat on is, from its centre, once it has
   * been slid off it and the reseat has not yet seen it go.
   *
   * A tee on a bend is the pipe's corner there: both its lines stop at its
   * faces, so neither carries the bend, and the pipe is drawn through the
   * tee's centre (`pipes.cornersOfPipe`). Slid along a leg, it takes its
   * centre away from the corner, and drawn through where the tee had gone
   * the pipe lost its bend -- an L with its corner at the tee, wherever the
   * tee was put. So the slide leaves the corner here, by how far it is from
   * the tee, and the next seat hands it to the line on the side it is on
   * and drops this. Relative, so a tee picked up with its bay carries it
   * without anything having to move it.
   */
  corner?: Pt;
}

/** Half the junction dot: its position is its top-left, its centre is +5. */
export const J_HALF = 5;

export const junctionData = (n: Node) => n.data as unknown as PIDNodeData & { along?: Along };

/**
 * Is this node a tee (or an open end)?
 *
 * Either marking counts. Today's tees carry both the node type and the
 * component type; a tee made by the old click-to-branch was saved with the
 * node type alone and `data: {}`, and read as a symbol it was routed as a
 * sixty-pixel box and deleted as though it were the end of a pipe.
 */
export const isJunction = (n: Node | undefined) =>
  !!n && ((n.data as unknown as PIDNodeData)?.componentType === 'JUNCTION' || n.type === 'JUNCTION');

export const faceOfDir = (d: Pt): Face =>
  Math.abs(d.x) >= Math.abs(d.y) ? (d.x >= 0 ? 'r' : 'l') : (d.y >= 0 ? 'b' : 't');

/** The two faces a pipe runs through a tee by: `in` toward the pipe's start, `out` toward its end. */
export interface RunFaces { in: Face; out: Face }

/** The faces a run enters and leaves a tee by, from the way it runs there. */
export const runFaces = (dir: Pt): RunFaces =>
  ({ in: faceOfDir({ x: -dir.x, y: -dir.y }), out: faceOfDir(dir) });

/** Every face of a tee, in the order choices are offered (and ties kept). */
export const FACES: Face[] = ['t', 'b', 'l', 'r'];

/** The way out of a tee by each of its faces. */
export const OUT_OF: Record<Face, Pt> = { t: { x: 0, y: -1 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 }, r: { x: 1, y: 0 } };

const levelFace = (f: Face) => f === 'l' || f === 'r';

/**
 * Does the run turn at the tee: an elbow tee, on the bend of its pipe, whose
 * run faces are at right angles rather than opposite each other?
 *
 * A drafter puts a tee where a pipe turns as readily as anywhere along it:
 * three lines meeting at the corner, one of them carrying a leg straight on
 * past it. Kept off every bend, a tee a line came in to at a corner sat a
 * tee's reach down one leg, and the line to it jogged over to reach it.
 */
export const isElbow = (run: RunFaces) => levelFace(run.in) !== levelFace(run.out);

/**
 * The faces a riding tee's run does not use: the ones its branches may take.
 * Across the run on a straight tee; on an elbow, the two that carry its legs
 * straight on past the corner. In `FACES` order, so across a level run the
 * face toward smaller coordinates is first.
 */
export const freeFaces = (run: RunFaces): Face[] => FACES.filter(f => f !== run.in && f !== run.out);

/**
 * The faces a pipe running along `pts` takes through a tee at arc position
 * `s`: on a bend (within a millionth of a pixel of it, the tolerance a legal
 * spot is judged to), in by the face the pipe arrives at and out by the one
 * it leaves by -- at right angles; anywhere else, the two faces along the leg.
 */
export function runFacesAt(pts: Pt[], s: number): RunFaces {
  const arcs = arcsOf(pts);
  for (let i = 1; i + 1 < pts.length; i++) {
    if (Math.abs(arcs[i] - s) > SPOT_EPS) continue;
    const d0 = direction(pts[i - 1], pts[i]), d1 = direction(pts[i], pts[i + 1]);
    if (d0 && d1 && (Math.abs(d0.x - d1.x) > 1e-9 || Math.abs(d0.y - d1.y) > 1e-9)) {
      return { in: faceOfDir({ x: -d0.x, y: -d0.y }), out: faceOfDir(d1) };
    }
  }
  return runFaces(pointAtArc(pts, s)?.dir ?? { x: 1, y: 0 });
}

/**
 * The faces a tee at `p`, a point of the path `pts`, would run by: on a bend
 * when `p` is within `reach` of one (the router's tolerance by default), as
 * `runFacesAt` says, and otherwise along the leg it is nearest. For a place a
 * pointer names, which is never exactly on anything.
 */
export function runFacesNear(pts: Pt[], p: Pt, reach = AXIS_EPS): RunFaces {
  for (let i = 1; i + 1 < pts.length; i++) {
    if (Math.hypot(pts[i].x - p.x, pts[i].y - p.y) > reach) continue;
    const d0 = direction(pts[i - 1], pts[i]), d1 = direction(pts[i], pts[i + 1]);
    if (d0 && d1 && (Math.abs(d0.x - d1.x) > 1e-9 || Math.abs(d0.y - d1.y) > 1e-9)) {
      return { in: faceOfDir({ x: -d0.x, y: -d0.y }), out: faceOfDir(d1) };
    }
  }
  return runFaces(nearestOnPolyline(pts, p)?.dir ?? { x: 1, y: 0 });
}

/**
 * The face a branch enters a riding tee by: of the faces its run leaves free,
 * the one that points most nearly at where the branch comes from -- across a
 * straight run, the side it is on (the far side of the two on a tie, as it
 * always was); on an elbow, the leg it carries on. Never one of the run's own
 * two faces -- a branch that landed on one of those drew itself along the
 * run and on top of it.
 */
export function branchFaceOf(run: RunFaces, from: Pt, at: Pt): Face {
  const v = { x: from.x - at.x, y: from.y - at.y };
  const score = (f: Face) => OUT_OF[f].x * v.x + OUT_OF[f].y * v.y;
  return freeFaces(run).reduce((best, f) => (score(f) >= score(best) ? f : best));
}

/** The face a branch enters a tee on a straight run going `runDir` by: `branchFaceOf` across it. */
export const branchFace = (runDir: Pt, from: Pt, at: Pt): Face => branchFaceOf(runFaces(runDir), from, at);

/** The way the run goes into a tee, from the face it enters by. */
export const runDirOf = (along: Along): Pt => ({ x: -OUT_OF[along.in].x, y: -OUT_OF[along.in].y });

/**
 * Is `to` on the out side of a riding tee at `c`, rather than its in side:
 * further along the way its run leaves than the way it arrives from? Ahead
 * along a straight run; on an elbow, toward its out leg.
 */
export const aheadOnRun = (run: RunFaces, c: Pt, to: Pt): boolean => {
  const v = { x: to.x - c.x, y: to.y - c.y };
  const by = (f: Face) => OUT_OF[f].x * v.x + OUT_OF[f].y * v.y;
  return by(run.out) >= by(run.in);
};

/**
 * The corner of its pipe a riding tee carries: an elbow's, which is its
 * centre while it sits on it, and where the slide that took it off left it
 * (`Along.corner`); nothing for a straight tee, or a junction that rides
 * nothing.
 */
export function teeCorner(n: Node): Pt | null {
  const along = junctionData(n).along;
  if (!along || !isElbow(along)) return null;
  const c = centreOfJunction(n);
  return along.corner ? { x: c.x + along.corner.x, y: c.y + along.corner.y } : c;
}

export const SIDE_OF: Record<Face, Position> = {
  t: Position.Top, b: Position.Bottom, l: Position.Left, r: Position.Right,
};

/**
 * Where a line anchors on a junction's face, given the dot's top-left.
 *
 * Eight from the centre, not five. The dot is ten across with a two-pixel
 * border, and each face's handle is ten across and centred on the edge of
 * the box *inside* the border -- so the handle's outer edge, which is where
 * React Flow anchors a line, sits three pixels beyond the dot. What the
 * designer measures off the rendered handle says the same; this is only for
 * a tee nothing has measured yet, and for tests.
 */
export const J_ANCHOR = J_HALF + 3;

/** What a route has to clear to get round a tee: the dot and a little. */
export const J_CLEAR = 14;
/** How far a line runs straight out of a tee before it may turn. */
export const J_STUB = 6;
/** The routing an end on a tee carries, measured or not. */
export const J_END = { clear: J_CLEAR, stub: J_STUB } as const;

// ── Where on a pipe a tee may sit ────────────────────────────────────────────
//
// A tee reaches J_ANCHOR + J_STUB = 14 px each way along its pipe: its face,
// and the stub a line runs straight out of it before it may turn. Anything
// inside that reach -- a bend, a port, another tee -- is something one of its
// two halves has to double back to reach, and that is every hook and loop
// that was ever drawn at a tee. So a tee is never put there.
//
// But on the bend itself it is not inside its own reach: an elbow tee's two
// run faces are the two legs, each half draws straight into its face, and the
// bend belongs to neither half -- the tee is the corner. So a tee may sit on
// a bend, and one asked for within its reach of a bend it may sit on is put
// on it (`SpotRules.elbows`).

/**
 * How far, along the pipe, a tee's centre stays from every bend. A leg
 * shorter than twice this holds no tee; the tee goes to the next leg.
 */
export const CORNER_GAP = J_ANCHOR + J_STUB;
/** How far a tee's centre stays from a symbol's port, or an open end, at the end of its pipe. */
export const END_GAP = J_ANCHOR + J_STUB;
/**
 * How far a tee's centre stays from the anchor of a tee its pipe ends on
 * (a pipe that arrives on another tee's branch face): that tee's own stub
 * and half its dot besides.
 */
export const TEE_END_GAP = 20;
/**
 * How far apart two tees on one pipe stay, centre to centre: each one's face
 * and a stub of line between them, so the short line joining them is a line
 * and not two anchors on top of each other. A tee dragged along its pipe
 * stops here; it cannot pass its neighbour.
 */
export const TEE_GAP = 20;

/** What decides the legal places on a pipe for one tee or part. */
export interface SpotRules {
  /** Arc length to keep clear of the pipe's first point (its `a` end). */
  endGapA?: number;
  /** Arc length to keep clear of the pipe's last point (its `b` end). */
  endGapB?: number;
  /** Arc length to keep clear of every bend, both ways. */
  cornerGap?: number;
  /**
   * Where no spot is `cornerGap` clear of the bends, the least a spot keeps
   * clear of them: the span of the thing itself (a tee's two faces, a part's
   * body), and a pixel. Inside it a bend belongs to neither line either side,
   * and would be lost.
   */
  minCornerGap?: number;
  /** Arc positions of the neighbouring tees' centres, which the spot may not come within `gap` of or pass. */
  neighbours?: { before?: number; after?: number };
  /** The spacing kept from a neighbour. */
  gap?: number;
  /**
   * The way along the pipe the gesture heads, +1 toward its `b` end, -1
   * toward `a`: an illegal spot then goes to the first legal spot that way
   * (onto the leg a pull at a bend heads for). Unset, it goes to the nearest.
   */
  prefer?: number;
  /**
   * Arc positions kept `cornerGap` clear of, as a bend is, where there is
   * room to: where another line crosses, or another tee's dot sits beside
   * the pipe. Where keeping clear of them leaves nowhere, they are not kept
   * clear of.
   */
  avoid?: number[];
  /**
   * A tee may sit on a bend, as an elbow tee: on one clear of the ends and
   * its neighbours as any spot is, and of every other bend (and anything
   * avoided) by a full `cornerGap`. A spot asked for within the clearance
   * the spots off the bends keep of such a bend is put on it. A part never
   * sits on a bend -- its body would be bent round it -- and is not told
   * this.
   */
  elbows?: boolean;
}

/** Arc positions of a path's bends -- points where it changes direction. */
function bendsOf(path: Pt[]): number[] {
  const arcs = arcsOf(path);
  const out: number[] = [];
  for (let i = 1; i + 1 < path.length; i++) {
    const d0 = direction(path[i - 1], path[i]), d1 = direction(path[i], path[i + 1]);
    if (!d0 || !d1) continue;
    if (Math.abs(d0.x - d1.x) > 1e-9 || Math.abs(d0.y - d1.y) > 1e-9) out.push(arcs[i]);
  }
  return out;
}

/** The pieces of [lo, hi] that are not within `gap` of any bend, as closed intervals. */
function legalIntervals(bends: number[], lo: number, hi: number, gap: number): [number, number][] {
  if (lo > hi + SPOT_EPS) return [];
  let pieces: [number, number][] = [[lo, Math.max(lo, hi)]];
  for (const c of bends) {
    const next: [number, number][] = [];
    for (const [u, v] of pieces) {
      // Remove the open interval (c - gap, c + gap).
      if (c + gap <= u + SPOT_EPS || c - gap >= v - SPOT_EPS) { next.push([u, v]); continue; }
      if (c - gap >= u - SPOT_EPS) next.push([u, c - gap]);
      if (c + gap <= v + SPOT_EPS) next.push([c + gap, v]);
    }
    pieces = next.filter(([u, v]) => v >= u - SPOT_EPS);
  }
  return pieces;
}

/** Two arc positions this close are one position. */
const SPOT_EPS = 1e-6;

/**
 * The bends of a path a tee may sit on, given what else it keeps clear of
 * (`stops`, the bends among them): within the ends and the neighbours
 * (`lo`..`hi`), and `clear` from every other stop -- a full reach, on every
 * tier. An elbow's lines leave it along both legs, and a bend nearer than
 * its reach on either is one a line turns inside its stub to reach: a hook.
 * A straight tee squeezed between two bends has nowhere better; an elbow
 * squeezed against one does, and is not put there.
 */
function elbowsOf(bends: number[], stops: number[], lo: number, hi: number, clear: number): number[] {
  return bends.filter(c => c >= lo - SPOT_EPS && c <= hi + SPOT_EPS
    && stops.every(x => x === c || Math.abs(x - c) >= clear - SPOT_EPS));
}

/**
 * The spots `legalSpot` may give on a path: stretches clear of the bends
 * (`legal`), and the bends a tee may sit on (`elbows`), from the first of
 * the rules' tiers that has a stretch -- or, when none has, the first that
 * has a bend; both empty when it can only fall back. `snap` is that tier's
 * clearance: a spot within it of one of the `elbows` goes onto it.
 *
 * A tier is chosen by its stretches, as it always was, and only then are
 * its bends added: a tee a crowded pipe could only put on its last tier
 * stays where that tier put it, rather than being taken onto a bend a tier
 * further up allowed it -- a drawing that settled before tees sat on bends
 * settles where it was.
 */
function spotsOf(path: Pt[], rules: SpotRules) {
  const pts = simplifyPoints(path);
  const arcs = arcsOf(pts);
  const L = arcs[arcs.length - 1] ?? 0;
  const gap = rules.gap ?? TEE_GAP;
  const lo = Math.max(rules.endGapA ?? END_GAP, rules.neighbours?.before !== undefined ? rules.neighbours.before + gap : -Infinity);
  const hi = Math.min(L - (rules.endGapB ?? END_GAP), rules.neighbours?.after !== undefined ? rules.neighbours.after - gap : Infinity);
  const bends = bendsOf(pts);
  const cornerGap = rules.cornerGap ?? CORNER_GAP;
  const tiers: { stops: number[]; clear: number }[] = [
    ...(rules.avoid?.length ? [{ stops: [...bends, ...rules.avoid], clear: cornerGap }] : []),
    { stops: bends, clear: cornerGap },
    // Nowhere clear of the bends by a full reach: at least clear of them by
    // the thing's own span, so no bend is under it.
    { stops: bends, clear: rules.minCornerGap ?? J_ANCHOR + 1 },
  ];
  for (const t of tiers) {
    const legal = legalIntervals(t.stops, lo, hi, t.clear);
    if (legal.length) {
      return { pts, L, lo, hi, bends, legal, elbows: rules.elbows ? elbowsOf(bends, t.stops, lo, hi, cornerGap) : [], snap: t.clear };
    }
  }
  if (rules.elbows) {
    for (const t of tiers) {
      const elbows = elbowsOf(bends, t.stops, lo, hi, cornerGap);
      if (elbows.length) return { pts, L, lo, hi, bends, legal: [] as [number, number][], elbows, snap: cornerGap };
    }
  }
  return { pts, L, lo, hi, bends, legal: [] as [number, number][], elbows: [] as number[], snap: 0 };
}

/**
 * Whether a path has a spot for the thing at all under `rules`: one clear of
 * its bends by at least its own span. When it has none, `legalSpot` still
 * answers -- the least bad place, because a tee a drawing already has must
 * go somewhere -- but nothing new should be put there: a tee put into a line
 * too short and bent to hold one landed beside the bend, and its halves
 * hooked round it; a valve put into a gap narrower than itself sat on both
 * its neighbours, and both its lines looped back through it.
 */
export function hasLegalSpot(path: Pt[], rules: SpotRules = {}): boolean {
  const { legal, elbows } = spotsOf(path, rules);
  return legal.length > 0 || elbows.length > 0;
}

/**
 * The legal spot for a tee (or a part) that is asked for at arc position `s`
 * on `path`: `s` itself when it is legal, otherwise the nearest legal spot
 * -- on the leg `s` was on when the two nearest are equally far, or the way
 * `prefer` says when it is given.
 *
 * Legal is: at least `endGapA`/`endGapB` from the two ends, at least
 * `cornerGap` from every bend, measured along the path both ways, and at
 * least `gap` from each neighbour, without passing it. Told `elbows`, a bend
 * is legal too when it keeps those clearances itself, and a spot asked for
 * nearer one than `cornerGap` is put on it, whichever leg it was on: the
 * spots a tee keeps clear of a bend are the bend's. When nothing is
 * legal -- a pipe too short, too bent, or too crowded -- the bends need only
 * be clear of the thing's own span (`minCornerGap`); when not even that can
 * be had, the answer is the middle of the longest straight piece that the
 * ends and neighbours still allow, or the middle of what they allow when
 * that is nothing: the least bad place, and the same place whatever was
 * asked for.
 *
 * It is a projection: a legal spot is its own answer, and every answer is
 * legal or the fixed fallback, so asking twice changes nothing. That is what
 * lets the hover dot, a split, a slide and the reseat all use it and agree,
 * and what keeps the reseat from ever moving a tee it has already placed.
 */
export function legalSpot(path: Pt[], s: number, rules: SpotRules = {}): number {
  const { pts, L, lo, hi, bends, legal: stretches, elbows, snap } = spotsOf(path, rules);

  if (!stretches.length && !elbows.length) {
    // Nothing is legal. The middle of the longest straight piece left
    // between the ends and neighbours, so the tee is at least off a bend if
    // that can be had; otherwise the middle of what the ends allow.
    if (lo <= hi) {
      const cuts = [lo, ...bends.filter(c => c > lo && c < hi), hi];
      let best: [number, number] = [lo, hi], len = -1;
      for (let i = 0; i + 1 < cuts.length; i++) {
        if (cuts[i + 1] - cuts[i] > len + SPOT_EPS) { len = cuts[i + 1] - cuts[i]; best = [cuts[i], cuts[i + 1]]; }
      }
      return (best[0] + best[1]) / 2;
    }
    return Math.min(L, Math.max(0, (lo + hi) / 2));
  }
  // Within a tee's reach of a bend it may sit on: on the bend. A spot exactly
  // the reach away is a legal spot of its own and stays, so a tee a drawing
  // already has a reach off a corner is left there.
  let corner: number | undefined;
  for (const c of elbows) {
    if (Math.abs(s - c) < snap - SPOT_EPS && (corner === undefined || Math.abs(s - c) < Math.abs(s - corner) - SPOT_EPS)) corner = c;
  }
  if (corner !== undefined) return corner;
  // A bend is a spot of no length.
  const legal = [...stretches, ...elbows.map((c): [number, number] => [c, c])].sort((x, y) => x[0] - y[0]);
  for (const [u, v] of legal) if (s >= u - SPOT_EPS && s <= v + SPOT_EPS) return s;

  let prev: number | undefined, next: number | undefined;
  for (const [u, v] of legal) {
    if (v < s) prev = v;
    else if (u > s && next === undefined) next = u;
  }
  if (rules.prefer && rules.prefer > 0 && next !== undefined) return next;
  if (rules.prefer && rules.prefer < 0 && prev !== undefined) return prev;
  if (prev === undefined) return next!;
  if (next === undefined) return prev;
  const dp = s - prev, dn = next - s;
  if (Math.abs(dp - dn) > SPOT_EPS) return dp < dn ? prev : next;
  // Equally far: stay on the leg it was on. A spot exactly on a bend is on
  // the leg before it, as `pointAtArc` says.
  const leg = (x: number) => pointAtArc(pts, x)?.segment ?? 0;
  if (leg(next) === leg(s) && leg(prev) !== leg(s)) return next;
  return prev;
}

/**
 * The latest legal spot each of `count` tees on a path may take, in order,
 * so that every tee after it still has a legal spot of its own: worked back
 * from the far end, each one a neighbour's spacing short of the next.
 * Null when the path has no room for that many.
 *
 * Reserving a flat spacing for each tee still to come is not enough on a
 * bent pipe: a tee that took the last legal spot before a bend left the one
 * after it nowhere to go but onto the bend.
 */
export function latestSpots(
  path: Pt[], count: number, rules: Pick<SpotRules, 'endGapA' | 'endGapB' | 'cornerGap' | 'gap' | 'elbows'> = {},
): number[] | null {
  const pts = simplifyPoints(path);
  const arcs = arcsOf(pts);
  const L = arcs[arcs.length - 1] ?? 0;
  const gap = rules.gap ?? TEE_GAP;
  const lo = rules.endGapA ?? END_GAP, hi = L - (rules.endGapB ?? END_GAP), clear = rules.cornerGap ?? CORNER_GAP;
  const bends = bendsOf(pts);
  // The bends a tee may sit on count as spots of no length.
  const legal = [
    ...legalIntervals(bends, lo, hi, clear),
    ...(rules.elbows ? elbowsOf(bends, bends, lo, hi, clear).map((c): [number, number] => [c, c]) : []),
  ].sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(count);
  let limit = L - (rules.endGapB ?? END_GAP);
  for (let i = count - 1; i >= 0; i--) {
    let best: number | null = null;
    for (const [u, v] of legal) if (u <= limit + SPOT_EPS) best = Math.min(v, limit);
    if (best === null) return null;
    out[i] = best;
    limit = best - gap;
  }
  return out;
}

export function junctionEnd(position: XYPosition, face: Face): End {
  const c = { x: position.x + J_HALF, y: position.y + J_HALF };
  const off: Record<Face, Pt> = { t: { x: 0, y: -J_ANCHOR }, b: { x: 0, y: J_ANCHOR }, l: { x: -J_ANCHOR, y: 0 }, r: { x: J_ANCHOR, y: 0 } };
  return { x: c.x + off[face].x, y: c.y + off[face].y, side: SIDE_OF[face], ...J_END };
}

export const centreOfJunction = (n: Node): Pt => ({ x: n.position.x + J_HALF, y: n.position.y + J_HALF });

/**
 * Where a port is and which way it faces, given the node it is on.
 *
 * The designer answers this from React Flow's measured handle bounds; a test
 * answers it from a table. Either way it is asked with the node's *current*
 * position, which is what lets a run be re-drawn while its ends are moving.
 */
export type EndLookup = (node: Node, handleId: string | null | undefined) => End | null;

/** The same line with its handle at `end` set to `handle`; the same object when it already is. */
export function withHandle(e: Edge, end: 'source' | 'target', handle: string): Edge {
  if (end === 'source') return e.sourceHandle === handle ? e : { ...e, sourceHandle: handle };
  return e.targetHandle === handle ? e : { ...e, targetHandle: handle };
}

/** Is a point on the axis a port faces along? */
export const onAxisOf = (e: End, p: Pt) =>
  (e.side === Position.Left || e.side === Position.Right ? Math.abs(p.y - e.y) < AXIS_EPS : Math.abs(p.x - e.x) < AXIS_EPS);

// The pipe model: pipes, their paths, placing tees on them, and pointing
// the lines. It lives in its own module; these are its entry points.
export {
  adoptTee, crowdOf, dragging, freezePipe, keptShape, pipeGeometry, pipeOf, pipesOf, pointLines, recordPipes, reseatJunctions,
  seatTees, setHandCorners, slideAlong, splitSpot, thawPipe,
} from './pipes';
export type { Crowd, Dragging, Pipe, PipeEnd, PipeGeometry } from './pipes';
