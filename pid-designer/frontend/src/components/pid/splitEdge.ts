import type { Edge, Node, XYPosition } from '@xyflow/react';
import { nextJunctionId } from './ids';
import type { PIDNodeData } from './types';
import type { ParamValue } from './params';
import type { LineSegment } from './segments';
import { INLINE, centreOf, nodeSize } from './attach';
import { J_HALF, faceOfDir, runFaces } from './junctions';
import type { Along } from './junctions';
import { nearestOnPolyline, pathPoints, routeOrthogonal, routeThrough } from './route';
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
}

export interface Split {
  nodes: Node[];
  edges: Edge[];
  junctionId: string;
}

/** Where the cut falls on the run, and what each half keeps of the routing. */
interface Cut {
  points: Pt[];
  t: number;
  dir: Pt;
  at: Pt;
  byHand: boolean;
  upstream: Pt[];
  downstream: Pt[];
}

function routeOf(edge: Edge, a: End, b: End): Pt[] {
  const data = (edge.data ?? {}) as { waypoints?: Pt[]; offset?: number };
  const route = data.waypoints?.length
    ? routeThrough(a, b, data.waypoints)
    : routeOrthogonal(a, b, data.offset ?? 0);
  return pathPoints(route.d);
}

function cutAt(edge: Edge, from: Node, to: Node, at: XYPosition, drawn?: Drawn): Cut | null {
  const points = drawn?.points
    ?? (drawn?.a && drawn?.b ? routeOf(edge, drawn.a, drawn.b) : [centreOf(from), centreOf(to)]);
  const near = nearestOnPolyline(points, at);
  if (!near) return null;
  const data = (edge.data ?? {}) as { waypoints?: Pt[]; offset?: number; viaRun?: boolean };
  // Corners the run put on this line (`viaRun`) are not a person's routing:
  // cut such a line and the halves route themselves, as the run does.
  const byHand = (!!data.waypoints?.length && !data.viaRun) || !!data.offset;
  return {
    points, t: near.t, dir: near.dir, at: near.point, byHand,
    // The corners on each side of the cut. A half that keeps corners is a run
    // somebody routed, and stays routed; one with none routes itself.
    upstream: points.slice(1, near.segment + 1),
    downstream: points.slice(near.segment + 1, -1),
  };
}

function halves(
  edge: Edge, cut: Cut, midId: string, inHandle: string, outHandle: string, clear: number,
): Edge[] {
  const carried: Record<string, unknown> = { ...(edge.data ?? {}), offset: 0 };
  delete carried.waypoints;
  delete carried.viaRun;
  // Each half takes the run's corners on its side of the cut -- less any
  // corner within the thing that went in, measured along the run: a valve
  // sixty wide covers thirty of pipe each side of the cut, and a corner in
  // that span is one a line from the outlet would have to double back
  // through the valve to reach. Corners a person put on the run stay a
  // person's; corners the router chose are marked as the run's, so a
  // re-seat may replace them -- see `withRunCorners` in junctions.ts.
  const outside = (pts: Pt[]) => pts.filter(c =>
    Math.abs((c.x - cut.at.x) * cut.dir.x + (c.y - cut.at.y) * cut.dir.y) > clear);
  const corners = (pts: Pt[]) => (pts.length ? { waypoints: pts, ...(cut.byHand ? {} : { viaRun: true }) } : {});
  const up = { ...carried, ...corners(outside(cut.upstream)) };
  const down = { ...intensiveOnly(carried), ...corners(outside(cut.downstream)) };
  return [
    {
      ...edge,
      id: `${edge.source}-${midId}`,
      target: midId,
      targetHandle: inHandle,
      data: up,
    },
    {
      ...edge,
      id: `${midId}-${edge.target}`,
      source: midId,
      sourceHandle: outHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      data: down,
    },
  ];
}

/**
 * Put a junction into a line.
 *
 * The one operation behind every gesture that branches a line. The tee is
 * placed on the pipe at the nearest point to `at`, turned to the way the run
 * goes there, and told which run it rides so it can stay on it -- see
 * `junctions.ts`.
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
  const cut = cutAt(edge, from, to, at, drawn);
  if (!cut) return null;

  const junctionId = nextJunctionId();
  const faces = runFaces(cut.dir);
  const along: Along = { t: cut.t, in: faces.in, out: faces.out, from: edge.source, to: edge.target };

  const junction: Node = {
    id: junctionId,
    type: 'JUNCTION',
    position: { x: cut.at.x - J_HALF, y: cut.at.y - J_HALF },
    data: {
      componentType: 'JUNCTION',
      label: junctionId,
      // A junction inherits the page of the line it lands on, so one never
      // appears on a page its own pipe is not drawn on.
      page: page ?? (from.data as unknown as PIDNodeData)?.page,
      along,
    } as unknown as Record<string, unknown>,
  };

  return {
    nodes: [...nodes, junction],
    edges: [...edges.filter(e => e.id !== edgeId), ...halves(edge, cut, junctionId, faces.in, faces.out, J_HALF)],
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
  const cut = cutAt(edge, from, to, at, drawn);
  if (!cut) return null;

  const { w, h } = nodeSize(part);
  const placed: Node = {
    ...part,
    position: { x: cut.at.x - w / 2, y: cut.at.y - h / 2 },
    data: { ...(part.data ?? {}), rotation: rotationAlong(cut.dir) },
  };

  return {
    nodes: [...nodes, placed],
    edges: [...edges.filter(e => e.id !== edgeId), ...halves(edge, cut, part.id, 'l', 'r', Math.max(w, h) / 2)],
    partId: part.id,
  };
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
 * pretending one of the two numbers was the whole run. Corners routed by
 * hand on either half are kept, in order.
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

  // Corners that were the run's own come back as nothing: the rejoined run
  // routes itself and lands on the same corners. Corners a person put on
  // either half are kept, in order.
  const hand = (d: Record<string, unknown> | undefined) =>
    d?.viaRun ? [] : ((d?.waypoints as Pt[] | undefined) ?? []);
  const waypoints = [...hand(a), ...hand(b)];
  delete merged.viaRun;
  if (waypoints.length) { merged.waypoints = waypoints; merged.offset = 0; }
  else delete merged.waypoints;

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

/** Something that sits in a run: a tee, or a part in `INLINE`. */
export function isMidRun(n: Node): boolean {
  const t = (n.data as unknown as PIDNodeData)?.componentType;
  return t === 'JUNCTION' || (!!t && INLINE.has(t));
}

/**
 * The lines to put back after a delete took something out of a run.
 *
 * Works from what was deleted, not from what is left: React Flow has already
 * removed both halves by the time a handler runs, so there is nothing in the
 * current edge list to rejoin.
 *
 * A run is rejoined only where everything deleted along it was genuinely
 * mid-line -- one line in and one out. A tee with a third leg on it is not a
 * point in a single run, so there is no run to give back and everything
 * attached goes, which is the ordinary behaviour. A valve venting to
 * atmosphere has one line, not two, so taking it out takes its line out too.
 * Deleting two adjacent mid-run things still leaves one line, because the
 * walk follows the chain to whatever survives.
 */
export function rejoinAfterDelete(deletedNodes: Node[], deletedEdges: Edge[]): Edge[] {
  const gone = new Set(deletedNodes.map(n => n.id));
  const mid = new Set(deletedNodes.filter(isMidRun).map(n => n.id));
  if (mid.size === 0) return [];
  const boxes = new Map(deletedNodes.map(n => { const { w, h } = nodeSize(n); return [n.id, { x: n.position.x, y: n.position.y, w, h }]; }));
  // A corner inside the thing that was taken out was the run turning to
  // reach its port; without the part there is nothing to turn for.
  const clearOf = (data: Record<string, unknown> | undefined, id: string) => {
    const box = boxes.get(id);
    const pts = data?.waypoints as Pt[] | undefined;
    if (!box || !pts?.length) return data;
    const kept = pts.filter(c => c.x < box.x || c.x > box.x + box.w || c.y < box.y || c.y > box.y + box.h);
    const out = { ...data };
    if (kept.length) out.waypoints = kept; else delete out.waypoints;
    return out;
  };

  const rejoined: Edge[] = [];
  for (const first of deletedEdges) {
    // Start only from a line whose upstream end survives.
    if (gone.has(first.source) || !mid.has(first.target)) continue;

    let edge = first;
    let data = clearOf(first.data, first.target);
    let ok = true;
    for (;;) {
      const j = edge.target;
      const inTo = deletedEdges.filter(e => e.target === j);
      const outOf = deletedEdges.filter(e => e.source === j);
      if (inTo.length !== 1 || outOf.length !== 1) { ok = false; break; }
      edge = outOf[0];
      data = mergedLineData(data, clearOf(edge.data, j));
      if (!mid.has(edge.target)) break;
    }
    if (!ok || gone.has(edge.target)) continue;

    rejoined.push({
      ...first,
      id: `${first.source}-${edge.target}-rejoined`,
      target: edge.target,
      targetHandle: edge.targetHandle,
      data,
    });
  }
  return rejoined;
}
