import type { Connection, Edge, EdgeChange, HandleType, Node } from '@xyflow/react';
import { Position, addEdge } from '@xyflow/react';
import { freshEdgeId, nextJunctionId } from './ids';
import {
  FACES, J_ANCHOR, J_END, J_HALF, J_STUB, TEE_GAP, adoptTee, branchFace, centreOfJunction, isJunction, junctionData,
  crowdOf, junctionEnd, pipesOf, runDirOf, splitSpot,
} from './junctions';
import type { Along, Crowd, EndLookup, Face, Pipe } from './junctions';
import { healThrough, insertInline, splitEdgeAt, tapLine } from './splitEdge';
import { drawnRoute } from './lineRoute';
import { lineAt } from './lineHit';
import type { DrawnLine } from './lineHit';
import { isInline, isTapped } from './attach';
import { pageOf } from './pages';
import {
  ALIGNED, AXIS_EPS, GRID, STUB, faceTowards, gridAlong, nearestOnPolyline, pathPoints, pointAtArc, polylineLength,
  routeCost, simplifyPoints,
} from './route';
import type { Box, End, Pt } from './route';
import { boxOfNode, perPage, routeAuto } from './routeGrid';
import type { Obstacles } from './routeGrid';
import { measuredAt } from './ports';

/**
 * Where a drag is let go, and what it makes there.
 *
 * Three gestures draw a line: a drag out of a port (React Flow's own), a pull
 * out of a line, and a pull out of a tee's ring (BranchDrag). Each used to
 * decide what it had landed on by its own rules, and none of them asked what
 * the thing it landed on already was. So a second line was stacked on a port
 * that had one and read as a tee that is not there; a release over the middle
 * of a valve made an open end inside it; a pull let go back on its own pipe
 * left a dot on the line or a loop with nothing in it; and a short pull that
 * ended near a neighbouring header joined two runs that have nothing to do
 * with each other -- a flow path feed-twin then reads.
 *
 * Now there is one answer, worked out here and nowhere else: `resolveDrop`
 * says what a release means, as a plan, and `commitDrop` makes the plan.
 * Nothing in between reads the DOM or React Flow; the designer asks those
 * what is under the pointer and hands the answer in (`Under`), so every rule
 * below is a pure function of the drawing, and each is tested on its own.
 *
 * The rules, in the order they are asked:
 *
 * a. **Cancel** a pull that ends on its own pipe -- its lines, its tees, the
 *    symbols or tees at its two ends -- or on its own symbol, or, from a
 *    symbol or a tee, on a pipe that would join it to itself (`ownAround`);
 *    and a pull shorter than `MIN_PULL` on screen, unless it is let go right
 *    on a free port. Nothing that was under the pointer and refused ever
 *    falls through to an open end: a refused drop draws nothing.
 * b. A **port** strictly under the pointer is the target. A tee's faces never
 *    are; they are the tee.
 * c. Otherwise the drawn **line** nearest the pointer (within `LINE_REACH`)
 *    and the **node** under it compete, and the nearer wins.
 * d. A symbol's **body** means its best free port, by the route a line to it
 *    would draw. A **tee** means its free face across its run on the side the
 *    line comes from, or, with that face taken, a new tee on its run
 *    `TEE_GAP` along, toward the other end.
 * e. A port that already has a line is **teed**: the line is split `TEE_OUT`
 *    out from the port, and the new line joins the tee. A drag that starts on
 *    such a port is a pull out of that line, from the same place.
 * f. A **line** is split where it was hit -- or at the foot of the other end
 *    on it, when that is within `ALIGN_REACH` on the same straight leg and a
 *    tee may sit there, so the branch is straight.
 * g. **Empty canvas** leaves an open end, on the grid, and level with where
 *    the line leaves from when it is within `ALIGN_REACH` of it.
 *
 * Every tee is put in with `splitEdgeAt` at the spot the reseat will keep it
 * (`splitSpot`), and only where the line has room for it without pushing a
 * neighbour (`roomBeside`); every new line's id is fresh, and nothing here
 * ever joins a symbol to itself or puts a second line on one of its ports.
 * A line drawn out of an open end, or let go on one, is no new line: it is
 * the line that open end ends, going on (`commitDrop`).
 */

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * How far a pull has to travel, in screen pixels, before letting go of it
 * draws anything. Shorter is a change of mind. In screen pixels because that
 * is what a hand misses by: a fixed distance on the drawing was a dead zone
 * at one zoom and a hair trigger at another.
 */
export const MIN_PULL = 30;
/**
 * The least a pull may be on the drawing, whatever the zoom: an open end
 * nearer than this to where its line leaves has no room to turn and hooks.
 */
export const MIN_PULL_FLOW = 20;
/** How near the pointer a line has to be, in screen pixels, to be the one let go on. */
export const LINE_REACH = 14;
/** ...and never less than this on the drawing: half the stroke a line takes presses on. */
const LINE_REACH_FLOW = 6;
/**
 * How far out along its line from an occupied port a tee goes: the port's
 * stub, the tee's anchor and the tee's own stub, so the short piece of line
 * between the port and the tee is a line and not a knot.
 */
export const TEE_OUT = STUB + J_ANCHOR + J_STUB;
/**
 * How far a tee or an open end is moved to put it level with the other end
 * of its branch. About a grid square and a hand's error: far enough to take
 * the jog out of a pull aimed straight, not so far that it overrides a
 * branch drawn off to one side on purpose.
 */
export const ALIGN_REACH = 20;

/** A distance in screen pixels, as flow pixels at this zoom, and never less than `floor`. */
export const onScreen = (screen: number, floor: number, zoom = 1) => Math.max(floor, screen / (zoom > 0 ? zoom : 1));

// ── What the designer hands in ───────────────────────────────────────────────

/**
 * Where a drag began. `line` and `node` are BranchDrag's own sources -- a
 * pull out of a line at a point on it, and a pull out of a tee's ring; `port`
 * is a React Flow drag out of a port; `reconnect` is one end of a line being
 * carried to somewhere else, the other end staying where it is.
 */
export type DropSource =
  | { kind: 'port'; nodeId: string; handle: string }
  | { kind: 'line'; edgeId: string; at: Pt; dir?: Pt; points: Pt[] }
  | { kind: 'node'; nodeId: string; at?: Pt }
  | { kind: 'reconnect'; edgeId: string; moving: 'source' | 'target' };

/** A line as drawn: its corners, unhopped, source to target. */
export interface DrawnPoints {
  id: string;
  points: Pt[];
}

/** The nearest drawn line to the pointer, and the point on it nearest. */
export interface LineUnder {
  id: string;
  at: Pt;
  points: Pt[];
}

/**
 * What is under the pointer: the port and the node the page says are there
 * (`document.elementFromPoint`), and the nearest drawn line (`lineUnder`).
 */
export interface Under {
  handle?: { nodeId: string; handleId: string } | null;
  node?: string | null;
  line?: LineUnder | null;
}

/** The drawing a drop is resolved against. */
export interface DropScene {
  nodes: Node[];
  edges: Edge[];
  /** Where a port is and which way it faces, as measured (the designer's `endOfClear`). */
  endOf: EndLookup;
  /** The ports a symbol has, by handle id. Unset, a port is any side `endOf` answers for. */
  portsOf?: (node: Node) => readonly string[] | null | undefined;
  /** What automatic routes go round. Unset, the visible symbols on each page. */
  obstacles?: Obstacles;
  /** The lines as drawn. Unset, a line is routed the way the canvas routes it. */
  lines?: readonly DrawnPoints[];
  /** For thresholds given in screen pixels. */
  zoom?: number;
  /** The page an open end goes on. Unset, the page of what it is drawn from. */
  page?: string;
}

// ── What comes back ──────────────────────────────────────────────────────────

interface EndAt {
  /** A port's anchor, or the centre of a tee or an open end. */
  centre: Pt;
  /** The end as the router takes it: where the line anchors and which way it leaves. */
  end: End;
}

/** One end of the line a drop makes. */
export type PlanEnd =
  | (EndAt & { kind: 'port'; nodeId: string; handle: string })
  | (EndAt & { kind: 'tee'; nodeId: string; face: Face })
  | (EndAt & { kind: 'split'; edgeId: string; at: Pt; points: Pt[]; face: Face })
  | (EndAt & { kind: 'open'; face: Face });

/** What the pointer was let go on. */
export type Landing = 'port' | 'occupied' | 'body' | 'tee' | 'line' | 'open';
/** Why a drop draws nothing: too short, back on its own pipe, nowhere to join, or nothing to join. */
export type Refusal = 'short' | 'own' | 'full' | 'nothing';

export type DropPlan =
  | { kind: 'cancel'; why: Refusal }
  | {
    kind: 'connect';
    landed: Landing;
    /** Where the line starts: the port, the tee, or the new tee in the line it was pulled from. */
    from: PlanEnd;
    to: PlanEnd;
    /** Set when the drop carries an existing line's end rather than drawing a new line. */
    reconnect?: { edgeId: string; moving: 'source' | 'target' };
  };

// ── The drawing, looked up ───────────────────────────────────────────────────

interface Cx {
  scene: DropScene;
  byId: Map<string, Node>;
  edgeById: Map<string, Edge>;
  linesAt: Map<string, Edge[]>;
  zoom: number;
  /** What routes go round on a page. */
  boxes: (page: string) => Box[];
  /** The same, as the split and the reseat take it. */
  sheet: Obstacles;
  /** A line's corners as drawn, source to target. */
  points: (edgeId: string) => Pt[] | null;
  /** The pipe a line is part of, if it is part of one. */
  pipeOf: (edgeId: string) => Pipe | null;
  /** The lines as drawn and the tees, which a new tee keeps clear of. */
  crowd: () => Crowd;
}

const pageOfNode = (n: Node | undefined) => pageOf(n?.data as { page?: string } | undefined);
const handleAt = (e: Edge, nodeId: string) => (e.source === nodeId ? e.sourceHandle : e.targetHandle);
const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);

function contextOf(scene: DropScene): Cx {
  const byId = new Map(scene.nodes.map(n => [n.id, n]));
  const edgeById = new Map<string, Edge>();
  const linesAt = new Map<string, Edge[]>();
  for (const e of scene.edges) {
    if (!edgeById.has(e.id)) edgeById.set(e.id, e);
    for (const id of new Set([e.source, e.target])) {
      const list = linesAt.get(id);
      if (list) list.push(e); else linesAt.set(id, [e]);
    }
  }
  const boxes = perPage(scene.nodes, scene.obstacles);
  const drawn = new Map((scene.lines ?? []).map(l => [l.id, l.points]));
  const points = (edgeId: string): Pt[] | null => {
    const e = edgeById.get(edgeId);
    if (!e) return null;
    const pts = drawn.get(edgeId) ?? drawnRoute(e, byId, scene.endOf, boxes);
    return pts && pts.length >= 2 ? simplifyPoints(pts) : null;
  };
  let pipes: Map<string, Pipe> | null = null;
  const pipeOf = (edgeId: string): Pipe | null => {
    if (!pipes) {
      pipes = new Map();
      for (const p of pipesOf(scene.nodes, scene.edges)) for (const id of p.lines) pipes.set(id, p);
    }
    return pipes.get(edgeId) ?? null;
  };
  const zoom = scene.zoom && scene.zoom > 0 ? scene.zoom : 1;
  let crowded: Crowd | null = null;
  const crowd = () => {
    crowded ??= crowdOf(scene.nodes, scene.lines
      ?? scene.edges.flatMap(e => { const p = points(e.id); return p ? [{ id: e.id, points: p }] : []; }));
    return crowded;
  };
  return { scene, byId, edgeById, linesAt, zoom, boxes, sheet: scene.obstacles ?? boxes, points, pipeOf, crowd };
}

/** The line on a port, if it has one. */
function lineOn(cx: Cx, nodeId: string, handle: string | null | undefined): Edge | undefined {
  return (cx.linesAt.get(nodeId) ?? []).find(e =>
    (e.source === nodeId && e.sourceHandle === handle) || (e.target === nodeId && e.targetHandle === handle));
}

/** The two run lines of a tee that rides a pipe, or null for a tee that does not. */
function runOfTee(cx: Cx, tee: Node): { along: Along; inLine: Edge; outLine: Edge } | null {
  const along = junctionData(tee).along;
  if (!along || along.in === along.out) return null;
  const lines = cx.linesAt.get(tee.id) ?? [];
  const inLine = lines.find(e => handleAt(e, tee.id) === along.in);
  const outLine = inLine && lines.find(e => e !== inLine && handleAt(e, tee.id) === along.out);
  return inLine && outLine ? { along, inLine, outLine } : null;
}

/** Section boxes and text frame and label the drawing; nothing joins to them. */
function joinable(n: Node | undefined): Node | null {
  if (!n) return null;
  const t = (n.data as { componentType?: string } | undefined)?.componentType ?? n.type;
  return t === 'REGION' || t === 'TEXT' || n.type === 'REGION' || n.type === 'TEXT' ? null : n;
}

/** How far the pointer is from a node: a tee from its centre, a symbol from its box. */
function nodeDistance(n: Node, at: Pt): number {
  if (isJunction(n)) return dist(at, centreOfJunction(n));
  const b = boxOfNode(n);
  const dx = Math.max(b.x - at.x, 0, at.x - (b.x + b.w));
  const dy = Math.max(b.y - at.y, 0, at.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** A symbol's ports: what the designer measured, or every side `endOf` answers for. */
function portsOfNode(cx: Cx, n: Node): string[] {
  const given = cx.scene.portsOf?.(n);
  return [...(given ?? FACES)].filter(h => !!h && !!cx.scene.endOf(n, h));
}

// ── Which way a line leaves an end ───────────────────────────────────────────

/**
 * The axis a line leaves an end along, and which way along it (+1, -1, or 0
 * for either). A port leaves the way it faces; a tee's branch leaves across
 * its run; a free junction any way at all (`axis` null).
 */
interface Leave { axis: 'x' | 'y' | null; sign: number }

const SIDE_LEAVE: Record<string, Leave> = {
  [Position.Left]: { axis: 'x', sign: -1 }, [Position.Right]: { axis: 'x', sign: 1 },
  [Position.Top]: { axis: 'y', sign: -1 }, [Position.Bottom]: { axis: 'y', sign: 1 },
};
const ANY: Leave = { axis: null, sign: 0 };

/** Across a run going `dir`, toward `to` from `at`. */
function across(dir: Pt, at: Pt, to: Pt): Leave {
  return Math.abs(dir.x) >= Math.abs(dir.y)
    ? { axis: 'y', sign: Math.sign(to.y - at.y) }
    : { axis: 'x', sign: Math.sign(to.x - at.x) };
}

const leaveOf = (e: PlanEnd): Leave => SIDE_LEAVE[e.end.side] ?? ANY;

// ── Where the drag came from ─────────────────────────────────────────────────

/** Everything a pull may not land on: the pipe it is on, and what that pipe ends at. */
interface Own { lines: Set<string>; nodes: Set<string> }

/**
 * The pipe `e` is part of, as somewhere a pull may not land: its lines, its
 * tees, and the ends it has -- every one, or with `ends` 'junctions', only an
 * end that is a junction and not a symbol.
 */
function ownPipe(cx: Cx, e: Edge, own: Own, ends: 'all' | 'junctions' = 'all') {
  const end = (id: string) => { if (ends === 'all' || isJunction(cx.byId.get(id))) own.nodes.add(id); };
  const pipe = cx.pipeOf(e.id);
  if (!pipe) {
    own.lines.add(e.id);
    end(e.source);
    end(e.target);
    return;
  }
  for (const id of pipe.lines) own.lines.add(id);
  for (const id of pipe.tees) own.nodes.add(id);
  end(pipe.a.nodeId);
  end(pipe.b.nodeId);
}

/**
 * What a line drawn from `node` may not be let go on: `node` itself, and the
 * pipes round it -- all but `except`'s, the line being carried.
 *
 * Round a tee, every pipe through it or out of it, whole: a line back into
 * any of them closes a loop with nothing in it, and one to the symbol at the
 * far end of any of them joins that symbol to itself through the tee.
 * Round a symbol, every pipe out of its ports, but for the symbols at their
 * far ends: a tee in one of those pipes, or the junction one ends at, joined
 * to another of the symbol's ports puts two of its ports on one node -- its
 * outlet on its own inlet, exactly what a pull out of that pipe let go on the
 * symbol would make, and is refused. A second line to the symbol at the far
 * end is only two lines between two symbols, which a drawing may have.
 */
function ownAround(cx: Cx, node: Node, own: Own, except?: Edge) {
  own.nodes.add(node.id);
  const skip = new Set(except ? cx.pipeOf(except.id)?.lines ?? [except.id] : []);
  for (const e of cx.linesAt.get(node.id) ?? []) {
    if (!skip.has(e.id)) ownPipe(cx, e, own, isJunction(node) ? 'all' : 'junctions');
  }
}

/**
 * The end a drag starts from, before it is known where it is going.
 * `pointer` is where the pointer started, which the pull is measured from;
 * `point` is where the new line will start, which the target is judged from.
 */
type Origin =
  | { kind: 'port'; node: Node; handle: string; end: End; pointer: Pt; point: Pt; own: Own }
  | { kind: 'line'; edge: Edge; points: Pt[]; pointer: Pt; point: Pt; own: Own }
  | { kind: 'tee'; node: Node; pointer: Pt; point: Pt; own: Own }
  | {
    kind: 'fixed'; node: Node; handle: string; end: End; pointer: Pt; point: Pt; own: Own;
    reconnect: { edgeId: string; moving: 'source' | 'target' };
  };

/** Where on a line, from its end at a port, a tee `TEE_OUT` out goes. */
function outFromPort(pts: Pt[], line: Edge, nodeId: string, handle: string): Pt {
  const L = polylineLength(pts);
  const atSource = line.source === nodeId && line.sourceHandle === handle;
  const s = Math.max(0, Math.min(L, atSource ? TEE_OUT : L - TEE_OUT));
  return pointAtArc(pts, s)!.point;
}

function teeOrigin(cx: Cx, node: Node): Origin {
  const own: Own = { lines: new Set(), nodes: new Set() };
  ownAround(cx, node, own);
  const c = centreOfJunction(node);
  return { kind: 'tee', node, pointer: c, point: c, own };
}

function lineOrigin(cx: Cx, edge: Edge, points: Pt[], at: Pt, pointer: Pt): Origin {
  const own: Own = { lines: new Set(), nodes: new Set() };
  ownPipe(cx, edge, own);
  return { kind: 'line', edge, points, pointer, point: at, own };
}

function originOf(source: DropSource, cx: Cx): Origin | null {
  switch (source.kind) {
    case 'node': {
      const node = cx.byId.get(source.nodeId);
      return node && isJunction(node) ? teeOrigin(cx, node) : null;
    }
    case 'line': {
      const edge = cx.edgeById.get(source.edgeId);
      if (!edge) return null;
      const points = source.points.length >= 2 ? simplifyPoints(source.points) : cx.points(edge.id);
      // The pull is measured from the press; the line starts where its tee
      // goes, on the grid along the leg (`gridAlong`), as the hover dot
      // showed it. Judged from the press itself, an open end let go below
      // it was put level with the press, a fraction of a pixel off the grid
      // at any zoom but one and a few pixels off at one, and the tee was
      // then put at its foot, off the grid with it.
      return points ? lineOrigin(cx, edge, points, gridAlong(points, source.at), source.at) : null;
    }
    case 'port': {
      const node = cx.byId.get(source.nodeId);
      if (!node) return null;
      if (isJunction(node)) return teeOrigin(cx, node);
      const end = cx.scene.endOf(node, source.handle);
      const b = boxOfNode(node);
      const anchor = end ? { x: end.x, y: end.y } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      // A port that already has a line is a place on that line: the drag is
      // a pull out of it, from where a tee off the port would go.
      const on = lineOn(cx, node.id, source.handle);
      if (on) {
        const pts = cx.points(on.id);
        return pts ? lineOrigin(cx, on, pts, outFromPort(pts, on, node.id, source.handle), anchor) : null;
      }
      if (!end) return null;
      const own: Own = { lines: new Set(), nodes: new Set() };
      ownAround(cx, node, own);
      return { kind: 'port', node, handle: source.handle, end, pointer: anchor, point: anchor, own };
    }
    case 'reconnect': {
      const e = cx.edgeById.get(source.edgeId);
      if (!e) return null;
      const [fixedId, fixedHandle, movingId, movingHandle] = source.moving === 'target'
        ? [e.source, e.sourceHandle, e.target, e.targetHandle]
        : [e.target, e.targetHandle, e.source, e.sourceHandle];
      const node = cx.byId.get(fixedId), moving = cx.byId.get(movingId);
      if (!node || !moving || !fixedHandle) return null;
      const end = endAt(cx, node, fixedHandle);
      if (!end) return null;
      // Round the end that stays, as for a line drawn from it: a carried end
      // is a line from there as much as a drag out of it is.
      const own: Own = { lines: new Set(), nodes: new Set() };
      ownAround(cx, node, own, e);
      // And the carried line's own pipe -- but for the symbol the end is
      // leaving, which may take it back on another of its ports (that is
      // what carrying an end is for) unless the pipe starts there too, or
      // it is round the end that stays as well.
      const carried: Own = { lines: new Set(), nodes: new Set() };
      ownPipe(cx, e, carried);
      const pipe = cx.pipeOf(e.id);
      if (!pipe || pipe.a.nodeId !== pipe.b.nodeId) carried.nodes.delete(movingId);
      for (const id of carried.lines) own.lines.add(id);
      for (const id of carried.nodes) own.nodes.add(id);
      const m = cx.scene.endOf(moving, movingHandle);
      const pointer = m ? { x: m.x, y: m.y } : centreOfJunction(moving);
      const point = isJunction(node) ? centreOfJunction(node) : { x: end.x, y: end.y };
      return { kind: 'fixed', node, handle: fixedHandle, end, pointer, point, own, reconnect: { edgeId: e.id, moving: source.moving } };
    }
  }
}

/** An end on a node as the router takes it: a tee's face carries J_END. */
function endAt(cx: Cx, n: Node, handle: string): End | null {
  if (isJunction(n)) return { ...(cx.scene.endOf(n, handle) ?? junctionEnd(n.position, handle as Face)), ...J_END };
  return cx.scene.endOf(n, handle);
}

/** Which way a line from the origin leaves it, heading for `to`. */
function originLeave(o: Origin, to: Pt, cx: Cx): Leave {
  switch (o.kind) {
    case 'port':
    case 'fixed':
      return SIDE_LEAVE[o.end.side] ?? ANY;
    case 'line': {
      const near = nearestOnPolyline(o.points, o.point);
      return near ? across(near.dir, o.point, to) : ANY;
    }
    case 'tee': {
      const run = runOfTee(cx, o.node);
      return run ? across(runDirOf(run.along), o.point, to) : ANY;
    }
  }
}

/** The origin's end facing `to`, cheaply, for pricing the ports of a body it is let go on. */
function originProbe(o: Origin, to: Pt, cx: Cx): End {
  switch (o.kind) {
    case 'port':
    case 'fixed':
      return o.end;
    case 'line': {
      const near = nearestOnPolyline(o.points, o.point);
      const face = branchFace(near?.dir ?? { x: 1, y: 0 }, to, o.point);
      return junctionEnd({ x: o.point.x - J_HALF, y: o.point.y - J_HALF }, face);
    }
    case 'tee': {
      const run = runOfTee(cx, o.node);
      const c = o.point;
      const face = run ? branchFace(runDirOf(run.along), to, c) : faceTowards(to.x, to.y, c.x, c.y) as Face;
      return { ...junctionEnd(o.node.position, face) };
    }
  }
}

// ── Ends ─────────────────────────────────────────────────────────────────────

const teeFace = (cx: Cx, tee: Node, face: Face): PlanEnd =>
  ({ kind: 'tee', nodeId: tee.id, face, centre: centreOfJunction(tee), end: endAt(cx, tee, face)! });

/**
 * The foot of `far` on the line through the straight leg of `pts` that `at`
 * is on, when a tee there makes a straight branch: within `ALIGN_REACH` of
 * `at`, and with `far` able to leave straight toward it. Whether the foot is
 * on the leg at all, clear of its bends, is `splitSpot`'s to say: a foot off
 * the leg is never where a tee lands.
 */
function footOf(pts: Pt[], at: Pt, far: { point: Pt; leave: Leave }): Pt | null {
  const near = nearestOnPolyline(pts, at);
  if (!near || near.segment + 1 >= pts.length) return null;
  const a = pts[near.segment], b = pts[near.segment + 1];
  const horizontal = Math.abs(a.y - b.y) < AXIS_EPS, vertical = Math.abs(a.x - b.x) < AXIS_EPS;
  if (horizontal === vertical) return null;
  const q = far.point;
  const foot = horizontal ? { x: q.x, y: a.y } : { x: a.x, y: q.y };
  if (dist(foot, at) > ALIGN_REACH) return null;
  // From the far end to the leg, across it.
  const gap = horizontal ? a.y - q.y : a.x - q.x;
  if (Math.abs(gap) < 1) return null;
  if (far.leave.axis && far.leave.axis !== (horizontal ? 'y' : 'x')) return null;
  if (far.leave.sign && Math.sign(gap) !== far.leave.sign) return null;
  return foot;
}

/** Two tees this much nearer than `TEE_GAP` are still `TEE_GAP` apart: arithmetic, not a place. */
const ROOM_EPS = 0.01;

/**
 * Whether a new tee at `spot` in `edge` (`s` along the line as drawn, of
 * `length`) leaves the tees riding its pipe at the line's two ends their
 * spacing, `TEE_GAP` centre to centre.
 *
 * Between two tees closer than twice that there is no room for a third, and
 * `splitSpot` still answers -- with the least bad place, which can be on a
 * neighbour or past it -- because a pipe has to hold whatever tees it is
 * given. But the room is made by the reseat, pushing the neighbour along: a
 * tee nobody touched jumps, its branch with it, and the drop was not what it
 * showed. So a split with no room is not planned. A tee or symbol a pipe ends
 * at stays where it is whatever goes in beside it, and is no neighbour here.
 */
function roomBeside(cx: Cx, edge: Edge, spot: { s: number; length: number }): boolean {
  for (const [id, arc] of [[edge.source, spot.s], [edge.target, spot.length - spot.s]] as const) {
    const n = cx.byId.get(id);
    if (!n || !isJunction(n)) continue;
    const along = junctionData(n).along;
    const face = handleAt(edge, id);
    if (!along || along.in === along.out || (face !== along.in && face !== along.out)) continue;
    // The line is drawn from the tee's face, its anchor out from the centre.
    if (arc + J_ANCHOR < TEE_GAP - ROOM_EPS) return false;
  }
  return true;
}

/**
 * The tee at an end of `edge` that stands where the line would be teed level
 * with the other end (`footOf`), when its face toward that end is free: a
 * pull let go on a line just beside a tee in line with it means that tee.
 * The line's own tee there had taken the foot, so a new tee went in
 * `TEE_GAP` along, and the pull drew a jog into it beside the tee it was
 * aimed at -- two dots touching, a knot, where a cross was meant.
 */
function teeAtFoot(o: Origin, cx: Cx, edge: Edge, pts: Pt[], at: Pt, far: { point: Pt; leave: Leave }): PlanEnd | null {
  const foot = footOf(pts, at, far);
  if (!foot) return null;
  for (const id of [edge.source, edge.target]) {
    const n = cx.byId.get(id);
    if (!n || !isJunction(n) || o.own.nodes.has(n.id)) continue;
    const run = runOfTee(cx, n);
    const c = centreOfJunction(n);
    // In line with it to within what the router draws straight into a tee.
    if (!run || dist(c, foot) > ALIGNED) continue;
    const face = branchFace(runDirOf(run.along), far.point, c);
    const used = (cx.linesAt.get(n.id) ?? []).some(e => handleAt(e, n.id) === face);
    if (!used) return teeFace(cx, n, face);
  }
  return null;
}

/**
 * A new tee in `edge`, asked for at `at` and landing where `splitEdgeAt` will
 * put it (the spot the reseat keeps), its branch face across the run on the
 * side of `toward`. With `far`, at the foot of the other end on the line
 * when a tee may sit there. Null when the line has no room for a tee
 * (`roomBeside`).
 */
function splitEnd(cx: Cx, edge: Edge, pts: Pt[], at: Pt, toward: Pt, far: { point: Pt; leave: Leave } | null): PlanEnd | null {
  const { nodes, edges, endOf } = cx.scene;
  const geometry = { endOf, obstacles: cx.sheet, crowd: cx.crowd() };
  // On the grid, where the pointer put it; level with the other end, where
  // that is near and the tee may stand there.
  let want = gridAlong(pts, at);
  let spot = null;
  const foot = far ? footOf(pts, at, far) : null;
  if (foot) {
    spot = splitSpot(nodes, edges, edge.id, pts, foot, toward, geometry);
    if (spot && dist(spot.point, foot) <= AXIS_EPS) want = foot;
    else spot = null;
  }
  spot ??= splitSpot(nodes, edges, edge.id, pts, want, toward, geometry);
  if (!spot || !roomBeside(cx, edge, spot)) return null;
  const face = branchFace(spot.dir, toward, spot.point);
  const position = { x: spot.point.x - J_HALF, y: spot.point.y - J_HALF };
  return { kind: 'split', edgeId: edge.id, at: want, points: pts, face, centre: spot.point, end: junctionEnd(position, face) };
}

/**
 * The end a line to or from an existing tee takes, the other end being at
 * `toward`. A tee that rides a pipe takes it on the face across its run on
 * that side; that face taken, a new tee goes into the run `TEE_GAP` along,
 * toward the other end -- two branches on one face are drawn as one. A free
 * junction or open end takes it on the face that points at it, or the free
 * face that points nearest.
 */
function teeEnd(cx: Cx, tee: Node, toward: Pt): PlanEnd | null {
  const c = centreOfJunction(tee);
  const used = new Set((cx.linesAt.get(tee.id) ?? []).map(e => handleAt(e, tee.id)));
  const run = runOfTee(cx, tee);
  if (run) {
    const dir = runDirOf(run.along);
    const face = branchFace(dir, toward, c);
    if (!used.has(face)) return teeFace(cx, tee, face);
    const ahead = (toward.x - c.x) * dir.x + (toward.y - c.y) * dir.y >= 0;
    const line = ahead ? run.outLine : run.inLine;
    const pts = cx.points(line.id);
    if (!pts) return null;
    const L = polylineLength(pts);
    const s = line.source === tee.id ? TEE_GAP - J_ANCHOR : L - (TEE_GAP - J_ANCHOR);
    return splitEnd(cx, line, pts, pointAtArc(pts, Math.max(0, Math.min(L, s)))!.point, toward, null);
  }
  const want = faceTowards(toward.x, toward.y, c.x, c.y) as Face;
  if (!used.has(want)) return teeFace(cx, tee, want);
  const out: Record<Face, Pt> = { t: { x: 0, y: -1 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 }, r: { x: 1, y: 0 } };
  const free = FACES.filter(f => !used.has(f));
  if (!free.length) return null;
  const score = (f: Face) => out[f].x * (toward.x - c.x) + out[f].y * (toward.y - c.y);
  return teeFace(cx, tee, free.reduce((best, f) => (score(f) > score(best) ? f : best)));
}

// ── The target ───────────────────────────────────────────────────────────────

type Target = { kind: 'target'; landed: Landing; end: PlanEnd } | { kind: 'cancel'; why: Refusal };

const refuse = (why: Refusal): Target => ({ kind: 'cancel', why });
/** A target, or -- with no end to be had there -- nothing, for the reason given. */
const hit = (landed: Landing, end: PlanEnd | null, otherwise: Refusal = 'nothing'): Target =>
  (end ? { kind: 'target', landed, end } : refuse(otherwise));

/** A port that has a line: that line, teed `TEE_OUT` out from the port. */
function teedPort(o: Origin, cx: Cx, n: Node, handle: string, line: Edge, from: Pt): Target {
  if (o.own.lines.has(line.id)) return refuse('own');
  const pts = cx.points(line.id);
  if (!pts) return refuse('nothing');
  return hit('occupied', splitEnd(cx, line, pts, outFromPort(pts, line, n.id, handle), from, null), 'full');
}

function portTarget(o: Origin, cx: Cx, n: Node, handle: string, from: Pt): Target {
  const line = lineOn(cx, n.id, handle);
  if (line) return teedPort(o, cx, n, handle, line, from);
  const end = cx.scene.endOf(n, handle);
  if (!end) return refuse('nothing');
  return hit('port', { kind: 'port', nodeId: n.id, handle, centre: { x: end.x, y: end.y }, end });
}

/**
 * A symbol let go on: its free port the line reaches best, by the route it
 * would draw round the symbols in its way -- a port that faces away is near
 * and wrong. With every port taken, the one it reaches best is teed.
 */
function bodyTarget(o: Origin, cx: Cx, n: Node, from: Pt): Target {
  const boxes = cx.boxes(pageOfNode(n));
  const ports = portsOfNode(cx, n).map((handle, index) => {
    const end = cx.scene.endOf(n, handle)!;
    const probe = originProbe(o, end, cx);
    // No route between the two is shorter than the steps between them, less
    // the half pixel the router may line an end up by.
    const bound = Math.abs(end.x - probe.x) + Math.abs(end.y - probe.y) - 1;
    return { handle, index, end, probe, bound, line: lineOn(cx, n.id, handle) };
  });
  // The cheapest of `candidates` by the route drawn to it, the first of them
  // on a tie. Asked nearest first, and none asked once no route to what is
  // left could be as cheap: the route to each port is searched round the
  // symbols in its way, and searching every port of a symbol, cold, the
  // first frame a drag came over it, cost a frame.
  const cheapest = <T extends (typeof ports)[number]>(candidates: T[]) => {
    let best: (T & { cost: number }) | null = null;
    for (const p of [...candidates].sort((x, y) => x.bound - y.bound || x.index - y.index)) {
      if (best && p.bound > best.cost) break;
      const cost = routeCost(simplifyPoints(pathPoints(routeAuto(p.probe, p.end, boxes).d)));
      if (!best || cost < best.cost || (cost === best.cost && p.index < best.index)) best = { ...p, cost };
    }
    return best;
  };
  const free = cheapest(ports.filter(p => !p.line));
  if (free) return hit('body', { kind: 'port', nodeId: n.id, handle: free.handle, centre: { x: free.end.x, y: free.end.y }, end: free.end });
  const taken = cheapest(ports.filter(p => p.line && !o.own.lines.has(p.line.id)));
  if (taken) return teedPort(o, cx, n, taken.handle, taken.line!, from);
  return refuse('full');
}

/** Rules b to g: what the pointer landed on, judged from `from`, where the origin's line leaves. */
function targetOf(o: Origin, from: Pt, at: Pt, under: Under, cx: Cx): Target {
  let nodeId = under.node ?? null;
  // b. A port strictly under the pointer. A tee's faces are the tee.
  if (under.handle) {
    const n = cx.byId.get(under.handle.nodeId);
    if (n && isJunction(n)) nodeId = n.id;
    else if (n) return o.own.nodes.has(n.id) ? refuse('own') : portTarget(o, cx, n, under.handle.handleId, from);
  }
  // c. The nearer of the line and the node under the pointer. A tee's own
  // lines start at its dot, and are the tee there: counted against it, they
  // beat it everywhere along its run but the middle four pixels of a dot
  // drawn fourteen across, and a drop on the edge of the dot put a second
  // tee in beside it.
  const node = nodeId ? joinable(cx.byId.get(nodeId)) : null;
  const under0 = under.line && cx.edgeById.has(under.line.id) ? under.line : null;
  const ownLine = !!node && !!under0 && isJunction(node) && ((l: Edge) => l.source === node.id || l.target === node.id)(cx.edgeById.get(under0.id)!);
  const line = ownLine ? null : under0;
  if (node && (!line || nodeDistance(node, at) <= dist(line.at, at))) {
    // d. A tee, or a symbol's body.
    if (o.own.nodes.has(node.id)) return refuse('own');
    return isJunction(node) ? hit('tee', teeEnd(cx, node, from), 'full') : bodyTarget(o, cx, node, from);
  }
  if (line) {
    // f. A line, teed where it was hit or level with the other end -- or,
    // where level with the other end is a tee already, that tee.
    if (o.own.lines.has(line.id)) return refuse('own');
    const pts = line.points.length >= 2 ? simplifyPoints(line.points) : cx.points(line.id);
    if (!pts) return refuse('nothing');
    const edge = cx.edgeById.get(line.id)!;
    const far = { point: from, leave: originLeave(o, line.at, cx) };
    const level = teeAtFoot(o, cx, edge, pts, line.at, far);
    if (level) return hit('tee', level);
    return hit('line', splitEnd(cx, edge, pts, line.at, from, far), 'full');
  }
  // g. Empty canvas: an open end, level with the origin when it nearly is --
  // ahead of it, and not moved onto a line it was let go clear of.
  let p = { x: Math.round(at.x / GRID) * GRID, y: Math.round(at.y / GRID) * GRID };
  const leave = originLeave(o, p, cx);
  const axis = leave.axis ?? (Math.abs(p.x - from.x) >= Math.abs(p.y - from.y) ? 'x' : 'y');
  const ahead = !leave.sign || leave.sign * (axis === 'x' ? p.x - from.x : p.y - from.y) > 0;
  const level = axis === 'x' ? { x: p.x, y: from.y } : { x: from.x, y: p.y };
  if (ahead && dist(level, p) <= ALIGN_REACH && !lineUnder(cx.scene.lines ?? [], level, cx.zoom)) p = level;
  const face = faceTowards(from.x, from.y, p.x, p.y) as Face;
  return hit('open', { kind: 'open', face, centre: p, end: junctionEnd({ x: p.x - J_HALF, y: p.y - J_HALF }, face) });
}

/** Where the origin's line starts, now that it is known where it goes. */
function originEnd(o: Origin, to: PlanEnd, cx: Cx): PlanEnd | null {
  switch (o.kind) {
    case 'port':
      return { kind: 'port', nodeId: o.node.id, handle: o.handle, centre: o.point, end: o.end };
    case 'fixed':
      return isJunction(o.node)
        ? { kind: 'tee', nodeId: o.node.id, face: o.handle as Face, centre: o.point, end: o.end }
        : { kind: 'port', nodeId: o.node.id, handle: o.handle, centre: o.point, end: o.end };
    case 'line':
      return splitEnd(cx, o.edge, o.points, o.point, to.centre, { point: to.centre, leave: leaveOf(to) });
    case 'tee':
      return teeEnd(cx, o.node, to.centre);
  }
}

// ── The resolver ─────────────────────────────────────────────────────────────

/** How far the pointer has to travel for a pull to count, on the drawing at this zoom. */
export const minPull = (zoom = 1) => onScreen(MIN_PULL, MIN_PULL_FLOW, zoom);

/**
 * Is what is under the pointer aimed at closely enough to count however
 * short the pull? A symbol's port with no line on it, and a tee's dot: both
 * are small, and let go on is let go on deliberately -- two tees on runs one
 * grid step apart are twenty pixels apart, closer than any pull counts, and
 * could not be joined. A port with a line on it is teed, and a line a short
 * pull only brushes; those are still a change of mind. (Either on the drag's
 * own symbol or tee is refused as its own by the rules that follow.)
 */
function aimedAtUnder(under: Under, cx: Cx): boolean {
  const h = under.handle;
  const n = h ? cx.byId.get(h.nodeId) : undefined;
  if (h && n && !isJunction(n)) return !lineOn(cx, n.id, h.handleId) && !!cx.scene.endOf(n, h.handleId);
  const t = under.node ? cx.byId.get(under.node) : undefined;
  return !!t && isJunction(t);
}

/**
 * What letting go of `source` at `at` means, with `under` what is under the
 * pointer there. Pure: it reads the drawing and changes nothing. See the
 * rules at the top of this file.
 */
export function resolveDrop(source: DropSource, at: Pt, under: Under, scene: DropScene): DropPlan {
  const cx = contextOf(scene);
  const o = originOf(source, cx);
  if (!o) return { kind: 'cancel', why: 'nothing' };
  // a. Too short to be anything but a change of mind -- unless it was let go
  // right on a free port or a tee, which is aimed at, not missed by: a
  // manifold's next outlet is 26 px along, a tank's next lid port 20, and
  // carrying an end there is the commonest carry there is.
  if (dist(o.pointer, at) < minPull(cx.zoom) && !aimedAtUnder(under, cx)) return { kind: 'cancel', why: 'short' };
  let target = targetOf(o, o.point, at, under, cx);
  if (target.kind === 'cancel') return target;
  let from = originEnd(o, target.end, cx);
  if (!from) return { kind: 'cancel', why: 'full' };
  // Where the line starts can move once the target is known -- a new tee put
  // level with it, or beside a face that is taken. What the target is was
  // judged from the old place, so it is judged once more from the new one.
  if (dist(from.centre, o.point) > AXIS_EPS) {
    const again = targetOf(o, from.centre, at, under, cx);
    const next = again.kind === 'target' ? originEnd(o, again.end, cx) : null;
    if (again.kind === 'target' && next) { target = again; from = next; }
  }
  // Carrying an end somewhere with nothing to join is not a place to leave it.
  if (o.kind === 'fixed' && target.landed === 'open') return { kind: 'cancel', why: 'nothing' };
  return {
    kind: 'connect', landed: target.landed, from, to: target.end,
    ...(o.kind === 'fixed' ? { reconnect: o.reconnect } : {}),
  };
}

// ── Making it ────────────────────────────────────────────────────────────────

/**
 * `after`, with every place a drop wrote in it to a thousandth of a pixel
 * (`measuredAt`): the position of each node it made or changed, the ends a
 * tee's pipe was put down between, and each line's corners.
 *
 * A drop reads the lines as the page draws them, and the page draws them
 * from React Flow's handles as it measured them: read off the screen and
 * divided by the zoom, a hundred-thousandth of a pixel out at any zoom but
 * one, and at one under a pan a fit left fractional. The canvas's own port
 * lookups are rid of that (`handleEnd`); a tee put on a drawn line, the ends
 * its pipe was put down between and the corners of the two halves it cut
 * were not, and the noise was saved -- and a stored shape no longer fitted
 * the ports once they were measured again at another zoom. What was in the
 * drawing already, and not touched by the drop, is left exactly as it was.
 */
function placedClean(before: { nodes: Node[]; edges: Edge[] }, after: { nodes: Node[]; edges: Edge[] }): { nodes: Node[]; edges: Edge[] } {
  const had = new Set<object>([...before.nodes, ...before.edges]);
  const same = (p: Pt, q: Pt) => p.x === q.x && p.y === q.y;
  const node = (n: Node): Node => {
    if (had.has(n)) return n;
    const position = measuredAt(n.position);
    const along = isJunction(n) ? junctionData(n).along : undefined;
    const ends = along?.ends ? { a: measuredAt(along.ends.a), b: measuredAt(along.ends.b) } : null;
    const endsMoved = !!ends && (!same(ends.a, along!.ends!.a) || !same(ends.b, along!.ends!.b));
    if (same(position, n.position) && !endsMoved) return n;
    return { ...n, position, ...(endsMoved ? { data: { ...n.data, along: { ...along!, ends: ends! } } } : {}) };
  };
  const line = (e: Edge): Edge => {
    if (had.has(e)) return e;
    const corners = (e.data as { waypoints?: unknown } | undefined)?.waypoints;
    if (!Array.isArray(corners) || (corners as Pt[]).every(p => same(measuredAt(p), p))) return e;
    return { ...e, data: { ...e.data, waypoints: (corners as Pt[]).map(measuredAt) } };
  };
  return { nodes: after.nodes.map(node), edges: after.edges.map(line) };
}

/** Is a symbol's port on this drawing already carrying a line (other than `except`)? */
function portTaken(nodes: Node[], edges: Edge[], nodeId: string, handle: string, except?: string): boolean {
  const n = nodes.find(x => x.id === nodeId);
  if (!n || isJunction(n)) return false;
  return edges.some(e => e.id !== except
    && ((e.source === nodeId && e.sourceHandle === handle) || (e.target === nodeId && e.targetHandle === handle)));
}

/** A line's routing, without the corners it was drawn with at its old ends. */
function unrouted(data: Edge['data']): Record<string, unknown> {
  const rest = { ...((data ?? {}) as Record<string, unknown>) };
  delete rest.waypoints;
  delete rest.viaRun;
  delete rest.offset;
  return rest;
}

/**
 * The line an open end is the end of: the one line on a junction that has
 * that line and no other. Null for a symbol, and for a junction with no line
 * or with more than one.
 */
function lineOfOpenEnd(nodes: Node[], edges: Edge[], id: string): Edge | null {
  const n = nodes.find(x => x.id === id);
  if (!n || !isJunction(n)) return null;
  let only: Edge | null = null;
  for (const e of edges) {
    if (e.source !== id && e.target !== id) continue;
    if (only || e.source === e.target) return null;
    only = e;
  }
  return only;
}

/**
 * Does a line coming from `prev` through `via` turn there to reach `next`?
 * Not when the three are in one straight line and it goes on the way it came.
 */
function turnsAt(prev: Pt, via: Pt, next: Pt): boolean {
  const onward = (u: number, v: number, w: number) => Math.sign(v - u) === Math.sign(w - v) && Math.abs(w - v) > AXIS_EPS;
  if (Math.abs(prev.y - via.y) < AXIS_EPS && Math.abs(next.y - via.y) < AXIS_EPS) return !onward(prev.x, via.x, next.x);
  if (Math.abs(prev.x - via.x) < AXIS_EPS && Math.abs(next.x - via.x) < AXIS_EPS) return !onward(prev.y, via.y, next.y);
  return true;
}

/**
 * `line`, the one line on the open end `open` (centred at `via`), carried on
 * from there to `to`: the same line, its id and everything typed into it
 * kept, with the end that was at the open end now at `to`.
 *
 * The router's corners were drawn to where the open end was, and go; the
 * line routes itself to where it ends now, as a carried end does. A person's
 * corners stay theirs, and where the line turns at the open end to go on,
 * the open end's centre is one more of them: the line went there by hand and
 * on from there by the pull, so that is where it bends. Left out, the corner
 * before it was pulled across onto the new end's axis, and a hand route
 * folded back over itself to get there.
 */
function carriedOn(line: Edge, open: string, via: Pt, to: { id: string; handle: string; centre: Pt }): Edge {
  const atSource = line.source === open;
  const data = (line.data ?? {}) as Record<string, unknown>;
  const own = Array.isArray(data.waypoints) ? (data.waypoints as Pt[]) : [];
  let kept: Record<string, unknown>;
  if (own.length && !data.viaRun) {
    // Read toward the open end, whichever end of the line it is at: the
    // last corner is the one before it.
    const corners = atSource ? [...own].reverse() : [...own];
    const last = corners[corners.length - 1];
    const there = Math.abs(last.x - via.x) < AXIS_EPS && Math.abs(last.y - via.y) < AXIS_EPS;
    if (!there && turnsAt(last, via, to.centre)) corners.push({ x: via.x, y: via.y });
    kept = { ...data, waypoints: atSource ? corners.reverse() : corners };
  } else {
    kept = unrouted(data);
  }
  return atSource
    ? { ...line, source: to.id, sourceHandle: to.handle, data: kept }
    : { ...line, target: to.id, targetHandle: to.handle, data: kept };
}

/**
 * Make a plan: the tees it splits into lines (the target first, then the
 * line pulled from), the open end it leaves, and the new line -- or, for a
 * carried end, the line re-pointed. The drawing back, and the id of the line
 * drawn or carried; null for a cancel, or for a plan the drawing no longer
 * allows.
 *
 * An open end is the end of a line not finished yet, and a line drawn on out
 * of one, or let go on one, is that line going on -- straight on or round a
 * corner -- not a branch off it. So the line the open end ends is carried on
 * to where the new line would have gone, and the open end goes
 * (`carriedOn`). Put in as a line of its own, the new line left a junction
 * with two lines and nothing branching from it: drawn as a filled dot, which
 * says the pipe branches there, and to feed-twin a node in series nobody
 * asked for. Two open ends joined are two lines made one, when they agree
 * about what kind of pipe they are (`healThrough`); a half inch line joined
 * to a quarter inch one keeps the junction between them, as a reducer.
 *
 * A free junction with lines of its own that the new line gives a straight
 * continuation -- a tee somebody put down -- rides it from then on
 * (`adoptTee`), exactly as a tee split into a line does.
 *
 * Every place it writes is to a thousandth of a pixel (`placedClean`), as
 * every port the canvas reads is: a drop is worked out on the lines as the
 * page draws them, which carry React Flow's measuring noise.
 */
export function commitDrop(plan: DropPlan, scene: DropScene): { nodes: Node[]; edges: Edge[]; lineId: string } | null {
  const made = connected(plan, scene);
  return made && { ...placedClean(scene, made), lineId: made.lineId };
}

/** What `commitDrop` makes, as worked out: off the lines as drawn, noise and all. */
function connected(plan: DropPlan, scene: DropScene): { nodes: Node[]; edges: Edge[]; lineId: string } | null {
  if (plan.kind !== 'connect') return null;
  const cx = contextOf(scene);
  let nodes = scene.nodes, edges = scene.edges;
  // The drawing as the plan was made on, crowd and all: the second split
  // keeps clear of what the first found, not of the tee the first put in.
  const geometry = { endOf: scene.endOf, obstacles: cx.sheet, crowd: cx.crowd() };
  // An open end goes on the page the line is drawn from.
  const origin = plan.from.kind === 'split' ? cx.edgeById.get(plan.from.edgeId)?.source
    : plan.from.kind === 'open' ? undefined : plan.from.nodeId;
  const page = scene.page ?? pageOfNode(origin ? cx.byId.get(origin) : undefined);

  const made = (end: PlanEnd, other: Pt, page: string): { id: string; handle: string; centre: Pt } | null => {
    switch (end.kind) {
      case 'port': return { id: end.nodeId, handle: end.handle, centre: end.centre };
      case 'tee': return { id: end.nodeId, handle: end.face, centre: end.centre };
      case 'split': {
        const split = splitEdgeAt(nodes, edges, end.edgeId, end.at, undefined, { points: end.points, toward: other, ...geometry });
        if (!split) return null;
        nodes = split.nodes;
        edges = split.edges;
        const tee = nodes.find(n => n.id === split.junctionId)!;
        const c = centreOfJunction(tee);
        const along = junctionData(tee).along;
        return { id: tee.id, handle: along ? branchFace(runDirOf(along), other, c) : end.face, centre: c };
      }
      case 'open': {
        const id = nextJunctionId();
        nodes = [...nodes, {
          id, type: 'JUNCTION',
          position: { x: end.centre.x - J_HALF, y: end.centre.y - J_HALF },
          data: { componentType: 'JUNCTION', label: id, page } as unknown as Record<string, unknown>,
        }];
        return { id, handle: end.face, centre: end.centre };
      }
    }
  };
  const settleOpenEnd = (id: string) => {
    const n = nodes.find(x => x.id === id);
    if (n && isJunction(n) && !junctionData(n).along) ({ nodes, edges } = adoptTee(nodes, edges, id, scene.endOf));
  };
  // The open end `id`, now with two lines on it, taken out and its two lines
  // made one; or, when they do not agree about what kind of pipe they are,
  // left as the junction between them. The id of the line through it.
  const joinAt = (id: string, through: string): string => {
    const healed = healThrough(nodes, edges, id, { old: e => cx.points(e) ?? undefined });
    if (!healed) { settleOpenEnd(id); return through; }
    ({ nodes, edges } = healed);
    return healed.lineId;
  };
  // A plan's end that is an open end: which, the one line on it, and its centre.
  const openAt = (end: PlanEnd) => {
    if (end.kind !== 'tee') return null;
    const line = lineOfOpenEnd(nodes, edges, end.nodeId);
    return line ? { id: end.nodeId, line, via: centreOfJunction(cx.byId.get(end.nodeId)!) } : null;
  };

  // Asked before anything is made: the ends as the plan found them. The end
  // a carried line stays at is not where anything is drawn from.
  const toOpen = openAt(plan.to);
  const fromOpen = plan.reconnect ? null : openAt(plan.from);
  const to = made(plan.to, plan.from.centre, page);
  if (!to) return null;

  if (plan.reconnect) {
    const e = edges.find(x => x.id === plan.reconnect!.edgeId);
    if (!e) return null;
    const moving = plan.reconnect.moving;
    if (to.id === (moving === 'target' ? e.source : e.target)) return null;
    if (portTaken(nodes, edges, to.id, to.handle, e.id)) return null;
    // The same line, carried: its id, its data (bore, length, fittings, its
    // sketch) kept, and only the corners it was drawn with dropped -- they
    // were drawn to where the end was.
    const moved: Edge = moving === 'target'
      ? { ...e, target: to.id, targetHandle: to.handle, data: unrouted(e.data) }
      : { ...e, source: to.id, sourceHandle: to.handle, data: unrouted(e.data) };
    edges = edges.map(x => (x.id === e.id ? moved : x));
    // Carried onto an open end, it and the line the open end ends are one.
    if (toOpen && toOpen.line.id !== e.id) {
      const lineId = joinAt(to.id, e.id);
      return { nodes, edges, lineId };
    }
    settleOpenEnd(to.id);
    return { nodes, edges, lineId: e.id };
  }

  const from = made(plan.from, to.centre, page);
  if (!from || from.id === to.id) return null;
  if (portTaken(nodes, edges, from.id, from.handle) || portTaken(nodes, edges, to.id, to.handle)) return null;

  // Out of an open end: its line carried on to where the drop landed. Onto
  // one, from anywhere else: that open end's line carried back to where the
  // drop began. Never onto the far end of the line carried, which would be
  // a line from a thing to itself.
  const carry = fromOpen ? { open: fromOpen, onto: to } : toOpen ? { open: toOpen, onto: from } : null;
  if (carry) {
    const { open, onto } = carry;
    const line = edges.find(e => e.id === open.line.id);
    if (!line) return null;
    const farOf = (e: Edge, end: string) => (e.source === end ? e.target : e.source);
    const far = farOf(line, open.id);
    // Nor, joining two open ends, two lines out of one symbol: one line
    // round from a symbol to itself, with the junction left in it.
    if (far === onto.id || (fromOpen && toOpen && far === farOf(toOpen.line, toOpen.id))) return null;
    edges = edges.map(e => (e === line ? carriedOn(line, open.id, open.via, onto) : e));
    nodes = nodes.filter(n => n.id !== open.id);
    // Out of one open end onto another: the two lines are one.
    if (fromOpen && toOpen) {
      const lineId = joinAt(to.id, open.line.id);
      return { nodes, edges, lineId };
    }
    settleOpenEnd(onto.id);
    return { nodes, edges, lineId: open.line.id };
  }

  const lineId = freshEdgeId(`${from.id}-${to.id}`, new Set(edges.map(e => e.id)));
  edges = [...edges, {
    id: lineId, source: from.id, sourceHandle: from.handle, target: to.id, targetHandle: to.handle,
    type: 'smoothstep', data: {},
  }];
  settleOpenEnd(from.id);
  settleOpenEnd(to.id);
  return { nodes, edges, lineId };
}

// ── A part from the palette, let go on a line ────────────────────────────────

/**
 * A part from the palette let go over a line, as the line is drawn
 * (`lineAt`): the drawing with the part in the line, or null when it is not
 * a part that goes on a line, was let go clear of every line, or the line
 * has no room for it -- and the part is dropped loose where it was let go.
 *
 * A valve, a regulator or a disconnect goes *into* the run: the run breaks
 * round it and the part is turned to face the way the run goes
 * (`insertInline`). A transducer or a gauge taps it -- one port, so landing
 * on a pipe can only mean "tap here": a tee in the line, and the instrument
 * stood off the pipe on the side the pointer was, on the tee's third face
 * (`tapLine`). Either way the cut is on the grid along the line
 * (`gridAlong`), not where the pointer happened to be: read off the screen at
 * any zoom but one that is a fraction of a pixel, and a part or a tee put
 * there was off the grid the symbols round it are on.
 */
export function partOnLine(
  graph: { nodes: Node[]; edges: Edge[] }, lines: DrawnLine[], at: Pt, part: Node,
  geometry: { endOf: EndLookup; obstacles?: Obstacles; page?: string },
): { nodes: Node[]; edges: Edge[] } | null {
  const type = (part.data as { componentType?: string } | undefined)?.componentType ?? part.type;
  if (!isInline(type) && !isTapped(type)) return null;
  const hit = lineAt(lines, at);
  if (!hit) return null;
  const cut = gridAlong(hit.points, hit.at);
  // Across the line, the cut is where the line is drawn -- React Flow's
  // measuring noise included -- so what is put in is placed clean, as a drop
  // is (`placedClean`).
  const made = isInline(type)
    ? insertInline(graph.nodes, graph.edges, hit.id, cut, part, { points: hit.points })
    : tapLine(graph.nodes, graph.edges, hit.id, cut, at, part,
      { points: hit.points, endOf: geometry.endOf, obstacles: geometry.obstacles }, geometry.page);
  return made && placedClean(graph, made);
}

// ── For the designer ─────────────────────────────────────────────────────────

/** The lines as the page draws them (`lineHit.drawnLines`), as corners without their hops. */
export function drawnPoints(lines: readonly DrawnLine[]): DrawnPoints[] {
  return lines.map(l => ({ id: l.id, points: simplifyPoints(pathPoints(l.d)) }));
}

/** The drawn line nearest `at`, within `LINE_REACH` on screen at this zoom. */
export function lineUnder(lines: readonly DrawnPoints[], at: Pt, zoom = 1): LineUnder | null {
  let best: LineUnder | null = null;
  let bestDist = onScreen(LINE_REACH, LINE_REACH_FLOW, zoom);
  for (const line of lines) {
    const near = nearestOnPolyline(line.points, at);
    if (near && near.dist < bestDist) {
      bestDist = near.dist;
      best = { id: line.id, at: near.point, points: line.points };
    }
  }
  return best;
}

/** Where a mouse or touch event happened, on screen. */
export function clientOf(event: MouseEvent | TouchEvent | { clientX: number; clientY: number }): Pt {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY };
  const t = event.changedTouches[0];
  return { x: t?.clientX ?? 0, y: t?.clientY ?? 0 };
}

/**
 * Which end of `edge` a reconnect is carrying. React Flow starts a reconnect
 * as a drag out of the end that stays (`from`); without that, `fixed` is the
 * handle type React Flow reports for it.
 */
export function reconnectMoving(edge: Edge, fixed: HandleType, from?: { nodeId: string; handle: string | null } | null): 'source' | 'target' {
  if (from) {
    const atSource = edge.source === from.nodeId && (edge.sourceHandle ?? null) === (from.handle ?? null);
    const atTarget = edge.target === from.nodeId && (edge.targetHandle ?? null) === (from.handle ?? null);
    if (atSource !== atTarget) return atSource ? 'target' : 'source';
  }
  return fixed === 'source' ? 'target' : 'source';
}

/** The line `edgeId` re-pointed to the ends of `connection`: its id and data kept, its corners dropped. */
export function reconnectLine(edges: Edge[], edgeId: string, connection: Connection): Edge[] {
  return edges.map(e => (e.id !== edgeId ? e : {
    ...e,
    source: connection.source, sourceHandle: connection.sourceHandle,
    target: connection.target, targetHandle: connection.targetHandle,
    data: unrouted(e.data),
  }));
}

/** Lines as the page last handed them out, with the ends each may be carried by. */
const withEnds = new WeakMap<Edge, Edge>();

/**
 * The lines as React Flow gets them, with only their ends at a symbol's port
 * offered for carrying elsewhere. A tee's end is where its pipe runs through
 * it or its branch leaves it; carrying that end would pull the line off the
 * tee and leave the tee where it was. A line with both ends on symbols has
 * no mark (`edgesReconnectable` covers it) -- and loses one it has somehow
 * brought with it, which would otherwise hold one of its ends fast for good.
 * Each line keeps its object from one call to the next while nothing about
 * it changes, so React Flow redraws none that did not.
 *
 * The mark belongs to the view. React Flow hands its own objects back -- to
 * `onDelete`, and to `onEdgesChange` for a line changed through
 * `useReactFlow().setEdges` -- so the canvas takes them into the drawing
 * without it (`plainLine`), and the stored drawing never has it.
 */
export function reconnectableEnds(nodes: Node[], edges: Edge[]): Edge[] {
  const tees = new Set(nodes.filter(isJunction).map(n => n.id));
  let changed = false;
  const out = edges.map(e => {
    const s = !tees.has(e.source), t = !tees.has(e.target);
    const want: Edge['reconnectable'] = s && t ? undefined : s ? 'source' : t ? 'target' : false;
    if (e.reconnectable === want) return e;
    changed = true;
    const kept = withEnds.get(e);
    if (kept && kept.reconnectable === want) return kept;
    const next = want === undefined ? plainLine(e) : { ...e, reconnectable: want };
    withEnds.set(e, next);
    return next;
  });
  return changed ? out : edges;
}

/**
 * React Flow's changes to the lines, with the view's carry marks taken off
 * what they hand back (`plainLine`): a line React Flow replaces or adds is
 * its own object, the view's, marked.
 */
export function plainChanges(changes: EdgeChange<Edge>[]): EdgeChange<Edge>[] {
  return changes.map(c => ((c.type === 'replace' || c.type === 'add') && 'reconnectable' in c.item ? { ...c, item: plainLine(c.item) } : c));
}

/**
 * The ports React Flow may join by itself: two free ports of two different
 * symbols, and nothing else.
 *
 * A symbol joined to itself is a loop with nothing in it. A second line on
 * a port that has one is drawn on top of the first and reads as a tee that
 * is not there. And a tee's faces are where its pipe and its branches meet
 * it, which the tee decides (`pointLines`), not whichever face a drop came
 * nearest. React Flow hands a refused drop to the designer's `onConnectEnd`,
 * which tees the port's line, or the tee's run, instead (`resolveDrop`). A
 * carried end is always refused here, since the end that stays has the
 * carried line on it: where it goes is the resolver's too.
 *
 * Asked on every pointer move of a drag, so it reads nothing but the
 * drawing as last rendered.
 */
export function canJoin(c: Connection | Edge, nodes: Node[], edges: Edge[]): boolean {
  if (c.source === c.target) return false;
  const free = (id: string, handle: string | null | undefined) => {
    const n = nodes.find(x => x.id === id);
    if (!n || isJunction(n)) return false;
    return !edges.some(e => (e.source === id && e.sourceHandle === handle) || (e.target === id && e.targetHandle === handle));
  };
  return free(c.source, c.sourceHandle) && free(c.target, c.targetHandle);
}

/**
 * The line React Flow's own join makes (`canJoin`), added to `edges`: no
 * fluid and no colour, both inherited from whatever ends up feeding it, and
 * named as every other line is (`freshEdgeId`). React Flow's own name for a
 * line is made of the two ports and never checked, and a carried line keeps
 * its name wherever its ends go, so once both ends of a line had been
 * carried off, joining its first two ports again named a second line the
 * same, which feed-twin refuses and React Flow draws as one.
 */
export function connectLine(edges: Edge[], c: Connection): Edge[] {
  const id = freshEdgeId(`${c.source}-${c.target}`, new Set(edges.map(e => e.id)));
  return addEdge({ ...c, id, type: 'smoothstep', data: {} }, edges);
}

/** A line without the view's `reconnectable` mark: itself when it has none. */
export function plainLine<E extends Edge>(e: E): E {
  if (!('reconnectable' in e)) return e;
  const { reconnectable: _mark, ...rest } = e;
  return rest as E;
}
