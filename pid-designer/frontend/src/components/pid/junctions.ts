import type { Edge, Node, XYPosition } from '@xyflow/react';
import { Position } from '@xyflow/react';
import {
  faceTowards, nearestOnPolyline, pathPoints, pointAt, polylineLength, routeOrthogonal, routeThrough,
} from './route';
import type { End, Pt } from './route';
import type { PIDNodeData } from './types';
import { nodeSize } from './attach';

/**
 * A tee is a point in a run, and it stays one.
 *
 * A junction used to be a node with a position like any other, and that was
 * the whole of what made it feel broken: move the tank at one end of a run
 * and its tees stayed behind on the canvas, so the two halves of the line
 * re-routed around a point that was no longer on it and the run grew a kink
 * it never had. A tee dragged by hand could be put anywhere at all, off the
 * pipe included.
 *
 * So a junction now rides the run between the two things its run connects
 * -- whatever is on the far end of each of its two run lines, found from the
 * drawing every time rather than remembered -- and it sits a fixed fraction
 * of the way along that run. Move either end and it is put back at the same
 * fraction; drag it and it slides, because along the run is the only place
 * it can be; put a valve into one of its halves and its run simply got
 * shorter. Its lines are re-pointed at the right faces each time, chosen
 * from where the run actually goes at that point rather than from which of
 * four handles a drag happened to land on, and each half is handed the run's
 * own corners on its side of the tee so the two halves draw the run.
 */

export type Face = 't' | 'b' | 'l' | 'r';

export interface Along {
  /** How far along the run, as a fraction of its length. */
  t: number;
  /** The faces the run enters and leaves by. Anything else on the tee is a branch. */
  in: Face;
  out: Face;
  /**
   * What was on each end of the run when the fraction was last taken. Kept
   * only to notice a change: when a part goes into one half the run is a
   * different run, and the tee keeps its place on the drawing rather than
   * its fraction of a run that no longer exists.
   */
  from?: string;
  to?: string;
  /**
   * Where the run's two ports were when the fraction was last taken. If they
   * have not moved, the run has only been re-routed, and the tee keeps its
   * place on the drawing; if one has, the run itself moved, and the tee
   * keeps its fraction of it.
   */
  ends?: { a: Pt; b: Pt };
}

/** Half the junction dot: its position is its top-left, its centre is +5. */
export const J_HALF = 5;

export const junctionData = (n: Node) => n.data as unknown as PIDNodeData & { along?: Along };

export const isJunction = (n: Node | undefined) =>
  !!n && (n.data as unknown as PIDNodeData)?.componentType === 'JUNCTION';

export const faceOfDir = (d: Pt): Face =>
  Math.abs(d.x) >= Math.abs(d.y) ? (d.x >= 0 ? 'r' : 'l') : (d.y >= 0 ? 'b' : 't');

/** The faces a run enters and leaves a tee by, from the way it runs there. */
export const runFaces = (dir: Pt): { in: Face; out: Face } =>
  ({ in: faceOfDir({ x: -dir.x, y: -dir.y }), out: faceOfDir(dir) });

/**
 * The face a branch enters a tee by: across the run, on the side the branch
 * comes from. Never one of the run's own two faces -- a branch that landed on
 * one of those drew itself along the run and on top of it.
 */
export function branchFace(runDir: Pt, from: Pt, at: Pt): Face {
  if (Math.abs(runDir.x) >= Math.abs(runDir.y)) return from.y < at.y ? 't' : 'b';
  return from.x < at.x ? 'l' : 'r';
}

/** The way the run goes into a tee, from the face it enters by. */
export const runDirOf = (along: Along): Pt =>
  ({ l: { x: 1, y: 0 }, r: { x: -1, y: 0 }, t: { x: 0, y: 1 }, b: { x: 0, y: -1 } } as Record<Face, Pt>)[along.in];

const SIDE_OF: Record<Face, Position> = {
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

/**
 * A fallback for a port nothing has measured: the node's centre, facing the
 * point it is being joined to. Right for symmetric symbols and near enough
 * for the rest until the real bounds arrive a render later.
 */
export function endTowards(node: Node, towards: Pt): End {
  const { w, h } = nodeSize(node);
  const c = { x: node.position.x + w / 2, y: node.position.y + h / 2 };
  const f = faceTowards(towards.x, towards.y, c.x, c.y) as Face;
  const edge: Record<Face, Pt> = { t: { x: c.x, y: node.position.y }, b: { x: c.x, y: node.position.y + h }, l: { x: node.position.x, y: c.y }, r: { x: node.position.x + w, y: c.y } };
  return { ...edge[f], side: SIDE_OF[f] };
}

/** How an edge touches a node, if it does. */
export function endAt(e: Edge, nodeId: string): { end: 'source' | 'target'; handle: string | null | undefined } | null {
  if (e.source === nodeId) return { end: 'source', handle: e.sourceHandle };
  if (e.target === nodeId) return { end: 'target', handle: e.targetHandle };
  return null;
}

/** Corners a person put on a line. Corners the run put there do not count. */
const handCorners = (e: Edge): Pt[] => {
  const d = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
  return d.viaRun ? [] : (d.waypoints ?? []);
};

/** The run a tee rides: its two run lines, what is on their far ends, and the run drawn without the tee. */
export interface Run {
  inEdge: Edge;
  outEdge: Edge;
  from: Node;
  fromHandle: string | null | undefined;
  to: Node;
  toHandle: string | null | undefined;
  a: End;
  b: End;
  path: Pt[];
  /**
   * One of the two ports could not be looked up, so `a` or `b` is a guess.
   *
   * A tee is never seated on a guess. The guess (`endTowards`) picks the
   * face of the symbol nearest the tee, so it depends on where the tee is
   * -- and a seat that moves the tee then changes the guess, which moves the
   * seat, which is a loop that took the whole page down before React Flow
   * had measured a single handle. The guess is fine for drawing a tee's
   * lines; it is not fine for deciding where the tee goes.
   */
  unmeasured: boolean;
}

export function runOf(
  junction: Node, along: Along, edges: Edge[], nodesById: Map<string, Node>, endOf: EndLookup,
): Run | null {
  let inEdge: Edge | undefined;
  let outEdge: Edge | undefined;
  for (const e of edges) {
    const at = endAt(e, junction.id);
    if (!at) continue;
    if (at.handle === along.in && !inEdge) inEdge = e;
    else if (at.handle === along.out && !outEdge) outEdge = e;
  }
  if (!inEdge || !outEdge) return null;
  const farEnd = (e: Edge) => (e.source === junction.id
    ? { id: e.target, handle: e.targetHandle }
    : { id: e.source, handle: e.sourceHandle });
  const f = farEnd(inEdge), t = farEnd(outEdge);
  const from = nodesById.get(f.id), to = nodesById.get(t.id);
  if (!from || !to) return null;
  const c = centreOfJunction(junction);
  const ma = endOf(from, f.handle);
  const mb = endOf(to, t.handle);
  const a = ma ?? endTowards(from, c);
  const b = mb ?? endTowards(to, c);
  const corners = [...handCorners(inEdge), ...handCorners(outEdge)];
  const offset = ((inEdge.data ?? {}) as { offset?: number }).offset ?? ((outEdge.data ?? {}) as { offset?: number }).offset ?? 0;
  const route = corners.length ? routeThrough(a, b, corners) : routeOrthogonal(a, b, offset);
  return {
    inEdge, outEdge, from, fromHandle: f.handle, to, toHandle: t.handle, a, b,
    path: pathPoints(route.d), unmeasured: !ma || !mb,
  };
}

function withHandle(e: Edge, end: 'source' | 'target', handle: Face): Edge {
  if (end === 'source') return e.sourceHandle === handle ? e : { ...e, sourceHandle: handle };
  return e.targetHandle === handle ? e : { ...e, targetHandle: handle };
}

const sameCorners = (a: Pt[] | undefined, b: Pt[]) =>
  !!a && a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6);

/**
 * Give a half of a run the run's own corners on its side of the tee.
 *
 * A half that routes itself from the tee cannot always reproduce the run: a
 * tee seated near a corner leaves its downstream half twenty pixels to make
 * a Z in, and the router, quite rightly, sends it round the houses instead.
 * So the halves are told the corners, and told again every time the tee is
 * re-seated. `viaRun` marks corners that came from here, so a half somebody
 * has since routed by hand -- which drops the mark -- is left alone, and is
 * what the run is then drawn through.
 */
function withRunCorners(e: Edge, corners: Pt[]): Edge {
  const data = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
  if (data.waypoints?.length && !data.viaRun) return e;
  if (corners.length === 0) {
    if (!data.waypoints && !data.viaRun) return e;
    const rest = { ...data } as Record<string, unknown>;
    delete rest.waypoints;
    delete rest.viaRun;
    return { ...e, data: rest };
  }
  if (sameCorners(data.waypoints, corners) && data.viaRun) return e;
  return { ...e, data: { ...data, waypoints: corners, viaRun: true, offset: 0 } };
}

/**
 * Point every line on a tee at the right face for where the run goes there,
 * and hand its two halves the run's corners.
 *
 * The run's two lines take the faces the run enters and leaves by; each
 * branch takes the face across the run on its own side. Which lines are the
 * run is read off the faces the tee recorded last time, so this is stable
 * under repeated calls.
 */
export function repointJunction(
  edges: Edge[], junction: Node, along: Along, dir: Pt, nodesById: Map<string, Node>,
  corners?: { upstream: Pt[]; downstream: Pt[] },
): { edges: Edge[]; along: Along } {
  const faces = runFaces(dir);
  const centre = centreOfJunction(junction);
  let changed = false;
  let runIn = false, runOut = false;
  const out = edges.map(e => {
    const at = endAt(e, junction.id);
    if (!at) return e;
    let face: Face;
    if (at.handle === along.in && !runIn) {
      runIn = true;
      face = faces.in;
      if (corners) { const c = withRunCorners(e, corners.upstream); if (c !== e) { changed = true; e = c; } }
    } else if (at.handle === along.out && !runOut) {
      runOut = true;
      face = faces.out;
      if (corners) { const c = withRunCorners(e, corners.downstream); if (c !== e) { changed = true; e = c; } }
    } else {
      // A branch. It only has to be off the run's two faces here; which of
      // the other two it takes is `pointLines`' decision, made from the
      // route each would produce rather than from where a centre is.
      const cur = at.handle as Face | null | undefined;
      const across = ACROSS[faces.in];
      face = cur && across.includes(cur) ? cur : across[0];
      void nodesById; void centre;
    }
    const next = withHandle(e, at.end, face);
    if (next !== e) changed = true;
    return next;
  });
  return { edges: changed ? out : edges, along: { ...along, in: faces.in, out: faces.out } };
}

/** The two faces across a run, given the face it enters by. */
const ACROSS: Record<Face, Face[]> = { l: ['t', 'b'], r: ['t', 'b'], t: ['l', 'r'], b: ['l', 'r'] };

/**
 * The faces a line may take at a tee: the two across its run, or all four
 * of an open end. Null for anything that is not a tee -- a symbol's port is
 * drawn where it is drawn, and is not a choice.
 */
function candidateFaces(n: Node | undefined): Face[] | null {
  if (!n || !isJunction(n)) return null;
  const along = junctionData(n).along;
  return along ? ACROSS[along.in] : ['t', 'b', 'l', 'r'];
}

/** The cost of drawing a line: its length, and a little for every corner. */
function cost(a: End, b: End, corners: Pt[]): number {
  const route = corners.length ? routeThrough(a, b, corners) : routeOrthogonal(a, b);
  const pts = pathPoints(route.d);
  return polylineLength(pts) + 12 * Math.max(0, pts.length - 2);
}

/**
 * Point every line that touches a tee at the faces that draw it best.
 *
 * This is what stops the knots. A branch's face used to be picked by
 * which side of the tee the other end's centre was on -- and for two tees
 * on runs at nearly the same height that put `t` on one and `b` on the
 * other, which the router can only join with a five-segment S over one
 * run and under the other. Both `t` is a three-segment hook. So the
 * faces of a line are chosen together, by trying each combination and
 * keeping the shortest route with the fewest corners. The current faces
 * win a tie, so nothing flips between two equal answers.
 *
 * Run lines are not touched: they are the run's, and `repointJunction`
 * has already set them.
 */
export function pointLines(edges: Edge[], nodesById: Map<string, Node>, endOf: EndLookup): Edge[] {
  let changed = false;
  const out = edges.map(e => {
    const s = nodesById.get(e.source), t = nodesById.get(e.target);
    const sc = candidateFaces(s), tc = candidateFaces(t);
    if (!sc && !tc) return e;
    // A run line: the tee's in or out face. Not a choice.
    const isRun = (n: Node | undefined, handle: string | null | undefined) => {
      const along = n && isJunction(n) ? junctionData(n).along : undefined;
      return !!along && (handle === along.in || handle === along.out);
    };
    if (isRun(s, e.sourceHandle) || isRun(t, e.targetHandle)) return e;

    const endFor = (n: Node | undefined, handle: string | null | undefined): End | null => {
      if (!n) return null;
      if (isJunction(n)) return handle ? junctionEnd(n.position, handle as Face) : null;
      const m = endOf(n, handle);
      if (m) return m;
      return null;   // an unmeasured symbol port: no basis for a choice
    };
    const corners = handCornersOf(e);
    const sOpts = sc ?? [e.sourceHandle as Face];
    const tOpts = tc ?? [e.targetHandle as Face];
    let best: { s: Face; t: Face; c: number } | null = null;
    for (const fs of sOpts) {
      const a = endFor(s, fs);
      if (!a) return e;
      for (const ft of tOpts) {
        const b = endFor(t, ft);
        if (!b) return e;
        let c = cost(a, b, corners);
        if (fs === e.sourceHandle && ft === e.targetHandle) c -= 1e-6;
        if (!best || c < best.c) best = { s: fs, t: ft, c };
      }
    }
    if (!best || (best.s === e.sourceHandle && best.t === e.targetHandle)) return e;
    changed = true;
    return { ...e, sourceHandle: best.s, targetHandle: best.t };
  });
  return changed ? out : edges;
}

const handCornersOf = (e: Edge): Pt[] => {
  const d = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
  return d.viaRun ? [] : (d.waypoints ?? []);
};

/**
 * Where a tee dragged to `p` may actually go: the nearest point of its run,
 * and the fraction that puts it there.
 */
export function slideAlong(
  junction: Node, along: Along, p: XYPosition, edges: Edge[], nodesById: Map<string, Node>, endOf: EndLookup,
): { position: XYPosition; along: Along; dir: Pt } | null {
  const run = runOf(junction, along, edges, nodesById, endOf);
  if (!run || run.unmeasured) return null;
  const near = nearestOnPolyline(run.path, { x: p.x + J_HALF, y: p.y + J_HALF });
  if (!near) return null;
  return {
    position: { x: near.point.x - J_HALF, y: near.point.y - J_HALF },
    along: { ...along, t: near.t, from: run.from.id, to: run.to.id, ends: { a: { x: run.a.x, y: run.a.y }, b: { x: run.b.x, y: run.b.y } } },
    dir: near.dir,
  };
}

const EPS = 1e-3;

/**
 * Put every tee back on its run, and re-point its lines.
 *
 * A tee whose run has changed ends -- a part went into one of its halves --
 * keeps its place on the drawing and takes a fresh fraction of the new run.
 * A tee that has lost a run line stops riding anything and keeps the
 * position it has. Tees along one pipe depend on each other, so this goes
 * round until nothing moves.
 *
 * Returns the same arrays when nothing needed doing, so callers can compare
 * by identity.
 */
export function reseatJunctions(
  nodes: Node[], edges: Edge[], endOf: EndLookup,
): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const riding = nodes.filter(n => isJunction(n) && !!junctionData(n).along).map(n => n.id);
  if (riding.length === 0) {
    // No tee rides a run, but an open end still has a line to point.
    const pointed = nodes.some(isJunction) ? pointLines(edges, byId, endOf) : edges;
    return { nodes, edges: pointed };
  }

  let outNodes = nodes;
  let outEdges = edges;

  const seat = (id: string): boolean => {
    const node = byId.get(id)!;
    const data = junctionData(node);
    const along = data.along!;
    const run = runOf(node, along, outEdges, byId, endOf);
    if (!run) {
      // Stop riding; keep the spot.
      const { along: _dropped, ...rest } = data;
      void _dropped;
      const next = { ...node, data: rest as unknown as Record<string, unknown> };
      byId.set(id, next);
      outNodes = outNodes.map(n => (n.id === id ? next : n));
      return true;
    }
    if (run.unmeasured) return false;   // not on a guess; see `Run.unmeasured`
    // Keep the place, or keep the fraction. A different run -- a part went
    // into one half -- or the same run re-routed with its ends where they
    // were: the tee stays where it is on the drawing and takes a fresh
    // fraction. An end moved: the run itself moved, and the tee goes with
    // it at its fraction.
    let t = along.t;
    const ends = { a: { x: run.a.x, y: run.a.y }, b: { x: run.b.x, y: run.b.y } };
    const centre = centreOfJunction(node);
    const near = nearestOnPolyline(run.path, centre);
    const endsMoved = !along.ends
      || Math.hypot(along.ends.a.x - ends.a.x, along.ends.a.y - ends.a.y) > EPS
      || Math.hypot(along.ends.b.x - ends.b.x, along.ends.b.y - ends.b.y) > EPS;
    const runChanged = along.from !== run.from.id || along.to !== run.to.id;
    // Off its fraction but still on the run: the run was re-routed under it.
    const atFraction = pointAt(run.path, t);
    const offFraction = !atFraction
      || Math.hypot(atFraction.point.x - centre.x, atFraction.point.y - centre.y) > EPS;
    if (near && (runChanged || (!endsMoved && offFraction && near.dist < 1))) t = near.t;
    const at = pointAt(run.path, t);
    if (!at) return false;
    const position = { x: at.point.x - J_HALF, y: at.point.y - J_HALF };
    const moved = Math.abs(position.x - node.position.x) > EPS || Math.abs(position.y - node.position.y) > EPS;
    const seated = moved ? { ...node, position } : node;
    const re = repointJunction(outEdges, seated, along, at.dir, byId, {
      upstream: run.path.slice(1, at.segment + 1),
      downstream: run.path.slice(at.segment + 1, -1),
    });
    const nextAlong: Along = { ...re.along, t, from: run.from.id, to: run.to.id, ends };
    const alongChanged = nextAlong.in !== along.in || nextAlong.out !== along.out
      || nextAlong.t !== along.t || nextAlong.from !== along.from || nextAlong.to !== along.to || endsMoved;
    const next = (moved || alongChanged)
      ? { ...seated, data: { ...(seated.data as Record<string, unknown>), along: nextAlong } }
      : seated;
    if (next !== node) {
      byId.set(id, next);
      outNodes = outNodes.map(n => (n.id === id ? next : n));
    }
    outEdges = re.edges;
    return moved;
  };

  // Tees along one pipe ride each other's runs, so one may move another;
  // the fixed point is reached in a few passes and each is cheap.
  for (let pass = 0; pass < 12; pass++) {
    let anyMoved = false;
    for (const id of riding) if (junctionData(byId.get(id)!).along && seat(id)) anyMoved = true;
    if (!anyMoved) break;
  }
  outEdges = pointLines(outEdges, byId, endOf);

  return { nodes: outNodes, edges: outEdges };
}
