import type { Edge, Node } from '@xyflow/react';
import { pageOf } from './pages';
import type { Pt } from './route';
import type { PIDNodeData } from './types';

/**
 * Operations on a piece of the drawing as a whole.
 *
 * A drawing stores geometry in more than one place. A symbol's position is
 * obvious; less obvious are the corners a line was routed through
 * (`data.waypoints`, hand corners and the `viaRun` corners a pipe hands its
 * halves alike) and where a tee last saw the two ends of its pipe
 * (`data.along.ends`). All of them are absolute flow coordinates. Every edit
 * that picks part of the drawing up and puts it down somewhere else -- a
 * paste, a group drag, a snap on release -- has to move all of them together,
 * and each one used to write its own transform and forget a different piece:
 * a pasted hand-routed line ran back to the original's corners and returned,
 * and a copied tee compared its copy's pipe with the original's ends and
 * seated itself on the original pipe. So there is one transform, here.
 */

const ZERO_EPS = 1e-9;

const shift = (p: Pt, d: Pt): Pt => ({ x: p.x + d.x, y: p.y + d.y });

/**
 * Move the nodes in `ids`, and everything stored in absolute coordinates that
 * belongs to them, by `delta`.
 *
 * - each node in `ids` moves by `delta`;
 * - a line whose two ends are both in `ids` has every stored corner moved too
 *   -- it was picked up whole. A line with only one end moving keeps its
 *   corners where they are: a corner is a decision about where the pipe runs,
 *   and moving one end does not unmake it;
 * - a tee in `ids` has the pipe ends it last saw (`along.ends`) moved with it,
 *   so the reseat sees a pipe that was moved, not one that was re-routed.
 *
 * Nothing else is touched, and anything unchanged comes back as the same
 * object -- the same arrays when nothing moved at all -- so React can skip it.
 */
export function translateSubgraph(
  nodes: Node[],
  edges: Edge[],
  ids: ReadonlySet<string> | Iterable<string>,
  delta: Pt,
): { nodes: Node[]; edges: Edge[] } {
  if (Math.abs(delta.x) < ZERO_EPS && Math.abs(delta.y) < ZERO_EPS) return { nodes, edges };
  const moving = ids instanceof Set ? (ids as ReadonlySet<string>) : new Set(ids);
  if (moving.size === 0) return { nodes, edges };

  let nodesChanged = false;
  const nextNodes = nodes.map(n => {
    if (!moving.has(n.id)) return n;
    nodesChanged = true;
    const data = n.data as { along?: { ends?: { a: Pt; b: Pt } } } | undefined;
    const ends = data?.along?.ends;
    return {
      ...n,
      position: shift(n.position, delta),
      ...(ends
        ? { data: { ...n.data, along: { ...data!.along, ends: { a: shift(ends.a, delta), b: shift(ends.b, delta) } } } }
        : {}),
    };
  });

  let edgesChanged = false;
  const nextEdges = edges.map(e => {
    if (!moving.has(e.source) || !moving.has(e.target)) return e;
    const pts = (e.data as { waypoints?: Pt[] } | undefined)?.waypoints;
    if (!pts?.length) return e;
    edgesChanged = true;
    return { ...e, data: { ...e.data, waypoints: pts.map(p => shift(p, delta)) } };
  });

  return { nodes: nodesChanged ? nextNodes : nodes, edges: edgesChanged ? nextEdges : edges };
}

/**
 * R: turn every selected symbol on `page` a quarter turn clockwise.
 *
 * Scoped to the page being looked at. Selection is kept on the components,
 * and the components of every page are in one array, so a selection made on
 * one page and left behind when the reader switched used to be turned out of
 * sight -- with its lines re-routed -- by an R pressed on another.
 */
export function turnSelected(nodes: Node[], page: string): Node[] {
  let changed = false;
  const next = nodes.map(n => {
    if (!n.selected || pageOf(n.data as unknown as PIDNodeData) !== page) return n;
    changed = true;
    const rotation = ((n.data as { rotation?: number }).rotation ?? 0) as number;
    return { ...n, data: { ...n.data, rotation: (rotation + 90) % 360 } };
  });
  return changed ? next : nodes;
}
