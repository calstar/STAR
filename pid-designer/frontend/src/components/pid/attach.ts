import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { PIDNodeData } from './types';

/**
 * Instruments clip to what they are measuring.
 *
 * Wiring a thermocouple into the graph -- tank outlet to RTD, RTD onward --
 * was wrong in both directions. On the drawing it meant a temperature probe
 * could only be placed by breaking a line and re-joining it. In a solve it was
 * worse: `feedtwin.solve` peels a probe off as a `DeadEnd` precisely because it
 * carries no flow, so every one of them was two unknowns and a branch
 * modelling a stub that does not exist.
 *
 * A sensor is a *measurement point*: "report the pressure here". So dropping
 * one on a tank, a valve or a line attaches it to that thing and draws a
 * leader, and no edge is created. Which is also what people were trying to do
 * when they dropped it there.
 */

/** Component types that attach rather than connect. */
export const INSTRUMENTS = new Set(['RTD', 'TC', 'PT', 'PG', 'LC']);

export const isInstrument = (type?: string) => !!type && INSTRUMENTS.has(type);

export interface AttachTarget {
  id: string;
  kind: 'node' | 'edge';
}

/**
 * What is under a point, tested against the graph rather than the DOM.
 *
 * `elementsFromPoint` was the obvious way and is the wrong one here: React
 * Flow paints its drag surface (`.react-flow__pane`) above the node layer, so
 * a hit test at the centre of a tank returns the pane. It also only works for
 * what is currently rendered, which a drop handler cannot rely on.
 *
 * Rectangles and a distance to a segment, in flow coordinates, answer the same
 * question from data that is always there.
 */
export function targetAt(
  point: XYPosition,
  nodes: Node[],
  edges: Edge[],
  selfId?: string,
): AttachTarget | null {
  // Components first: dropping a probe on a valve that happens to sit on a
  // line means the valve, which is the more specific of the two.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.id === selfId) continue;
    if (isInstrument((n.data as unknown as PIDNodeData)?.componentType)) continue;
    const w = n.measured?.width ?? 60;
    const h = n.measured?.height ?? 60;
    if (point.x >= n.position.x && point.x <= n.position.x + w &&
        point.y >= n.position.y && point.y <= n.position.y + h) {
      return { id: n.id, kind: 'node' };
    }
  }

  // Then lines, within a few pixels of the run. The real edge is a smoothstep
  // path and this is the straight line between its ends -- close enough to pick
  // a line out at the scale a P&ID is drawn, and it never disagrees about
  // *which* line, only about exactly where along it.
  const centre = (n: Node) => ({
    x: n.position.x + (n.measured?.width ?? 60) / 2,
    y: n.position.y + (n.measured?.height ?? 60) / 2,
  });
  const TOLERANCE = 14;
  for (const e of edges) {
    const a = nodes.find(n => n.id === e.source);
    const b = nodes.find(n => n.id === e.target);
    if (!a || !b) continue;
    if (distanceToSegment(point, centre(a), centre(b)) <= TOLERANCE) {
      return { id: e.id, kind: 'edge' };
    }
  }
  return null;
}

function distanceToSegment(p: XYPosition, a: XYPosition, b: XYPosition): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Everything clipped to one host. */
export function attachedTo(nodes: Node[], hostId: string): Node[] {
  return nodes.filter(n => (n.data as unknown as PIDNodeData)?.attachedTo === hostId);
}

/**
 * Move instruments by the same delta as the component they are clipped to.
 *
 * React Flow's own `parentId` would do this, and is not used on purpose: it
 * makes a child's position relative to its parent, which changes what is
 * stored, and it requires parents to be ordered before children in the array.
 * Both are migrations to every saved diagram in return for a drag behaviour
 * that is four lines here.
 */
export function dragAttached(
  nodes: Node[],
  hostId: string,
  delta: XYPosition,
): Node[] {
  if (delta.x === 0 && delta.y === 0) return nodes;
  return nodes.map(n =>
    (n.data as unknown as PIDNodeData)?.attachedTo === hostId
      ? { ...n, position: { x: n.position.x + delta.x, y: n.position.y + delta.y } }
      : n,
  );
}

/**
 * Where the leader line from an instrument should land.
 *
 * The host's centre for a component; the midpoint of the run for a line. Both
 * are approximations that read correctly at the scale a P&ID is drawn at, and
 * neither needs the edge path re-derived.
 */
export function leaderTarget(
  attachedTo: string,
  nodes: Node[],
  edges: Edge[],
): XYPosition | null {
  const host = nodes.find(n => n.id === attachedTo);
  if (host) {
    return {
      x: host.position.x + (host.measured?.width ?? 60) / 2,
      y: host.position.y + (host.measured?.height ?? 60) / 2,
    };
  }
  const edge = edges.find(e => e.id === attachedTo);
  if (!edge) return null;
  const a = nodes.find(n => n.id === edge.source);
  const b = nodes.find(n => n.id === edge.target);
  if (!a || !b) return null;
  return {
    x: (a.position.x + (a.measured?.width ?? 60) / 2 + b.position.x + (b.measured?.width ?? 60) / 2) / 2,
    y: (a.position.y + (a.measured?.height ?? 60) / 2 + b.position.y + (b.measured?.height ?? 60) / 2) / 2,
  };
}

/** Instrument size, for placing one clear of its host. */
const PROBE = 60;
const GAP = 14;

/**
 * Move a freshly attached instrument off the thing it measures.
 *
 * Up and to the right of a component, and just off the line for a line, which
 * is where a draughtsman puts a tag anyway. Only the initial placement -- drag
 * it wherever you like afterwards, and the leader follows.
 */
export function clearOfHost(
  host: AttachTarget,
  dropped: XYPosition,
  nodes: Node[],
  edges: Edge[],
): XYPosition {
  if (host.kind === 'node') {
    const n = nodes.find(x => x.id === host.id);
    if (!n) return dropped;
    return {
      x: n.position.x + (n.measured?.width ?? PROBE) + GAP,
      y: n.position.y - GAP,
    };
  }
  const to = leaderTarget(host.id, nodes, edges);
  if (!to) return dropped;
  return { x: to.x + GAP, y: to.y - PROBE - GAP };
}
