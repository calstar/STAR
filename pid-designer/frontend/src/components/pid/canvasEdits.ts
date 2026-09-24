import { applyNodeChanges } from '@xyflow/react';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import { dragAttached } from './attach';
import { translateSubgraph } from './graphOps';
import type { Graph } from './history';
import { isJunction, junctionData, pipesOf, slideAlong } from './junctions';
import type { EndLookup } from './junctions';
import type { Obstacles } from './routeGrid';
import type { Pt } from './route';
import { dissolveAfterDelete, reclipAfterRejoin, rejoinChains } from './splitEdge';
import type { HealDrawn } from './splitEdge';

/**
 * The canvas's own edits that React Flow starts -- a drag, a delete -- as
 * pure functions of the drawing, so what the canvas does and what its tests
 * check are the same code.
 */

// ── Moving nodes ─────────────────────────────────────────────────────────────

export interface Moved {
  nodes: Node[];
  /** How far each node that moved went, tees after sliding. What `followCorners` moves corners by. */
  shifts: Map<string, Pt>;
}

const ZERO = 1e-9;

/**
 * React Flow's node changes applied the way the canvas applies them.
 *
 * - A tee dragged by hand slides along its pipe: the position React Flow
 *   reports is where the pointer put it, and the pipe is where it can go
 *   (`slideAlong`, against `edges` -- the lines as last drawn).
 * - A tee picked up with both ends of its pipe is part of what was picked up
 *   and moves with them, rigidly, by exactly their delta: a box-selected bay
 *   is one piece. Slid instead, it was re-proposed by React Flow from where
 *   the drag began every tick and put back on the pipe by a different
 *   amount than the rest, so its lines no longer moved as one and the hand
 *   corners on them were left behind as zigzags. Where the pipe's ends last
 *   stood (`along.ends`) moves with it, as `translateSubgraph` moves it.
 * - So does a tee left out of the selection whose pipe's two ends are both
 *   picked up by one delta: it rides that pipe, and the pipe is moving
 *   whole. React Flow proposes nothing for it, and left where it was it
 *   was drawn a tick behind the pipe it is on until the reseat caught up.
 * - Probes clipped to anything that moved go with it (`dragAttached`).
 * - A resize is copied into the authored size, for the nodes that have one.
 */
export function applyMoves(
  current: Node[], changes: NodeChange<Node>[], edges: Edge[], endOf: EndLookup, obstacles?: Obstacles,
): Moved {
  const before = new Map(current.map(n => [n.id, n.position]));
  let next = applyNodeChanges(changes, current);
  // How far React Flow proposes to move each node.
  const proposed = new Map<string, Pt>();
  for (const c of changes) {
    const from = c.type === 'position' && c.position ? before.get(c.id) : undefined;
    if (from && c.type === 'position' && c.position) proposed.set(c.id, { x: c.position.x - from.x, y: c.position.y - from.y });
  }
  const shifts = new Map<string, Pt>();

  // The tees whose pipes are picked up whole, and the delta each moves by:
  // its pipe's ends', when they agree, so the tee cannot fall a rounding
  // behind them -- `carried` for the tees React Flow is moving, `riders`
  // for those it is not. Worked out from the drawing as it was, since which
  // pipe a tee rides does not change in a drag; and again until nothing
  // more is found, since a pipe can end on a tee that rides another.
  const carried = new Map<string, Pt>();
  const riders = new Map<string, Pt>();
  if (proposed.size > 1 && current.some(n => isJunction(n) && junctionData(n).along)) {
    const pipes = pipesOf(current, edges);
    const moving = new Map(proposed);
    for (let grew = true; grew;) {
      grew = false;
      for (const pipe of pipes) {
        const da = moving.get(pipe.a.nodeId), db = moving.get(pipe.b.nodeId);
        if (!da || !db) continue;
        const together = Math.abs(da.x - db.x) < ZERO && Math.abs(da.y - db.y) < ZERO;
        for (const id of pipe.tees) {
          if (carried.has(id) || riders.has(id)) continue;
          const own = proposed.get(id);
          if (own) carried.set(id, together ? da : own);
          else if (together) riders.set(id, da);
          else continue;
          moving.set(id, own && !together ? own : da);
          grew = true;
        }
      }
    }
  }

  for (const c of changes) {
    if (c.type === 'position' && c.position) {
      const from = before.get(c.id);
      if (!from) continue;
      const moved = next.find(n => n.id === c.id);
      const along = moved && isJunction(moved) ? junctionData(moved).along : undefined;
      const rigid = carried.get(c.id);
      if (rigid) {
        next = next.map(n => (n.id === c.id ? { ...n, position: { x: from.x + rigid.x, y: from.y + rigid.y } } : n));
      } else if (moved && along) {
        const slid = slideAlong(moved, along, c.position, edges, new Map(next.map(n => [n.id, n])), endOf, obstacles);
        if (slid) {
          next = next.map(n => (n.id === c.id ? { ...n, position: slid.position, data: { ...n.data, along: slid.along } } : n));
        }
      }
      const now = next.find(n => n.id === c.id)?.position ?? c.position;
      // A tee carried whole moved by the group's delta, exactly: worked out
      // again as where it is less where it was, a coordinate that crosses a
      // power of two on the way can lose its last bit, and the tee's delta
      // then differed from the group's in the fourteenth place -- enough for
      // `followCorners` to take it for a node that moved differently and
      // leave the corners between it and the rest of the bay behind.
      const delta = rigid ?? { x: now.x - from.x, y: now.y - from.y };
      if (Math.abs(delta.x) < ZERO && Math.abs(delta.y) < ZERO) continue;
      if (rigid && along?.ends) {
        const { a, b } = along.ends;
        next = next.map(n => (n.id === c.id
          ? {
            ...n,
            data: {
              ...n.data,
              along: { ...along, ends: { a: { x: a.x + delta.x, y: a.y + delta.y }, b: { x: b.x + delta.x, y: b.y + delta.y } } },
            },
          }
          : n));
      }
      next = dragAttached(next, c.id, delta);
      shifts.set(c.id, delta);
      continue;
    }
    // A resize arrives as a `dimensions` change, and React Flow records it
    // in `measured` -- which `toStored` strips on the way out, correctly,
    // since it is a post-layout measurement recomputed on load. So a
    // resized section box looked right until the page was reloaded and
    // then sprang back to the size it was dropped at. `width`/`height` are
    // the authored size and do persist, so the measurement is copied into
    // them here.
    //
    // Two conditions, and the second is not redundant: `setAttributes` is
    // React Flow's own marker for "the author resized this", but the last
    // change of a drag arrives without it, so following that flag alone
    // stored the size one step behind what was on screen. A node that
    // already *has* an authored size keeps it in step with every
    // measurement. A node that never had one -- every ordinary symbol --
    // never acquires one, which is what stops the whole diagram filling up
    // with sizes nobody asked for.
    if (c.type === 'dimensions' && c.dimensions) {
      const authored = c.setAttributes || next.find(n => n.id === c.id)?.width !== undefined;
      if (authored) {
        const { width, height } = c.dimensions;
        next = next.map(n => (n.id === c.id ? { ...n, width, height } : n));
      }
    }
  }
  // The tees riding a pipe that is moving whole, which React Flow is not
  // moving: each by its pipe's delta, with its record of where the pipe's
  // ends stood (`translateSubgraph`) and its probes.
  for (const [id, delta] of riders) {
    next = translateSubgraph(next, [], [id], delta).nodes;
    next = dragAttached(next, id, delta);
    shifts.set(id, delta);
  }
  return { nodes: next, shifts };
}

/**
 * What a move of `moving` carries: those nodes, and every tee riding a pipe
 * whose two ends it carries -- the tee goes where its pipe goes. What a
 * drop's snap shifts, so that a tee the selection left out is lined up with
 * the rest of its bay instead of left a few pixels behind it.
 */
export function carriedWith(nodes: Node[], edges: Edge[], moving: Iterable<string>): Set<string> {
  const out = new Set(moving);
  if (!nodes.some(n => isJunction(n) && junctionData(n).along)) return out;
  const pipes = pipesOf(nodes, edges);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of pipes) {
      if (!out.has(p.a.nodeId) || !out.has(p.b.nodeId)) continue;
      for (const id of p.tees) if (!out.has(id)) { out.add(id); grew = true; }
    }
  }
  return out;
}

/**
 * The corners of every line both of whose ends moved by one delta, moved by
 * it too: a line routed by hand keeps its corners where they were put when
 * one end moves -- a corner is a decision about where the pipe runs -- but
 * when both ends move together, as a box-selected bay's do, the corners
 * between them are part of what was picked up. Tees included, which is why
 * a tee carried with its pipe (`applyMoves`) takes exactly the group's delta.
 * Returns the same array when nothing moved.
 */
export function followCorners(edges: Edge[], shifts: Map<string, Pt>): Edge[] {
  if (shifts.size < 2) return edges;
  // The nodes that moved by each delta: one translation per delta. Deltas
  // are told apart to a millionth of a pixel, not to the last bit: the same
  // move worked out from two different positions can differ in the last
  // place, and is still one move.
  const groups = new Map<string, { delta: Pt; ids: Set<string> }>();
  for (const [id, d] of shifts) {
    const k = `${Math.round(d.x * 1e6)},${Math.round(d.y * 1e6)}`;
    const g = groups.get(k);
    if (g) g.ids.add(id); else groups.set(k, { delta: d, ids: new Set([id]) });
  }
  let out = edges;
  for (const { delta, ids } of groups.values()) {
    if (ids.size > 1) out = translateSubgraph([], out, ids, delta).edges;
  }
  return out;
}

// ── Deleting ─────────────────────────────────────────────────────────────────

/**
 * The drawing after a delete, with what a delete leaves that should not be
 * left put right (decision: deleting keeps pipes whole):
 *
 * - a riding tee taken out gives its pipe back as one line, with the lines
 *   of its branches gone -- React Flow takes every line on a deleted node,
 *   and a run between two symbols is still wanted when a tee on it is not;
 *   likewise a part taken out of a run, and a chain of them (`rejoinChains`);
 * - a riding tee that lost its branch, and has nothing left but its two run
 *   lines, is dissolved into one line when the halves agree about what kind
 *   of pipe it is; a junction left with no lines is removed
 *   (`dissolveAfterDelete`);
 * - every healed line has an id nothing else on the drawing has, and probes
 *   clipped to the lines it replaces follow it, to where on the pipe they
 *   were (`drawn`: the old lines as they were drawn).
 *
 * `before` is the drawing before the delete, `gone` what React Flow
 * removed. `healed` says whether anything beyond the removal was done.
 */
export function afterDelete(before: Graph, gone: Graph, drawn?: HealDrawn): Graph & { healed: boolean } {
  const goneNodes = new Set(gone.nodes.map(n => n.id));
  const goneEdges = new Set(gone.edges.map(e => e.id));
  let nodes = before.nodes.filter(n => !goneNodes.has(n.id));
  let edges = before.edges.filter(e => !goneEdges.has(e.id));
  const rejoins = rejoinChains(gone.nodes, gone.edges, new Set(edges.map(e => e.id)));
  if (rejoins.length) {
    edges = [...edges, ...rejoins.map(r => r.edge)];
    nodes = reclipAfterRejoin(nodes, rejoins, drawn);
  }
  const left = dissolveAfterDelete(gone.nodes, gone.edges, nodes, edges, drawn);
  return { ...left, healed: rejoins.length > 0 || left.nodes !== nodes || left.edges !== edges };
}
