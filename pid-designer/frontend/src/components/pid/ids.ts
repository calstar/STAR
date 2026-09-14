import type { Node } from '@xyflow/react';

/**
 * Ids for newly drawn nodes.
 *
 * These are not cosmetic. A node id is the tag a reader keys on -- `feedtwin`'s
 * network nodes are "the tags on the P&ID" -- so two nodes sharing one is not a
 * rendering glitch, it is two components that a solver cannot tell apart.
 *
 * The counters used to be module-level and started at 1 on every page load,
 * while the ids already in a saved diagram did not. Open a diagram holding
 * `node_1 … node_9`, drop one more, and it was `node_1` again: React Flow keys
 * on id, so the new symbol and the old one became the same element, and the
 * duplicate went out in the next autosave.
 *
 * Seeding from what was actually loaded is what makes that impossible. The
 * counters are shared across diagrams on purpose -- ids only have to be unique
 * within one, and a monotonic counter that never rewinds is the cheapest way to
 * stay ahead of every diagram this tab has opened.
 */

let _node = 0;
let _junction = 0;

const NODE_RE = /^node_(\d+)$/;
const JUNCTION_RE = /^junc_(\d+)$/;

function highest(ids: string[], re: RegExp): number {
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Advance the counters past everything in a freshly loaded diagram. */
export function seedIdsFrom(nodes: Node[]): void {
  const ids = nodes.map(n => n.id);
  _node = Math.max(_node, highest(ids, NODE_RE));
  _junction = Math.max(_junction, highest(ids, JUNCTION_RE));
}

export const nextNodeId = () => `node_${++_node}`;
export const nextJunctionId = () => `junc_${++_junction}`;
