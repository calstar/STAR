import type { Edge, Node, XYPosition } from '@xyflow/react';
import { Position } from '@xyflow/react';
import {
  AXIS_EPS, GRID, STUB, arcsOf, crossbarOffsets, gridAlong, nearestOnPolyline, pathPoints, pointAtArc, routeCost,
  routeOrthogonal, routeThrough, segmentEntersBox, simplifyPoints, sliceByArc, throughAsStored,
} from './route';
import type { Box, End, Pt } from './route';
import {
  AMONG_REACH, NO_BOXES, REACH, avoidable, boundsOf, boxGrid, boxOfNode, perPage, routeAmong, routeAuto,
  routeHitsBoxes, withinReach,
} from './routeGrid';
import type { Obstacles, Soft, SoftLine } from './routeGrid';
import {
  ACROSS, CORNER_GAP, END_GAP, FACES, J_ANCHOR, J_CLEAR, J_END, J_HALF, J_STUB, TEE_END_GAP, TEE_GAP,
  branchFace, centreOfJunction, faceOfDir, hasLegalSpot, isJunction, junctionData, junctionEnd, latestSpots, legalSpot,
  onAxisOf, runFaces, withHandle,
} from './junctions';
import type { Along, EndLookup, Face } from './junctions';
import { centreOf } from './attach';
import { pageOf } from './pages';

/**
 * Pipes: the unit a tee rides.
 *
 * A pipe is the longest chain of lines that runs through riding tees -- in
 * by one of a tee's two run faces, out by the other -- between two ends that
 * are not: a symbol's port, an open end, or a tee the chain reaches on one
 * of its branch faces. Nothing is stored about a pipe. It is found from the
 * drawing each time, from the tees' `along.in`/`along.out` and the lines on
 * those faces, so it can never disagree with what is drawn.
 *
 * A pipe is routed once (`pipeGeometry`), and everything about it follows
 * from that one path:
 *
 *  - every tee on it is put on the path -- on the point nearest where it
 *    already is, so a tee keeps its place on the drawing when the pipe
 *    changes under it -- and then moved, if it has to be, to a legal spot
 *    (`legalSpot`): off every bend, clear of the ends, and in order;
 *  - each of its lines is handed exactly its slice of the path between the
 *    tees on either side of it, by distance along the path. Its corners are
 *    the pipe's corners on that stretch, so the lines together draw the
 *    pipe and nothing else;
 *  - which faces its tees' run lines take follows from which way the path
 *    runs at each tee.
 *
 * Adding a tee changes neither the pipe's ends nor its corners, so it cannot
 * change the pipe's shape. That was the bug this replaced: each tee routed
 * its own piece of pipe between its two neighbours, so a new tee moved the
 * bend, two tees on a Z each wrote their own idea of the bend into the line
 * they shared, and the reseat went round and round.
 *
 * A pipe is either the router's (no line of it has corners a person placed:
 * its lines carry their slices marked `viaRun`) or a person's (a hand edit on
 * any line of it froze the whole pipe: every line carries its slice as its
 * own corners, `freezePipe`). The router's pipe keeps the shape it was drawn
 * with for as long as that shape still fits its two ends (`keptShape`), and
 * routes itself again once it does not; a person's pipe is routed through
 * its corners wherever the ends go (`routeThrough`). A symbol that comes to
 * lie across a pipe whose shape still fits its ends is in the way of the
 * lines it lies across and nothing else: those go round it, each between its
 * own two stations, and no tee moves (`keptAround`).
 */

// ── The model ────────────────────────────────────────────────────────────────

/** One end of a pipe: the node there, the handle its line uses on it, and that line. */
export interface PipeEnd {
  nodeId: string;
  handle: string | null | undefined;
  lineId: string;
}

export interface Pipe {
  a: PipeEnd;
  b: PipeEnd;
  /** The riding tees on it, in order from `a` to `b`. */
  tees: string[];
  /** `lines[k]` joins station k to station k + 1, where station 0 is `a`, station n + 1 is `b`, and station i + 1 is `tees[i]`. */
  lines: string[];
  /** Whether `lines[k]` is stored source to target in the pipe's direction. */
  forward: boolean[];
}

interface Model {
  pipes: Pipe[];
  byLine: Map<string, Pipe>;
  byTee: Map<string, { pipe: Pipe; index: number }>;
  /** Tees with an `along` that cannot ride anything: a run line gone, or a ring of tees with no ends. */
  broken: string[];
  /**
   * Tees with their run intact that a ring of pipes cannot have riding
   * (`ringCloser`): the tee a pipe ends on when that pipe is, by way of the
   * pipes it ends on, where the tee itself is put.
   */
  unhooked: string[];
  /** The lines on each node, in the drawing's order. */
  linesAt: Map<string, Edge[]>;
  byId: Map<string, Node>;
  edgeById: Map<string, Edge>;
}

/** A line both of whose ends exist and are different nodes. Anything else is not a line a pipe can run through. */
const live = (e: Edge, byId: Map<string, Node>) => e.source !== e.target && byId.has(e.source) && byId.has(e.target);

const farOf = (e: Edge, nodeId: string) =>
  (e.source === nodeId ? { id: e.target, handle: e.targetHandle } : { id: e.source, handle: e.sourceHandle });

const handleAt = (e: Edge, nodeId: string) => (e.source === nodeId ? e.sourceHandle : e.targetHandle);

type RunOfTee = Map<string, { in: Edge; out: Edge }>;

/** The pipes the riding tees make, walked through their run faces, and the tees in rings of tees with no ends. */
function walkPipes(nodes: Node[], runOfTee: RunOfTee) {
  const pipes: Pipe[] = [];
  const byLine = new Map<string, Pipe>();
  const byTee = new Map<string, { pipe: Pipe; index: number }>();
  const ringed: string[] = [];

  for (const n of nodes) {
    const start = runOfTee.get(n.id);
    if (!start || byTee.has(n.id)) continue;
    // Walk out of each of the tee's two run faces until the chain reaches
    // something that is not a riding tee entered on a run face.
    const seen = new Set<string>([n.id]);
    let ring = false;
    const walk = (first: Edge): { tees: string[]; lines: Edge[]; end: PipeEnd } => {
      const tees: string[] = [], lines: Edge[] = [first];
      let at = n.id, e = first;
      for (;;) {
        const far = farOf(e, at);
        const r = runOfTee.get(far.id);
        if (r && (r.in === e || r.out === e)) {
          if (seen.has(far.id)) { ring = true; return { tees, lines, end: { nodeId: far.id, handle: far.handle, lineId: e.id } }; }
          seen.add(far.id);
          tees.push(far.id);
          e = r.in === e ? r.out : r.in;
          lines.push(e);
          at = far.id;
          continue;
        }
        return { tees, lines, end: { nodeId: far.id, handle: far.handle, lineId: e.id } };
      }
    };
    const back = walk(start.in);
    const fwd = ring ? null : walk(start.out);
    if (ring || !fwd) {
      // A ring of tees has no ends to route between. Nothing in it can ride.
      for (const id of seen) ringed.push(id);
      continue;
    }
    const tees = [...back.tees.reverse(), n.id, ...fwd.tees];
    const lines = [...back.lines.reverse(), ...fwd.lines];
    const a = back.end, b = fwd.end;
    // Station k is `a`, the tees, then `b`; line k is stored forward when
    // its source is station k.
    const stations = [a.nodeId, ...tees, b.nodeId];
    const forward = lines.map((e, k) => e.source === stations[k]);
    const pipe: Pipe = { a, b, tees, lines: lines.map(e => e.id), forward };
    pipes.push(pipe);
    tees.forEach((id, index) => byTee.set(id, { pipe, index }));
    for (const e of lines) byLine.set(e.id, pipe);
  }
  return { pipes, byLine, byTee, ringed };
}

/**
 * The tee that closes a ring of pipes, if there is one: the first, in the
 * drawing's order, that a pipe ends on while the pipe the tee rides depends,
 * by way of the pipes it ends on, on that same pipe -- a pipe that loops back
 * into one of its own tees is the shortest such ring.
 *
 * Where a pipe runs depends on where its ends are, and where a tee is
 * depends on where its pipe runs. Round a ring of pipes that is a loop with
 * no first pipe to seat: moving one moves the next, which moves the first
 * again by a fraction of what it moved, for ever, and the reseat never
 * settles. So the tee that closes the ring does not ride. It stays where it
 * is, and the pipes either side of it end on it as they would on an open end.
 */
function ringCloser(pipes: Pipe[], byTee: Map<string, { pipe: Pipe; index: number }>): string | null {
  const state = new Map<Pipe, 'visiting' | 'done'>();
  let found: string | null = null;
  const visit = (p: Pipe) => {
    state.set(p, 'visiting');
    for (const end of [p.a, p.b]) {
      const q = byTee.get(end.nodeId)?.pipe;
      if (!q) continue;
      const st = state.get(q);
      if (st === 'visiting') { found = end.nodeId; return; }
      if (!st) visit(q);
      if (found) return;
    }
    state.set(p, 'done');
  };
  for (const p of pipes) {
    if (!state.has(p)) visit(p);
    if (found) break;
  }
  return found;
}

function buildModel(nodes: Node[], edges: Edge[]): Model {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edgeById = new Map<string, Edge>();
  const linesAt = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!live(e, byId)) continue;
    if (!edgeById.has(e.id)) edgeById.set(e.id, e);
    for (const id of [e.source, e.target]) {
      const list = linesAt.get(id);
      if (list) list.push(e); else linesAt.set(id, [e]);
    }
  }

  // Each riding tee's two run lines: the first line on its `in` face and the
  // first other line on its `out` face.
  const runOfTee: RunOfTee = new Map();
  const broken: string[] = [];
  for (const n of nodes) {
    if (!isJunction(n)) continue;
    const along = junctionData(n).along;
    if (!along) continue;
    const lines = linesAt.get(n.id) ?? [];
    const inE = along.in !== along.out ? lines.find(e => handleAt(e, n.id) === along.in) : undefined;
    const outE = inE ? lines.find(e => e !== inE && handleAt(e, n.id) === along.out) : undefined;
    if (!inE || !outE) { broken.push(n.id); continue; }
    runOfTee.set(n.id, { in: inE, out: outE });
  }

  // Walk the pipes; take out of riding what cannot, and walk again until
  // what is left has an order to seat it in.
  const unhooked: string[] = [];
  for (;;) {
    const w = walkPipes(nodes, runOfTee);
    for (const id of w.ringed) { broken.push(id); runOfTee.delete(id); }
    const closer = w.ringed.length ? null : ringCloser(w.pipes, w.byTee);
    if (closer) { unhooked.push(closer); runOfTee.delete(closer); continue; }
    if (w.ringed.length) continue;
    return { pipes: w.pipes, byLine: w.byLine, byTee: w.byTee, broken, unhooked, linesAt, byId, edgeById };
  }
}

/** Every pipe in the drawing that has at least one riding tee on it, in the order its tees appear. */
export function pipesOf(nodes: Node[], edges: Edge[]): Pipe[] {
  return buildModel(nodes, edges).pipes;
}

/** The pipe a riding tee, or a line that is part of one, belongs to. Null for anything else. */
export function pipeOf(nodes: Node[], edges: Edge[], of: Node | Edge): Pipe | null {
  const m = buildModel(nodes, edges);
  if ('source' in of) return m.byLine.get(of.id) ?? null;
  return m.byTee.get(of.id)?.pipe ?? null;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** A pipe's route, and where along it things are. */
export interface PipeGeometry {
  a: End;
  b: End;
  pts: Pt[];
  arcs: number[];
  length: number;
  /** A person routed it: its lines carry their slices as their own corners. */
  hand: boolean;
}

/** An end of a line at `node`, as the router takes it: a tee's face carries J_END. */
function endFor(node: Node, handle: string | null | undefined, endOf: EndLookup): End | null {
  if (isJunction(node)) {
    if (!handle || !(handle in ACROSS)) return null;
    return { ...(endOf(node, handle) ?? junctionEnd(node.position, handle as Face)), ...J_END };
  }
  return endOf(node, handle);
}

const waypointsOfLine = (e: Edge): Pt[] => ((e.data as { waypoints?: Pt[] } | undefined)?.waypoints ?? []);
const isHand = (e: Edge) => {
  const d = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
  return !!d.waypoints?.length && !d.viaRun;
};

/** The sign of each step of a path, one per segment. */
function steps(pts: Pt[]): Pt[] {
  const s = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Math.sign(v));
  return pts.slice(0, -1).map((p, i) => ({ x: s(pts[i + 1].x - p.x), y: s(pts[i + 1].y - p.y) }));
}

/** Does a path turn back on itself: a U-turn (segment i and i + 2 opposite), or a spike? */
function doublesBack(pts: Pt[]): boolean {
  const d = steps(pts);
  for (let i = 0; i + 1 < d.length; i++) if (d[i].x === -d[i + 1].x && d[i].y === -d[i + 1].y) return true;
  for (let i = 0; i + 2 < d.length; i++) if (d[i].x === -d[i + 2].x && d[i].y === -d[i + 2].y) return true;
  return false;
}

/** Do two segments that do not share a point touch? Axis-aligned segments only; others by bounding box. */
function touch(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const e = AXIS_EPS / 2;
  return Math.max(p1.x, p2.x) + e >= Math.min(q1.x, q2.x) && Math.max(q1.x, q2.x) + e >= Math.min(p1.x, p2.x)
    && Math.max(p1.y, p2.y) + e >= Math.min(q1.y, q2.y) && Math.max(q1.y, q2.y) + e >= Math.min(p1.y, p2.y);
}

function crossesItself(pts: Pt[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) for (let j = i + 2; j + 1 < pts.length; j++) {
    if (touch(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
  }
  return false;
}

/** What a port is measured to (`ports.measured`), and so what two places closer than are one place. */
const MEASURED = 1e-3;

const samePts = (a: Pt[], b: Pt[], tol = 1e-6) =>
  a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) <= tol && Math.abs(p.y - b[i].y) <= tol);

/**
 * The boxes that overlap a path's bounding box: the only ones it can run
 * through. What a stored shape is kept against and a face's route is priced
 * against, less any an end sits inside (`avoidable`) -- each box as it is,
 * not grown by its ports' reach as `routeAuto` holds a route it searches
 * clear of one (`heldClear`).
 */
function boxesNear(pts: Pt[], boxes: Box[]): Box[] {
  if (!boxes.length || !pts.length) return [];
  const { x0, y0, x1, y1 } = boundsOf(pts);
  return boxGrid(boxes).overlapping(x0, y0, x1, y1);
}

/**
 * The route through stored corners the router put there, if they still fit
 * the two ends; null once they do not.
 *
 * Corners marked `viaRun` were the router's, written down so a line cut into
 * pieces keeps drawing the shape it was cut from. They are kept while that
 * shape is still a sensible route between the ends as they now are: the
 * first corner on the first end's axis and the last on the last end's, the
 * route drawn through them exactly (nothing refitted, snapped or folded), no
 * U-turn, no crossing itself, and no symbol on the sheet in its way. The
 * first time an end moves off them they are dropped and the line is routed
 * afresh. So a valve dropped on a bent line keeps the bend until something
 * moves, and never drags a bend that no longer fits behind it.
 *
 * `uTurns` lets the shape double back. A pipe's own shape may: drawn through
 * exactly, with each end leaving and arriving along its axis, a detour the
 * pipe was given is still the pipe. A line that belongs to no pipe keeps
 * nothing that doubles back, which is how a bend left behind by a valve
 * that has since moved shows itself.
 */
export function keptShape(a: End, b: End, corners: Pt[], boxes: Box[] = [], uTurns = false): Pt[] | null {
  if (!corners.length) return null;
  // Cheap to see, and saves drawing the route: corners off an end's axis are
  // ones the router would refit, which the exact check below refuses anyway.
  if (!onAxisOf(a, corners[0]) || !onAxisOf(b, corners[corners.length - 1])) return null;
  const pts = pathPoints(routeThrough(a, b, corners).d);
  // Exactly: a corner the router snapped half a pixel onto a stub is not the
  // shape that was stored, and keeping it would rewrite the corners every time.
  // Exactly to a thousandth of a pixel, the finest a port is measured to
  // (`measured`): corners stored from ports measured noisily at another zoom
  // are still the shape they were.
  if (!samePts(pts.slice(1, -1), corners, MEASURED)) return null;
  if ((!uTurns && doublesBack(pts)) || crossesItself(pts)) return null;
  if (boxes.length && routeHitsBoxes(pts, avoidable(boxesNear(pts, boxes), a, b))) return null;
  return pts;
}

/**
 * The router's own route between two ends, clear of the obstacles when it
 * can be: `routeAuto`'s answer, got without showing it every symbol on the
 * sheet. The plain route when nothing is in its way, and otherwise
 * `routeAuto`'s search, told of the obstacles within its reach of the plain
 * route (`withinReach`) -- which is everything its search can see, and what
 * the line itself is drawn from, so a face is priced on the route it will be
 * drawn with.
 */
function autoRoute(a: End, b: End, obstacles: Box[], offset = 0): Pt[] {
  const plain = pathPoints(routeOrthogonal(a, b, offset).d);
  const reach = withinReach(plain, boxGrid(obstacles), a, b);
  return simplifyPoints(reach === NO_BOXES ? plain : pathPoints(routeAuto(a, b, reach, offset).d));
}

/**
 * What a pipe's route, or a face's, has to reckon with on the sheet.
 * `obstacles` are what the router routes round -- the symbols on the page,
 * when the caller says so. `bodies` are what a shape may not keep running
 * through, and a face may not send a line through, on a given page: the
 * same boxes when they are given, and every visible symbol on that page when
 * they are not. A bend left running through a symbol is never still the
 * pipe's, whatever the router is told; a symbol on another page is not in
 * its way.
 */
interface PipeSheet {
  obstacles: (page: string) => Box[];
  bodies: (page: string) => Box[];
}

/**
 * The sheet for a drawing: `obstacles` read as every caller reads them
 * (`perPage`) for both, or, when there are none, nothing to route round and
 * each page's symbols as its bodies.
 */
function pipeSheet(nodes: Node[], obstacles?: Obstacles): PipeSheet {
  const bodies = perPage(nodes, obstacles);
  return { obstacles: obstacles ? bodies : () => NO_BOXES, bodies };
}

const asSheet = (x: Box[] | PipeSheet | undefined): PipeSheet =>
  (!x ? { obstacles: () => NO_BOXES, bodies: () => NO_BOXES } : Array.isArray(x) ? { obstacles: () => x, bodies: () => x } : x);

/** The page a node is drawn on. */
const pageOfNode = (n: Node | undefined) => pageOf(n?.data as { page?: string } | undefined);

/**
 * The route through corners a person placed, settled: `routeThrough` fits
 * stored corners to where the ends are now, and the corners it then draws
 * through are what the pipe's lines are handed back. Routed through those
 * again it must draw the same thing, or the reseat would not be a fixed
 * point; a refit that moves them again is followed until it stops, which is
 * at once in every case but the odd one.
 */
function settledThrough(a: End, b: End, corners: Pt[]): Pt[] {
  let w = corners;
  let pts = pathPoints(routeThrough(a, b, w).d);
  for (let k = 0; k < 3; k++) {
    const inner = pts.slice(1, -1);
    if (samePts(inner, w)) break;
    const next = pathPoints(routeThrough(a, b, inner).d);
    if (samePts(next, pts)) break;
    w = inner;
    pts = next;
  }
  return pts;
}

/** A pipe's stored corners, in order from `a` to `b`: every line's, each read the pipe's way. */
function cornersOfPipe(pipe: Pipe, edgeById: Map<string, Edge>): Pt[] {
  return pipe.lines.flatMap((id, k) => {
    const w = waypointsOfLine(edgeById.get(id)!);
    return pipe.forward[k] ? w : [...w].reverse();
  });
}

/**
 * Does routing a pipe along `pts` leave every tee on it where it is to be
 * kept? Each tee put where the reseat would put it (`placeTees`), from where
 * it is to be kept (`anchors`, or where it is).
 */
function keepsTees(pipe: Pipe, a: End, b: End, pts: Pt[], m: Model, anchors?: Map<string, Pt>): boolean {
  const arcs = arcsOf(pts);
  const geo: PipeGeometry = { a, b, pts, arcs, length: arcs[arcs.length - 1] ?? 0, hand: false };
  if (geo.length < 1e-6) return false;
  const spots = placeTees(pipe, geo, m, anchors);
  return pipe.tees.every((id, i) => {
    const tee = m.byId.get(id);
    const at = pointAtArc(pts, spots[i]);
    if (!tee || !at) return false;
    const q = anchors?.get(id) ?? centreOfJunction(tee);
    return Math.abs(at.point.x - q.x) < MEASURED && Math.abs(at.point.y - q.y) < MEASURED;
  });
}

/**
 * The router's route for a pipe with tees on it: the router's own, unless
 * that moves a tee and one of the other crossbars the pipe could be drawn
 * with -- out at the end of either end's stub (`crossbarOffsets`), for two
 * ends that face each other across a gap -- leaves every tee exactly where
 * it is.
 *
 * A pipe routed afresh because an end moved was drawn with its crossbar in
 * the middle whatever was on it. A tank moved sideways under a tee on the
 * line down to it brought the middle of the new Z exactly to the tee: the tee
 * was pushed off the bend it found itself on (no tee sits on a bend), and the
 * branch into it from a port level with where it had been jogged over and ran
 * along the crossbar a tee's clearance above it. Out at the tank's stub, the
 * crossbar went under the tee and nothing moved. A tee stays where it is on
 * the drawing when its pipe changes under it, and the pipe is drawn so that
 * it can.
 *
 * Only a crossbar that moves no tee at all is taken instead: where the
 * choice is made from is then where the tees still are once they are
 * seated, and the next reseat makes the same choice. One that merely moved
 * them less moved them, and the next reseat, asked from where they had gone,
 * could choose again. `anchors` says where the tees are to be kept, during
 * a drag (where it began); otherwise it is where they are.
 */
function routeOfPipe(pipe: Pipe, a: End, b: End, obstacles: Box[], m: () => Model, anchors?: Map<string, Pt>): Pt[] {
  const plain = autoRoute(a, b, obstacles);
  if (!pipe.tees.length) return plain;
  const offsets = crossbarOffsets(a, b);
  if (!offsets.length) return plain;
  const model = m();
  if (keepsTees(pipe, a, b, plain, model, anchors)) return plain;
  for (const off of offsets) {
    const alt = autoRoute(a, b, obstacles, off);
    if (keepsTees(pipe, a, b, alt, model, anchors)) return alt;
  }
  return plain;
}

/**
 * The shape a pipe was drawn with, as its stored corners say, while it still
 * fits its two ends -- whatever is in its way. A pipe the router drew with no
 * corners at all was drawn straight, and is that while its ends are in line.
 */
function shapeOf(a: End, b: End, corners: Pt[]): Pt[] | null {
  if (corners.length) return keptShape(a, b, corners, [], true);
  const straight = simplifyPoints(pathPoints(routeOrthogonal(a, b).d));
  return straight.length === 2 ? straight : null;
}

/**
 * The shape a pipe keeps when a symbol has come to lie across it while its
 * ends stayed where they were relative to each other -- left alone, carried
 * whole, or moved only as far as the shape still fits them: every line of it
 * as it was, but for the lines whose stretch the symbol lies across, each
 * routed round it on its own (`routeAuto`), between its own two stations --
 * the tee or the end either side of it. Null when the pipe is not such a
 * pipe: its shape no longer fits its ends, a tee is not on it, nothing lies
 * across it, or the router was told of nothing to go round.
 *
 * A tee never moves because of something in its pipe's way. A bay let go of
 * with its pipe lying across a valve it had nothing to do with was routed
 * again whole, round the valve, and its tees were put on the detour: one
 * ended up jammed against the manifold's port on a six-pixel stub, and the
 * branch into it jogged over to reach it. The tees are where the person who
 * put them there left them, and the symbol is in the way of the stretch it
 * lies across and of nothing else -- the other lines keep their corners too.
 * Only a pipe whose ends moved so that its shape no longer fits them has no
 * shape to keep, and is the router's to draw again whole (`routeOfPipe`).
 *
 * Whether the shape still fits is the whole test of whether the ends have
 * stayed put, and nothing is recorded to answer it: a record of where the
 * ends were would have to be rewritten whenever they moved, and a drawing
 * opened on a screen that measures its ports a few pixels from where they
 * were written down would be rewritten on opening.
 *
 * A line with no way round keeps its stretch through the symbol: one whose
 * tee was set down inside it or against it, one boxed in, or one whose way
 * round would cross the pipe itself or could not be drawn again from the
 * corners it would be handed. Sent round whole instead, the pipe took its
 * tees with it -- the very move this is here to stop -- for the sake of a
 * line that went through the symbol anyway.
 *
 * `anchors` are where the tees are kept during a drag (`Dragging`); where
 * they are, otherwise. What it hands back is drawn through again exactly by
 * the corners its lines are handed, with every tee on it, so the next reseat
 * keeps it as the shape it is and moves no tee.
 */
function keptAround(
  pipe: Pipe, a: End, b: End, corners: Pt[], nodesById: Map<string, Node>, endOf: EndLookup,
  sheet: { bodies: Box[]; obstacles: Box[] }, m: () => Model, anchors?: Map<string, Pt>,
): Pt[] | null {
  const { bodies, obstacles } = sheet;
  // Nothing to route round -- the caller told the router of no symbols --
  // and there is no way round to take.
  if (!bodies.length || !obstacles.length || !pipe.tees.length) return null;
  const shape = shapeOf(a, b, corners);
  const inTheWay = (pts: Pt[]) => routeHitsBoxes(pts, avoidable(boxesNear(pts, bodies), a, b));
  if (!shape || !inTheWay(shape)) return null;
  const onIt = (pts: Pt[], c: Pt, s: number) => {
    const q = pointAtArc(pts, s)?.point;
    return !!q && Math.abs(q.x - c.x) < MEASURED && Math.abs(q.y - c.y) < MEASURED;
  };
  const arcs = arcsOf(shape);
  const L = arcs[arcs.length - 1];
  // Each tee exactly on the shape, in order: otherwise it is not the shape
  // the tees ride, and there is nothing to keep.
  const at: Pt[] = [], spots: number[] = [];
  for (const id of pipe.tees) {
    const tee = nodesById.get(id);
    if (!tee) return null;
    const c = anchors?.get(id) ?? centreOfJunction(tee);
    const s = project(shape, c, recordedArc(tee, pipe, L));
    if (!onIt(shape, c, s) || (spots.length && s <= spots[spots.length - 1] + SPOT_EPS)) return null;
    at.push(c);
    spots.push(s);
  }
  // A tee's end of a line: the tee where it is kept, on the face the pipe
  // runs through it by there -- the face the seat gives the line, which is
  // not yet the one it is on when the tee has just been slid round a bend.
  const teeEnd = (i: number, side: 'in' | 'out'): End | null => {
    const tee = nodesById.get(pipe.tees[i])!;
    const face = runFaces(pointAtArc(shape, spots[i])!.dir)[side];
    return endFor({ ...tee, position: { x: at[i].x - J_HALF, y: at[i].y - J_HALF } }, face, endOf);
  };
  // The whole pipe from its stretches, and whether it is one the next
  // reseat keeps: drawn again exactly through its own corners, and every tee
  // on it where the reseat puts it -- a way round that turns inside a tee's
  // reach has the tee pushed off the bend it brought (`keepsTees`).
  const join = (pieces: Pt[][]) => simplifyPoints(pieces.flat());
  const keeps = (path: Pt[]) => {
    const again = shapeOf(a, b, path.slice(1, -1));
    return !!again && samePts(again, path, MEASURED) && keepsTees(pipe, a, b, path, m(), anchors);
  };
  const n = pipe.tees.length;
  const pieces: Pt[][] = [];
  for (let k = 0; k <= n; k++) pieces.push(sliceByArc(shape, k === 0 ? 0 : spots[k - 1], k === n ? L : spots[k]));
  let path = shape;
  for (let k = 0; k <= n; k++) {
    // The stretch the line draws: from face to face, not under the dots.
    const lo = k === 0 ? 0 : spots[k - 1] + J_ANCHOR, hi = k === n ? L : spots[k] - J_ANCHOR;
    const drawn = hi > lo ? sliceByArc(shape, lo, hi) : [];
    if (drawn.length < 2 || !inTheWay(drawn)) continue;
    const sa = k === 0 ? a : teeEnd(k - 1, 'out');
    const sb = k === n ? b : teeEnd(k, 'in');
    if (!sa || !sb) continue;
    const round = autoRoute(sa, sb, obstacles);
    if (inTheWay(round)) continue;
    const tried = [...pieces];
    tried[k] = [...(k > 0 ? [at[k - 1]] : []), ...round, ...(k < n ? [at[k]] : [])];
    const next = join(tried);
    if (!keeps(next)) continue;
    pieces[k] = tried[k];
    path = next;
  }
  return path;
}

/**
 * Where a pipe runs: the route between its two ends, through the corners a
 * person placed, or the shape the router last drew while it still fits, or
 * that shape round a symbol that has come to lie across it (`keptAround`),
 * or the router's route (`routeOfPipe`). The two ends can be given, to price the
 * pipe on other faces than it has, and, for the tees on it, the drawing they
 * are placed in (`seat.m`, worked out from the two maps when not given) and
 * where they are to be kept during a drag (`seat.anchors`). Null when an end
 * is not a port that can be looked up (not yet measured): a pipe is never
 * routed, and no tee is ever moved, on a guess.
 */
export function pipeGeometry(
  pipe: Pipe, nodesById: Map<string, Node>, edgeById: Map<string, Edge>, endOf: EndLookup,
  sheet: Box[] | PipeSheet = [], ends?: { a?: End; b?: End }, seat?: { m?: Model; anchors?: Map<string, Pt> },
): PipeGeometry | null {
  const { obstacles, bodies } = asSheet(sheet);
  const na = nodesById.get(pipe.a.nodeId), nb = nodesById.get(pipe.b.nodeId);
  if (!na || !nb) return null;
  // The faces its end lines are on now, which a choice of face made since
  // the pipe was found may have changed.
  const handleOf = (end: PipeEnd) => {
    const e = edgeById.get(end.lineId);
    return e ? handleAt(e, end.nodeId) : end.handle;
  };
  const a = ends?.a ?? endFor(na, handleOf(pipe.a), endOf);
  const b = ends?.b ?? endFor(nb, handleOf(pipe.b), endOf);
  if (!a || !b) return null;
  const hand = pipe.lines.some(id => isHand(edgeById.get(id)!));
  const corners = cornersOfPipe(pipe, edgeById);
  const page = pageOfNode(na);
  const pts = simplifyPoints(hand
    ? settledThrough(a, b, corners)
    : (keptShape(a, b, corners, bodies(page), true)
      ?? keptAround(pipe, a, b, corners, nodesById, endOf, { bodies: bodies(page), obstacles: obstacles(page) }, model, seat?.anchors)
      ?? routeOfPipe(pipe, a, b, obstacles(page), model, seat?.anchors)));
  const arcs = arcsOf(pts);
  return { a, b, pts, arcs, length: arcs[arcs.length - 1] ?? 0, hand };

  function model(): Model {
    return seat?.m ? { ...seat.m, byId: nodesById } : buildModel([...nodesById.values()], [...edgeById.values()]);
  }
}

/**
 * The arc position of the point on `pts` nearest `p`. Where two points of
 * the path are equally near -- a tee exactly between two legs -- the one
 * nearer `prefer` along the path wins, so a tee that was on one leg stays on
 * that leg's side.
 */
function project(pts: Pt[], p: Pt, prefer?: number): number {
  let best = Infinity;
  const hits: number[] = [];
  let before = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const u = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
    const s = before + u * len;
    if (d < best - 1e-6) { best = d; hits.length = 0; hits.push(s); }
    else if (d <= best + 1e-6) hits.push(s);
    before += len;
  }
  if (!hits.length) return 0;
  if (prefer === undefined) return hits[0];
  return hits.reduce((q, s) => (Math.abs(s - prefer) < Math.abs(q - prefer) - 1e-9 ? s : q), hits[0]);
}

/** How far a tee on a pipe keeps from the pipe's end at this node. */
function endGapAt(end: PipeEnd, m: Model): number {
  const n = m.byId.get(end.nodeId);
  if (!n || !isJunction(n)) return END_GAP;
  return (m.linesAt.get(n.id)?.length ?? 0) <= 1 ? END_GAP : TEE_END_GAP;
}

/**
 * Where a tee was along a pipe as it last recorded it, in pixels from `a`.
 * Nothing when the record is about another pipe -- one a part has since cut
 * in two, say -- whose fraction says nothing about this one.
 */
function recordedArc(tee: Node, pipe: Pipe, length: number): number | undefined {
  const along = junctionData(tee).along;
  if (!along || typeof along.t !== 'number') return undefined;
  const flipped = along.from === pipe.b.nodeId && along.to === pipe.a.nodeId && along.from !== along.to;
  if (!flipped && !(along.from === pipe.a.nodeId && along.to === pipe.b.nodeId)) return undefined;
  return (flipped ? 1 - along.t : along.t) * length;
}

/**
 * The legal spots of a pipe's tees, in order, each kept where it is when it
 * may be. Each is held short of the latest spot that still leaves room for
 * the tees after it (`latestSpots`), so an early tee never crowds a later
 * one onto a bend or off the end.
 */
function placeTees(pipe: Pipe, geo: PipeGeometry, m: Model, anchors?: Map<string, Pt>): number[] {
  const n = pipe.tees.length;
  const gapA = endGapAt(pipe.a, m), gapB = endGapAt(pipe.b, m);
  const latest = latestSpots(geo.pts, n, { endGapA: gapA, endGapB: gapB });
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const tee = m.byId.get(pipe.tees[i])!;
    const at = project(geo.pts, anchors?.get(tee.id) ?? centreOfJunction(tee), recordedArc(tee, pipe, geo.length));
    out.push(legalSpot(geo.pts, at, {
      endGapA: gapA,
      // Room for the tees still to come. A pipe too short for them all
      // falls back to a flat spacing each.
      endGapB: latest ? geo.length - latest[i] : gapB + (n - 1 - i) * TEE_GAP,
      neighbours: { before: i > 0 ? out[i - 1] : undefined },
    }));
  }
  return out;
}

/**
 * The corners of the slice of a pipe that line k draws, in its own stored
 * order: every corner of the pipe between the tee before the line and the
 * tee after it. Dealt out by the tees' centres, so every corner belongs to
 * exactly one line -- for a tee on its legal spot, a reach clear of any
 * bend, that is exactly the line's slice; for one a crowded pipe could only
 * put near a bend, the corner still goes to a line rather than being lost
 * under the tee, and the pipe keeps its shape.
 */
function sliceCorners(pipe: Pipe, geo: PipeGeometry, spots: number[], k: number): Pt[] {
  const n = pipe.tees.length;
  const lo = k === 0 ? -Infinity : spots[k - 1];
  const hi = k === n ? Infinity : spots[k];
  const inner = geo.pts.slice(1, -1).filter((_, i) => geo.arcs[i + 1] > lo + 1e-9 && geo.arcs[i + 1] <= hi + 1e-9).map(p => ({ ...p }));
  return pipe.forward[k] ? inner : inner.reverse();
}

const sameCorners = (a: Pt[] | undefined, b: Pt[]) =>
  !!a && a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < MEASURED && Math.abs(p.y - b[i].y) < MEASURED);

/** A line carrying `corners` as its routing: a person's (`hand`) or the pipe's. The same object when it already does. */
function withCorners(e: Edge, corners: Pt[], hand: boolean): Edge {
  const d = (e.data ?? {}) as Record<string, unknown> & { waypoints?: Pt[]; viaRun?: boolean };
  if (!corners.length) {
    if (!d.waypoints && !d.viaRun) return e;
    const rest = { ...d };
    delete rest.waypoints;
    delete rest.viaRun;
    return { ...e, data: rest };
  }
  if (sameCorners(d.waypoints, corners) && (hand ? !d.viaRun : d.viaRun === true)) return e;
  const rest = { ...d };
  delete rest.viaRun;
  return { ...e, data: { ...rest, waypoints: corners, offset: 0, ...(hand ? {} : { viaRun: true }) } };
}

/** A line with the router's corners taken off it; the same object when it has none. */
function withoutRunCorners(e: Edge): Edge {
  const d = (e.data ?? {}) as Record<string, unknown> & { viaRun?: boolean };
  if (!d.viaRun) return e;
  const rest = { ...d };
  delete rest.waypoints;
  delete rest.viaRun;
  return { ...e, data: rest };
}

/** A tee this near where it was put has not moved: see `MEASURED`. */
const POS_EPS = MEASURED;

/** Mutable working copy of a drawing, handing back the original arrays when nothing changed. */
class Draft {
  nodes: Node[];
  edges: Edge[];
  private nodeAt = new Map<string, number>();
  private edgeAt = new Map<string, number>();
  private nodeMap: Map<string, Node> | null = null;
  private nodesCopied = false;
  private edgesCopied = false;
  constructor(nodes: Node[], edges: Edge[]) {
    this.nodes = nodes;
    this.edges = edges;
    nodes.forEach((n, i) => { if (!this.nodeAt.has(n.id)) this.nodeAt.set(n.id, i); });
    edges.forEach((e, i) => { if (!this.edgeAt.has(e.id)) this.edgeAt.set(e.id, i); });
  }
  node(id: string): Node | undefined { const i = this.nodeAt.get(id); return i === undefined ? undefined : this.nodes[i]; }
  /** The nodes by id, as they are now. */
  byId(): Map<string, Node> {
    if (!this.nodeMap) this.nodeMap = new Map(this.nodes.map(n => [n.id, n]));
    return this.nodeMap;
  }
  edge(id: string): Edge | undefined { const i = this.edgeAt.get(id); return i === undefined ? undefined : this.edges[i]; }
  setNode(next: Node) {
    const i = this.nodeAt.get(next.id)!;
    if (this.nodes[i] === next) return;
    if (!this.nodesCopied) { this.nodes = [...this.nodes]; this.nodesCopied = true; }
    this.nodes[i] = next;
    this.nodeMap?.set(next.id, next);
  }
  setEdge(next: Edge) {
    const i = this.edgeAt.get(next.id)!;
    if (this.edges[i] === next) return;
    if (!this.edgesCopied) { this.edges = [...this.edges]; this.edgesCopied = true; }
    this.edges[i] = next;
  }
}

/** Point the end of `e` at `nodeId` at `face`. */
const faceAt = (e: Edge, nodeId: string, face: Face) => withHandle(e, e.source === nodeId ? 'source' : 'target', face);

/**
 * Put a pipe's tees on it and hand its lines their slices. Returns the
 * geometry and the tees' spots, or null when the pipe could not be routed
 * (an end not yet measured), in which case nothing of it is touched.
 */
function seatPipe(
  pipe: Pipe, d: Draft, m: Model, endOf: EndLookup, sheet: PipeSheet, anchors?: Map<string, Pt>,
): { geo: PipeGeometry; spots: number[] } | null {
  const nodesById = d.byId();
  const edgeById = new Map<string, Edge>(); for (const id of pipe.lines) edgeById.set(id, d.edge(id)!);
  const geo = pipeGeometry(pipe, nodesById, edgeById, endOf, sheet, undefined, { m, anchors });
  if (!geo || geo.length < 1e-6) return null;
  const view: Model = { ...m, byId: nodesById };
  const spots = placeTees(pipe, geo, view, anchors);

  pipe.tees.forEach((id, i) => {
    const tee = d.node(id)!;
    const at = pointAtArc(geo.pts, spots[i])!;
    const faces = runFaces(at.dir);
    const position = { x: at.point.x - J_HALF, y: at.point.y - J_HALF };
    const moved = Math.abs(position.x - tee.position.x) > POS_EPS || Math.abs(position.y - tee.position.y) > POS_EPS;
    const along = junctionData(tee).along!;
    const from = pipe.a.nodeId, to = pipe.b.nodeId;
    // The record is rewritten when the tee moved, turned, or is on another
    // pipe. A pipe re-routed under a tee that stays where it was leaves it
    // alone: `t` and `ends` say where the tee was last put down, which is
    // all anything uses them for, and rewriting them on every re-route would
    // make opening a drawing an edit.
    const stale = moved || along.in !== faces.in || along.out !== faces.out || along.from !== from || along.to !== to
      || typeof along.t !== 'number' || !along.ends;
    if (stale) {
      const next: Along = {
        ...along, t: geo.length ? spots[i] / geo.length : 0, in: faces.in, out: faces.out, from, to,
        ends: { a: { x: geo.a.x, y: geo.a.y }, b: { x: geo.b.x, y: geo.b.y } },
      };
      d.setNode({ ...tee, ...(moved ? { position } : {}), data: { ...(tee.data as Record<string, unknown>), along: next } });
    }
    d.setEdge(faceAt(d.edge(pipe.lines[i])!, id, faces.in));
    d.setEdge(faceAt(d.edge(pipe.lines[i + 1])!, id, faces.out));
    // Anything else left on one of the run's faces -- a branch the tee has
    // just turned under -- goes across the run, on the side it comes from.
    // The lines on a riding tee's run faces are then only ever its run, which
    // is how the next reseat finds the pipe; which face across is best is the
    // face choice's to say.
    for (const line of m.linesAt.get(id) ?? []) {
      if (line.id === pipe.lines[i] || line.id === pipe.lines[i + 1]) continue;
      const e = d.edge(line.id)!;
      const h = handleAt(e, id);
      if (h !== faces.in && h !== faces.out) continue;
      const far = d.node(farOf(e, id).id);
      const comesFrom = far ? (isJunction(far) ? centreOfJunction(far) : centreOf(far)) : at.point;
      d.setEdge(faceAt(e, id, branchFace(at.dir, comesFrom, at.point)));
    }
  });
  pipe.lines.forEach((id, k) => d.setEdge(withCorners(d.edge(id)!, sliceCorners(pipe, geo, spots, k), geo.hand)));
  return { geo, spots };
}

// ── Choosing faces ───────────────────────────────────────────────────────────
//
// A line that meets a tee off its run -- a branch -- or an open end has a
// choice of face, and the choice is the route. Each choice is priced as the
// router prices a shape (length, and CORNER a corner), plus heavily for
// crossing the tee's own pipe or passing through a symbol, more for lying on
// the pipe, less for running near it within a tee's clearance, and by the
// pixel for running beside it within two grid steps. At most one line goes
// to a face while there are faces to go round, so two lines are never drawn
// on top of each other out of one face. The faces a line has win an exact
// tie, so nothing flips between two equal answers.
//
// A line that is no pipe's is priced against the rest of the page too, as
// it is laid (`Laid`): lying on another line, or passing through another
// junction's dot, costs what lying on its own pipe does, since either reads
// as a joint that is not there -- a branch run up an open end's line for
// ninety pixels and through its dot drew the two as one line with a tee on
// it. Running near another line, or beside it, costs as it does beside its
// own pipe, and crossing one a little (`crowdCost`). A straight line pays
// for neither: two open ends put down a tee's clearance from a pipe are
// joined straight, as they were put, not sent round in a U to keep further
// off it. A person's line is not priced at all: it arrives by the face its
// corners come in by (`handFace`).
//
// Where every way the router draws between the two ends still pays for the
// lines round it, the line is looked for among them (`routeAmong`), and a way
// that comes out cheaper is taken and carried as the router's corners.
//
// The choices are made in an order that never looks back, each priced only
// on what is already settled, so the reseat's own output prices exactly as
// what it was chosen on -- which is what makes the reseat a fixed point. A
// pipe that ends on a junction chooses its faces there just before it is
// seated, in the order the pipes are seated in: where its ends are is then
// where they stay, and a pipe chosen later at the same junction takes the
// faces left. The lines that are no pipe's choose last, together per
// junction, round the faces the pipes hold. When the choices were made all at
// once, a pipe's face at a junction moved the pipe, which moved the tees on
// it, which re-priced the other pipe ending at that junction, which moved the
// first one back: the two traded faces on every reseat and never settled.
//
// And a route is priced as it would be drawn afresh on that face -- through a
// person's corners, which nothing but a person changes, and otherwise the
// router's own route -- never by the shape the router last left on the line.
// The face a line already has would otherwise be priced by one shape and
// every other face by another, and a face changed on one reseat, its old
// shape dropped with it, could look like the wrong one on the next.

/**
 * What crossing the tee's own pipe, or passing through a symbol, costs, in
 * pixels of length: more than any detour that avoids it.
 */
const PENALTY = 1000;
/**
 * What a route lying on its tee's own pipe costs -- within a few pixels of
 * it, where it reads as the pipe itself: more than crossing it.
 */
const ON_PIPE = 2 * PENALTY;
/** Within this, a route running beside the pipe is drawn on it. */
const ON = 4;
/**
 * What running beside the pipe within a tee's clearance costs, beyond that:
 * something to avoid when there is room, and less than crossing the pipe,
 * since a crossbar in a gap narrower than the clearance is the right shape
 * for a symbol set just below a header.
 */
const NEAR_PIPE = 300;
/** Nearer another line than half a grid step, a route is drawn on it: the two read as one (`tracks.APART`). */
const ON_LINE_WITHIN = GRID / 2;
/** What lying on another line costs: what lying on its own pipe does. */
const ON_LINE = ON_PIPE;
/** What passing through another junction's dot costs: it reads as joined there, as lying on a line does. */
const THROUGH_DOT = ON_PIPE;
/**
 * How near a junction's centre a route may pass before it goes through the
 * dot: the dot and its shadow's ring. The pass that moves lines apart keeps
 * a middle half a grid step further off still (`tracks.dotReach`), which is
 * right for a nudge and too much for a choice of face: a branch running
 * straight up to its tank ten pixels beside another tee was sent the long
 * way round it. Worked out when asked, since junctions.ts, whose constants
 * these are, loads this module before it sets them.
 */
const dotReach = () => J_HALF + 2;
/**
 * How near a line a route may run alongside it before the two crowd each
 * other: two grid steps, the spacing of tees on a run. Nearer, and no
 * further, the two read as a pair that belong together -- a branch that
 * turned out of its tee to run twenty pixels down its own pipe's riser, or
 * a crossbar put fourteen pixels under a pipe it has nothing to do with. It
 * costs by the pixel (`BESIDE_PX`), so a short stretch is let be and a long
 * one goes further out when there is a way that does.
 */
const BESIDE = 2 * GRID;
/** What each pixel run beside a line, within `BESIDE` and beyond nearer, costs. */
const BESIDE_PX = 1;
/**
 * What crossing another line costs: a little. A crossing is drawn with a
 * hop, and says plainly that the two do not meet; a route with one fewer is
 * better when it costs no more than a corner or so to have.
 */
const CROSS_LINE = 20;
/**
 * Nearer another line than a grid step, and further than lying on it: the
 * two are drawn closer than any two lines the canvas spaces apart itself,
 * and read as a line and its shadow. Once for the stretch, besides the
 * pixels of it (`NEAR_LINE`).
 */
const NEAR_LINE_WITHIN = GRID;
const NEAR_LINE = 100;

interface UnitEnd { nodeId: string; lineId: string; handle: string | null | undefined; choices: Face[] | null }
interface Unit {
  key: string;
  pipe: Pipe | null;
  line: Edge | null;
  ends: [UnitEnd, UnitEnd];
  /** For pricing it against what is laid (`crowdCost`): its page, and what of what is laid is its own. */
  crowd?: { page: string; own: Set<string> };
}

/**
 * Where two axis-aligned paths cross at right angles, away from their ends,
 * and whether the segment of `q` crossed there runs across (horizontally).
 */
function crossingsOf(p: Pt[], q: Pt[]): { at: Pt; across: boolean }[] {
  const out: { at: Pt; across: boolean }[] = [];
  for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
    const [p1, p2, q1, q2] = [p[i], p[i + 1], q[j], q[j + 1]];
    const pH = Math.abs(p1.y - p2.y) < 1e-6, qH = Math.abs(q1.y - q2.y) < 1e-6;
    const pV = Math.abs(p1.x - p2.x) < 1e-6, qV = Math.abs(q1.x - q2.x) < 1e-6;
    if (!((pH && qV) || (pV && qH))) continue;
    const [h1, h2, v1, v2] = pH ? [p1, p2, q1, q2] : [q1, q2, p1, p2];
    const x = v1.x, y = h1.y;
    if (x > Math.min(h1.x, h2.x) + 1e-6 && x < Math.max(h1.x, h2.x) - 1e-6
      && y > Math.min(v1.y, v2.y) + 1e-6 && y < Math.max(v1.y, v2.y) - 1e-6) out.push({ at: { x, y }, across: qH });
  }
  return out;
}

/**
 * The crossings of a tee's own pipe that a route to `far` makes because of
 * where the tee is, not because of where `far` is: all of them but one right
 * where the far end is -- within a tee's clearance of it -- on a leg of the
 * pipe the tee has no face on the far end's side of.
 *
 * That one is the far end's doing. It was put down across the pipe, a few
 * pixels off it -- an open end the pipe's last leg came to run just above
 * when its symbol was dragged down, with the tee up on the pipe's other leg
 * -- and every way into it either crosses the pipe there or goes all the way
 * round the pipe's corner: out of the tee's other face, down beside the pipe
 * and back up under it, a hook. Crossing where the end is, is only what the
 * drawing says. But where the tee has a face on the far end's side of the
 * leg -- a tee on that very leg -- the crossing is the choice of the other
 * face, and is priced as any crossing is.
 */
function ownCrossings(pts: Pt[], pipe: Pt[], tee: Node | undefined, faces: Face[], far: Pt): number {
  let n = 0;
  for (const x of crossingsOf(pts, pipe)) {
    if (tee && Math.hypot(x.at.x - far.x, x.at.y - far.y) <= J_CLEAR + AXIS_EPS) {
      const side = (q: Pt) => {
        const v = x.across ? q.y - x.at.y : q.x - x.at.x;
        return Math.abs(v) < AXIS_EPS ? 0 : Math.sign(v);
      };
      const s = side(far);
      if (s !== 0 && faces.every(f => side(junctionEnd(tee.position, f)) !== s)) continue;
    }
    n++;
  }
  return n;
}

/** How long two paths run parallel within `within` px of each other. */
function alongside(p: Pt[], q: Pt[], within: number): number {
  let total = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    for (let j = 0; j + 1 < q.length; j++) total += lying(p[i], p[i + 1], q[j], q[j + 1], within);
  }
  return total;
}

/**
 * How far apart segment a-b runs from segment c-d when the two run the same
 * way, and for how long they run side by side; null when they run across
 * each other, or not side by side at all.
 */
function together(a: Pt, b: Pt, c: Pt, d: Pt): { apart: number; o: number } | null {
  let apart: number, o: number;
  if (Math.abs(a.y - b.y) < 1e-6 && Math.abs(c.y - d.y) < 1e-6) {
    apart = Math.abs(a.y - c.y);
    o = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
  } else if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(c.x - d.x) < 1e-6) {
    apart = Math.abs(a.x - c.x);
    o = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
  } else return null;
  return o > AXIS_EPS ? { apart, o } : null;
}

/** How long segment a-b runs parallel to segment c-d within `within` px of it. */
function lying(a: Pt, b: Pt, c: Pt, d: Pt, within: number): number {
  let o = 0;
  if (Math.abs(a.y - b.y) < 1e-6 && Math.abs(c.y - d.y) < 1e-6 && Math.abs(a.y - c.y) < within) {
    o = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
  } else if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(c.x - d.x) < 1e-6 && Math.abs(a.x - c.x) < within) {
    o = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
  }
  return o > AXIS_EPS ? o : 0;
}

/** How many of the boxes a path passes through the inside of, each counted once. */
function entries(pts: Pt[], boxes: Box[]): number {
  let n = 0;
  for (const bx of boxes) {
    for (let i = 0; i + 1 < pts.length; i++) if (segmentEntersBox(pts[i], pts[i + 1], bx, 1)) { n++; break; }
  }
  return n;
}

/** The faces a line may take at `node`: the two across a riding tee's run, all four of any other tee, none of a symbol. */
function choicesAt(node: Node | undefined): Face[] | null {
  if (!node || !isJunction(node)) return null;
  const along = junctionData(node).along;
  return along ? ACROSS[along.in] : FACES;
}

/** The faces given out at a junction so far in one reseat, and the routes that took them. */
interface Held { faces: Set<string>; routes: Pt[][] }

/** Everything a choice of face is priced on, for one reseat. */
interface Pricing {
  d: Draft;
  m: Model;
  endOf: EndLookup;
  sheet: PipeSheet;
  /**
   * The sheet a route between these nodes is priced and routed on: `sheet`,
   * or during a drag, for what the drag does not move, `sheet` without the
   * symbols being dragged (`Dragging`).
   */
  sheetFor: (nodeIds: string[]) => PipeSheet;
  /** Where the tees are to be kept while a pipe is routed: where a drag began (`Dragging.anchors`), or where they are. */
  anchors?: Map<string, Pt>;
  /** Each pipe's path as it runs: put in as the pipe is seated, worked out from the drawing when asked for sooner. */
  paths: Map<Pipe, Pt[] | null>;
  held: Map<string, Held>;
  prices: Map<string, Price>;
  /** The routes a unit could be drawn with, by unit and faces: worked out once, however often they are priced. */
  routes: Map<string, Candidates | null>;
  /**
   * What is laid on the page, once the lines that are no pipe's are being
   * chosen (`chooseLineFaces`): what those are priced against besides their
   * own pipes. Null while the pipes are.
   */
  laid: Laid | null;
  /** The junctions whose person's lines have been given their faces to hold (`holdHandFaces`). */
  handHeld: Set<string>;
  /**
   * During a drag, what it moves: the nodes it picks up, and the tees on
   * every pipe that ends on one. A line with an end on none of them is not
   * looked for again among the other lines until the drag is let go of
   * (`priced`).
   */
  moving?: ReadonlySet<string>;
}

/**
 * A unit's route on a pair of faces, and what it costs. `offset` is the
 * crossbar a line that routes itself is drawn with (`routeOrthogonal`), the
 * middle unless another prices better.
 */
interface Price {
  pts: Pt[] | null;
  cost: number;
  offset: number;
  /** Its route is not one the router draws from its two ends, and the line is to carry it as the router's corners. */
  corners?: boolean;
}

/**
 * One route a unit could be drawn with, and the crossbar it is drawn with;
 * and, once asked, what it costs for everything but what is laid on the page
 * (its length and corners, its own pipes and the symbols in its way), which
 * nothing laid later changes.
 */
interface Candidate {
  pts: Pt[];
  offset: number;
  /**
   * Drawn through its own corners, which the line carries (`viaRun`), not
   * routed from its two ends: the route looked for among the other lines
   * (`routeAmong`), or the one the line already carries. Nothing moves its
   * middle a step aside (`tracks.separate`), so it is priced as it stands.
   */
  corners?: boolean;
  own?: number;
  /** The part of `own` its own pipes charge: what, with `crowd`, says the route pays for the lines round it. */
  ownLines?: number;
  /** What it costs for what is laid on its page (`crowdCost`), as far as the first `n` lines laid. */
  crowd?: { n: number; cost: number };
}

/**
 * The routes a unit could be drawn with on a pair of faces; `crossbars` when
 * it is a line that routes itself; and, once looked for, the route among the
 * other lines (`among`: null when there was none to find).
 */
interface Candidates {
  list: Candidate[];
  crossbars: boolean;
  among?: Candidate | null;
  /**
   * The line carries router's corners on these faces that are not kept
   * (`candidatesOf`): the way round it was sent, which only the search can
   * say is still the one, or corners that no longer fit.
   */
  lost?: boolean;
}

/**
 * Is a line to be looked for again among the other lines this reseat? Always
 * but during a drag, and then only a line with an end on something the drag
 * moves (`Pricing.moving`).
 */
const looksAgain = (u: Unit, p: Pricing) => !p.moving || u.ends.some(end => p.moving!.has(end.nodeId));

const pricingFor = (
  d: Draft, m: Model, endOf: EndLookup, sheet: PipeSheet, sheetFor: (ids: string[]) => PipeSheet = () => sheet,
  anchors?: Map<string, Pt>, moving?: ReadonlySet<string>,
): Pricing =>
  ({
    d, m, endOf, sheet, sheetFor, anchors, paths: new Map(), held: new Map(), prices: new Map(), routes: new Map(),
    laid: null, handHeld: new Set(), moving,
  });

/** The nodes at a pipe's two ends and the tees on it. */
const nodesOfPipe = (pipe: Pipe) => [pipe.a.nodeId, pipe.b.nodeId, ...pipe.tees];

/** A pipe's lines as the drawing has them now. */
function linesNow(pipe: Pipe, d: Draft): Map<string, Edge> {
  const out = new Map<string, Edge>();
  for (const id of pipe.lines) out.set(id, d.edge(id)!);
  return out;
}

/** The path of the pipe a riding tee is on, as it now runs. */
function pipeAtTee(p: Pricing, teeId: string): Pt[] | undefined {
  const pipe = p.m.byTee.get(teeId)?.pipe;
  if (!pipe) return undefined;
  if (!p.paths.has(pipe)) {
    const sheet = p.sheetFor(nodesOfPipe(pipe));
    const geo = pipeGeometry(pipe, p.d.byId(), linesNow(pipe, p.d), p.endOf, sheet, undefined, { m: p.m, anchors: p.anchors });
    p.paths.set(pipe, geo?.pts ?? null);
  }
  return p.paths.get(pipe) ?? undefined;
}

/**
 * The route a unit would draw with its two ends on these faces, drawn
 * afresh: through a person's corners where it has them, the router's route
 * otherwise. For a pipe that is the router's own route, not the crossbar it
 * may be seated with to leave its tees where they are (`routeOfPipe`): that
 * depends on where the tees are, which the choice of face moves, and a face
 * priced from where the last reseat left them could win the next one. Null
 * when an end cannot be looked up.
 */
function freshRoute(u: Unit, fa: string | null | undefined, fb: string | null | undefined, p: Pricing): Pt[] | null {
  const byId = p.d.byId();
  const na = byId.get(u.ends[0].nodeId), nb = byId.get(u.ends[1].nodeId);
  if (!na || !nb) return null;
  const a = endFor(na, fa, p.endOf), b = endFor(nb, fb, p.endOf);
  if (!a || !b) return null;
  const obstacles = p.sheetFor(u.pipe ? nodesOfPipe(u.pipe) : [na.id, nb.id]).obstacles(pageOfNode(na));
  if (u.pipe) {
    const lines = linesNow(u.pipe, p.d);
    if (u.pipe.lines.some(id => isHand(lines.get(id)!))) return simplifyPoints(settledThrough(a, b, cornersOfPipe(u.pipe, lines)));
    return autoRoute(a, b, obstacles);
  }
  const e = p.d.edge(u.line!.id)!;
  if (isHand(e)) return pathPoints(routeThrough(a, b, waypointsOfLine(e)).d);
  return autoRoute(a, b, obstacles);
}

/** The key a pipe is laid under (`Laid`). */
const pipeKey = (pipe: Pipe) => `pipe:${pipe.lines[0]}`;

/**
 * What a unit's route pays for the symbols it runs through. With its length
 * and corners and what its own pipes charge (`ownLineCost`), what it costs
 * but for what is laid on the page (`candidateCost`); a line that is no
 * pipe's is priced for what else is laid on its page besides (`crowdCost`).
 */
function bodyCost(u: Unit, pts: Pt[], p: Pricing): number {
  const bodies = p.sheetFor(u.pipe ? nodesOfPipe(u.pipe) : u.ends.map(e => e.nodeId)).bodies(pageOfNode(p.d.node(u.ends[0].nodeId)));
  return bodies.length && pts.length ? PENALTY * entries(pts, avoidable(boxesNear(pts, bodies), pts[0], pts[pts.length - 1])) : 0;
}

/**
 * What a unit's route pays for the pipes its own tees ride: crossing one, as
 * `ownCrossings` counts; lying on it; running near it, within a tee's
 * clearance; and running beside it, within `BESIDE`.
 *
 * Beside is by the pixel, and is what keeps a branch that leaves its tee
 * across the run from turning straight down alongside it: out of a tee on a
 * riser to an open end below, the branch ran twenty pixels down the riser
 * for a hundred, crossed the pipe's lower leg in its last two pixels and
 * ended in a hop no bigger than the line -- when out past the leg and into
 * the open end's far side, it crossed the leg with room for its hop and
 * kept its distance from the riser.
 *
 * Where the far end itself was put down within a tee's clearance of the
 * pipe, its own stub is its doing, not the route's: an open end set just
 * under the pipe is reached along the pipe for the few pixels of its stub
 * whichever way the route comes, as it is crossed to (`ownCrossings`).
 */
function ownLineCost(u: Unit, pts: Pt[], p: Pricing): number {
  let c = 0;
  u.ends.forEach((end, i) => {
    if (!end.choices) return;
    const pipe = pipeAtTee(p, end.nodeId);
    if (!pipe) return;
    const far = i === 0 ? pts[pts.length - 1] : pts[0];
    c += PENALTY * ownCrossings(pts, pipe, p.d.node(end.nodeId), end.choices, far);
    const put = (nearestOnPolyline(pipe, far)?.dist ?? Infinity) <= J_CLEAR + AXIS_EPS;
    const route = put ? withoutApproach(pts, i === 1, u.ends[1 - i].choices ? J_STUB : STUB) : pts;
    const on = alongside(route, pipe, ON);
    const near = alongside(route, pipe, J_CLEAR) - on;
    if (on > 0) c += ON_PIPE + on;
    if (near > 0) c += NEAR_PIPE + near;
    if (turns(pts)) c += BESIDE_PX * (alongside(route, pipe, BESIDE + AXIS_EPS) - on - near);
  });
  return c;
}

/**
 * Does a route turn? One that does not is a straight line between two ends
 * that were put in line, and is never charged for running beside a line:
 * two open ends put down a tee's clearance from a pipe are joined straight,
 * as they were put, not sent round in a U to keep further off it.
 */
const turns = (pts: Pt[]) => simplifyPoints(pts).length > 2;

/**
 * A route with the last `len` pixels of its leg into one end taken off: the
 * first leg's when `atStart`, the last leg's otherwise; the whole leg when
 * it is no longer.
 */
function withoutApproach(pts: Pt[], atStart: boolean, len: number): Pt[] {
  if (pts.length < 2) return pts;
  const q = atStart ? [...pts].reverse() : pts;
  const n = q.length, a = q[n - 2], b = q[n - 1];
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  const out = l <= len + AXIS_EPS
    ? q.slice(0, n - 1)
    : [...q.slice(0, n - 1), { x: a.x + ((b.x - a.x) * (l - len)) / l, y: a.y + ((b.y - a.y) * (l - len)) / l }];
  return atStart ? out.reverse() : out;
}

/**
 * What a candidate route costs: its own price worked out once, and what is
 * laid on its page priced as far as it has been laid -- the lines laid since
 * it was last asked added to what the ones before them came to.
 */
function candidateCost(u: Unit, cand: Candidate, p: Pricing): number {
  if (cand.own === undefined) {
    cand.ownLines = ownLineCost(u, cand.pts, p);
    cand.own = routeCost(cand.pts) + cand.ownLines + bodyCost(u, cand.pts, p);
  }
  const laid = p.laid;
  if (!laid || u.pipe) return cand.own;
  if (!cand.crowd) cand.crowd = { n: laid.count, cost: crowdCost(u, cand.pts, p, laid, undefined, cand.corners) };
  else if (cand.crowd.n < laid.count) {
    cand.crowd.cost += crowdCost(u, cand.pts, p, laid, cand.crowd.n, cand.corners);
    cand.crowd.n = laid.count;
  }
  return cand.own + cand.crowd.cost;
}

/** What a candidate pays for the lines round it -- its own pipes and what is laid -- as far as it has been priced. */
const lineCostOf = (cand: Candidate) => (cand.ownLines ?? 0) + (cand.crowd?.cost ?? 0);

/**
 * What a line's route costs for what else is laid on its page: lying on
 * another line, running beside one, crossing one, and passing through the
 * dot of a junction it does not end on. Not its own pipes, which
 * `ownLineCost` prices as such, nor itself. Given `since`, only the lines
 * laid from that one on. `fixed` says the route is drawn through its own
 * corners (`Candidate.corners`), so nothing will move its middle.
 *
 * Lying on a line is charged only where the pass that moves lines apart
 * cannot undo it (`tracks.separate`). That pass moves the middle of a line
 * that routes itself a grid step or two, off every other line and off every
 * dot; what it cannot move is a segment touching an end, or any of a line
 * with corners, or a pipe's. So a middle on either side is its to draw a
 * step apart, as it always has -- two branches from tees side by side down
 * to symbols side by side, their crossbars both in the middle of the same
 * gap. Charged for that here, the second one's crossbar was sent out to its
 * tee's stub, and ran along the pipe a tee's clearance under it the whole
 * way across. What is left is a leg out of an end lying on another such leg,
 * or on a line nothing moves -- a branch run up an open end's line -- and a
 * leg out of an end through a dot.
 *
 * Running near a line, closer than a grid step, or beside one, within
 * `BESIDE`, is what that pass leaves alone -- it moves a middle off a line a
 * step, no further -- and is charged: near by the stretch and the pixel,
 * beside by the pixel, a middle it moves off a line included, since a step
 * off is still beside it. All but two middles side by side, which are the
 * staircase that pass draws of parallel feeds on purpose. A crossing costs a
 * little, however it comes: a hop is honest, and the route with fewer is the
 * plainer one.
 */
function crowdCost(u: Unit, pts: Pt[], p: Pricing, laid: Laid, since?: number, fixed = false): number {
  if (pts.length < 2) return 0;
  if (!u.crowd) {
    const own = new Set<string>([u.line!.id]);
    for (const end of u.ends) {
      const pipe = p.m.byTee.get(end.nodeId)?.pipe;
      if (pipe && end.choices) own.add(pipeKey(pipe));
    }
    u.crowd = { page: pageOfNode(p.d.node(u.ends[0].nodeId)), own };
  }
  const { page, own } = u.crowd;
  const w = ON_LINE_WITHIN, far = BESIDE + AXIS_EPS;
  const { x0, y0, x1, y1 } = boundsOf(pts);
  // A line being chosen is priced as routing itself: the router's corners on
  // it are priced afresh, as every line's are, and a person's are not chosen.
  // One that is to carry corners of its own is priced as it stands.
  const middle = (route: Pt[], routesItself: boolean) => (i: number) => routesItself && i > 0 && i < route.length - 2;
  const oursMoves = middle(pts, !fixed);
  const turning = turns(pts);
  let c = 0;
  const others = since === undefined
    ? laid.near(page, x0 - far, y0 - far, x1 + far, y1 + far)
    : laid.laidSince(since, page, x0 - far, y0 - far, x1 + far, y1 + far);
  for (const other of others) {
    if (own.has(other.id)) continue;
    const theirsMoves = middle(other.pts, other.free);
    let on = 0, near = 0, beside = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      for (let j = 0; j + 1 < other.pts.length; j++) {
        const ours = oursMoves(i), theirs = theirsMoves(j);
        if (ours && theirs) continue;
        const run = together(pts[i], pts[i + 1], other.pts[j], other.pts[j + 1]);
        if (!run || run.apart >= far) continue;
        // Lying on it where one of the two moves is moved a step off it:
        // beside it, then.
        if (run.apart < w) { if (ours || theirs) beside += run.o; else on += run.o; }
        else if (run.apart < NEAR_LINE_WITHIN) near += run.o;
        else beside += run.o;
      }
    }
    if (on > 0) c += ON_LINE + on;
    if (near > 0 && turning) c += NEAR_LINE + near;
    if (turning) c += BESIDE_PX * beside;
    c += CROSS_LINE * crossingsOf(pts, other.pts).length;
  }
  // The dots are all laid before anything is priced.
  if (since !== undefined) return c;
  const r = dotReach();
  for (const dot of laid.dotsNear(page, x0 - r, y0 - r, x1 + r, y1 + r)) {
    if (dot.id === u.ends[0].nodeId || dot.id === u.ends[1].nodeId) continue;
    const box = { x: dot.at.x - r, y: dot.at.y - r, w: 2 * r, h: 2 * r };
    for (let i = 0; i + 1 < pts.length; i++) {
      if (!oursMoves(i) && segmentEntersBox(pts[i], pts[i + 1], box, 0)) { c += THROUGH_DOT; break; }
    }
  }
  return c;
}

/**
 * What choosing a crossbar other than the middle adds to its price: enough
 * that the middle wins every tie, and nothing a real difference notices.
 */
const OTHER_CROSSBAR = 1e-3;

/**
 * By how much the route looked for among the lines has to come out cheaper
 * than the best the router draws from the two ends before it is taken:
 * more than every tie-break above. A route the router can draw is drawn by
 * it, and one it cannot is carried as corners; of two that cost the same,
 * the router's.
 */
const AMONG_WINS = 1e-2;

/** The crossbar a line that routes itself is stored with. */
const offsetOfLine = (e: Edge) => ((e.data as { offset?: number } | undefined)?.offset ?? 0);

/** The router's corners a line carries: none for a person's line, or a line with none. */
const runCornersOf = (e: Edge): Pt[] => {
  const d = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
  return d.viaRun && d.waypoints?.length ? d.waypoints : [];
};

/**
 * The routes a unit could be drawn with on these faces: its route drawn
 * afresh, and, for a line that routes itself, the same with each crossbar
 * it could be drawn with besides -- the one it has, and out at the end of
 * either end's stub (`crossbarOffsets`) -- and, on the faces it is on, the
 * route through the router's corners it carries, while they still fit it
 * (`keptShape`) and run through no symbol. Worked out once per reseat.
 */
function candidatesOf(u: Unit, fa: string | null | undefined, fb: string | null | undefined, p: Pricing): Candidates | null {
  const k = `${u.key}|${fa}|${fb}`;
  if (p.routes.has(k)) return p.routes.get(k)!;
  const pts = freshRoute(u, fa, fb, p);
  let out: Candidates | null = null;
  if (pts) {
    out = { list: [{ pts, offset: 0 }], crossbars: false };
    const e = u.line ? p.d.edge(u.line.id)! : null;
    const ends = e && !isHand(e) ? endsOf(u, fa, fb, p) : null;
    if (e && ends) {
      out.crossbars = true;
      const here = fa === u.ends[0].handle && fb === u.ends[1].handle;
      const current = here ? offsetOfLine(e) : 0;
      const offsets = new Set([current, ...crossbarOffsets(ends.a, ends.b)]);
      offsets.delete(0);
      for (const off of offsets) out.list.push({ pts: autoRoute(ends.a, ends.b, ends.obstacles, off), offset: off });
      // Kept as step 4 keeps the router's corners on a line that is no
      // pipe's: while they fit, run through no symbol and do not double
      // back. A way round that does is one only the search could have found,
      // and the search is asked for it again (`Candidates.lost`).
      const w = here ? runCornersOf(e) : [];
      const bodies = p.sheet.bodies(pageOfNode(p.d.node(u.ends[0].nodeId)));
      const kept = w.length ? keptShape(ends.a, ends.b, w, bodies) : null;
      if (kept) out.list.push({ pts: throughAsStored(ends.a, ends.b, w) ?? kept, offset: 0, corners: true });
      else if (w.length) out.lost = true;
    }
  }
  p.routes.set(k, out);
  return out;
}

/**
 * A unit's route and price with its ends on these faces, worked out once for
 * everything laid so far.
 *
 * A line that routes itself -- a branch, or a line on an open end -- is
 * priced on each crossbar it could be drawn with, and takes the cheapest:
 * the middle, or out at the end of either end's stub (`crossbarOffsets`).
 * Priced only in the middle, a branch whose crossbar there lay along its own
 * pipe or crossed it had to choose between two faces that both did, and one
 * of them wrapped round the pipe -- when a crossbar at the other end's stub,
 * on the face it had, crossed nothing. The middle wins every tie, and the
 * crossbar the line has now wins over both, so nothing moves that need not;
 * the corners it carries win over all of them.
 *
 * And when the best of those still pays for the lines round it -- crosses
 * its own pipe, runs along or beside it or another line, crosses another,
 * or passes through a dot -- the route looked for among them is priced too
 * (`amongOf`), and taken when it comes out cheaper. It is not a shape the
 * router draws from the two ends, so the line carries it as the router's
 * corners (`Price.corners`). During a drag, only for a line with an end on
 * something the drag moves (`looksAgain`), or one carrying corners that are
 * not kept (`Candidates.lost`) -- a way round that doubles back, which only
 * the search can say is still the way, and which dropped as a stale bend
 * had the branch drawn across its own pipe until the drag was let go of.
 * Every other line keeps what it has, as a pipe the drag does not touch
 * keeps its shape, and is looked for again when the drag is let go of: a
 * valve dragged across a crowded stand looked for fresh routes for every
 * branch whose neighbourhood its lines passed through, on every tick.
 */
function priced(u: Unit, fa: string | null | undefined, fb: string | null | undefined, p: Pricing): Price {
  const k = `${u.key}|${fa}|${fb}|${p.laid ? p.laid.version : -1}`;
  let v = p.prices.get(k);
  if (!v) {
    const cands = candidatesOf(u, fa, fb, p);
    if (!cands) v = { pts: null, cost: Infinity, offset: 0 };
    else {
      const e = u.line ? p.d.edge(u.line.id)! : null;
      const here = !!e && fa === u.ends[0].handle && fb === u.ends[1].handle;
      const current = here ? offsetOfLine(e!) : 0;
      const carrying = here && runCornersOf(e!).length > 0;
      const first = cands.list[0];
      let best = first;
      v = { pts: first.pts, cost: candidateCost(u, first, p) - (cands.crossbars && current === 0 && !carrying ? 1e-6 : 0), offset: 0 };
      for (const cand of cands.list.slice(1)) {
        const cost = candidateCost(u, cand, p) + (cand.corners || cand.offset === current ? -1e-6 : OTHER_CROSSBAR);
        if (cost < v.cost - 1e-12) { v = { pts: cand.pts, cost, offset: cand.offset, corners: cand.corners }; best = cand; }
      }
      const looking = looksAgain(u, p) || !!cands.lost;
      const among = cands.crossbars && p.laid && looking && lineCostOf(best) > 0 ? amongOf(u, fa, fb, p, cands) : null;
      if (among) {
        const cost = candidateCost(u, among, p);
        if (cost < v.cost - AMONG_WINS) v = { pts: among.pts, cost, offset: 0, corners: true };
      }
    }
    p.prices.set(k, v);
  }
  return v;
}

/**
 * The route for a line that is no pipe's looked for among the other lines
 * on its page (`routeAmong`), once per reseat and pair of faces: what is
 * laid when it is first asked for -- the pipes its tees ride, as a great
 * deal to cross or run along; every other line laid, as a hop to cross and
 * something to keep its distance from; and every junction's dot but its own
 * two ends'. Null when there is none, or none the line could carry: the
 * route has to be drawn again exactly from its own corners (`throughAsStored`)
 * wherever it is drawn, and a straight line has no corners to carry.
 *
 * Round every symbol on the page (`PipeSheet.bodies`), whether or not the
 * caller has the router go round them: a way round the lines that ran
 * through a symbol would be no way at all. And the ones a drag is carrying
 * included: a line routed afresh during a drag goes round a symbol dragged
 * into its way, and so does this.
 */
function amongOf(u: Unit, fa: string | null | undefined, fb: string | null | undefined, p: Pricing, cands: Candidates): Candidate | null {
  if (cands.among !== undefined) return cands.among;
  cands.among = null;
  const ends = endsOf(u, fa, fb, p);
  if (!ends || !p.laid) return null;
  const page = pageOfNode(p.d.node(u.ends[0].nodeId));
  const plain = pathPoints(routeOrthogonal(ends.a, ends.b).d);
  const b = boundsOf(plain), r = AMONG_REACH;
  const around = { x0: b.x0 - r, y0: b.y0 - r, x1: b.x1 + r, y1: b.y1 + r };
  const obstacles = boxGrid(p.sheet.bodies(page)).overlapping(around.x0, around.y0, around.x1, around.y1);
  const found = routeAmong(ends.a, ends.b, obstacles, softFor(u, p, p.laid, page, around), plain);
  if (!found) return null;
  const pts = simplifyPoints(found);
  const drawn = pts.length > 2 ? throughAsStored(ends.a, ends.b, pts.slice(1, -1)) : null;
  if (!drawn || !samePts(drawn, pts, MEASURED) || !wellMade(pts, plain, ends.a, ends.b)) return null;
  cands.among = { pts, offset: 0, corners: true };
  return cands.among;
}

/**
 * Is a route found among the lines one to draw? Not when it shortens a stub
 * the plain route leaves whole, nor when it turns twice within half a grid
 * step. The search may do either, at a price, to keep off a line it would
 * otherwise touch -- and between two ports that face each other across a
 * narrow gap, each with a line on it, it came into its port by a leg of two
 * pixels and a half, a wiggle nobody can read as a line arriving. The plain
 * route, touching the other line, is the plainer drawing of that.
 */
function wellMade(pts: Pt[], plain: Pt[], a: End, b: End): boolean {
  const len = (p: Pt, q: Pt) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
  const n = pts.length, m = plain.length;
  if (len(pts[0], pts[1]) < Math.min(a.stub ?? STUB, len(plain[0], plain[1])) - AXIS_EPS) return false;
  if (len(pts[n - 2], pts[n - 1]) < Math.min(b.stub ?? STUB, len(plain[m - 2], plain[m - 1])) - AXIS_EPS) return false;
  for (let i = 1; i + 2 < n; i++) if (len(pts[i], pts[i + 1]) < GRID / 2) return false;
  return true;
}

/**
 * What a line's route is looked for among (`Soft`), priced as `ownLineCost`
 * and `crowdCost` price it: the pipes its tees ride, and the lines laid on
 * its page and the dots inside `around` -- as far as the search can go.
 */
function softFor(
  u: Unit, p: Pricing, laid: Laid, page: string, around: { x0: number; y0: number; x1: number; y1: number },
): Soft {
  const lines: SoftLine[] = [];
  const own = new Set<string>([u.line!.id]);
  for (const end of u.ends) {
    if (!end.choices) continue;
    const pipe = p.m.byTee.get(end.nodeId)?.pipe;
    const path = pipe && pipeAtTee(p, end.nodeId);
    if (!pipe || !path || own.has(pipeKey(pipe))) continue;
    own.add(pipeKey(pipe));
    lines.push({
      pts: path, cross: PENALTY,
      lie: { within: ON, once: ON_PIPE, px: 1 }, near: { within: J_CLEAR, once: NEAR_PIPE, px: 1 },
      beside: { within: BESIDE, px: BESIDE_PX },
    });
  }
  const { x0, y0, x1, y1 } = around;
  for (const other of laid.near(page, x0, y0, x1, y1)) {
    if (own.has(other.id)) continue;
    lines.push({
      pts: other.pts, cross: CROSS_LINE,
      lie: { within: ON_LINE_WITHIN, once: ON_LINE, px: 1 }, near: { within: NEAR_LINE_WITHIN, once: NEAR_LINE, px: 1 },
      beside: { within: BESIDE, px: BESIDE_PX },
    });
  }
  const at = laid.dotsNear(page, x0, y0, x1, y1)
    .filter(d => d.id !== u.ends[0].nodeId && d.id !== u.ends[1].nodeId).map(d => d.at);
  return { lines, dots: { at, reach: dotReach(), cost: THROUGH_DOT } };
}

/** A unit's two ends on these faces, as the router takes them, and what routes go round there. */
function endsOf(u: Unit, fa: string | null | undefined, fb: string | null | undefined, p: Pricing) {
  const byId = p.d.byId();
  const na = byId.get(u.ends[0].nodeId), nb = byId.get(u.ends[1].nodeId);
  if (!na || !nb) return null;
  const a = endFor(na, fa, p.endOf), b = endFor(nb, fb, p.endOf);
  if (!a || !b) return null;
  return { a, b, obstacles: p.sheetFor([na.id, nb.id]).obstacles(pageOfNode(na)) };
}

/** A line drawn with `offset` as its crossbar; the same object when it already is. */
function withOffset(e: Edge, offset: number): Edge {
  if (offsetOfLine(e) === offset) return e;
  const d = { ...((e.data ?? {}) as Record<string, unknown>) };
  if (offset) d.offset = offset; else delete d.offset;
  return { ...e, data: d };
}

/** What a route lying on the routes that already hold faces at a junction costs. */
function overlapCost(pts: Pt[], routes: Pt[][] | undefined): number {
  let c = 0;
  for (const r of routes ?? []) {
    const o = alongside(pts, r, AXIS_EPS);
    if (o > 0) c += PENALTY + o;
  }
  return c;
}

function hold(p: Pricing, nodeId: string, face: string | null | undefined, route: Pt[] | null) {
  let h = p.held.get(nodeId);
  if (!h) { h = { faces: new Set(), routes: [] }; p.held.set(nodeId, h); }
  if (face) h.faces.add(face);
  if (route) h.routes.push(route);
}

/** The faces at a junction still to be had: those nothing holds yet, or all of them once none are left. */
function openFaces(p: Pricing, nodeId: string, faces: Face[]): Face[] {
  const held = p.held.get(nodeId)?.faces;
  const free = held ? faces.filter(f => !held.has(f)) : faces;
  return free.length ? free : faces;
}

function unitOfPipe(pipe: Pipe, d: Draft): Unit {
  const end = (e: PipeEnd): UnitEnd => ({
    nodeId: e.nodeId, lineId: e.lineId, handle: handleAt(d.edge(e.lineId)!, e.nodeId), choices: choicesAt(d.node(e.nodeId)),
  });
  return { key: `pipe:${pipe.lines[0]}`, pipe, line: null, ends: [end(pipe.a), end(pipe.b)] };
}

/**
 * Choose the faces a pipe ends on, where it ends on a junction: the pair that
 * draws it best of the faces no pipe chosen before it holds there. Priced on
 * its two ends as they are, which the seating order has already put where
 * they will stay, and nothing else that is still to move.
 *
 * A pipe a person has routed keeps the faces it has, as it keeps its
 * corners. Its route on any other face would be priced through corners the
 * router refits to whichever face it is on -- and seating it writes the
 * refit back -- so the price of every other face would change with the face
 * it is on, and the pipe would go back and forth between two faces from one
 * reseat to the next. It still holds its faces against what comes after it.
 */
function choosePipeFaces(pipe: Pipe, p: Pricing) {
  const u = unitOfPipe(pipe, p.d);
  // The faces a person's lines arrive by are theirs before anything is
  // chosen: they are not chosen again (`handFace`).
  for (const e of u.ends) if (e.choices) holdHandFaces(p, e.nodeId);
  // A pipe that meets one junction at both ends is left as it is.
  const loop = u.ends[0].nodeId === u.ends[1].nodeId;
  const hand = pipe.lines.some(id => isHand(p.d.edge(id)!));
  // A pipe the router drew keeps the faces it was drawn on while the shape
  // it was drawn with still fits them (`keptShape`), as it keeps the shape:
  // a bend stays until an end moves off it. Priced afresh on every face,
  // a pipe that came to end on an open end -- a valve at its end deleted
  // and healed through -- found an L into another face cheaper than its Z,
  // took it, and was routed again as the L, every tee on it moved to where
  // the L runs.
  if (!hand && !loop && u.ends.some(e => e.choices)) {
    const kept = keptOnFaces(pipe, u, p);
    const free = u.ends.every(e => !e.choices || openFaces(p, e.nodeId, e.choices).includes(e.handle as Face));
    if (kept && free) {
      for (const e of u.ends) if (e.choices) hold(p, e.nodeId, e.handle, kept);
      return;
    }
  }
  const choosing = u.ends.map(e => !!e.choices && !loop && !hand);
  if (!choosing[0] && !choosing[1]) {
    if (u.ends.some(e => e.choices)) {
      const pts = priced(u, u.ends[0].handle, u.ends[1].handle, p).pts;
      for (const e of u.ends) if (e.choices) hold(p, e.nodeId, e.handle, pts);
    }
    return;
  }
  const cands = u.ends.map((e, i) => (choosing[i] ? openFaces(p, e.nodeId, e.choices!) : [e.handle]));
  let best: { faces: (string | null | undefined)[]; cost: number; pts: Pt[] } | null = null;
  for (const fa of cands[0]) for (const fb of cands[1]) {
    const v = priced(u, fa, fb, p);
    if (!v.pts) continue;
    let c = v.cost;
    u.ends.forEach((e, i) => { if (choosing[i]) c += overlapCost(v.pts!, p.held.get(e.nodeId)?.routes); });
    c -= (fa === u.ends[0].handle ? 1e-6 : 0) + (fb === u.ends[1].handle ? 1e-6 : 0);
    if (!best || c < best.cost - 1e-12) best = { faces: [fa, fb], cost: c, pts: v.pts };
  }
  // One that cannot be priced yet (an end not measured) holds what it has.
  u.ends.forEach((e, i) => {
    if (!choosing[i]) return;
    const f = best ? best.faces[i] : e.handle;
    if (f && f !== e.handle) p.d.setEdge(faceAt(p.d.edge(e.lineId)!, e.nodeId, f as Face));
    hold(p, e.nodeId, f, best?.pts ?? null);
  });
}

/**
 * A pipe's faces at the junctions it ends on, held as they are, against what
 * is chosen after it: for a pipe that is not to choose them again (a pipe a
 * drag carries whole). `pts` is its path, what a line chosen later at the
 * same junction is kept off.
 */
function holdPipeFaces(pipe: Pipe, p: Pricing, pts: Pt[] | null) {
  for (const e of unitOfPipe(pipe, p.d).ends) if (e.choices) hold(p, e.nodeId, e.handle, pts);
}

/**
 * The shape the router last left on a pipe, while it still fits the faces the
 * pipe's ends are on -- taken round a symbol that has come to lie across it
 * (`keptAround`), since a pipe that keeps its tees where they are keeps the
 * faces it ends on too.
 */
function keptOnFaces(pipe: Pipe, u: Unit, p: Pricing): Pt[] | null {
  const lines = linesNow(pipe, p.d);
  const corners = cornersOfPipe(pipe, lines);
  const byId = p.d.byId();
  const na = byId.get(u.ends[0].nodeId), nb = byId.get(u.ends[1].nodeId);
  if (!na || !nb) return null;
  const a = endFor(na, u.ends[0].handle, p.endOf), b = endFor(nb, u.ends[1].handle, p.endOf);
  if (!a || !b) return null;
  const sheet = p.sheetFor(nodesOfPipe(pipe)), page = pageOfNode(na);
  return (corners.length ? keptShape(a, b, corners, sheet.bodies(page), true) : null)
    ?? keptAround(pipe, a, b, corners, byId, p.endOf, { bodies: sheet.bodies(page), obstacles: sheet.obstacles(page) },
      () => ({ ...p.m, byId }), p.anchors);
}

/** The lines that are no pipe's and meet a junction with a choice of face, as units. */
function lineUnits(m: Model, d: Draft): Unit[] {
  const units: Unit[] = [];
  for (const id of m.edgeById.keys()) {
    if (m.byLine.has(id)) continue;
    const e = d.edge(id)!;
    const ends: [UnitEnd, UnitEnd] = [
      { nodeId: e.source, lineId: e.id, handle: e.sourceHandle, choices: choicesAt(d.node(e.source)) },
      { nodeId: e.target, lineId: e.id, handle: e.targetHandle, choices: choicesAt(d.node(e.target)) },
    ];
    if (ends.some(x => x.choices)) units.push({ key: `line:${e.id}`, pipe: null, line: e, ends });
  }
  return units;
}

type FacePair = [string | null | undefined, string | null | undefined];

// ── A person's lines ─────────────────────────────────────────────────────────

/**
 * The face a person's line arrives at a junction by: the side its corners
 * come in from. Its nearest corner in line with the junction's centre says
 * so outright; one off both lines through the centre is reached along the
 * leg before it, so the line comes in across that leg. Null when the corners
 * do not say -- the nearest one on the centre itself, say -- or say a face
 * the junction does not offer (the run faces of a riding tee), and the line
 * keeps the face it has.
 *
 * A person's corners are drawn where they were put, so the face they arrive
 * by is the one the line has to be on. Priced against every other face, a
 * line whose middle leg was dragged away from its open end found the face on
 * the open end's far side cheaper -- routed afresh, which is what the other
 * face got -- once the drag had made the way through the corners long
 * enough: the face flipped, the line was drawn as the router's route, which
 * ignores corners that no longer fit, and the grip being dragged moved
 * nothing.
 */
function handFace(e: Edge, nodeId: string, p: Pricing): Face | null {
  const node = p.d.node(nodeId);
  const choices = choicesAt(node);
  const w = waypointsOfLine(e);
  if (!node || !choices || !w.length) return null;
  const inward = e.source === nodeId ? w : [...w].reverse();
  const c = centreOfJunction(node);
  const q = inward[0];
  const across = (dir: 'x' | 'y'): Face => (dir === 'y' ? (q.y < c.y ? 't' : 'b') : (q.x < c.x ? 'l' : 'r'));
  const onV = Math.abs(q.x - c.x) < AXIS_EPS, onH = Math.abs(q.y - c.y) < AXIS_EPS;
  let face: Face | null = null;
  if (onV && !onH) face = across('y');
  else if (onH && !onV) face = across('x');
  else if (!onV && !onH) {
    // The leg before it: to the next corner, or from the far end.
    let prev: Pt | null = inward[1] ?? null;
    if (!prev) {
      const far = farOf(e, nodeId);
      const n = p.d.node(far.id);
      prev = n ? (isJunction(n) ? centreOfJunction(n) : p.endOf(n, far.handle)) : null;
    }
    if (prev && Math.abs(prev.y - q.y) < AXIS_EPS) face = across('y');
    else if (prev && Math.abs(prev.x - q.x) < AXIS_EPS) face = across('x');
  }
  return face && choices.includes(face) ? face : null;
}

/** The lines that are no pipe's, a person has routed, and meet `nodeId`. */
const handLinesAt = (p: Pricing, nodeId: string) =>
  (p.m.linesAt.get(nodeId) ?? []).map(e => p.d.edge(e.id)!).filter(e => !p.m.byLine.has(e.id) && isHand(e));

/**
 * Hold at a junction the faces its person's lines arrive by, once, before a
 * pipe chooses its faces there: they are not the pipe's to take.
 */
function holdHandFaces(p: Pricing, nodeId: string) {
  if (p.handHeld.has(nodeId)) return;
  p.handHeld.add(nodeId);
  for (const e of handLinesAt(p, nodeId)) hold(p, nodeId, handFace(e, nodeId, p) ?? handleAt(e, nodeId), null);
}

/** Put every person's line that is no pipe's on the faces its corners arrive by (`handFace`). */
function faceByHand(p: Pricing, keep: ReadonlySet<string>) {
  for (const e0 of p.m.edgeById.values()) {
    if (p.m.byLine.has(e0.id) || keep.has(e0.id)) continue;
    let e = p.d.edge(e0.id)!;
    if (!isHand(e)) continue;
    for (const id of [e.source, e.target]) {
      const f = handFace(e, id, p);
      if (f && f !== handleAt(e, id)) { e = faceAt(e, id, f); p.d.setEdge(e); }
    }
  }
}

// ── What is laid on the page ─────────────────────────────────────────────────

/**
 * A line laid on the page, as a line chosen after it is priced against it:
 * its route, and whether it routes itself -- no corners of its own, and no
 * pipe's -- so that the pass that moves lines apart may move its middle.
 */
interface LaidLine { id: string; pts: Pt[]; free: boolean }

interface LaidItem {
  id: string;
  page: string;
  free: boolean;
  x0: number; y0: number; x1: number; y1: number;
  pts: Pt[] | null;
  /** For a line routed only once something is priced near it. */
  route?: () => { pts: Pt[]; free: boolean } | null;
  seen: number;
}

const LAID_CELL = 200;
/** A cell's key: exact for any drawing within a few million pixels of the origin (`tracks.cellKey`). */
const laidCell = (cx: number, cy: number) => cx * 67108864 + cy;

/**
 * What is laid on the pages of a drawing while the lines that are no pipe's
 * choose their faces: every pipe as it was seated; every line with no choice
 * to make -- one between two symbols, a person's, one a drag carries whole
 * -- as it is drawn; each line as it is chosen, once both its ends are; and
 * every junction's dot, where the junction now is.
 *
 * A line is priced against what is laid before it, and against nothing
 * chosen after it. Every choice in the reseat is made once, on what is
 * already settled, and that is what keeps the reseat a fixed point: priced
 * against lines still to be chosen, a line would be priced against where
 * they were, and the next reseat against where they went. So a line yields
 * to the lines laid before it, as the pass that moves lines apart makes a
 * line yield (`tracks.separate`); and a junction's dot, which is where it is
 * before any line is chosen, is kept clear of whichever order the lines come
 * in.
 */
class Laid {
  /** Bumped whenever a line is laid: what a price worked out before it did not see. */
  version = 0;
  /** How many lines are laid, in the order they were: what `laidSince` counts from. */
  get count() { return this.items.length; }
  private readonly items: LaidItem[] = [];
  /** Each page's lines and dots, filed by cell. */
  private readonly cells = new Map<string, Map<number, number[]>>();
  private readonly dots: { id: string; page: string; at: Pt }[] = [];
  private readonly dotCells = new Map<string, Map<number, number[]>>();
  private look = 0;

  private file(
    by: Map<string, Map<number, number[]>>, i: number, page: string, x0: number, y0: number, x1: number, y1: number,
  ) {
    let cells = by.get(page);
    if (!cells) { cells = new Map(); by.set(page, cells); }
    for (let cx = Math.floor(x0 / LAID_CELL); cx <= Math.floor(x1 / LAID_CELL); cx++) {
      for (let cy = Math.floor(y0 / LAID_CELL); cy <= Math.floor(y1 / LAID_CELL); cy++) {
        const k = laidCell(cx, cy);
        const list = cells.get(k);
        if (list) list.push(i); else cells.set(k, [i]);
      }
    }
  }

  /** Lay a line whose route is known. */
  add(id: string, page: string, pts: Pt[] | null, free = false) {
    this.version++;
    if (!pts || pts.length < 2) return;
    const route = simplifyPoints(pts);
    const { x0, y0, x1, y1 } = boundsOf(route);
    this.items.push({ id, page, free, x0, y0, x1, y1, pts: route, seen: 0 });
    this.file(this.cells, this.items.length - 1, page, x0, y0, x1, y1);
  }

  /**
   * Lay a line whose route is worked out only when something is priced near
   * it: within the router's reach of the box of its two ends, which is as
   * far as a route round what is in its way goes, near enough always.
   */
  addLater(id: string, page: string, ends: Pt[], route: () => { pts: Pt[]; free: boolean } | null) {
    const b = boundsOf(ends);
    const x0 = b.x0 - REACH, y0 = b.y0 - REACH, x1 = b.x1 + REACH, y1 = b.y1 + REACH;
    this.items.push({ id, page, free: false, x0, y0, x1, y1, pts: null, route, seen: 0 });
    this.file(this.cells, this.items.length - 1, page, x0, y0, x1, y1);
  }

  addDot(id: string, page: string, at: Pt) {
    this.dots.push({ id, page, at });
    this.file(this.dotCells, this.dots.length - 1, page, at.x, at.y, at.x, at.y);
  }

  /** The lines laid on `page` whose routes come within the rectangle. */
  near(page: string, x0: number, y0: number, x1: number, y1: number): LaidLine[] {
    const look = ++this.look;
    const out: LaidLine[] = [];
    const cells = this.cells.get(page);
    if (!cells) return out;
    for (let cx = Math.floor(x0 / LAID_CELL); cx <= Math.floor(x1 / LAID_CELL); cx++) {
      for (let cy = Math.floor(y0 / LAID_CELL); cy <= Math.floor(y1 / LAID_CELL); cy++) {
        for (const i of cells.get(laidCell(cx, cy)) ?? []) {
          const it = this.items[i];
          if (it.seen === look) continue;
          it.seen = look;
          if (it.x0 > x1 || it.x1 < x0 || it.y0 > y1 || it.y1 < y0) continue;
          if (it.route) {
            const r = it.route();
            it.pts = r && r.pts.length >= 2 ? simplifyPoints(r.pts) : null;
            it.free = !!r?.free;
            it.route = undefined;
            if (it.pts) Object.assign(it, boundsOf(it.pts));
            if (!it.pts || it.x0 > x1 || it.x1 < x0 || it.y0 > y1 || it.y1 < y0) continue;
          }
          if (it.pts) out.push({ id: it.id, pts: it.pts, free: it.free });
        }
      }
    }
    return out;
  }

  /**
   * The lines laid from the `from`th on, on `page`, whose routes come within
   * the rectangle: the few laid since a price was last worked out.
   */
  laidSince(from: number, page: string, x0: number, y0: number, x1: number, y1: number): LaidLine[] {
    const out: LaidLine[] = [];
    for (let i = from; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.page !== page || !it.pts || it.x0 > x1 || it.x1 < x0 || it.y0 > y1 || it.y1 < y0) continue;
      out.push({ id: it.id, pts: it.pts, free: it.free });
    }
    return out;
  }

  /** The dots on `page` inside the rectangle. */
  dotsNear(page: string, x0: number, y0: number, x1: number, y1: number): { id: string; at: Pt }[] {
    const out: { id: string; at: Pt }[] = [];
    const cells = this.dotCells.get(page);
    if (!cells) return out;
    for (let cx = Math.floor(x0 / LAID_CELL); cx <= Math.floor(x1 / LAID_CELL); cx++) {
      for (let cy = Math.floor(y0 / LAID_CELL); cy <= Math.floor(y1 / LAID_CELL); cy++) {
        for (const i of cells.get(laidCell(cx, cy)) ?? []) {
          const d = this.dots[i];
          if (d.at.x >= x0 && d.at.x <= x1 && d.at.y >= y0 && d.at.y <= y1) out.push(d);
        }
      }
    }
    return out;
  }
}

/**
 * A line's route as it will be drawn once the reseat is done, with no choice
 * made for it, and whether it routes itself then: through a person's
 * corners; through the router's while they still fit (`keptShape`, as step 4
 * of the reseat keeps them); otherwise routing itself with the crossbar it
 * has -- the router's corners that no longer fit are gone by then, and a
 * line laid as the corners' would be laid as its own by the next reseat,
 * which would price what is chosen round it differently. Null when an end
 * cannot be looked up.
 */
function routeAsIs(e: Edge, p: Pricing, carried = false): { pts: Pt[]; free: boolean } | null {
  const s = p.d.node(e.source), t = p.d.node(e.target);
  if (!s || !t) return null;
  const a = endFor(s, e.sourceHandle, p.endOf), b = endFor(t, e.targetHandle, p.endOf);
  if (!a || !b) return null;
  const d = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean; offset?: number };
  const sheet = p.sheetFor([s.id, t.id]);
  if (d.waypoints?.length) {
    if (!d.viaRun) return { pts: simplifyPoints(pathPoints(routeThrough(a, b, d.waypoints).d)), free: false };
    const kept = keptShape(a, b, d.waypoints, carried ? NO_BOXES : sheet.bodies(pageOfNode(s)));
    if (kept) return { pts: throughAsStored(a, b, d.waypoints) ?? kept, free: false };
  }
  return { pts: autoRoute(a, b, sheet.obstacles(pageOfNode(s)), d.offset ?? 0), free: true };
}

/**
 * The page as the lines that are no pipe's find it before any of them is
 * chosen: every pipe, every line that has no choice to make (between two
 * symbols), and every junction's dot.
 */
function layPage(p: Pricing, units: Unit[]): Laid {
  const laid = new Laid();
  for (const pipe of p.m.pipes) {
    const page = pageOfNode(p.d.node(pipe.a.nodeId));
    laid.add(pipeKey(pipe), page, pipeAtTee(p, pipe.tees[0]) ?? null);
  }
  const chosen = new Set(units.map(u => u.line!.id));
  for (const e0 of p.m.edgeById.values()) {
    if (p.m.byLine.has(e0.id) || chosen.has(e0.id)) continue;
    const e = p.d.edge(e0.id)!;
    const s = p.d.node(e.source), t = p.d.node(e.target);
    if (!s || !t) continue;
    const a = p.endOf(s, e.sourceHandle), b = p.endOf(t, e.targetHandle);
    if (!a || !b) continue;
    laid.addLater(e.id, pageOfNode(s), [a, b, ...waypointsOfLine(e)], () => routeAsIs(e, p));
  }
  for (const n of p.d.nodes) if (isJunction(n)) laid.addDot(n.id, pageOfNode(n), centreOfJunction(n));
  return laid;
}

/**
 * Choose the faces of every line that is no pipe's, junction by junction in
 * drawing order: the lines on one junction together, round the faces its
 * pipes hold. A line's far end, when it is a choice too and not yet made, is
 * chosen with it and settled for good at its own junction. Each is priced
 * against what is laid on its page before it (`Laid`), and is laid there
 * itself once both its ends are chosen.
 *
 * A person's lines take the faces their corners arrive by (`handFace`), and
 * the lines in `keep` -- carried whole by a drag -- are not chosen again:
 * they hold the faces and the crossbar they have, and the rest are chosen
 * round them.
 */
function chooseLineFaces(p: Pricing, keep: ReadonlySet<string> = new Set()): Set<string> {
  faceByHand(p, keep);
  const all = lineUnits(p.m, p.d);
  const laid = layPage(p, all);
  p.laid = laid;
  const pageOfUnit = (u: Unit) => pageOfNode(p.d.node(u.ends[0].nodeId));
  const stays = (u: Unit) => keep.has(u.line!.id) || isHand(p.d.edge(u.line!.id)!);
  for (const u of all) {
    if (!stays(u)) continue;
    const e = p.d.edge(u.line!.id)!;
    const as = routeAsIs(e, p, keep.has(e.id));
    for (const end of u.ends) if (end.choices) hold(p, end.nodeId, end.handle, as?.pts ?? null);
    laid.add(e.id, pageOfUnit(u), as?.pts ?? null, !!as?.free);
  }
  const units = all.filter(u => !stays(u));
  if (!units.length) return new Set();
  // The units with a choice to make at each junction. One that meets a
  // junction at both ends is left as it is.
  const at = new Map<string, { u: Unit; end: 0 | 1 }[]>();
  for (const u of units) {
    if (u.ends[0].nodeId === u.ends[1].nodeId) continue;
    u.ends.forEach((e, i) => {
      if (!e.choices) return;
      const slot = { u, end: i as 0 | 1 };
      const list = at.get(e.nodeId);
      if (list) list.push(slot); else at.set(e.nodeId, [slot]);
    });
  }
  const decided = new Map<string, FacePair>();
  for (const u of units) decided.set(u.key, [u.ends[0].handle, u.ends[1].handle]);
  const fixed = new Set<string>();   // `${key}#${end}`: decided at its own junction
  // Each line's route and crossbar as it was laid, once both its ends were chosen.
  const settled = new Map<string, Price>();

  for (const n of p.d.nodes) {
    const slots = at.get(n.id);
    if (!slots) continue;
    const faces = choicesAt(n)!;
    const held = p.held.get(n.id);

    // Each slot's best route for each face here, the far end's face chosen
    // too when that is still open. The far end's own face wins no tie here:
    // it is chosen for good at its own junction, later in this same reseat,
    // and a tie decided by the face it has now would be decided the other
    // way by the next reseat, once it had changed.
    const table = slots.map(({ u, end }) => faces.map(f => {
      const far = u.ends[1 - end];
      const farDone = !far.choices || fixed.has(`${u.key}#${1 - end}`);
      const farFaces: (string | null | undefined)[] = farDone ? [decided.get(u.key)![1 - end]] : openFaces(p, far.nodeId, far.choices!);
      let best: { pts: Pt[] | null; cost: number; far: string | null | undefined } = { pts: null, cost: Infinity, far: farFaces[0] };
      for (const g of farFaces) {
        const [fa, fb] = end === 0 ? [f, g] : [g, f];
        const v = priced(u, fa, fb, p);
        if (!v.pts) continue;
        const bonus = f === u.ends[end].handle ? 1e-6 : 0;
        const cost = v.cost + overlapCost(v.pts, held?.routes) - bonus;
        if (cost < best.cost - 1e-12) best = { pts: v.pts, cost, far: g };
      }
      return best;
    }));
    if (table.some(row => row.every(x => !x.pts))) continue;   // something here cannot be priced yet

    // One line to a face while faces are left over: the faces no pipe holds
    // go round first, and a line shares only once every one of them is taken.
    const k = slots.length;
    const free = faces.filter(f => !held?.faces.has(f));
    const need = Math.min(k, free.length);
    let pick: number[] | null = null, pickCost = Infinity;
    if (k > 6) {
      // More lines than it is worth trying every way of: each takes its own best.
      pick = table.map(row => row.reduce((bi, x, i) => (x.cost < row[bi].cost ? i : bi), 0));
    } else {
      const idx = new Array<number>(k).fill(0);
      for (;;) {
        if (new Set(idx.map(i => faces[i]).filter(f => free.includes(f))).size === need) {
          let c = 0;
          for (let s = 0; s < k; s++) c += table[s][idx[s]].cost;
          for (let s = 0; s < k && c < pickCost; s++) for (let t = s + 1; t < k; t++) {
            const ps = table[s][idx[s]].pts, pt = table[t][idx[t]].pts;
            if (!ps || !pt) continue;
            const o = alongside(ps, pt, AXIS_EPS);
            if (o > 0) c += PENALTY + o;
          }
          if (c < pickCost - 1e-12) { pickCost = c; pick = [...idx]; }
        }
        let s = k - 1;
        while (s >= 0 && ++idx[s] === faces.length) { idx[s] = 0; s--; }
        if (s < 0) break;
      }
    }
    if (!pick) continue;
    const done: Unit[] = [];
    slots.forEach(({ u, end }, s) => {
      const next: FacePair = [...decided.get(u.key)!];
      next[end] = faces[pick![s]];
      const far = u.ends[1 - end];
      const farDone = !far.choices || fixed.has(`${u.key}#${1 - end}`);
      if (!farDone) next[1 - end] = table[s][pick![s]].far;
      decided.set(u.key, next);
      fixed.add(`${u.key}#${end}`);
      if (farDone) done.push(u);
    });
    // The lines whose both ends are now chosen are laid for every line chosen
    // after them, as they were priced: routing themselves, or through the
    // corners they are to carry.
    for (const u of done) settled.set(u.key, priced(u, decided.get(u.key)![0], decided.get(u.key)![1], p));
    for (const u of done) laid.add(u.line!.id, pageOfUnit(u), settled.get(u.key)!.pts, !settled.get(u.key)!.corners);
  }

  const routed = new Set<string>();
  for (const u of units) {
    const faces = decided.get(u.key)!;
    u.ends.forEach((end, i) => {
      const f = faces[i];
      if (!end.choices || !f || f === end.handle) return;
      p.d.setEdge(faceAt(p.d.edge(end.lineId)!, end.nodeId, f as Face));
    });
    // And the route it was laid with on those faces: the crossbar it routes
    // itself with, the router's corners it carries off; or, for a route the
    // router does not draw from two ends, those corners, which the line is
    // drawn through exactly (`lineRoute`). Either way the choice is this
    // reseat's, made afresh every time, and step 4 leaves it alone.
    const e = p.d.edge(u.line!.id)!;
    const v = settled.get(u.key) ?? priced(u, faces[0], faces[1], p);
    if (!v.pts) continue;
    routed.add(e.id);
    p.d.setEdge(v.corners ? withCorners(e, v.pts.slice(1, -1), false) : withOffset(withoutRunCorners(e), v.offset));
  }
  return routed;
}

/**
 * Point every line that meets a tee off its run -- a branch, a pipe that
 * ends there, or a line on an open end -- at the faces that draw it best:
 * the pipes first, in the order the reseat seats them, then the lines on
 * each junction together. Run lines are the pipe's and are not touched.
 * Returns the same array when nothing changed.
 */
export function pointLines(edges: Edge[], nodesById: Map<string, Node>, endOf: EndLookup, obstacles?: Obstacles): Edge[] {
  const nodes = [...nodesById.values()];
  const m = buildModel(nodes, edges);
  const d = new Draft(nodes, edges);
  const p = pricingFor(d, m, endOf, pipeSheet(nodes, obstacles));
  for (const pipe of seatingOrder(m)) choosePipeFaces(pipe, p);
  chooseLineFaces(p);
  return d.edges;
}

// ── Adopting a tee ───────────────────────────────────────────────────────────

/**
 * How far off the straight run between two ports a tee can be and still be
 * on it: the router's own tolerance for two ends in line, inside which it
 * draws the two lines through the tee as one straight run anyway. Further
 * off, the lines through it have a bend at the tee, and where the tee is is
 * a corner somebody chose -- an open end put down beside a line, say, and
 * then carried on to the far port -- which nothing may take away.
 */
const ADOPT_REACH = 4;

/** Two lines through a tee that make one straight run: which is which, and where the far ends are. */
interface StraightPair {
  inLine: Edge;
  outLine: Edge;
  in: Face;
  out: Face;
  /** The far end of the in line, and of the out line. */
  a: End;
  b: End;
}

/**
 * The one straight run through a tee that has no `along`, if its lines make
 * exactly one: two lines whose far ends are ports in line with each other,
 * facing each other, one either side of the tee, and the tee on the line
 * between them (within the router's in-line tolerance). Lines with corners a
 * person placed are not a straight run.
 */
function straightPair(tee: Node, lines: Edge[], farEnd: (e: Edge) => End | null): StraightPair | null {
  const c = centreOfJunction(tee);
  const cands = lines.filter(e => !isHand(e)).map(e => ({ e, p: farEnd(e) })).filter((x): x is { e: Edge; p: End } => !!x.p);
  const found: StraightPair[] = [];
  const near = (u: number, v: number) => Math.abs(u - v) <= ADOPT_REACH;
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    for (const [u, v] of [[cands[i], cands[j]], [cands[j], cands[i]]]) {
      const p = u.p, q = v.p;
      if (farOf(u.e, tee.id).id === farOf(v.e, tee.id).id) continue;
      const horizontal = p.side === Position.Right && q.side === Position.Left;
      const vertical = p.side === Position.Bottom && q.side === Position.Top;
      if (horizontal) {
        if (!near(p.y, q.y) || !near(c.y, p.y) || !near(c.y, q.y) || !(p.x < c.x && c.x < q.x)) continue;
        found.push({ inLine: u.e, outLine: v.e, in: 'l', out: 'r', a: p, b: q });
      } else if (vertical) {
        if (!near(p.x, q.x) || !near(c.x, p.x) || !near(c.x, q.x) || !(p.y < c.y && c.y < q.y)) continue;
        found.push({ inLine: u.e, outLine: v.e, in: 't', out: 'b', a: p, b: q });
      }
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * A tee's `along`, minted from a straight pair of its lines as a split mints
 * it: the faces the run takes, how far along it the tee is, and the two ends.
 */
function alongOf(tee: Node, pair: StraightPair): Along {
  const c = centreOfJunction(tee);
  const horizontal = pair.in === 'l';
  const span = horizontal ? pair.b.x - pair.a.x : pair.b.y - pair.a.y;
  const t = span > 0 ? Math.max(0, Math.min(1, ((horizontal ? c.x - pair.a.x : c.y - pair.a.y) / span))) : 0.5;
  return {
    t, in: pair.in, out: pair.out,
    from: farOf(pair.inLine, tee.id).id, to: farOf(pair.outLine, tee.id).id,
    ends: { a: { x: pair.a.x, y: pair.a.y }, b: { x: pair.b.x, y: pair.b.y } },
  };
}

/**
 * Would a tee riding this pair sit on a pipe with two ends? A tee that would
 * close a ring of tees is left free rather than given a run it would be
 * stripped of again by the next reseat.
 */
function walksToEnds(m: Model, teeId: string, pair: StraightPair): boolean {
  const riding = (id: string) => {
    const n = m.byId.get(id);
    return !!n && isJunction(n) && !!junctionData(n).along;
  };
  for (const first of [pair.inLine, pair.outLine]) {
    let at = teeId, e = first;
    const seen = new Set([teeId]);
    for (;;) {
      const far = farOf(e, at);
      if (far.id === teeId) return false;
      if (!riding(far.id)) break;
      const along = junctionData(m.byId.get(far.id)!).along!;
      const lines = m.linesAt.get(far.id) ?? [];
      const inE = lines.find(x => handleAt(x, far.id) === along.in);
      const outE = lines.find(x => x !== inE && handleAt(x, far.id) === along.out);
      if (e !== inE && e !== outE) break;
      if (seen.has(far.id)) return false;
      seen.add(far.id);
      const next = e === inE ? outE : inE;
      if (!next) break;
      at = far.id; e = next;
    }
  }
  return true;
}

/**
 * Make a tee with no `along` ride the straight run its lines make through
 * it, as `splitEdgeAt` would have made it: for the gesture that gives an open
 * end its continuation, and for old drawings (`migrate`). The reseat never
 * does this by itself -- a junction somebody put down off a line stays where
 * they put it, however near the line it is dragged. The same arrays back
 * when the tee rides already, its lines make no one straight run, or riding
 * it would close a ring of tees.
 */
export function adoptTee(nodes: Node[], edges: Edge[], teeId: string, endOf: EndLookup): { nodes: Node[]; edges: Edge[] } {
  const d = new Draft(nodes, edges);
  const m = buildModel(nodes, edges);
  const tee = d.node(teeId);
  if (!tee || !isJunction(tee) || junctionData(tee).along) return { nodes, edges };
  const lines = m.linesAt.get(teeId) ?? [];
  const pair = straightPair(tee, lines, e => { const f = farOf(e, teeId); const n = m.byId.get(f.id); return n ? endFor(n, f.handle, endOf) : null; });
  if (!pair || !walksToEnds(m, teeId, pair)) return { nodes, edges };
  d.setNode({ ...tee, data: { ...(tee.data as Record<string, unknown>), along: alongOf(tee, pair) } });
  d.setEdge(faceAt(d.edge(pair.inLine.id)!, teeId, pair.in));
  d.setEdge(faceAt(d.edge(pair.outLine.id)!, teeId, pair.out));
  return { nodes: d.nodes, edges: d.edges };
}

/**
 * Seat the pipes that carry any of `teeIds`, exactly as the reseat seats
 * them -- each routed once, its tees put on it at their legal spots, its
 * lines handed their slices -- and nothing else: no face is chosen and no
 * other line is touched. For `migrate`, which adopts an old drawing's tees
 * and puts them on their pipes before the autosave takes its baseline, so
 * the first reseat after opening finds nothing of theirs to do. The same
 * arrays back when nothing moved.
 */
export function seatTees(nodes: Node[], edges: Edge[], teeIds: Iterable<string>, endOf: EndLookup): { nodes: Node[]; edges: Edge[] } {
  const want = new Set(teeIds);
  const m = buildModel(nodes, edges);
  const d = new Draft(nodes, edges);
  const sheet = pipeSheet(nodes);
  for (const pipe of seatingOrder(m)) if (pipe.tees.some(t => want.has(t))) seatPipe(pipe, d, m, endOf, sheet);
  return { nodes: d.nodes, edges: d.edges };
}

/**
 * Bring the record of every riding tee that names another pipe's ends up to
 * date, without moving anything: `from` and `to` the ends of the pipe it is
 * on now, `t` how far along that pipe it sits and `ends` where the pipe's
 * ends are, when the pipe can be routed. A drawing saved when each tee
 * recorded its two neighbours carries such records on every tee of a pipe
 * with two tees or more; brought up to date on opening, before the autosave
 * takes its baseline, they are not rewritten by the first reseat -- which
 * rewrites the record of a tee on another pipe than it names -- and opening
 * the drawing is not an edit.
 */
export function recordPipes(nodes: Node[], edges: Edge[], endOf: EndLookup): Node[] {
  const m = buildModel(nodes, edges);
  const d = new Draft(nodes, edges);
  const sheet = pipeSheet(nodes);
  for (const pipe of m.pipes) {
    let geo: PipeGeometry | null | undefined;
    pipe.tees.forEach((id, i) => {
      const tee = d.node(id)!;
      const along = junctionData(tee).along!;
      const ends = [pipe.a.nodeId, pipe.b.nodeId];
      if ([along.from, along.to].sort().join('\u0000') === [...ends].sort().join('\u0000')) return;
      if (geo === undefined) geo = pipeGeometry(pipe, m.byId, m.edgeById, endOf, sheet, undefined, { m });
      // The end on the side the tee's `in` face looks to is its `from`.
      const forward = handleAt(m.edgeById.get(pipe.lines[i])!, id) === along.in;
      const s = geo ? project(geo.pts, centreOfJunction(tee)) / (geo.length || 1) : along.t;
      const next: Along = {
        ...along,
        from: forward ? pipe.a.nodeId : pipe.b.nodeId,
        to: forward ? pipe.b.nodeId : pipe.a.nodeId,
        t: geo && !forward ? 1 - s : s,
        ...(geo ? {
          ends: forward
            ? { a: { x: geo.a.x, y: geo.a.y }, b: { x: geo.b.x, y: geo.b.y } }
            : { a: { x: geo.b.x, y: geo.b.y }, b: { x: geo.a.x, y: geo.a.y } },
        } : {}),
      };
      d.setNode({ ...tee, data: { ...(tee.data as Record<string, unknown>), along: next } });
    });
  }
  return d.nodes;
}

// ── The reseat ───────────────────────────────────────────────────────────────

/** Two plain-data values with the same content, whatever order their keys are in. */
function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter(k => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter(k => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => sameContent((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * A drag in progress, as the reseat is to take it: which nodes are being
 * dragged, and where every junction that is not was when the drag began.
 *
 * During a drag the reseat runs on every tick, and a tee put on its pipe from
 * where the last tick left it is put there from somewhere the tick before
 * already moved it: a bend swept past a tee pushed it a little ahead each
 * tick, never back, and the tee was left pushed wherever the pipe ended up,
 * its branch jogged -- a drag made slowly and the same move made at once
 * gave two drawings. Put on its pipe from where it was when the drag began
 * (`anchors`), a tee is where the end of the drag puts it, whatever way the
 * drag went, and back where it was when the drawing is. An open end a tee
 * is carried onto is put beside it from where it was when the drag began
 * too (`clearOpenEnds`), so one the tee only passes over is left as it was.
 *
 * And what the drag does not move is not routed round what it does: a
 * symbol dragged across a pipe it has nothing to do with, or a pasted bay
 * dragged over another, pushed that pipe into a detour round it on every
 * tick, and the pipe's tees with it. The dragged symbols are in the way of
 * the pipes and lines that end on them (`moving`), and of nothing else,
 * until the drag is let go of and the drawing is settled whole.
 *
 * Nor is what the drag carries whole routed at all. A pipe whose two ends
 * have moved by one delta since the drag began -- a box-selected bay -- is
 * that piece of the drawing picked up, and it goes where it is put exactly
 * as it was (`start`): its shape, its corners, its tees, and the faces its
 * lines are on, all moved by that delta, whatever it passes over on the way.
 * Routed afresh each tick, it was bent round every symbol the bay crossed,
 * its tees were put on the detour, and the detour, which still fitted its
 * ends, was kept once the symbol was left behind: the bay arrived out of
 * shape, and letting go did not put it back. Only a pipe whose ends moved
 * relative to each other is the router's to draw again.
 */
export interface Dragging {
  anchors: Map<string, Pt>;
  moving: Set<string>;
  /**
   * The drawing as it was when the drag began, node by node and line by
   * line: what a pipe carried whole is put back to, moved. Without it the
   * pipe is taken as the drag has left it.
   */
  start?: { nodes: Map<string, Node>; edges: Map<string, Edge> };
}

/**
 * Where each junction a drag does not pick up is when it begins -- riding
 * tees and open ends alike -- and, given its lines, the drawing as it then
 * is: see `Dragging`.
 */
export function dragging(nodes: Node[], moving: Iterable<string>, edges?: Edge[]): Dragging {
  const picked = new Set(moving);
  const anchors = new Map<string, Pt>();
  for (const n of nodes) if (!picked.has(n.id) && isJunction(n)) anchors.set(n.id, centreOfJunction(n));
  return {
    anchors, moving: picked,
    start: { nodes: new Map(nodes.map(n => [n.id, n])), edges: new Map((edges ?? []).map(e => [e.id, e])) },
  };
}

/**
 * Deltas closer than this are one move: the same move worked out from two
 * different positions can differ in the last place.
 */
const SAME_MOVE = 1e-6;
const sameMove = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < SAME_MOVE && Math.abs(a.y - b.y) < SAME_MOVE;
const noMove = (a: Pt) => Math.abs(a.x) < SAME_MOVE && Math.abs(a.y) < SAME_MOVE;
const moveBy = (p: Pt, by: Pt): Pt => ({ x: p.x + by.x, y: p.y + by.y });

/** How far each node the drag picked up has gone since it began. */
function movedSoFar(d: Draft, drag: Dragging): Map<string, Pt> {
  const out = new Map<string, Pt>();
  const start = drag.start?.nodes;
  if (!start) return out;
  for (const id of drag.moving) {
    const was = start.get(id), n = d.node(id);
    if (was && n) out.set(id, { x: n.position.x - was.position.x, y: n.position.y - was.position.y });
  }
  return out;
}

/**
 * The delta a drag carries a pipe by, whole: both its ends have gone that
 * far since the drag began, and so has every tee on it the drag picked up. A
 * tee on it the drag did not pick up rides it, and goes with it. Null for a
 * pipe that has not moved, or whose ends moved relative to each other.
 */
function carriedBy(pipe: Pipe, moved: Map<string, Pt>, drag: Dragging): Pt | null {
  const da = moved.get(pipe.a.nodeId), db = moved.get(pipe.b.nodeId);
  if (!da || !db || !sameMove(da, db) || noMove(da)) return null;
  for (const id of pipe.tees) {
    const dt = moved.get(id);
    if (drag.moving.has(id) && (!dt || !sameMove(dt, da))) return null;
  }
  return da;
}

/**
 * A tee put back where it was when the drag began, moved by `by`, with its
 * record of its pipe as it then was; left as it is when it is there already.
 */
function putBackTee(d: Draft, was: Node, by: Pt) {
  const n = d.node(was.id);
  const along = junctionData(was).along;
  if (!n || !along) return;
  const now = junctionData(n).along;
  const at = moveBy(was.position, by);
  // Where its pipe's ends were, moved; a record that had none keeps what it has.
  const ends = along.ends ? { a: moveBy(along.ends.a, by), b: moveBy(along.ends.b, by) } : now?.ends;
  const near = (p: Pt, q: Pt) => Math.abs(p.x - q.x) <= POS_EPS && Math.abs(p.y - q.y) <= POS_EPS;
  if (near(n.position, at) && now && now.t === along.t && now.in === along.in && now.out === along.out
    && now.from === along.from && now.to === along.to
    && (ends ? !!now.ends && near(now.ends.a, ends.a) && near(now.ends.b, ends.b) : !now.ends)) return;
  d.setNode({ ...n, position: at, data: { ...(n.data as Record<string, unknown>), along: { ...along, ...(ends ? { ends } : {}) } } });
}

/**
 * A line's routing put back as it was when the drag began, its corners moved
 * by `by`: the corners, whose they are, and the crossbar it is drawn with.
 * Left as it is when it already has them.
 */
function putBackLine(d: Draft, was: Edge, by: Pt) {
  const e = d.edge(was.id);
  if (!e) return;
  const w = (was.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean; offset?: number };
  const now = (e.data ?? {}) as Record<string, unknown> & { waypoints?: Pt[]; viaRun?: boolean; offset?: number };
  const corners = (w.waypoints ?? []).map(p => moveBy(p, by));
  if ((corners.length ? sameCorners(now.waypoints, corners) : !now.waypoints?.length)
    && !!now.viaRun === !!w.viaRun && (now.offset ?? 0) === (w.offset ?? 0)) return;
  const data: Record<string, unknown> = { ...now };
  delete data.waypoints;
  delete data.viaRun;
  delete data.offset;
  if (corners.length) data.waypoints = corners;
  if (w.viaRun) data.viaRun = true;
  if (w.offset !== undefined) data.offset = w.offset;
  d.setEdge({ ...e, data });
}

/** A sheet with nothing on it: what a pipe carried whole is seated on, since nothing it passes over bends it. */
const NOTHING: PipeSheet = { obstacles: () => NO_BOXES, bodies: () => NO_BOXES };

/**
 * `sheet` without the boxes of the nodes in `moving`: what a pipe the drag
 * does not touch is routed and priced on. A box is known by where it is,
 * since a sheet's boxes carry no names.
 */
function sheetWithout(sheet: PipeSheet, nodes: Node[], moving: Set<string>): PipeSheet {
  const gone = new Map<string, Box[]>();
  for (const n of nodes) {
    if (!moving.has(n.id) || isJunction(n)) continue;
    const page = pageOfNode(n);
    const list = gone.get(page);
    if (list) list.push(boxOfNode(n)); else gone.set(page, [boxOfNode(n)]);
  }
  if (!gone.size) return sheet;
  const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  const cut = (of: (page: string) => Box[]) => {
    const cache = new Map<string, Box[]>();
    return (page: string) => {
      let out = cache.get(page);
      if (!out) {
        const g = gone.get(page);
        out = g ? of(page).filter(b => !g.some(x => same(x, b))) : of(page);
        cache.set(page, out);
      }
      return out;
    };
  };
  return { obstacles: cut(sheet.obstacles), bodies: cut(sheet.bodies) };
}

/**
 * Put every tee on its pipe, hand every pipe's lines their slices, and point
 * every line at the faces that draw it.
 *
 * In this order:
 *
 *  1. the pipes are found; a tee that cannot ride anything (a run line gone,
 *     or a ring of tees with no ends) stops riding where it is, and the
 *     router's corners come off its lines; so does a tee that would close a
 *     ring of pipes (`ringCloser`), which keeps its lines as they are;
 *  2. each pipe in turn, in the order that puts a pipe after the pipes whose
 *     tees it ends on: its faces at the junctions it ends on are chosen, and
 *     then it is routed once, its tees put on it -- each on the point of the
 *     new path nearest where it was, then to its legal spot -- and its lines
 *     handed their slices; during a drag, a pipe the drag carries whole, and
 *     a line of no pipe whose two ends it carries, are put back as they were
 *     when it began, moved, and keep their shape and faces (`Dragging`);
 *  2b. an open end a tee has come to sit on is put beside it
 *     (`clearOpenEnds`);
 *  3. the faces of the lines that are no pipe's are chosen, jointly per
 *     junction, round the faces the pipes took;
 *  4. corners the router left on a line that is not part of a pipe -- the
 *     two halves of a valve dropped on a bent line -- stay only while they
 *     still fit (`keptShape`).
 *
 * Nothing in it gives a tee a run: a junction somebody put down off a line
 * is theirs, and only a gesture (`adoptTee`) or opening an old drawing
 * (`migrate`) makes a tee ride.
 *
 * `obstacles` are the symbols automatic routes go round (the page's, from
 * `obstacleBoxes`); left out, routes are the plain router's, and every
 * visible symbol still counts as a body a kept bend or a chosen face may not
 * run through (`pipeSheet`). Returns the same arrays when nothing needed
 * doing, so callers can compare by identity, and is idempotent: what it
 * returns, it returns again unchanged: every choice in it is made once, in
 * an order that never looks back, on what is already settled.
 */
export function reseatJunctions(
  nodes: Node[], edges: Edge[], endOf: EndLookup, obstacles?: Obstacles, drag?: Dragging | null,
): { nodes: Node[]; edges: Edge[] } {
  // Nothing to seat and nothing of the router's to check.
  if (!nodes.some(isJunction) && !edges.some(e => (e.data as { viaRun?: boolean } | undefined)?.viaRun)) return { nodes, edges };
  const sheet = pipeSheet(nodes, obstacles);
  const d = new Draft(nodes, edges);
  // During a drag: what it moves -- the dragged nodes, and the tees on every
  // pipe that ends on something it moves, which the seating order finds
  // before any pipe that ends on them -- and the sheet everything else is
  // routed on (`Dragging`).
  const touched = new Set(drag?.moving ?? []);
  const still = drag?.moving.size ? sheetWithout(sheet, nodes, drag.moving) : sheet;
  const sheetFor = (ids: string[]) => (still === sheet || ids.some(id => touched.has(id)) ? sheet : still);

  // 1. Find the pipes; stop riding what cannot.
  let m = buildModel(d.nodes, d.edges);
  const unride = (id: string) => {
    const tee = d.node(id)!;
    const { along: _gone, ...rest } = tee.data as Record<string, unknown> & { along?: Along };
    void _gone;
    d.setNode({ ...tee, data: rest });
  };
  for (const id of m.broken) {
    const along = junctionData(d.node(id)!).along;
    unride(id);
    // Its pipe is gone, and the slices of it its lines carried with it.
    for (const e of m.linesAt.get(id) ?? []) {
      const h = handleAt(e, id);
      if (along && (h === along.in || h === along.out)) d.setEdge(withoutRunCorners(d.edge(e.id)!));
    }
  }
  // A tee that would close a ring of pipes keeps its lines as they are: they
  // are two pipes ending on it now, which keep their shape while it fits.
  for (const id of m.unhooked) unride(id);
  if (m.broken.length || m.unhooked.length) m = buildModel(d.nodes, d.edges);

  // 2. Each pipe in turn, after every pipe whose tees it ends on: its faces,
  //    then its seat. Once a pipe is seated nothing seated after it can move
  //    its ends, so one pass puts everything where it stays.
  //
  //    A pipe the drag carries whole is put back as it was when the drag
  //    began, moved, and seated on a sheet with nothing on it: no face of it
  //    is chosen again and nothing it passes over bends it (`Dragging`). Its
  //    tees go with it, so a pipe seated after it that ends on one of them
  //    sees that end carried too.
  const p = pricingFor(d, m, endOf, sheet, sheetFor, drag?.anchors, drag ? touched : undefined);
  const moved = drag ? movedSoFar(d, drag) : null;
  for (const pipe of seatingOrder(m)) {
    const own = nodesOfPipe(pipe);
    if (own.some(id => touched.has(id))) for (const id of pipe.tees) touched.add(id);
    const whole = moved && carriedBy(pipe, moved, drag!);
    if (whole) {
      for (const id of pipe.tees) {
        moved!.set(id, whole);
        const was = drag!.start?.nodes.get(id);
        if (was) putBackTee(d, was, whole);
      }
      for (const id of pipe.lines) {
        const was = drag!.start?.edges.get(id);
        if (was) putBackLine(d, was, whole);
      }
      const seated = seatPipe(pipe, d, m, endOf, NOTHING);
      p.paths.set(pipe, seated ? seated.geo.pts : null);
      holdPipeFaces(pipe, p, seated ? seated.geo.pts : null);
      continue;
    }
    choosePipeFaces(pipe, p);
    const seated = seatPipe(pipe, d, m, endOf, sheetFor(own), drag?.anchors);
    p.paths.set(pipe, seated ? seated.geo.pts : null);
  }

  // The lines that are no pipe's the drag carries whole: both ends gone one
  // way by one delta. They are put back as they were, moved, and keep their
  // faces and whatever corners they carry.
  const carried = new Set<string>();
  if (moved?.size) {
    for (const e of m.edgeById.values()) {
      if (m.byLine.has(e.id)) continue;
      const ds = moved.get(e.source), dt = moved.get(e.target);
      if (!ds || !dt || !sameMove(ds, dt) || noMove(ds)) continue;
      carried.add(e.id);
      const was = drag!.start?.edges.get(e.id);
      if (was) putBackLine(d, was, ds);
    }
  }

  // 2b. The open ends the tees, where they now are, have come to sit on.
  // 3. The lines' faces. 4. What is left of the router's corners.
  clearOpenEnds(d, m, drag);
  const routed = chooseLineFaces(p, carried);
  normaliseRunCorners(d, m, endOf, sheetFor, carried, routed);

  // Anything that comes back as it was is handed back as the object it was,
  // not an equal copy: an equal copy is a change to React, and a reseat that
  // hands back a change every time it runs never lets the effect that runs
  // it stop.
  let outNodes = d.nodes, outEdges = d.edges;
  if (outNodes !== nodes) {
    outNodes = outNodes.map((n, i) => (n !== nodes[i] && sameContent(n, nodes[i]) ? nodes[i] : n));
    if (outNodes.every((n, i) => n === nodes[i])) outNodes = nodes;
  }
  if (outEdges !== edges) {
    outEdges = outEdges.map((e, i) => (e !== edges[i] && sameContent(e, edges[i]) ? edges[i] : e));
    if (outEdges.every((e, i) => e === edges[i])) outEdges = edges;
  }
  return { nodes: outNodes, edges: outEdges };
}

/**
 * The pipes in the order they are seated: one that ends on a tee riding
 * another pipe after that pipe, since where it ends is where that tee is
 * put. There is always such an order, since a tee that would close a ring
 * of pipes does not ride (`ringCloser`).
 */
function seatingOrder(m: Model): Pipe[] {
  const out: Pipe[] = [];
  const state = new Map<Pipe, 'visiting' | 'done'>();
  const visit = (p: Pipe) => {
    if (state.has(p)) return;
    state.set(p, 'visiting');
    for (const end of [p.a, p.b]) {
      const q = m.byTee.get(end.nodeId)?.pipe;
      if (q && q !== p) visit(q);
    }
    state.set(p, 'done');
    out.push(p);
  };
  for (const p of m.pipes) visit(p);
  return out;
}

/**
 * Step 4: the router's corners on lines that are not part of a pipe stay
 * only while they fit. A line a drag carries whole (`carried`) keeps them
 * over whatever it passes: nothing it passes over bends it -- a way round
 * that doubles back included, since the corners it carried when the drag
 * began were already settled. A line whose route the face choice has just
 * made (`routed`) is not looked at again: its corners, when it has any, are
 * that choice's.
 */
function normaliseRunCorners(
  d: Draft, m: Model, endOf: EndLookup, sheetFor: (ids: string[]) => PipeSheet, carried: ReadonlySet<string> = new Set(),
  routed: ReadonlySet<string> = new Set(),
) {
  for (const e0 of m.edgeById.values()) {
    if (m.byLine.has(e0.id) || routed.has(e0.id)) continue;
    const e = d.edge(e0.id)!;
    const data = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
    if (!data.viaRun || !data.waypoints?.length) continue;
    const s = d.node(e.source)!, t = d.node(e.target)!;
    const a = endFor(s, e.sourceHandle, endOf), b = endFor(t, e.targetHandle, endOf);
    if (!a || !b) continue;
    const whole = carried.has(e.id);
    const bodies = whole ? NO_BOXES : sheetFor([s.id, t.id]).bodies(pageOfNode(s));
    if (!keptShape(a, b, data.waypoints, bodies, whole)) d.setEdge(withoutRunCorners(e));
  }
}

/** The way out of a junction by each of its faces. */
const OUT_OF: Record<Face, Pt> = { t: { x: 0, y: -1 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 }, r: { x: 1, y: 0 } };

/**
 * Where an open end at `at` goes that is closer to `tee` than the two dots
 * are wide: touching it, on the side it is on -- across the run of a riding
 * tee, since its run faces are the pipe's, and whichever way it is furthest
 * off a junction that rides nothing. One right on top of the tee's centre
 * has no side, and goes out of the face its line leaves the tee by.
 */
function besideTee(tee: Node, at: Pt, face: string | null | undefined): Pt {
  const c = centreOfJunction(tee);
  const off = { x: at.x - c.x, y: at.y - c.y };
  const along = junctionData(tee).along;
  const faces = along ? ACROSS[along.in] : FACES;
  const now = faces.includes(face as Face) ? (face as Face) : faces[1];
  let side: Face;
  if (along) {
    // ACROSS lists the face toward smaller coordinates first.
    const v = faces[0] === 't' ? off.y : off.x;
    side = Math.abs(v) > POS_EPS ? (v < 0 ? faces[0] : faces[1]) : now;
  } else {
    side = Math.abs(off.x) > POS_EPS || Math.abs(off.y) > POS_EPS ? faceOfDir(off) : now;
  }
  const u = OUT_OF[side];
  return { x: c.x + 2 * J_HALF * u.x, y: c.y + 2 * J_HALF * u.y };
}

/**
 * Step 2b: an open end a tee has come to sit on is put beside it, the two
 * dots touching.
 *
 * An open end is where a line stops: a junction with that one line on it
 * and no run. Closer to the tee its line comes from than the two dots are
 * wide -- a pipe's end dragged until the tee riding it came to rest on the
 * open end of its own branch -- the line between them had nowhere to go:
 * the tee's face and the open end's face across from it overlapped by more
 * than the two stubs each keeps, and every other pair of faces went out and
 * round, a square loop hung off two dots drawn on top of each other.
 * Touching, the two are drawn as the router draws any two dots side by side,
 * the short line between them hidden under them.
 *
 * Only an open end on a line that is no pipe's, off a junction with other
 * lines on it: nothing else's place depends on where it is, so moving it
 * moves nothing else. During a drag it is put there from where it was when
 * the drag began (`Dragging`), so a tee carried over an open end and on
 * past it leaves it where it was; and one the drag itself is carrying is
 * left to the hand carrying it until it is let go of.
 */
function clearOpenEnds(d: Draft, m: Model, drag?: Dragging | null) {
  for (const [id, lines] of m.linesAt) {
    if (lines.length !== 1 || m.byLine.has(lines[0].id) || drag?.moving.has(id)) continue;
    const end = d.node(id);
    if (!end || !isJunction(end) || junctionData(end).along) continue;
    const far = farOf(d.edge(lines[0].id)!, id);
    const tee = d.node(far.id);
    if (!tee || !isJunction(tee) || (m.linesAt.get(far.id)?.length ?? 0) < 2) continue;
    const home = drag?.anchors.get(id) ?? centreOfJunction(end);
    const c = centreOfJunction(tee);
    const at = Math.hypot(home.x - c.x, home.y - c.y) < 2 * J_HALF - POS_EPS ? besideTee(tee, home, far.handle) : home;
    const now = centreOfJunction(end);
    if (Math.abs(at.x - now.x) > POS_EPS || Math.abs(at.y - now.y) > POS_EPS) {
      d.setNode({ ...end, position: { x: at.x - J_HALF, y: at.y - J_HALF } });
    }
  }
}

// ── Tees under a person's hand ───────────────────────────────────────────────

/**
 * How far a slid tee's centre is nudged toward where it was before it is
 * put on the grid: enough to break a tie, and nothing a pointer can place.
 */
const TOWARD_WAS = 1e-3;

/**
 * Where a tee dragged to `p` (its top-left, as React Flow reports it) may go:
 * the point of its pipe nearest the pointer, on the grid along the pipe
 * there (`gridAlong`), moved to a legal spot -- off the bends, clear of the
 * ends, and never past the tees either side of it. Null for a tee that
 * rides nothing, or a pipe that cannot be routed yet.
 *
 * On the grid by its centre, not its corner. React Flow snaps the corner of
 * the ten-pixel dot to the grid, which puts the centre five pixels off it
 * every time: a tee slid along its pipe could land anywhere but on a grid
 * line, and a branch from it to a symbol on the grid jogged by the five
 * pixels, as did the next symbol lined up with it. Split and insert already
 * put a new tee's centre on the grid; a slide did not.
 *
 * The snapped corner is exactly half a step from two grid lines, and says
 * nothing about which of them the pointer is nearer. The tie goes toward
 * where the tee was (its record, `Along.t`): the first tick of a drag, which
 * React Flow reports half a step on, leaves the tee where it is, and a tee
 * moves a whole step once the pointer has.
 */
export function slideAlong(
  junction: Node, along: Along, p: XYPosition, edges: Edge[], nodesById: Map<string, Node>, endOf: EndLookup,
  obstacles?: Obstacles,
): { position: XYPosition; along: Along; dir: Pt } | null {
  const nodes = [...nodesById.values()];
  const m = buildModel(nodes, edges);
  const at = m.byTee.get(junction.id);
  if (!at) return null;
  const { pipe, index: i } = at;
  const geo = pipeGeometry(pipe, m.byId, m.edgeById, endOf, pipeSheet(nodes, obstacles), undefined, { m });
  if (!geo || geo.length < 1e-6) return null;
  const arcOf = (id: string) => project(geo.pts, centreOfJunction(m.byId.get(id)!), recordedArc(m.byId.get(id)!, pipe, geo.length));
  const rules = {
    endGapA: endGapAt(pipe.a, m), endGapB: endGapAt(pipe.b, m),
    neighbours: {
      before: i > 0 ? arcOf(pipe.tees[i - 1]) : undefined,
      after: i < pipe.tees.length - 1 ? arcOf(pipe.tees[i + 1]) : undefined,
    },
  };
  const was = recordedArc(junction, pipe, geo.length);
  const pointer = project(geo.pts, { x: p.x + J_HALF, y: p.y + J_HALF }, was);
  const on = pointAtArc(geo.pts, pointer)!;
  const toward = was === undefined || Math.abs(was - pointer) < SPOT_EPS ? 0 : Math.sign(was - pointer) * TOWARD_WAS;
  const gridded = gridAlong(geo.pts, { x: on.point.x + on.dir.x * toward, y: on.point.y + on.dir.y * toward });
  // A leg with no grid line on it leaves the pointer where it is, not nudged.
  const v = Math.abs(on.dir.x) >= Math.abs(on.dir.y) ? gridded.x : gridded.y;
  const onGrid = Math.abs(v - Math.round(v / GRID) * GRID) < SPOT_EPS;
  const byPointer = legalSpot(geo.pts, pointer, rules);
  const gridArc = onGrid ? project(geo.pts, gridded, pointer) : pointer;
  const byGrid = onGrid ? legalSpot(geo.pts, gridArc, rules) : byPointer;
  // The grid moves the tee half a step at most. A grid line on a bend is no
  // spot for a tee, and the legal spot nearest one is on the leg before it,
  // whichever leg the pointer is on: three pixels down the leg after a
  // bend, the grid would send the tee back round the bend. Where the grid
  // takes it further than half a step from where the pointer alone would
  // put it, the pointer's spot stands.
  const s = Math.abs(byGrid - byPointer) <= GRID / 2 + SPOT_EPS ? byGrid : byPointer;
  const spot = pointAtArc(geo.pts, s)!;
  // The grid line itself, not the point a round trip through its arc
  // position comes back to a few ulps off it.
  if (onGrid && s === gridArc) spot.point = gridded;
  // `in` and `out` stay the faces its lines are on now: they are how the
  // reseat finds the tee's run lines, and the reseat is what turns them when
  // the tee has slid round a bend (`dir` says which way the pipe runs there).
  const flipped = along.from === pipe.b.nodeId && along.to === pipe.a.nodeId && along.from !== along.to;
  return {
    position: { x: spot.point.x - J_HALF, y: spot.point.y - J_HALF },
    along: {
      ...along, t: flipped ? 1 - s / geo.length : s / geo.length,
      ends: flipped
        ? { a: { x: geo.b.x, y: geo.b.y }, b: { x: geo.a.x, y: geo.a.y } }
        : { a: { x: geo.a.x, y: geo.a.y }, b: { x: geo.b.x, y: geo.b.y } },
    },
    dir: spot.dir,
  };
}

/** The lines a hand edit on `edgeId` belongs with: its whole pipe, or just itself. */
function linesWith(nodes: Node[], edges: Edge[], edgeId: string): string[] {
  const pipe = buildModel(nodes, edges).byLine.get(edgeId);
  return pipe ? pipe.lines : [edgeId];
}

/**
 * The first hand edit on any line of a pipe makes the whole pipe a person's:
 * every one of its lines keeps the slice it draws, as its own corners. Were
 * only the edited line to lose its `viaRun`, the pipe would be half the
 * router's and half a person's, and the router's half would re-route under
 * the edit. Returns the same array when nothing changed.
 */
export function freezePipe(nodes: Node[], edges: Edge[], edgeId: string): Edge[] {
  const ids = new Set(linesWith(nodes, edges, edgeId));
  let changed = false;
  const out = edges.map(e => {
    if (!ids.has(e.id)) return e;
    const d = (e.data ?? {}) as Record<string, unknown> & { viaRun?: boolean };
    if (!d.viaRun) return e;
    changed = true;
    const rest = { ...d };
    delete rest.viaRun;
    return { ...e, data: rest };
  });
  return changed ? out : edges;
}

/**
 * Back to the router: every line of the pipe `edgeId` is on gives up its
 * corners, and the pipe routes itself again. What double-clicking a grip
 * does. Returns the same array when nothing changed.
 */
export function thawPipe(nodes: Node[], edges: Edge[], edgeId: string): Edge[] {
  const ids = new Set(linesWith(nodes, edges, edgeId));
  let changed = false;
  const out = edges.map(e => {
    if (!ids.has(e.id)) return e;
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (!('waypoints' in d) && !('viaRun' in d) && !('offset' in d)) return e;
    changed = true;
    const rest = { ...d };
    delete rest.waypoints;
    delete rest.viaRun;
    delete rest.offset;
    return { ...e, data: rest };
  });
  return changed ? out : edges;
}

/**
 * Write a segment drag or a jog: the line gets `waypoints` as a person's
 * corners (never marked `viaRun`, which would let the reseat take them back),
 * and the rest of its pipe is frozen with it (`freezePipe`).
 */
export function setHandCorners(nodes: Node[], edges: Edge[], edgeId: string, waypoints: Pt[]): Edge[] {
  return freezePipe(nodes, edges, edgeId).map(e => {
    if (e.id !== edgeId) return e;
    const rest = { ...(e.data ?? {}) } as Record<string, unknown>;
    delete rest.viaRun;
    if (waypoints.length) return { ...e, data: { ...rest, waypoints, offset: 0 } };
    delete rest.waypoints;
    return { ...e, data: { ...rest, offset: 0 } };
  });
}

// ── Where a tee goes into a line ─────────────────────────────────────────────

/**
 * How far from each end of a line a tee put into it keeps: from a symbol's
 * port or an open end, END_GAP; from a tee the line is a run line of, the
 * neighbour spacing less that tee's anchor; from any other tee, TEE_END_GAP.
 */
function lineEndGaps(nodes: Node[], edges: Edge[], edge: Edge): { a: number; b: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const gap = (nodeId: string) => {
    const n = byId.get(nodeId);
    if (!n || !isJunction(n)) return END_GAP;
    const along = junctionData(n).along;
    const h = handleAt(edge, nodeId);
    if (along && (h === along.in || h === along.out)) return TEE_GAP - J_ANCHOR;
    const degree = edges.filter(e => e.source === nodeId || e.target === nodeId).length;
    return degree <= 1 ? END_GAP : TEE_END_GAP;
  };
  return { a: gap(edge.source), b: gap(edge.target) };
}

/**
 * Where a tee put into a line at `at` actually goes, on `points` (the line as
 * drawn, source to target): the nearest point, moved to its legal spot on
 * the line -- off every bend, clear of the ends and of the tees at them.
 * Null when the line has no spot a tee can sit on (`hasLegalSpot`).
 * `toward` is where the gesture heads (a pull's target), and decides which
 * leg a press on a bend goes to. The hover dot and `splitEdgeAt` both ask
 * this, so the dot is where the tee lands.
 *
 * Given the drawing's `geometry` (the ports as measured, and the symbols
 * automatic routes go round), the answer is where the reseat will put the
 * tee: placed on the whole pipe as the reseat places every tee on it, room
 * kept for the tees after it and none passed (`landingSpot`). On a line with
 * a legal spot of its own the two agree; on a short, bent one with none, the
 * pipe's placement can find the tee a spot the line alone could not -- the
 * next leg, with the tee beyond made room -- and the dot has to say so.
 */
export function splitSpot(
  nodes: Node[], edges: Edge[], edgeId: string, points: Pt[], at: Pt, toward?: Pt,
  geometry?: { endOf: EndLookup; obstacles?: Obstacles; crowd?: Crowd },
): { s: number; point: Pt; dir: Pt; length: number } | null {
  const edge = edges.find(e => e.id === edgeId);
  const pts = simplifyPoints(points);
  if (!edge || pts.length < 2) return null;
  const arcs = arcsOf(pts);
  const length = arcs[arcs.length - 1];
  const s0 = project(pts, at);
  const gaps = lineEndGaps(nodes, edges, edge);
  let prefer: number | undefined;
  if (toward) {
    // The leg the pull heads for: of the two legs at the nearest bend, the
    // one pointing more nearly at the target.
    const bend = arcs.slice(1, -1).map((s, i) => ({ s, i: i + 1 })).sort((x, y) => Math.abs(x.s - s0) - Math.abs(y.s - s0))[0];
    if (bend && Math.abs(bend.s - s0) < CORNER_GAP) {
      const c = pts[bend.i], back = pts[bend.i - 1], on = pts[bend.i + 1];
      const to = { x: toward.x - c.x, y: toward.y - c.y };
      const dot = (q: Pt) => { const l = Math.hypot(q.x - c.x, q.y - c.y) || 1; return ((q.x - c.x) * to.x + (q.y - c.y) * to.y) / l; };
      prefer = dot(on) > dot(back) ? 1 : -1;
    }
  }
  const crowd = geometry?.crowd ? crowdedArcs(pts, edge, geometry.crowd) : [];
  const rules = { endGapA: gaps.a, endGapB: gaps.b, prefer };
  // Clear of what crowds the line by a tee's spacing where there is room for
  // that, and by a tee's reach where there is only room for that.
  let s = legalSpot(pts, s0, { ...rules, avoid: crowd.flatMap(w => spreadOver(w.at, w.half)) });
  if (crowd.some(w => Math.abs(s - w.at) < w.half - SPOT_EPS)) {
    s = legalSpot(pts, s0, { ...rules, avoid: crowd.map(w => w.at) });
  }
  const spot = pointAtArc(pts, s)!;
  const landed = geometry ? landingSpot(nodes, edges, edge, pts, spot.point, geometry) : null;
  // Nowhere a tee can sit -- on the line's whole pipe, when that can be
  // routed, or else on the line -- and none goes in.
  if (!(landed ? landed.legal : hasLegalSpot(pts, { endGapA: gaps.a, endGapB: gaps.b }))) return null;
  if (!landed) return { s, point: spot.point, dir: spot.dir, length };
  return { s: project(pts, landed.point), point: landed.point, dir: landed.dir, length };
}

/** What else is on the page for a new tee to keep clear of: the lines as drawn, and the tees' dots. */
export interface Crowd {
  lines: readonly { id: string; points: Pt[] }[];
  tees: { id: string; at: Pt }[];
}

/** The crowd on a drawing: its lines as they are drawn, and the centres of its tees. */
export function crowdOf(nodes: Node[], lines: readonly { id: string; points: Pt[] }[]): Crowd {
  return { lines, tees: nodes.filter(isJunction).map(n => ({ id: n.id, at: centreOfJunction(n) })) };
}

/** A stretch of a line, `half` either side of arc position `at`, that a new tee's centre keeps out of where it can. */
interface Crowded { at: number; half: number }

/** Two arc positions this close are one (`legalSpot`'s own tolerance). */
const SPOT_EPS = 1e-6;

/**
 * Arc positions whose `CORNER_GAP` either side (what `legalSpot` keeps clear
 * of each position it is told to avoid) together cover `half` either side
 * of `at`.
 */
function spreadOver(at: number, half: number): number[] {
  const out = [at];
  const reach = half - CORNER_GAP;
  if (reach <= 0) return out;
  const steps = Math.ceil(reach / CORNER_GAP);
  for (let k = 1; k <= steps; k++) {
    const d = (reach * k) / steps;
    out.push(at - d, at + d);
  }
  return out;
}

/**
 * Where along a line, drawn as `pts`, a new tee would crowd something else
 * on the page: where another line crosses it, and where another tee's dot is
 * beside it. A tee put in on a crossing hid the crossing under its dot -- a
 * line through a tee reads as joined to it -- and its branch, off along the
 * crossing pipe a few pixels from it, drew the two as one fat line.
 *
 * Kept a tee's reach off a crossing, the new tee's branch -- which leaves it
 * square to its line, and so along the line that crosses -- still ran that
 * reach from the other pipe, beside it the whole way, as good as on it. So a
 * crossing is kept `TEE_GAP` off, the spacing two tees on a pipe keep: the
 * branch then runs two grid steps from the pipe it goes along. And a tee's
 * dot beside the line is kept `TEE_GAP` off as it is on the page, centre to
 * centre, not along the line: a dot ten pixels to one side of the line and
 * a tee's reach along it from the new one left the two dots all but
 * touching, a hop squeezed between them.
 */
function crowdedArcs(pts: Pt[], edge: Edge, crowd: Crowd): Crowded[] {
  const out: Crowded[] = [];
  const arcs = arcsOf(pts);
  const horizontal = (p: Pt, q: Pt) => Math.abs(p.y - q.y) < AXIS_EPS;
  const vertical = (p: Pt, q: Pt) => Math.abs(p.x - q.x) < AXIS_EPS;
  for (const other of crowd.lines) {
    if (other.id === edge.id) continue;
    const q = simplifyPoints(other.points);
    for (let i = 0; i + 1 < pts.length; i++) for (let j = 0; j + 1 < q.length; j++) {
      const [a, b, c, d] = [pts[i], pts[i + 1], q[j], q[j + 1]];
      let x: Pt | null = null;
      if (horizontal(a, b) && vertical(c, d)) x = { x: c.x, y: a.y };
      else if (vertical(a, b) && horizontal(c, d)) x = { x: a.x, y: c.y };
      if (!x) continue;
      const on = (p: Pt, u: Pt, v: Pt) => p.x >= Math.min(u.x, v.x) - AXIS_EPS && p.x <= Math.max(u.x, v.x) + AXIS_EPS
        && p.y >= Math.min(u.y, v.y) - AXIS_EPS && p.y <= Math.max(u.y, v.y) + AXIS_EPS;
      if (on(x, a, b) && on(x, c, d)) out.push({ at: arcs[i] + Math.hypot(x.x - a.x, x.y - a.y), half: TEE_GAP });
    }
  }
  const reach = J_ANCHOR + J_HALF;
  for (const { id, at: c } of crowd.tees) {
    if (id === edge.source || id === edge.target) continue;
    const s = project(pts, c);
    const p = pointAtArc(pts, s);
    if (!p) continue;
    const off = Math.hypot(p.point.x - c.x, p.point.y - c.y);
    if (off <= reach) out.push({ at: s, half: Math.sqrt(TEE_GAP * TEE_GAP - off * off) });
  }
  return out;
}

/**
 * Where the reseat will put a tee put into `edge` at `point` (on the line as
 * drawn, `drawn`): the pipe it lands on, routed as the split leaves it -- the
 * line carrying the corners it is drawn with -- and every tee on it placed as
 * the reseat places them, the new one among them in its order. Null when the
 * pipe cannot be routed yet.
 */
function landingSpot(
  nodes: Node[], edges: Edge[], edge: Edge, drawn: Pt[], point: Pt, g: { endOf: EndLookup; obstacles?: Obstacles },
): { point: Pt; dir: Pt; legal: boolean } | null {
  const m = buildModel(nodes, edges);
  if (!m.edgeById.has(edge.id)) return null;
  // A line that is no pipe's yet is one by itself once a tee is in it.
  const pipe: Pipe = m.byLine.get(edge.id) ?? {
    a: { nodeId: edge.source, handle: edge.sourceHandle, lineId: edge.id },
    b: { nodeId: edge.target, handle: edge.targetHandle, lineId: edge.id },
    tees: [], lines: [edge.id], forward: [true],
  };
  const k = pipe.lines.indexOf(edge.id);
  const lines = new Map<string, Edge>();
  for (const id of pipe.lines) lines.set(id, m.edgeById.get(id)!);
  const hand = pipe.lines.some(id => isHand(lines.get(id)!));
  const corners = drawn.slice(1, -1).map(p => ({ ...p }));
  const rest = { ...((edge.data ?? {}) as Record<string, unknown>) };
  delete rest.waypoints;
  delete rest.viaRun;
  lines.set(edge.id, { ...edge, data: { ...rest, ...(corners.length ? { waypoints: corners, ...(hand ? {} : { viaRun: true }) } : {}) } });
  const geo = pipeGeometry(pipe, m.byId, lines, g.endOf, pipeSheet(nodes, g.obstacles), undefined, { m });
  if (!geo || geo.length < 1e-6) return null;
  const id = '\u0000new';
  const byId = new Map(m.byId);
  byId.set(id, { id, type: 'JUNCTION', position: { x: point.x - J_HALF, y: point.y - J_HALF }, data: { componentType: 'JUNCTION' } });
  const spots = placeTees({ ...pipe, tees: [...pipe.tees.slice(0, k), id, ...pipe.tees.slice(k)] }, geo, { ...m, byId });
  const at = pointAtArc(geo.pts, spots[k]);
  const legal = hasLegalSpot(geo.pts, { endGapA: endGapAt(pipe.a, m), endGapB: endGapAt(pipe.b, m) });
  return at ? { point: at.point, dir: at.dir, legal } : null;
}
