import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  applyPage, clearSelection, crossPageEdges, listPages, moveToPage, pageOf, pageOfSubjects, selectOnPage, DEFAULT_PAGE,
} from './pages';

const node = (id: string, page?: string, extra: Record<string, unknown> = {}): Node =>
  ({ id, position: { x: 0, y: 0 }, data: { componentType: 'SOL', label: id, page, ...extra } }) as unknown as Node;

const edge = (id: string, source: string, target: string): Edge =>
  ({ id, source, target }) as unknown as Edge;

describe('which page a component is on', () => {
  it('defaults to the main page when unset, so old diagrams still open', () => {
    expect(pageOf(undefined)).toBe(DEFAULT_PAGE);
    expect(pageOf({})).toBe(DEFAULT_PAGE);
    expect(pageOf({ page: '' })).toBe(DEFAULT_PAGE);
  });

  it('lists pages in use first, then any declared and still empty', () => {
    const nodes = [node('a', 'GSE'), node('b', 'Rocket')];
    expect(listPages(nodes, ['Rocket'])).toEqual(['GSE', 'Rocket']);
    expect(listPages(nodes, ['Stand'])).toEqual(['GSE', 'Rocket', 'Stand']);
  });

  it('leaves a page where it was when it empties', () => {
    // Clear declares the page it emptied, so the sheet survives -- and the
    // tab must not jump to the front the moment it does.
    const nodes = [node('a', 'Main'), node('b', 'GSE')];
    expect(listPages(nodes, [])).toEqual(['Main', 'GSE']);
    expect(listPages([nodes[0]], ['GSE'])).toEqual(['Main', 'GSE']);
  });

  it('leaves a page where it was when somebody draws on it', () => {
    expect(listPages([node('a', 'Main')], ['GSE'])).toEqual(['Main', 'GSE']);
    expect(listPages([node('a', 'Main'), node('b', 'GSE')], ['GSE']))
      .toEqual(['Main', 'GSE']);
  });

  it('always offers at least one page', () => {
    expect(listPages([], [])).toEqual([DEFAULT_PAGE]);
  });
});

describe('what a page shows', () => {
  const nodes = [node('a', 'Rocket'), node('b', 'Rocket'), node('c', 'GSE')];
  const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')];

  it('hides what is on another page', () => {
    const { nodes: shown } = applyPage(nodes, edges, 'Rocket');
    // Shown is the flag unset or false: a drawing never stores it, and the
    // view leaves an object it shows untouched (see below).
    expect(shown.find(n => n.id === 'a')!.hidden).toBeFalsy();
    expect(shown.find(n => n.id === 'c')!.hidden).toBe(true);
  });

  it('hides a line unless both its ends are visible', () => {
    // A line to somewhere the reader cannot see is worse than no line.
    const { edges: shown } = applyPage(nodes, edges, 'Rocket');
    expect(shown.find(e => e.id === 'ab')!.hidden).toBeFalsy();
    expect(shown.find(e => e.id === 'bc')!.hidden).toBe(true);
  });

  it('leaves objects alone when nothing changed, so React can skip the render', () => {
    const once = applyPage(nodes, edges, 'Rocket');
    const twice = applyPage(once.nodes, once.edges, 'Rocket');
    expect(twice.nodes[0]).toBe(once.nodes[0]);
    expect(twice.edges[0]).toBe(once.edges[0]);
  });

  it('hands a drawing that never stored the flag back as the very same objects', () => {
    // Drawings as they are saved and dropped carry no `hidden`. A new object
    // for every visible node and line on every change made React Flow
    // re-render the whole page on each drag tick.
    const { nodes: shown, edges: shownEdges } = applyPage(nodes, edges, 'Rocket');
    expect(shown.filter((n, k) => n === nodes[k]).map(n => n.id)).toEqual(['a', 'b']);
    expect(shownEdges[0]).toBe(edges[0]);
    // Moving one symbol makes one new object, not a new page.
    const moved = nodes.map(n => (n.id === 'a' ? { ...n, position: { x: 10, y: 0 } } : n));
    const again = applyPage(moved, edges, 'Rocket');
    expect(again.nodes[1]).toBe(shown[1]);
    expect(again.edges[0]).toBe(shownEdges[0]);
    // A hidden object brought back onto its page is shown.
    const back = applyPage(applyPage(nodes, edges, 'GSE').nodes, edges, 'Rocket');
    expect(back.nodes[0].hidden).toBe(false);
  });

  it('hands nothing hidden over selected, so Backspace here cannot delete it', () => {
    // React Flow deletes every selected node in its store and frames every
    // selected one in the box-select rectangle, hidden or not.
    const picked = nodes.map(n => ({ ...n, selected: true }));
    const pickedEdges = edges.map(e => ({ ...e, selected: true }));
    const { nodes: shown, edges: shownEdges } = applyPage(picked, pickedEdges, 'Rocket');
    expect(shown.filter(n => n.selected).map(n => n.id)).toEqual(['a', 'b']);
    expect(shownEdges.filter(e => e.selected).map(e => e.id)).toEqual(['ab']);
    // The components keep their flag; only the view drops it.
    expect(picked.every(n => n.selected)).toBe(true);
  });

  it('keeps the whole graph, so checks still span both sides', () => {
    // The point of pages over separate diagrams: the pairing check has to see
    // both halves of a disconnect pair or it reports every correct one broken.
    const { nodes: shown } = applyPage(nodes, edges, 'Rocket');
    expect(shown).toHaveLength(3);
  });
});

describe('moving components between pages', () => {
  it('takes clipped instruments along', () => {
    const nodes = [
      node('TK', 'Rocket'),
      node('PT-1', 'Rocket', { attachedTo: 'TK' }),
      node('SOL', 'Rocket'),
    ];
    const moved = moveToPage(nodes, new Set(['TK']), 'GSE');
    expect(pageOf(moved.find(n => n.id === 'PT-1')!.data as { page?: string })).toBe('GSE');
    expect(pageOf(moved.find(n => n.id === 'SOL')!.data as { page?: string })).toBe('Rocket');
  });
});

describe('lines that run between pages', () => {
  it('finds them, so the checks panel can say so', () => {
    const nodes = [node('a', 'Rocket'), node('b', 'GSE')];
    expect(crossPageEdges(nodes, [edge('ab', 'a', 'b')]).map(e => e.id)).toEqual(['ab']);
  });

  it('says nothing about a line within one page', () => {
    const nodes = [node('a', 'Rocket'), node('b', 'Rocket')];
    expect(crossPageEdges(nodes, [edge('ab', 'a', 'b')])).toEqual([]);
  });
});

describe('selection and pages', () => {
  const nodes = [node('a', 'Rocket'), node('b', 'Rocket'), node('c', 'GSE'), node('d', 'GSE')];
  const edges = [edge('ab', 'a', 'b'), edge('cd', 'c', 'd'), edge('bc', 'b', 'c')];

  it('leaving a page clears the selection, and leaves an unselected drawing alone', () => {
    const picked = nodes.map(n => (n.id === 'a' ? { ...n, selected: true } : n));
    const cleared = clearSelection(picked);
    expect(cleared.some(n => n.selected)).toBe(false);
    expect(cleared[1]).toBe(picked[1]);
    expect(clearSelection(cleared)).toBe(cleared);
  });

  it('a checks item is shown on the page of its first component, or of its first line', () => {
    expect(pageOfSubjects(nodes, edges, ['c', 'a'])).toBe('GSE');
    expect(pageOfSubjects(nodes, edges, [], ['ab'])).toBe('Rocket');
    expect(pageOfSubjects(nodes, edges, ['gone'], [])).toBeNull();
  });

  it('a line whose source is gone is shown where its target is', () => {
    const hanging = [...edges, edge('xd', 'x', 'd')];
    expect(pageOfSubjects(nodes, hanging, [], ['xd'])).toBe('GSE');
    expect(pageOfSubjects(nodes, [edge('xy', 'x', 'y')], [], ['xy'])).toBeNull();
  });

  it('picking a checks item selects only what is on its page', () => {
    // A disconnect and its mate: only the half the reader is taken to is
    // selected, and nothing that was selected elsewhere stays so.
    const before = nodes.map(n => (n.id === 'b' ? { ...n, selected: true } : n));
    const out = selectOnPage(before, edges, 'GSE', ['c', 'a'], ['cd', 'ab', 'bc']);
    expect(out.nodes.filter(n => n.selected).map(n => n.id)).toEqual(['c']);
    expect(out.edges.filter(e => e.selected).map(e => e.id)).toEqual(['cd']);
    expect(out.nodes[3]).toBe(before[3]);
  });

  it('picks a line between pages by the component it leaves from on this page', () => {
    // No page draws `bc`, so selecting it would select nothing the reader
    // can see, and the check about it would do nothing when picked.
    const onRocket = selectOnPage(nodes, edges, 'Rocket', [], ['bc']);
    expect(onRocket.nodes.filter(n => n.selected).map(n => n.id)).toEqual(['b']);
    expect(onRocket.edges.some(e => e.selected)).toBe(false);
    const onGSE = selectOnPage(nodes, edges, 'GSE', [], ['bc']);
    expect(onGSE.nodes.filter(n => n.selected).map(n => n.id)).toEqual(['c']);
  });

  it('picks a line that hangs off nothing by the component it still hangs off', () => {
    const hanging = [...edges, edge('xd', 'x', 'd'), edge('xy', 'x', 'y')];
    const out = selectOnPage(nodes, hanging, 'GSE', [], ['xd', 'xy']);
    expect(out.nodes.filter(n => n.selected).map(n => n.id)).toEqual(['d']);
    expect(out.edges.some(e => e.selected)).toBe(false);
  });

  it('never stands a line drawn on a page in for anything', () => {
    // `ab` is drawn, on Rocket: picked from GSE it selects nothing there,
    // rather than an end of it.
    const out = selectOnPage(nodes, edges, 'GSE', [], ['ab']);
    expect(out.nodes.some(n => n.selected)).toBe(false);
    expect(out.edges.some(e => e.selected)).toBe(false);
    const drawn = selectOnPage(nodes, edges, 'Rocket', [], ['ab']);
    expect(drawn.nodes.some(n => n.selected)).toBe(false);
    expect(drawn.edges.filter(e => e.selected).map(e => e.id)).toEqual(['ab']);
  });
});
