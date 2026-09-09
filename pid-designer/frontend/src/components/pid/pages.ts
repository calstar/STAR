import type { Edge, Node } from '@xyflow/react';
import type { PIDNodeData } from './types';

/**
 * Pages within one diagram.
 *
 * The rocket side and the GSE side are one architecture and belong in one
 * document -- which is the point of pages rather than two diagrams. **The graph
 * is whole; only the view is filtered.** Fluid still propagates across the
 * umbilical, and the checks panel still sees both halves of every disconnect
 * pair, because a pairing check that only looked at the page you were on would
 * report every correct pair as broken.
 *
 * Pages are stored on the components rather than as their own containers, so a
 * component belongs to exactly one page by construction and there is no second
 * structure to keep in step with the first.
 *
 * A line between pages is not drawn. It is not a rendering limitation so much
 * as a drawing convention: the thing that crosses the umbilical is a
 * disconnect pair, and joining the two sides with a line that has to be
 * imagined leaving one page and arriving on another is how off-page connectors
 * were invented. The checks panel says so if one exists.
 */

export const DEFAULT_PAGE = 'Main';

export const pageOf = (data: { page?: string } | undefined) => data?.page || DEFAULT_PAGE;

/**
 * Every page in the diagram: the ones components sit on, plus any declared
 * empty. Declared ones come first and in order, so adding a page and then
 * drawing on it does not make it jump.
 */
export function listPages(nodes: Node[], declared: string[] = []): string[] {
  const used = new Set(nodes.map(n => pageOf(n.data as unknown as PIDNodeData)));
  const out = [...declared];
  for (const p of used) if (!out.includes(p)) out.push(p);
  if (out.length === 0) out.push(DEFAULT_PAGE);
  return out;
}

/**
 * Mark what is not on this page hidden.
 *
 * `hidden` rather than filtering the array: React Flow keeps a node's measured
 * size, so switching pages and back does not re-measure everything, and an edge
 * whose ends are hidden hides itself without any bookkeeping here.
 */
export function applyPage(nodes: Node[], edges: Edge[], page: string): {
  nodes: Node[];
  edges: Edge[];
} {
  const visible = new Set<string>();
  const shown = nodes.map(n => {
    const on = pageOf(n.data as unknown as PIDNodeData) === page;
    if (on) visible.add(n.id);
    return n.hidden === !on ? n : { ...n, hidden: !on };
  });

  const shownEdges = edges.map(e => {
    // Both ends, so a line never runs to somewhere the reader cannot see.
    const on = visible.has(e.source) && visible.has(e.target);
    return e.hidden === !on ? e : { ...e, hidden: !on };
  });

  return { nodes: shown, edges: shownEdges };
}

/** Lines whose two ends are on different pages. */
export function crossPageEdges(nodes: Node[], edges: Edge[]): Edge[] {
  const page = new Map(nodes.map(n => [n.id, pageOf(n.data as unknown as PIDNodeData)]));
  return edges.filter(e => {
    const a = page.get(e.source);
    const b = page.get(e.target);
    return a && b && a !== b;
  });
}

/** Move a selection onto another page, instruments included. */
export function moveToPage(nodes: Node[], ids: Set<string>, page: string): Node[] {
  // Anything clipped to something that moves goes with it: a transducer left
  // behind on the GSE page while its tank moves to the rocket page is
  // measuring nothing, and nobody would have meant that.
  const withAttached = new Set(ids);
  for (const n of nodes) {
    const host = (n.data as unknown as PIDNodeData)?.attachedTo;
    if (host && withAttached.has(host)) withAttached.add(n.id);
  }
  return nodes.map(n =>
    withAttached.has(n.id) ? { ...n, data: { ...n.data, page } } : n,
  );
}
