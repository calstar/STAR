import type { Edge, Node } from '@xyflow/react';
import { dragAttached } from './attach';
import { translateSubgraph } from './graphOps';
import { J_HALF, isJunction, pipesOf } from './junctions';
import { pageOf } from './pages';
import { AXIS_EPS } from './route';

/**
 * Dropping a symbol lines its ports up with the ones already on the drawing.
 *
 * The grid is not enough, and cannot be. A valve is sixty wide so its centre
 * port sits thirty from the node's origin; an engine is seventy-two, so its
 * top port sits at thirty-six. Node positions snap to ten, so the gap between
 * those two ports is always a multiple of ten minus six — an engine under a
 * rotary valve could not be lined up at all, at any position, by anybody.
 *
 * The obvious answer is to make every symbol's width a multiple of twenty so
 * every centre port lands on the same lattice. That works for centre ports and
 * then fails again for a tank with three outlets, or a manifold whose ports
 * were dragged round its perimeter by hand — the general case is symbols whose
 * ports are wherever the hardware puts them, and no lattice fixes that.
 *
 * So: on release, if a port of the symbol you moved is nearly in line with the
 * port at the other end of its line (or, on an axis it has no line on, with a
 * free port), move the symbol the last few pixels so that it *is*. Alignment
 * stops being arithmetic the reader has to do and becomes something the
 * drawing does.
 *
 * Deliberately on release rather than during the drag. Nudging a symbol under
 * the cursor while it is still moving fights the hand holding it.
 */

/**
 * How far a symbol may be moved to bring a port into line.
 *
 * Six, which is chosen rather than picked. Two ports are as far apart as the
 * difference in their offsets from their symbols' origins, and both origins
 * sit on the ten grid — so from the nearest grid square any pair is at most
 * five out, and six covers every pair there can be. The valve-and-engine case
 * is exactly six.
 *
 * Below the grid on purpose. A symbol put one square across from where it
 * would align is a decision, and it stays where it was put.
 */
export const SNAP_TOLERANCE = 6;

// ── What a dropped symbol lines up with ──────────────────────────────────────

/**
 * One port, where it is (the centre of its handle, in flow coordinates) and
 * which way it faces -- React Flow's `Position`, 'top', 'bottom', 'left' or
 * 'right'.
 */
export interface Port {
  id: string;
  x: number;
  y: number;
  side: string;
}

/** A symbol's ports, as measured, at the node's position; null for one not measured yet. */
export type PortsOf = (node: Node) => Port[] | null | undefined;

const VERTICAL = new Set(['top', 'bottom']);
const HORIZONTAL = new Set(['left', 'right']);
const FACE_SIDE: Record<string, string> = { t: 'top', b: 'bottom', l: 'left', r: 'right' };

/** Which coordinate lining up a port straightens: x for one facing up or down, y for one facing sideways. */
const axisOf = (side: string): 'x' | 'y' | null => (VERTICAL.has(side) ? 'x' : HORIZONTAL.has(side) ? 'y' : null);

/**
 * Where a line meets a node, for lining up: a symbol's port as measured, or a
 * tee's centre, facing the way the face the line is on does. A tee's four
 * faces sit three pixels either side of its centre line, and a symbol lined
 * up with a side face lands three pixels off the tee's column -- a bent
 * branch that was meant to be straight. A line through a tee is straight
 * when it is on the tee's centre line, so that is what a tee offers.
 */
function portAt(n: Node, handle: string | null | undefined, portsOf: PortsOf): Port | null {
  if (!handle) return null;
  if (isJunction(n)) {
    const side = FACE_SIDE[handle];
    return side ? { id: handle, x: n.position.x + J_HALF, y: n.position.y + J_HALF, side } : null;
  }
  return portsOf(n)?.find(p => p.id === handle) ?? null;
}

/**
 * The one shift that lines the moved symbols up on release, or zeros.
 *
 * Along their connections, not with whatever is near. Each line from a moved
 * node to one that did not move pairs the two ends it joins, and only such a
 * pair is lined up: the drop is there to make a line that is nearly straight
 * straight, and a port lined up with a symbol it has nothing to do with is a
 * false statement about the drawing -- in a manifold's fan-out, a valve
 * lined up under the outlet next to its own reads as fed by that outlet.
 *
 * And by the way the two ends face. Two ports facing up or down are lined up
 * in x, two facing sideways in y; a pair facing across each other is an L
 * whatever is done, and is left alone. A tee is taken by its centre.
 *
 * A line through riding tees is one pipe, and what is lined up is the pipe's
 * two ends, not a line's: a pipe is straight when its ends are in line,
 * whatever its tees are doing. A tee rides its pipe wherever the pipe goes,
 * so a symbol paired with the tee next to it along its own line was paired
 * with a point that had followed the symbol -- on the symbol's own leg of a
 * Z the tee is level with the symbol and offered no shift at all, and on a
 * pipe the router had already straightened it sat halfway and moved the
 * symbol halfway, leaving the pipe a pixel and a half out. A riding tee
 * dragged along its pipe has nothing to line up with by it for the same
 * reason: the pipe, not the drop, decides where the tee sits.
 *
 * Where the moved symbols have no connection at all on an axis, their ports
 * on it are lined up with the free ports of the symbols on the page -- a row
 * of symbols not yet wired stays tidy -- but a port some line already uses
 * is never a target: it has its line.
 *
 * Each axis on its own -- a symbol can line up vertically with one
 * neighbour and horizontally with another, which is what happens in any
 * real bay -- and the smallest shift wins, so the nearest alignment is the
 * one taken rather than whichever port was looked at first. The tolerance
 * is inclusive: it is the largest gap worth closing, so a pair exactly that
 * far apart is the case it was sized for. Nothing on another page counts.
 */
export function dropShift(
  nodes: Node[], edges: Edge[], moving: ReadonlySet<string>, portsOf: PortsOf, page?: string,
  tolerance = SNAP_TOLERANCE,
): { dx: number; dy: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const onPage = (n: Node) => page === undefined || pageOf(n.data as { page?: string }) === page;
  const best = { x: { gap: Infinity, shift: 0, paired: false }, y: { gap: Infinity, shift: 0, paired: false } };
  const offer = (axis: 'x' | 'y', shift: number) => {
    const b = best[axis];
    if (Math.abs(shift) <= tolerance && Math.abs(shift) < b.gap) { b.gap = Math.abs(shift); b.shift = shift; }
  };

  // Ports in use: a line whose two ends are both on the drawing holds its port at each.
  const used = new Set<string>();
  const live = edges.filter(e => e.source !== e.target && byId.has(e.source) && byId.has(e.target));
  for (const e of live) { used.add(`${e.source}\u0000${e.sourceHandle ?? ''}`); used.add(`${e.target}\u0000${e.targetHandle ?? ''}`); }

  // What each connection joins: a pipe's two ends, and each line in no pipe's.
  const pipes = pipesOf(nodes, edges);
  const inPipe = new Set(pipes.flatMap(p => p.lines));
  type Handle = string | null | undefined;
  const connections: { a: string; ah: Handle; b: string; bh: Handle }[] = [
    ...pipes.map(p => ({ a: p.a.nodeId, ah: p.a.handle, b: p.b.nodeId, bh: p.b.handle })),
    ...live.filter(e => !inPipe.has(e.id)).map(e => ({ a: e.source, ah: e.sourceHandle, b: e.target, bh: e.targetHandle })),
  ];

  for (const { a, ah, b, bh } of connections) {
    const am = moving.has(a), bm = moving.has(b);
    if (am === bm) continue;
    const [mid, mh, fid, fh] = am ? [a, ah, b, bh] : [b, bh, a, ah];
    const m = byId.get(mid)!, f = byId.get(fid)!;
    if (!onPage(m) || !onPage(f)) continue;
    const p = portAt(m, mh, portsOf), q = portAt(f, fh, portsOf);
    if (!p || !q) continue;
    const axis = axisOf(p.side);
    if (!axis || axis !== axisOf(q.side)) continue;
    best[axis].paired = true;
    offer(axis, axis === 'x' ? q.x - p.x : q.y - p.y);
  }

  if (!best.x.paired || !best.y.paired) {
    const mine = nodes.filter(n => moving.has(n.id) && !isJunction(n) && onPage(n)).flatMap(n => portsOf(n) ?? []);
    const free = nodes
      .filter(n => !moving.has(n.id) && !isJunction(n) && onPage(n))
      .flatMap(n => (portsOf(n) ?? []).filter(p => !used.has(`${n.id}\u0000${p.id}`)));
    for (const axis of ['x', 'y'] as const) {
      if (best[axis].paired) continue;
      for (const p of mine) {
        if (axisOf(p.side) !== axis) continue;
        for (const q of free) if (axisOf(q.side) === axis) offer(axis, axis === 'x' ? q.x - p.x : q.y - p.y);
      }
    }
  }
  // Less than half a pixel is the measuring, not a misalignment: a shift
  // that small put a symbol off the grid by a hundred-thousandth of a pixel
  // to line it up with a port measured that far off.
  const nudge = (v: number) => (Math.abs(v) < AXIS_EPS ? 0 : v);
  return { dx: nudge(best.x.shift), dy: nudge(best.y.shift) };
}

/**
 * The drawing after a drop's snap: the moved nodes shifted by `dropShift`,
 * and with them everything that belongs to them in absolute coordinates --
 * the corners of every line both of whose ends moved, the pipe ends a moved
 * tee last saw (`translateSubgraph`), and the probes clipped to them. The
 * snap used to move the symbols alone, and a hand-routed line between two
 * symbols snapped together kept its corners where they had been: a hook
 * four to six pixels deep at each end. The same arrays when nothing moves.
 */
export function snapOnDrop(
  nodes: Node[], edges: Edge[], moving: ReadonlySet<string>, portsOf: PortsOf, page?: string,
): { nodes: Node[]; edges: Edge[]; shift: { dx: number; dy: number } } {
  const shift = dropShift(nodes, edges, moving, portsOf, page);
  if (!shift.dx && !shift.dy) return { nodes, edges, shift };
  const delta = { x: shift.dx, y: shift.dy };
  const moved = translateSubgraph(nodes, edges, moving, delta);
  let next = moved.nodes;
  for (const id of moving) next = dragAttached(next, id, delta);
  return { nodes: next, edges: moved.edges, shift };
}
