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
 * Every page in the diagram: the ones components sit on, in the order those
 * components were drawn, then any declared and still empty.
 *
 * The order matters more than it looks. A page tab that moves when you touch
 * it is a page tab you stop trusting, and a page can cross between the two
 * lists in both directions -- draw on an empty one and it becomes used;
 * clear a used one and Clear declares it so the empty sheet survives. Putting
 * used first and empty after keeps a page where it was through both, because
 * a newly used page is last in node order and a newly emptied one is last
 * among the declared.
 */
export function listPages(nodes: Node[], declared: string[] = []): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = pageOf(n.data as unknown as PIDNodeData);
    if (!out.includes(p)) out.push(p);
  }
  for (const p of declared) if (!out.includes(p)) out.push(p);
  if (out.length === 0) out.push(DEFAULT_PAGE);
  return out;
}

/**
 * Mark what is not on this page hidden.
 *
 * `hidden` rather than filtering the array: React Flow keeps a node's measured
 * size, so switching pages and back does not re-measure everything, and an edge
 * whose ends are hidden hides itself without any bookkeeping here.
 *
 * Nothing hidden is handed over selected. React Flow's own selection readers
 * do not ask whether a node is hidden: Backspace deletes every selected node
 * in its store, and the box-select rectangle is drawn round every selected
 * one, so a selection left on another page was deleted by a Backspace
 * pressed here and framed by a rectangle over this page's symbols. The
 * components keep their flag; only the view drops it.
 */
export function applyPage(nodes: Node[], edges: Edge[], page: string): {
  nodes: Node[];
  edges: Edge[];
} {
  const visible = new Set<string>();
  const shown = nodes.map(n => {
    const on = pageOf(n.data as unknown as PIDNodeData) === page;
    if (on) visible.add(n.id);
    return shownAs(n, on);
  });

  const shownEdges = edges.map(e => {
    // Both ends, so a line never runs to somewhere the reader cannot see.
    return shownAs(e, visible.has(e.source) && visible.has(e.target));
  });

  return { nodes: shown, edges: shownEdges };
}

/**
 * One node or line as the page shows it: the same object when nothing changes.
 *
 * A missing flag reads as shown. The drawing never stores `hidden` -- nothing
 * loaded, dropped or pasted carries it -- so writing `hidden: false` onto
 * every visible object handed React Flow a new copy of each on every change,
 * and React Flow re-renders a node or line whenever its object is new: one
 * symbol dragged a tick re-rendered every line and symbol on the page. Every
 * reader of the flag asks whether it is set, so absent and false agree.
 */
function shownAs<T extends { hidden?: boolean; selected?: boolean }>(x: T, on: boolean): T {
  if (on) return x.hidden ? { ...x, hidden: false } : x;
  return x.hidden === true && !x.selected ? x : { ...x, hidden: true, selected: false };
}

/**
 * Everything unselected, and the same array back when nothing was selected.
 *
 * What a page switch does to the selection. Selection is how every action
 * below the page bar finds its subject -- R, Backspace, Cmd+C and Cmd+D, the
 * move-to-page menu -- and a subject the reader cannot see is not one they
 * chose. Clearing it on the way out means nothing picked on one page is
 * still live on the next.
 */
export function clearSelection<T extends { selected?: boolean }>(items: T[]): T[] {
  if (!items.some(x => x.selected)) return items;
  return items.map(x => (x.selected ? { ...x, selected: false } : x));
}

/**
 * Which page to show for a set of components and lines -- the page of the
 * first component, or when there is no component, of the first line's
 * source, or of its target when the source is gone -- or null when none of
 * them is on the drawing.
 *
 * An item in the checks panel names its subjects across the whole diagram,
 * because the checks see the whole diagram. Picking one has to take the
 * reader to where it is, or the selection lands somewhere they cannot see
 * and the view is centred on empty canvas.
 */
export function pageOfSubjects(
  nodes: Node[],
  edges: Edge[],
  nodeIds: string[],
  edgeIds: string[] = [],
): string | null {
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const id of nodeIds) {
    const n = byId.get(id);
    if (n) return pageOf(n.data as unknown as PIDNodeData);
  }
  for (const id of edgeIds) {
    const e = edges.find(x => x.id === id);
    // A line that hangs off nothing at its source still hangs off something
    // at its target, and that is where the reader can find it.
    const n = e && (byId.get(e.source) ?? byId.get(e.target));
    if (n) return pageOf(n.data as unknown as PIDNodeData);
  }
  return null;
}

/**
 * Select exactly `nodeIds` and `edgeIds` that lie on `page`, and nothing else.
 *
 * A check can name things on two pages -- a disconnect and its mate -- and
 * only the half the reader is taken to can be selected: the other is on a
 * sheet they are not looking at, and a selection there is one R or
 * Backspace would act on unseen. A line counts as on the page when both its
 * ends are, as it does for drawing it.
 *
 * A named line that no page draws -- its ends on two pages, or one end gone
 * -- is picked by the components it hangs off on this page instead. Selected
 * itself it would be selected nowhere the reader can see, so picking the
 * check that is about it would do nothing at all; the component is on the
 * sheet in front of them, and it is where the line leaves from.
 */
export function selectOnPage(
  nodes: Node[],
  edges: Edge[],
  page: string,
  nodeIds: string[],
  edgeIds: string[] = [],
): { nodes: Node[]; edges: Edge[] } {
  const wantNodes = new Set(nodeIds);
  const wantEdges = new Set(edgeIds);
  const pageById = new Map(nodes.map(n => [n.id, pageOf(n.data as unknown as PIDNodeData)]));
  const here = (id: string) => pageById.get(id) === page;
  for (const e of edges) {
    if (!wantEdges.has(e.id)) continue;
    const a = pageById.get(e.source);
    const b = pageById.get(e.target);
    if (a !== undefined && a === b) continue;          // drawn, on one page or another
    // Its ends stand in for it; which of them is on this page is settled
    // below, with everything else named.
    wantNodes.add(e.source);
    wantNodes.add(e.target);
  }
  const pick = <T extends { id: string; selected?: boolean }>(x: T, on: boolean): T =>
    !!x.selected === on ? x : { ...x, selected: on };
  return {
    nodes: nodes.map(n => pick(n, wantNodes.has(n.id) && here(n.id))),
    edges: edges.map(e => pick(e, wantEdges.has(e.id) && here(e.source) && here(e.target))),
  };
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
