import type { Edge, Node, XYPosition } from '@xyflow/react';
import { nextJunctionId } from './ids';
import { faceTowards } from './BranchableEdge';
import type { PIDNodeData } from './types';
import type { ParamValue } from './params';
import type { LineSegment } from './segments';
import { centreOf } from './attach';

/**
 * Put a junction into a line.
 *
 * The one operation behind two gestures: the Junction tool, and dropping a
 * connection onto a line. Both need identical results -- the same node, the
 * same two halves, the same faces -- so they share this rather than each
 * growing their own version that drifts.
 *
 * A junction is a point *in* a run, so the two halves are the same pipe told
 * apart at a tee -- but only the *intensive* facts copy to both. See
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
  const params = out.params as Record<string, ParamValue> | undefined;
  if (params) {
    const kept = { ...params };
    for (const k of EXTENSIVE_LINE_PARAMS) delete kept[k];
    out.params = kept;
  }
  return out;
}

const J_HALF = 5;

export interface Split {
  nodes: Node[];
  edges: Edge[];
  junctionId: string;
}

export function splitEdgeAt(
  nodes: Node[],
  edges: Edge[],
  edgeId: string,
  at: XYPosition,
  page?: string,
  /**
   * Where the line actually starts and ends, when the caller knows.
   *
   * The edge itself knows its two handle positions exactly; a caller working
   * from graph data alone only has the node boxes. Both pick the same face for
   * an ordinary run, so the centres are a fine default -- but a line leaving
   * the top of one part and entering the side of another is not ordinary.
   */
  ends?: { from: XYPosition; to: XYPosition },
): Split | null {
  const edge = edges.find(e => e.id === edgeId);
  if (!edge) return null;
  const from = nodes.find(n => n.id === edge.source);
  const to = nodes.find(n => n.id === edge.target);
  if (!from || !to) return null;

  const junctionId = nextJunctionId();
  const a = ends?.from ?? centreOf(from);
  const b = ends?.to ?? centreOf(to);

  const junction: Node = {
    id: junctionId,
    type: 'JUNCTION',
    position: { x: at.x - J_HALF, y: at.y - J_HALF },
    data: {
      componentType: 'JUNCTION',
      label: junctionId,
      // A junction inherits the page of the line it lands on, so one never
      // appears on a page its own pipe is not drawn on.
      page: page ?? (from.data as unknown as PIDNodeData)?.page,
    } as unknown as Record<string, unknown>,
  };

  const carried = { ...(edge.data ?? {}), offset: 0 };
  const downstream = intensiveOnly(carried);

  return {
    nodes: [...nodes, junction],
    edges: [
      ...edges.filter(e => e.id !== edgeId),
      {
        ...edge,
        id: `${edge.source}-${junctionId}`,
        target: junctionId,
        targetHandle: faceTowards(a.x, a.y, at.x, at.y),
        data: carried,
      },
      {
        ...edge,
        id: `${junctionId}-${edge.target}`,
        source: junctionId,
        sourceHandle: faceTowards(b.x, b.y, at.x, at.y),
        target: edge.target,
        targetHandle: edge.targetHandle,
        data: downstream,
      },
    ],
    junctionId,
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
 * pretending one of the two numbers was the whole run.
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

/**
 * The lines to put back after a delete took some junctions with them.
 *
 * Works from what was deleted, not from what is left: React Flow has already
 * removed both halves by the time a handler runs, so there is nothing in the
 * current edge list to rejoin.
 *
 * A run is rejoined only where every junction along it was genuinely mid-line,
 * one edge in and one out. A junction with a third leg on it is not a point in
 * a single run, so there is no run to give back and everything attached goes,
 * which is the ordinary behaviour. Deleting two adjacent junctions still leaves
 * one line, because the walk follows the chain to whatever survives.
 */
export function rejoinAfterDelete(deletedNodes: Node[], deletedEdges: Edge[]): Edge[] {
  const gone = new Set(deletedNodes.map(n => n.id));
  const junctions = new Set(deletedNodes
    .filter(n => (n.data as unknown as PIDNodeData)?.componentType === 'JUNCTION')
    .map(n => n.id));
  if (junctions.size === 0) return [];

  const rejoined: Edge[] = [];
  for (const first of deletedEdges) {
    // Start only from a line whose upstream end survives.
    if (gone.has(first.source) || !junctions.has(first.target)) continue;

    let edge = first;
    let data = first.data;
    let ok = true;
    for (;;) {
      const j = edge.target;
      const inTo = deletedEdges.filter(e => e.target === j);
      const outOf = deletedEdges.filter(e => e.source === j);
      if (inTo.length !== 1 || outOf.length !== 1) { ok = false; break; }
      edge = outOf[0];
      data = mergedLineData(data, edge.data);
      if (!junctions.has(edge.target)) break;
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
