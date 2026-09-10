import type { Edge, Node } from '@xyflow/react';
import type { PIDNodeData } from './types';

/**
 * A valve open on one side is a vent to atmosphere.
 *
 * Not a symbol you place. A vent valve is drawn as a valve with nothing on its
 * downstream side, which is what a P&ID already does and what people already
 * draw without being asked -- so the tool reads the drawing rather than asking
 * for a second statement of it.
 *
 * The rule is deliberately narrow: **valves only**, and only when the valve has
 * exactly one connected port. Widening it to any component with a spare port
 * was wrong. A spare manifold port or a blanked tee branch is a plug; plugs are
 * not drawn on a P&ID, and inferring an open atmospheric boundary from one
 * would model a tank venting through a fitting that holds pressure.
 *
 * The one exception that looked real -- a fill valve, where flow goes in rather
 * than out -- stopped existing when K-bottles and dewars became symbols. The
 * valve now has something on both sides, so nothing fires.
 *
 * What this is for: a vent is a *fixed-pressure boundary node* at ambient, and
 * a feed-system solve needs one at the end of every vent line or the branch
 * dangles. Reading it off the drawing means nobody has to remember to say it.
 */

/** Valve-like components. A relief valve vents by definition when unplumbed. */
const VALVES = new Set(['MAN', 'ROT', 'SOL', 'RV']);

export interface Vent {
  nodeId: string;
  /** The port with nothing on it — where the vent arrow is drawn. */
  handle: string;
}

const dataOf = (n: Node) => n.data as unknown as PIDNodeData;

/**
 * Every valve that vents, and out of which port.
 *
 * A valve with *no* connections is not a vent, it is undrawn — which is most
 * valves for most of the time a diagram is being built, and reporting those
 * would bury the real ones.
 */
export function findVents(nodes: Node[], edges: Edge[]): Vent[] {
  const connected = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.source) {
      const set = connected.get(e.source) ?? new Set<string>();
      set.add(e.sourceHandle ?? '');
      connected.set(e.source, set);
    }
    if (e.target) {
      const set = connected.get(e.target) ?? new Set<string>();
      set.add(e.targetHandle ?? '');
      connected.set(e.target, set);
    }
  }

  const out: Vent[] = [];
  for (const n of nodes) {
    const d = dataOf(n);
    if (!VALVES.has(d?.componentType ?? '')) continue;
    const used = connected.get(n.id);
    if (!used || used.size !== 1) continue;   // undrawn, or plumbed both ends
    // Valves carry a left and a right port; whichever is not in use is the one
    // open to atmosphere.
    const open = used.has('l') ? 'r' : 'l';
    out.push({ nodeId: n.id, handle: open });
  }
  return out;
}
