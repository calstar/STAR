import type { Edge, Node, XYPosition } from '@xyflow/react';
import { freshEdgeId, nextJunctionId } from './ids';
import type { PIDNodeData } from './types';
import type { ParamValue } from './params';
import type { FittingRow, LineSegment } from './segments';
import { INLINE, centreOf, nodeSize, remapAttachments } from './attach';
import {
  J_ANCHOR, J_HALF, branchFace, centreOfJunction, faceOfDir, hasLegalSpot, isJunction, junctionData, legalSpot, runDirOf,
  runFaces,
} from './junctions';
import type { Along, Crowd, EndLookup, Face } from './junctions';
import type { Obstacles } from './routeGrid';
import { pipeOf, splitSpot } from './pipes';
import { AXIS_EPS, STUB, arcsOf, pathPoints, pointAtArc, routeOrthogonal, routeThrough, simplifyPoints, sliceByArc } from './route';
import type { End, Pt } from './route';

/**
 * Put something into a line.
 *
 * Two operations, one shape. A tee goes in where a line is branched -- by the
 * Junction tool, by a connection dropped on the line, or by a line dragged
 * out of another line. A part goes in where somebody drops a valve, a
 * regulator or a disconnect on a run: the run breaks around it, upstream
 * half to the inlet and outlet to the downstream half, and the part is
 * turned to face the way the run goes there. Both cut a run into two runs
 * that are the same pipe, and only the *intensive* facts copy to both. See
 * `EXTENSIVE_LINE_PARAMS`.
 *
 * Neither changes the shape of the pipe it cuts. The cut is made on the line
 * as it is drawn, at a spot the thing going in can actually sit (off the
 * bends, clear of the ends -- `legalSpot`), and each half is handed its
 * slice of what was drawn, measured along the line: a person's corners stay
 * a person's, the router's stay the router's.
 */

/**
 * Line quantities that describe how *much* pipe there is, not what kind.
 *
 * This is the whole of why a split is not a copy. Bore, roughness and bend
 * radius are true of both halves of a cut line; three feet and two elbows are
 * true of the pair *together*, and giving both halves a copy would double the
 * run's pressure drop every time somebody dropped a junction on it.
 *
 * So the tally stays with the upstream half and the downstream half starts
 * unstated -- which in this codebase means "not stated", never "zero", so
 * feed-twin defaults it and reports it unchecked rather than believing a zero
 * nobody typed. Re-apportioning it is then a deliberate edit.
 */
export const EXTENSIVE_LINE_PARAMS = ['length', 'K_minor', 'end_fitting_K'] as const;

/** The half of a split line that keeps what there is only one of. */
function intensiveOnly(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  delete out.segments;
  delete out.sketch;
  const params = out.params as Record<string, ParamValue> | undefined;
  if (params) {
    const kept = { ...params };
    for (const k of EXTENSIVE_LINE_PARAMS) delete kept[k];
    out.params = kept;
  }
  return out;
}

/**
 * What a caller knows about where the line is drawn, when it knows it.
 *
 * The edge itself knows its two handle positions and its corners exactly; a
 * caller working from graph data alone only has the node boxes. Both pick
 * the same faces for an ordinary run, so the centres are a fine default --
 * but a line leaving the top of one part and entering the side of another is
 * not ordinary, and a run somebody has routed by hand is not a straight line.
 */
export interface Drawn {
  a?: End;
  b?: End;
  /** The run's corners as drawn, when the caller read them off the screen. */
  points?: Pt[];
  /**
   * Where the gesture that cut the line heads -- the point a pull is let go
   * on. A press on a bend then puts the tee on the leg the pull heads for.
   */
  toward?: Pt;
  /**
   * The drawing's ports as measured, and the symbols automatic routes go
   * round (`obstacleBoxes`, or each page's own). Given them, a tee goes
   * where the reseat will put it on its whole pipe (`splitSpot`), and the
   * hover dot, asked the same, is where it lands.
   */
  endOf?: EndLookup;
  obstacles?: Obstacles;
  /**
   * The other lines as drawn and the tees on the page, which a tee put in
   * keeps clear of where it can (`crowdOf`): not on a crossing, not beside
   * another tee's dot.
   */
  crowd?: Crowd;
}

export interface Split {
  nodes: Node[];
  edges: Edge[];
  junctionId: string;
}

function routeOf(edge: Edge, a: End, b: End): Pt[] {
  const data = (edge.data ?? {}) as { waypoints?: Pt[]; offset?: number };
  const route = data.waypoints?.length
    ? routeThrough(a, b, data.waypoints)
    : routeOrthogonal(a, b, data.offset ?? 0);
  return pathPoints(route.d);
}

/** The line as drawn, source to target. */
function pointsOf(edge: Edge, from: Node, to: Node, drawn?: Drawn): Pt[] {
  const pts = drawn?.points
    ?? (drawn?.a && drawn?.b ? routeOf(edge, drawn.a, drawn.b) : [centreOf(from), centreOf(to)]);
  return simplifyPoints(pts);
}

const isHandLine = (e: Edge) => {
  const d = (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };
  return !!d.waypoints?.length && !d.viaRun;
};

/**
 * Is the line a person's routing? Its own corners are, and so is any line of
 * a pipe a person has routed: a pipe is all the router's or all a person's.
 */
function routedByHand(nodes: Node[], edges: Edge[], edge: Edge): boolean {
  if (isHandLine(edge)) return true;
  const pipe = pipeOf(nodes, edges, edge);
  return !!pipe && pipe.lines.some(id => { const e = edges.find(x => x.id === id); return !!e && isHandLine(e); });
}

/** A half's routing: its slice's corners, a person's or the pipe's. */
const cornersData = (corners: Pt[], byHand: boolean) =>
  (corners.length ? { waypoints: corners, ...(byHand ? {} : { viaRun: true }) } : {});

/** Ids nothing on the drawing has, handed out in turn. */
function idMinter(edges: Edge[]) {
  const taken = new Set(edges.map(e => e.id));
  return (base: string) => { const id = freshEdgeId(base, taken); taken.add(id); return id; };
}

/**
 * The two halves of `edge`, cut around something at arc `s` of `points`
 * that reaches `reach` each way along it: the upstream half from the line's
 * source to the thing's inlet, the downstream from its outlet to the
 * target. Corners are dealt out by distance along the line -- a corner the
 * thing covers belongs to neither half.
 */
function halves(
  edges: Edge[], edge: Edge, points: Pt[], s: number, reach: { anchor: number; clear: number },
  midId: string, inHandle: string, outHandle: string, byHand: boolean,
): { edges: Edge[]; up: { id: string; points: Pt[] }; down: { id: string; points: Pt[] } } {
  const arcs = arcsOf(points);
  const L = arcs[arcs.length - 1];
  const inner = points.slice(1, -1).map((p, i) => ({ p, s: arcs[i + 1] }));
  // A spot is legal with a bend exactly its reach away, so a corner at the
  // edge of the reach is one the half keeps. A tee reaches nothing, and every
  // corner goes to exactly one half, the one up to and including the tee's
  // centre taking a corner under it, as the reseat deals them.
  const upCorners = inner.filter(c => (reach.clear > 0 ? c.s < s - reach.clear + AXIS_EPS : c.s <= s + 1e-9)).map(c => ({ ...c.p }));
  const downCorners = inner.filter(c => (reach.clear > 0 ? c.s > s + reach.clear - AXIS_EPS : c.s > s + 1e-9)).map(c => ({ ...c.p }));
  const carried: Record<string, unknown> = { ...(edge.data ?? {}), offset: 0 };
  delete carried.waypoints;
  delete carried.viaRun;
  const mint = idMinter(edges.filter(e => e.id !== edge.id));
  const upId = mint(`${edge.source}-${midId}`);
  const downId = mint(`${midId}-${edge.target}`);
  const upPts = s - reach.anchor > 0 ? sliceByArc(points, 0, s - reach.anchor) : [points[0]];
  const downPts = s + reach.anchor < L ? sliceByArc(points, s + reach.anchor, L) : [points[points.length - 1]];
  return {
    edges: [
      {
        ...edge, id: upId, target: midId, targetHandle: inHandle,
        data: { ...carried, ...cornersData(upCorners, byHand) },
      },
      {
        ...edge, id: downId, source: midId, sourceHandle: outHandle, target: edge.target, targetHandle: edge.targetHandle,
        data: { ...intensiveOnly(carried), ...cornersData(downCorners, byHand) },
      },
    ],
    up: { id: upId, points: upPts },
    down: { id: downId, points: downPts },
  };
}

/**
 * A new tee's `along`, for the pipe it lands on. A line that is a pipe of
 * its own gives the whole record: its two ends, the fraction along it, and
 * where its ends are. A line inside a longer pipe gives the pipe's two ends
 * and a fraction read off the tees either side; where the pipe's ends are is
 * left for the reseat to put in, since only it routes the whole pipe.
 */
function alongFor(nodes: Node[], edges: Edge[], edge: Edge, points: Pt[], s: number, dir: Pt): Along {
  const faces = runFaces(dir);
  const L = arcsOf(points)[points.length - 1] || 1;
  const f = s / L;
  const pipe = pipeOf(nodes, edges, edge);
  if (!pipe) {
    return {
      t: f, in: faces.in, out: faces.out, from: edge.source, to: edge.target,
      ends: { a: { ...points[0] }, b: { ...points[points.length - 1] } },
    };
  }
  const k = pipe.lines.indexOf(edge.id);
  const forward = pipe.forward[k];
  const n = pipe.tees.length;
  // How far along the pipe (a to b) station i is, as its tee last recorded it.
  const at = (i: number) => {
    if (i === 0) return 0;
    if (i === n + 1) return 1;
    const tee = nodes.find(x => x.id === pipe.tees[i - 1]);
    const a = tee && junctionData(tee).along;
    if (!a) return i / (n + 1);
    return a.from === pipe.b.nodeId && a.to === pipe.a.nodeId ? 1 - a.t : a.t;
  };
  const [src, tgt] = forward ? [at(k), at(k + 1)] : [at(k + 1), at(k)];
  const t = src + f * (tgt - src);
  return forward
    ? { t, in: faces.in, out: faces.out, from: pipe.a.nodeId, to: pipe.b.nodeId }
    : { t: 1 - t, in: faces.in, out: faces.out, from: pipe.b.nodeId, to: pipe.a.nodeId };
}

/**
 * Put a junction into a line.
 *
 * The one operation behind every gesture that branches a line. The tee goes
 * on the line where it is drawn, at the legal spot nearest `at` (see
 * `splitSpot`: never on or beside a bend, never inside a port's stub, never
 * on another tee), turned to the way the run goes there, and told which pipe
 * it rides -- see `pipes.ts`. The two halves draw exactly what the line drew;
 * probes clipped to the line are re-clipped to the half they were on.
 */
export function splitEdgeAt(
  nodes: Node[],
  edges: Edge[],
  edgeId: string,
  at: XYPosition,
  page?: string,
  drawn?: Drawn,
): Split | null {
  const edge = edges.find(e => e.id === edgeId);
  if (!edge) return null;
  const from = nodes.find(n => n.id === edge.source);
  const to = nodes.find(n => n.id === edge.target);
  if (!from || !to) return null;
  const points = pointsOf(edge, from, to, drawn);
  const spot = splitSpot(nodes, edges, edgeId, points, at, drawn?.toward,
    drawn?.endOf ? { endOf: drawn.endOf, obstacles: drawn.obstacles, crowd: drawn.crowd } : undefined);
  if (!spot) return null;

  const junctionId = nextJunctionId();
  const faces = runFaces(spot.dir);
  const along = alongFor(nodes, edges, edge, points, spot.s, spot.dir);
  const byHand = routedByHand(nodes, edges, edge);

  const junction: Node = {
    id: junctionId,
    type: 'JUNCTION',
    position: { x: spot.point.x - J_HALF, y: spot.point.y - J_HALF },
    data: {
      componentType: 'JUNCTION',
      label: junctionId,
      // A junction inherits the page of the line it lands on, so one never
      // appears on a page its own pipe is not drawn on.
      page: page ?? (from.data as unknown as PIDNodeData)?.page,
      along,
    } as unknown as Record<string, unknown>,
  };

  // Corners are dealt out at the tee's centre, as the reseat deals them, so
  // none is lost under a tee a crowded line could only put near a bend.
  const cut = halves(edges, edge, points, spot.s, { anchor: J_ANCHOR, clear: 0 }, junctionId, faces.in, faces.out, byHand);
  return {
    nodes: [...remapAttachments(nodes, edgeId, [cut.up, cut.down], points), junction],
    edges: [...edges.filter(e => e.id !== edgeId), ...cut.edges],
    junctionId,
  };
}

/** The quarter turn that puts a part's inlet on the upstream side of a run. */
export function rotationAlong(dir: Pt): number {
  return { r: 0, b: 90, l: 180, t: 270 }[faceOfDir(dir)];
}

export interface Inserted {
  nodes: Node[];
  edges: Edge[];
  partId: string;
}

/** How far a part put into a line reaches along it: half of it, its handle, and a stub of line to turn in. */
const partReach = (part: Node) => nodeSize(part).w / 2 + 3 + STUB;

/**
 * Put a part into a line.
 *
 * Dropping a valve on a run used to leave the valve sitting on top of the
 * line, unconnected, and the next four gestures were the ones that made it
 * part of the run. Now the run breaks around it: the upstream half runs to
 * the part's inlet, its outlet runs on to the downstream half, and the part
 * is turned so its inlet faces the way the run arrives. Its ports sit on the
 * pipe because the part is centred on the cut and its ports are on its
 * centreline -- which is why this is for the two-port hardware in `INLINE`
 * and nothing else.
 *
 * The part goes where it fits: on one straight leg, with a stub of line to
 * spare either side of it (`partReach`), slid along the line from where it
 * was dropped if it has to be. A valve dropped just before a bend used to go
 * in with the bend inside its reach, and the line out of its outlet had to
 * double back through it to get round the corner.
 *
 * "Inlet" is the `l` port, and "upstream" is the line's drawn source end.
 * A drawing does not state flow direction, so that is a convention, and the
 * R key turns a part that is facing the wrong way.
 */
export function insertInline(
  nodes: Node[],
  edges: Edge[],
  edgeId: string,
  at: XYPosition,
  part: Node,
  drawn?: Drawn,
): Inserted | null {
  const edge = edges.find(e => e.id === edgeId);
  if (!edge) return null;
  const from = nodes.find(n => n.id === edge.source);
  const to = nodes.find(n => n.id === edge.target);
  if (!from || !to) return null;
  const points = pointsOf(edge, from, to, drawn);
  if (points.length < 2) return null;
  const reach = partReach(part);
  const near = pathProject(points, at);
  // A stub of line either side where there is room for one; where there is
  // not, the part's own body and handles clear of the ends is enough. A
  // line too short even for that -- a gap between two symbols narrower than
  // the part -- takes nothing, and the part is dropped as a loose symbol:
  // put in anyway, it sat on both its neighbours and both its lines looped
  // back through it.
  const span = nodeSize(part).w / 2 + 3 + 1;
  const roomy = { endGapA: reach, endGapB: reach, cornerGap: reach, minCornerGap: span };
  const tight = { ...roomy, endGapA: span, endGapB: span };
  if (!hasLegalSpot(points, tight)) return null;
  const s = legalSpot(points, near, hasLegalSpot(points, roomy) ? roomy : tight);
  const spot = pointAtArc(points, s);
  if (!spot) return null;

  const { w, h } = nodeSize(part);
  const placed: Node = {
    ...part,
    position: { x: spot.point.x - w / 2, y: spot.point.y - h / 2 },
    data: { ...(part.data ?? {}), rotation: rotationAlong(spot.dir) },
  };

  const cut = halves(edges, edge, points, s, { anchor: w / 2 + 3, clear: reach }, part.id, 'l', 'r', routedByHand(nodes, edges, edge));
  return {
    nodes: [...remapAttachments(nodes, edgeId, [cut.up, cut.down], points), placed],
    edges: [...edges.filter(e => e.id !== edgeId), ...cut.edges],
    partId: part.id,
  };
}

/**
 * Tap a line with an instrument: a tee into the line where it lands, and the
 * instrument stood off the pipe on the side `pointer` is, turned so its one
 * port (`b`) faces the tee, on the tee's face across the run.
 *
 * Placed from the tee as it went in, not from where the instrument was
 * dropped. The tee keeps clear of the line's ends and bends and so can land
 * a few pixels from the drop -- a transducer dropped at a tank's outlet, just
 * before a bend -- and an instrument placed from the drop point sat that far
 * off the tee, its tapping jogged to reach it. `drawn` carries the line as
 * drawn and, for the tee to land where the reseat keeps it, the measured
 * ports and what routes go round.
 */
export function tapLine(
  nodes: Node[], edges: Edge[], edgeId: string, at: XYPosition, pointer: XYPosition, instrument: Node,
  drawn?: Drawn, page?: string,
): { nodes: Node[]; edges: Edge[]; junctionId: string } | null {
  const split = splitEdgeAt(nodes, edges, edgeId, at, page, drawn);
  if (!split) return null;
  const tee = split.nodes.find(n => n.id === split.junctionId)!;
  const c = centreOfJunction(tee);
  const face = branchFace(runDirOf(junctionData(tee).along!), pointer, c);
  const { w, h } = nodeSize(instrument);
  // The port on the middle of the bottom side, 30 px from the tee's centre.
  const reach = 30;
  const placement: Record<Face, { x: number; y: number; rotation?: number }> = {
    t: { x: c.x - w / 2, y: c.y - reach - h },
    b: { x: c.x - w / 2, y: c.y + reach, rotation: 180 },
    l: { x: c.x - reach - (w + h) / 2, y: c.y - h / 2, rotation: 270 },
    r: { x: c.x + reach + (h - w) / 2, y: c.y - h / 2, rotation: 90 },
  };
  const { rotation, ...position } = placement[face];
  const placed: Node = {
    ...instrument, position,
    data: { ...(instrument.data ?? {}), ...(rotation ? { rotation } : {}) },
  };
  const line: Edge = {
    id: freshEdgeId(`${instrument.id}-${tee.id}`, new Set(split.edges.map(e => e.id))),
    source: instrument.id, sourceHandle: 'b', target: tee.id, targetHandle: face, type: 'smoothstep', data: {},
  };
  return { nodes: [...split.nodes, placed], edges: [...split.edges, line], junctionId: tee.id };
}

/** The arc position of the point of `pts` nearest `p`. */
function pathProject(pts: Pt[], p: Pt): number {
  let best = Infinity, at = 0, before = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const u = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
    if (d < best - 1e-9) { best = d; at = before + u * len; }
    before += len;
  }
  return at;
}

/**
 * The two halves of a rejoined line, as one line again.
 *
 * The inverse of the split above, and it has to be: take a junction out of a
 * run you have just put one into and you should get the run back, not a
 * different one.
 *
 * Segments are ordered along the run, so upstream's followed by downstream's
 * *is* the run once the tee between them is gone. Extensive params add up when
 * both halves state them in the same unit; when the units differ there is no
 * conversion at this layer, so the result is left unstated rather than
 * pretending one of the two numbers was the whole run.
 *
 * Every corner either half drew is kept, in order, so the healed run draws
 * the shape the two halves drew. The router's stay the router's (`viaRun`):
 * on a pipe they are the pipe's shape, kept while it still fits its ends; on
 * a line that is no pipe's they stay while they fit, as any of the router's
 * corners left on such a line do. Dropping them re-routed the whole pipe the
 * healed line was part of, and moved every other tee on it, whenever the
 * pipe's shape was not the one the router would draw afresh. A person's
 * corners on either half make the healed run a person's, corners and all, as
 * a hand edit on one line of a pipe makes the whole pipe a person's.
 */
export function mergedLineData(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...a };

  const segments = [
    ...((a?.segments as LineSegment[] | undefined) ?? []),
    ...((b?.segments as LineSegment[] | undefined) ?? []),
  ];
  if (segments.length) merged.segments = segments;

  const own = (d: Record<string, unknown> | undefined) => (d?.waypoints as Pt[] | undefined) ?? [];
  const byHand = (d: Record<string, unknown> | undefined) => own(d).length > 0 && !d?.viaRun;
  const waypoints = [...own(a), ...own(b)];
  delete merged.viaRun;
  if (waypoints.length) {
    merged.waypoints = waypoints;
    merged.offset = 0;
    if (!byHand(a) && !byHand(b)) merged.viaRun = true;
  } else delete merged.waypoints;

  const pa = a?.params as Record<string, ParamValue> | undefined;
  const pb = b?.params as Record<string, ParamValue> | undefined;
  if (pa || pb) {
    const params: Record<string, ParamValue> = { ...pa };
    for (const k of EXTENSIVE_LINE_PARAMS) {
      const x = pa?.[k];
      const y = pb?.[k];
      if (!y) continue;
      if (!x) { params[k] = y; continue; }
      if (x.unit !== y.unit) { delete params[k]; continue; }
      params[k] = { ...x, value: Number(x.value) + Number(y.value) };
    }
    merged.params = params;
  }

  return merged;
}

/** Something that sits in a run: a tee (by either marking), or a part in `INLINE`. */
export function isMidRun(n: Node): boolean {
  const t = (n.data as unknown as PIDNodeData)?.componentType;
  return isJunction(n) || (!!t && INLINE.has(t));
}

/**
 * The line params that say which way the line runs: a rise is outlet less
 * inlet, and a fall inlet less outlet. Read the other way round, each is its
 * own negative.
 */
const SIGNED_LINE_PARAMS = ['elevation_change', 'fall'] as const;

const negated = (p: ParamValue): ParamValue => ({ ...p, value: -Number(p.value) });

/** A fitting row met from its other end: an adapter's two ends change places, and a reducer is an expander. */
function reversedFitting(row: FittingRow): FittingRow {
  const out: FittingRow & { bore?: unknown; bore2?: unknown } = { ...row };
  if (row.kind === 'contraction') out.kind = 'expansion';
  else if (row.kind === 'expansion') out.kind = 'contraction';
  if (row.ends) out.ends = { a: row.ends.b, b: row.ends.a };
  const r = row as FittingRow & { bore?: unknown; bore2?: unknown };
  if (r.bore !== undefined && r.bore2 !== undefined) { out.bore = r.bore2; out.bore2 = r.bore; }
  return out;
}

/** A segment met from its other end: its rise negated, its fittings in the other order, each met from its other end. */
function reversedSegment(seg: LineSegment): LineSegment {
  const out: LineSegment = { ...seg };
  if (seg.elevation_change) out.elevation_change = negated(seg.elevation_change);
  if (seg.fittings) out.fittings = seg.fittings.map(reversedFitting).reverse();
  return out;
}

/**
 * A line's data read the other way round: its corners and its segments
 * reversed, and everything that says which way the line runs said the other
 * way. A pipe can be stored as two lines drawn towards each other -- drawn
 * from both ends until they met -- and healed into one line, the half read
 * backwards kept its rise: a half that climbed a metre towards the tee
 * climbed a metre away from it, and feed-twin was handed a head of the wrong
 * sign for it.
 */
function reversedData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data;
  const out = { ...data };
  if (Array.isArray(data.waypoints)) out.waypoints = [...(data.waypoints as Pt[])].reverse();
  if (Array.isArray(data.segments)) out.segments = (data.segments as LineSegment[]).map(reversedSegment).reverse();
  const params = data.params as Record<string, ParamValue> | undefined;
  if (params && SIGNED_LINE_PARAMS.some(k => params[k])) {
    const p = { ...params };
    for (const k of SIGNED_LINE_PARAMS) if (p[k]) p[k] = negated(p[k]);
    out.params = p;
  }
  return out;
}

/**
 * A chain of lines joined through things taken out of the run, as one line:
 * `chain[k]` with `reversed[k]` when it is stored against the chain's
 * direction. `clear` drops the corners each removed thing made for itself.
 */
function mergeChain(
  chain: Edge[], reversed: boolean[], id: string,
  clear: (data: Record<string, unknown> | undefined, k: number) => Record<string, unknown> | undefined = d => d,
): Edge {
  const first = chain[0], last = chain[chain.length - 1];
  const dataOf = (k: number) => clear(reversed[k] ? reversedData(chain[k].data) : chain[k].data, k);
  let data = dataOf(0);
  for (let k = 1; k < chain.length; k++) data = mergedLineData(data, dataOf(k));
  if (chain.length === 1) data = mergedLineData(data, undefined);
  const source = reversed[0] ? first.target : first.source;
  const sourceHandle = reversed[0] ? first.targetHandle : first.sourceHandle;
  const target = reversed[chain.length - 1] ? last.source : last.target;
  const targetHandle = reversed[chain.length - 1] ? last.sourceHandle : last.targetHandle;
  const edge: Edge = { ...first, id, source, sourceHandle, target, targetHandle, data };
  delete (edge as { selected?: boolean }).selected;
  return edge;
}

/** A healed line and the lines it replaces, in order along it. */
export interface Rejoin {
  edge: Edge;
  replaced: string[];
  /** Whether each replaced line was stored against the healed line's direction. */
  reversed: boolean[];
}

/**
 * The lines to put back after a delete took something out of a run, and the
 * lines each one replaces.
 *
 * Works from what was deleted, not from what is left: React Flow has already
 * removed every line on a deleted node by the time a handler runs, so there
 * is nothing in the current edge list to rejoin.
 *
 * A deleted thing is mid-run when it names its run: a riding tee by its
 * `along` -- even with branches on it, which are deleted with it, so taking
 * a tee out of a manifold keeps the manifold's pipe -- and anything else in
 * a run by having exactly two lines. A valve venting to atmosphere has one
 * line, not two, so taking it out takes its line out too; a tee with three
 * legs and no run is not a point in one run, and everything on it goes.
 * Deleting two adjacent mid-run things still leaves one line, because the
 * walk follows the chain to whatever survives.
 *
 * The healed line runs the way the chain was drawn, from its upstream end.
 * Its id is the natural `source-target` when `taken` (the ids left on the
 * drawing) says that is free, numbered past it otherwise -- so two rejoins in
 * one delete, or one after another, can never share an id with each other or
 * with anything left on the drawing.
 */
export function rejoinChains(
  deletedNodes: Node[], deletedEdges: Edge[], taken: ReadonlySet<string> | ((id: string) => boolean),
): Rejoin[] {
  const gone = new Set(deletedNodes.map(n => n.id));
  const midNodes = deletedNodes.filter(isMidRun);
  if (!midNodes.length) return [];
  const boxes = new Map(deletedNodes.map(n => { const { w, h } = nodeSize(n); return [n.id, { x: n.position.x, y: n.position.y, w, h }]; }));

  // The two lines each deleted mid-run thing joins.
  const pairOf = new Map<string, [Edge, Edge]>();
  for (const n of midNodes) {
    const on = deletedEdges.filter(e => e.source !== e.target && (e.source === n.id || e.target === n.id));
    const along = isJunction(n) ? junctionData(n).along : undefined;
    const at = (e: Edge) => (e.source === n.id ? e.sourceHandle : e.targetHandle);
    if (along) {
      const inE = on.find(e => at(e) === along.in);
      const outE = on.find(e => e !== inE && at(e) === along.out);
      if (inE && outE) { pairOf.set(n.id, [inE, outE]); continue; }
    }
    if (on.length === 2) pairOf.set(n.id, [on[0], on[1]]);
  }

  const has = typeof taken === 'function' ? taken : (id: string) => taken.has(id);
  const minted = new Set<string>();
  const used = new Set<string>();
  const out: Rejoin[] = [];
  for (const first of deletedEdges) {
    if (used.has(first.id)) continue;
    for (const start of [first.source, first.target]) {
      if (gone.has(start)) continue;
      const m0 = start === first.source ? first.target : first.source;
      const p0 = pairOf.get(m0);
      if (!p0 || !p0.includes(first)) continue;
      // Walk from the surviving end `start` through the removed things.
      const chain: Edge[] = [first], via: string[] = [m0];
      let at = m0, cur = first, end: string | null = null;
      const seen = new Set([m0]);
      for (;;) {
        const pair = pairOf.get(at)!;
        const next = pair[0] === cur ? pair[1] : pair[0];
        const far = next.source === at ? next.target : next.source;
        chain.push(next);
        if (!gone.has(far)) { end = far; break; }
        const p = pairOf.get(far);
        if (!p || !p.includes(next) || seen.has(far)) break;
        seen.add(far);
        via.push(far);
        at = far; cur = next;
      }
      if (end === null || chain.some(e => used.has(e.id))) continue;
      // A part in a loop from one symbol back to it -- a bypass across two
      // ports of one regulator, say -- heals into a line from the symbol to
      // itself, which nothing may draw: the loop's lines go with the part.
      if (end === start) continue;
      chain.forEach(e => used.add(e.id));
      // Run it the way it was drawn: from the upstream end.
      const forward = first.source === start;
      const ordered = forward ? chain : [...chain].reverse();
      const mids = forward ? via : [...via].reverse();
      const nodesAlong = [forward ? start : end, ...mids, forward ? end : start];
      const reversed = ordered.map((e, k) => e.source !== nodesAlong[k]);
      // A corner inside the thing that was taken out was the run turning to
      // reach its port; without the part there is nothing to turn for.
      const clear = (data: Record<string, unknown> | undefined, k: number) => {
        let d = data;
        for (const id of [nodesAlong[k], nodesAlong[k + 1]]) {
          const box = gone.has(id) ? boxes.get(id) : undefined;
          const pts = d?.waypoints as Pt[] | undefined;
          if (!box || !pts?.length) continue;
          const kept = pts.filter(c => c.x < box.x || c.x > box.x + box.w || c.y < box.y || c.y > box.y + box.h);
          d = { ...d };
          if (kept.length) d.waypoints = kept; else delete d.waypoints;
        }
        return d;
      };
      const src = nodesAlong[0], tgt = nodesAlong[nodesAlong.length - 1];
      const id = freshEdgeId(`${src}-${tgt}`, x => has(x) || minted.has(x));
      minted.add(id);
      out.push({ edge: mergeChain(ordered, reversed, id, clear), replaced: ordered.map(e => e.id), reversed });
      break;
    }
  }
  return out;
}

/**
 * Where the lines a heal touches are drawn, when the caller can say: `old`
 * gives each replaced line as it was drawn, source to target, and `healed`
 * the healed line as it will be. They are separate because a healed line
 * can take the id of a line it replaces.
 */
export interface HealDrawn {
  old?: (edgeId: string) => Pt[] | undefined;
  healed?: (edgeId: string) => Pt[] | undefined;
}

/** The probes clipped to any of `replaced`, re-clipped to the healed line `healedId`. */
function reclip(nodes: Node[], healedId: string, replaced: string[], reversed: boolean[], drawn?: HealDrawn): Node[] {
  const clipped = (n: Node) => (n.data as { attachedTo?: string } | undefined)?.attachedTo;
  if (!nodes.some(n => replaced.includes(clipped(n) ?? ''))) return nodes;
  const olds = replaced.map(id => drawn?.old?.(id));
  // Where the healed line is drawn: as the caller says, or else the replaced
  // lines end to end, which is the shape the heal keeps.
  const healed = drawn?.healed?.(healedId)
    ?? (olds.every(p => p && p.length >= 2) ? olds.flatMap((p, k) => (reversed[k] ? [...p!].reverse() : p!)) : []);
  // Each probe is re-clipped once, from the line it was on, even when the
  // healed line has that line's id.
  const done = new Map<string, Node>();
  replaced.forEach((id, k) => {
    const on = nodes.filter(n => clipped(n) === id && !done.has(n.id));
    if (!on.length) return;
    for (const n of remapAttachments(on, id, [{ id: healedId, points: healed }], olds[k])) done.set(n.id, n);
  });
  return nodes.map(n => done.get(n.id) ?? n);
}

/**
 * Probes clipped to lines a rejoin replaced, re-clipped to the healed line,
 * at the point of the pipe they were clipped to when the lines are drawn
 * (`drawn`); without them, at the healed line's middle.
 */
export function reclipAfterRejoin(nodes: Node[], rejoins: Rejoin[], drawn?: HealDrawn): Node[] {
  let out = nodes;
  for (const r of rejoins) out = reclip(out, r.edge.id, r.replaced, r.reversed, drawn);
  return out;
}

/** Do two halves of a pipe say the same about what kind of pipe it is? Extensive quantities aside. */
function intensiveAgree(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!same(a?.lineType, b?.lineType) || !same(a?.partNumber, b?.partNumber)) return false;
  const oa = (a?.options ?? {}) as Record<string, unknown>, ob = (b?.options ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) if (!same(oa[k], ob[k])) return false;
  const pa = (a?.params ?? {}) as Record<string, ParamValue>, pb = (b?.params ?? {}) as Record<string, ParamValue>;
  const extensive = new Set<string>(EXTENSIVE_LINE_PARAMS);
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (extensive.has(k)) continue;
    const x = pa[k], y = pb[k];
    if (!x && !y) continue;
    if (!x || !y || Number(x.value) !== Number(y.value) || x.unit !== y.unit) return false;
  }
  return true;
}

/** The drawing with a healed line in it, and the healed line's id. */
export interface Healed {
  nodes: Node[];
  edges: Edge[];
  lineId: string;
}

/**
 * A junction that branches nowhere, taken out of its line: its two lines
 * healed into one, from the far end of the first to the far end of the
 * second, and the junction gone.
 *
 * A filled dot is drawn on every junction with two lines or more, and to
 * anybody reading the drawing it says the pipe branches there. A junction
 * with exactly two lines says nothing a line does not say better, and to
 * feed-twin it is a node in series that nobody asked for. A delete that
 * takes a tee's branch, or the end of its pipe, can leave one
 * (`dissolveAfterDelete`); so can an open end pulled on straight ahead,
 * which is the line made longer, not a tee put in.
 *
 * The two are read the way the pipe runs through the junction: its run when
 * it rides one, otherwise from the line that arrives at it to the one that
 * leaves it. A half stored the other way is read backwards, rise and
 * fittings and all (`reversedData`), so the healed line says what the pair
 * said. `drawn` gives the two as they were drawn, for probes on them to stay
 * where on the pipe they were.
 *
 * Returns null, and the drawing is left as it is, when the junction does not
 * have exactly two lines; when healing would make a line from a thing to
 * itself, which nothing may draw; or when the two disagree about what kind
 * of pipe they are -- a tee between a half inch and a quarter inch line is a
 * reducer somebody put there, not a dot.
 */
export function healThrough(nodes: Node[], edges: Edge[], id: string, drawn?: HealDrawn): Healed | null {
  const n = nodes.find(x => x.id === id);
  if (!n || !isJunction(n)) return null;
  const lines = edges.filter(e => e.source === id || e.target === id);
  if (lines.length !== 2 || lines.some(e => e.source === e.target)) return null;
  const along = junctionData(n).along;
  const at = (e: Edge) => (e.source === id ? e.sourceHandle : e.targetHandle) ?? '';
  const inE = along && lines.find(e => at(e) === along.in);
  const outE = along && lines.find(e => e !== inE && at(e) === along.out);
  const [first, second] = inE && outE ? [inE, outE]
    : lines[0].target === id || lines[1].source === id ? [lines[0], lines[1]] : [lines[1], lines[0]];
  // Heal through it: the first line from its far end, then the second on.
  const reversed = [first.target !== id, second.source !== id];
  const src = reversed[0] ? first.target : first.source, tgt = reversed[1] ? second.source : second.target;
  if (src === tgt) return null;
  const oriented = (e: Edge, back: boolean) => (back ? reversedData(e.data) : e.data);
  if (!intensiveAgree(oriented(first, reversed[0]), oriented(second, reversed[1]))) return null;
  const rest = edges.filter(e => e !== first && e !== second);
  const lineId = freshEdgeId(`${src}-${tgt}`, new Set(rest.map(e => e.id)));
  return {
    nodes: reclip(nodes.filter(x => x.id !== id), lineId, [first.id, second.id], reversed, drawn),
    edges: [...rest, mergeChain([first, second], reversed, lineId)],
    lineId,
  };
}

/**
 * What a delete leaves that should not be left: a riding tee that lost a leg
 * and is now just a point on a line, and a junction with no lines at all.
 *
 * Only what this delete took a line from is looked at, and only a face it
 * took one from for good: a line taken off a tee's run face that a rejoin has
 * put straight back -- a valve or tee beside it deleted, its run healed onto
 * the tee -- is not a leg lost, and a tee put in on purpose and never
 * branched stays where it was put, as it does when nothing near it is
 * deleted. A riding tee that lost a leg and has two lines left is taken out
 * and the two healed into one -- when they agree about what kind of pipe it
 * is; a tee between a half inch and a quarter inch line is a real reducer,
 * and stays. The two are its run, when it lost its branch, or what is left of
 * its run and its branch, when the end of its pipe was deleted: a dot on a
 * line that turns there and branches nowhere (`healThrough`). Probes on the
 * two healed lines follow the healed line, to the point of the pipe they
 * were on when the lines are drawn (`drawn`). Returns the same arrays when
 * there is nothing to do.
 */
export function dissolveAfterDelete(
  deletedNodes: Node[], deletedEdges: Edge[], remainingNodes: Node[], remainingEdges: Edge[], drawn?: HealDrawn,
): { nodes: Node[]; edges: Edge[] } {
  const goneNodes = new Set(deletedNodes.map(n => n.id));
  // The faces of each surviving node a deleted line was on.
  const lostAt = new Map<string, Set<string>>();
  for (const e of deletedEdges) {
    for (const [id, h] of [[e.source, e.sourceHandle], [e.target, e.targetHandle]] as const) {
      if (goneNodes.has(id)) continue;
      const faces = lostAt.get(id);
      if (faces) faces.add(h ?? ''); else lostAt.set(id, new Set([h ?? '']));
    }
  }
  if (!lostAt.size) return { nodes: remainingNodes, edges: remainingEdges };

  let nodes = remainingNodes, edges = remainingEdges;
  const removeNodes = new Set<string>();
  for (const n of remainingNodes) {
    const lost = lostAt.get(n.id);
    if (!lost || !isJunction(n)) continue;
    const lines = edges.filter(e => e.source === n.id || e.target === n.id);
    if (!lines.length) { removeNodes.add(n.id); continue; }
    if (!junctionData(n).along || lines.length !== 2) continue;
    const at = (e: Edge) => (e.source === n.id ? e.sourceHandle : e.targetHandle) ?? '';
    if (![...lost].some(h => !lines.some(e => at(e) === h))) continue;
    const healed = healThrough(nodes, edges, n.id, drawn);
    if (healed) ({ nodes, edges } = healed);
  }
  if (removeNodes.size) nodes = nodes.filter(n => !removeNodes.has(n.id));
  return { nodes, edges };
}
