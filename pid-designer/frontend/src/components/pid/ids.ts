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

/**
 * A random token per tab, ahead of the counter, since copies of the main diagram.
 *
 * Two people who copy main and each draw a valve would otherwise both get the
 * next counter value -- `node_13` in each copy, for two different valves. Fine
 * while the copies stay apart, but a merge back into main keys on id, and
 * would read those as one valve edited two ways. The token differs per page
 * load (36^6, ~2e9 values), so two tabs cannot mint the same id.
 *
 * Token plus counter rather than all-random, because the counter is what
 * `withoutSpendingIds` rolls back: a drag's preview mints exactly the ids the
 * kept drop will get, frame after frame. Existing ids are never rewritten, and
 * the `node_` / `junc_` prefixes stay.
 */
const TAB = (() => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
})();

export const nextNodeId = () => `node_${TAB}_${++_node}`;
export const nextJunctionId = () => `junc_${TAB}_${++_junction}`;

/**
 * Run `f`, and give back what it made with the counters where they were.
 *
 * For a drawing that is only looked at and never kept: a drag's preview makes
 * the drop it shows, frame after frame, to draw it exactly as it will be --
 * and the tees it puts in must not use up the ids the one drawing that is
 * kept will be given, or every tee drawn after a long drag is numbered in the
 * hundreds for nothing.
 */
export function withoutSpendingIds<T>(f: () => T): T {
  const node = _node, junction = _junction;
  try {
    return f();
  } finally {
    _node = node;
    _junction = junction;
  }
}

/**
 * A line id nothing in `taken` has: `base` itself when it is free, otherwise
 * `base-2`, `base-3`, and so on.
 *
 * Line ids are keyed on exactly as hard as node ids. React Flow looks a line
 * up by its id, last write wins, so two lines sharing one draw as the same
 * line twice and the other never, and a select or a delete of one hits both;
 * feed-twin refuses a network with two branches of one name. And the natural
 * name, `source-target`, is not unique: two lines can join the same pair of
 * symbols through different ports, and several lines can be named in one
 * operation -- a paste, a delete that heals several runs -- so `taken` has to
 * include the ids handed out earlier in the same operation, not just the ones
 * already on the drawing. That is why it is a set or a question the caller
 * answers, rather than the drawing.
 */
export function freshEdgeId(
  base: string,
  taken: ReadonlySet<string> | ((id: string) => boolean),
): string {
  const has = typeof taken === 'function' ? taken : (id: string) => taken.has(id);
  if (!has(base)) return base;
  let n = 2;
  while (has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
