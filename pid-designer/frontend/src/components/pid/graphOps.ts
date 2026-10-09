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
 * halves alike), where a tee last saw the two ends of its pipe
 * (`data.along.ends`) and where it was put down on purpose
 * (`data.along.home`). All of them are absolute flow coordinates. Every edit
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
 *   so the reseat sees a pipe that was moved, not one that was re-routed;
 *   and so has its home (`along.home`), so a bay picked up and put down
 *   elsewhere has its tees at home there, as they were where it came from.
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
    const data = n.data as { along?: { ends?: { a: Pt; b: Pt }; home?: { a: Pt; b: Pt; at: Pt } } } | undefined;
    const ends = data?.along?.ends, home = data?.along?.home;
    return {
      ...n,
      position: shift(n.position, delta),
      ...(ends || home
        ? {
          data: {
            ...n.data,
            along: {
              ...data!.along,
              ...(ends ? { ends: { a: shift(ends.a, delta), b: shift(ends.b, delta) } } : {}),
              ...(home ? { home: { a: shift(home.a, delta), b: shift(home.b, delta), at: shift(home.at, delta) } } : {}),
            },
          },
        }
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
    const d = n.data as unknown as PIDNodeData;
    // A K-bottle or a dewar stands upright: R moves its side outlet to the
    // other side, mirrored about the vertical. A turn left over from before
    // this goes with the first flip.
    if (d.componentType === 'KBOTTLE' || d.componentType === 'DEWAR') {
      const { rotation: _turned, ...rest } = n.data as Record<string, unknown>;
      return { ...n, data: { ...rest, flipped: !d.flipped } };
    }
    const rotation = d.rotation ?? 0;
    return { ...n, data: { ...n.data, rotation: (rotation + 90) % 360 } };
  });
  return changed ? next : nodes;
}

/** A disconnect's mate as stored: a node id, or '' / 'none' for none. */
const mateOf = (n: Node | undefined) => ((n?.data as unknown as PIDNodeData | undefined)?.options?.pairedWith ?? '');
const realMate = (v: string) => v !== '' && v !== 'none';
const withMate = (n: Node, mate: string): Node => {
  const d = n.data as unknown as PIDNodeData;
  return { ...n, data: { ...n.data, options: { ...(d.options ?? {}), pairedWith: mate } } };
};

/**
 * Quick disconnect `id` now mates with `after` (it mated with `before`):
 * the other half says so too.
 *
 * A pair is two halves, so naming one's mate names the other's. The half it
 * leaves stops naming it, and a half the new mate was paired with before
 * stops naming the new mate -- so no disconnect is ever left pointing at a
 * half that has moved on, which the checks flag as two halves disagreeing.
 */
export function matePair(nodes: Node[], id: string, before: string, after: string): Node[] {
  if (before === after) return nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const set = new Map<string, string>();
  if (realMate(before) && mateOf(byId.get(before)) === id) set.set(before, '');
  if (realMate(after) && byId.has(after)) {
    const theirs = mateOf(byId.get(after));
    if (realMate(theirs) && theirs !== id && mateOf(byId.get(theirs)) === after) set.set(theirs, '');
    set.set(after, id);
  }
  if (set.size === 0) return nodes;
  return nodes.map(n => (set.has(n.id) ? withMate(n, set.get(n.id)!) : n));
}
