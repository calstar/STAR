import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { applyPage, crossPageEdges, listPages, moveToPage, pageOf, DEFAULT_PAGE } from './pages';

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

  it('lists declared pages first, then any others in use', () => {
    const nodes = [node('a', 'GSE'), node('b', 'Rocket')];
    expect(listPages(nodes, ['Rocket'])).toEqual(['Rocket', 'GSE']);
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
    expect(shown.find(n => n.id === 'a')!.hidden).toBe(false);
    expect(shown.find(n => n.id === 'c')!.hidden).toBe(true);
  });

  it('hides a line unless both its ends are visible', () => {
    // A line to somewhere the reader cannot see is worse than no line.
    const { edges: shown } = applyPage(nodes, edges, 'Rocket');
    expect(shown.find(e => e.id === 'ab')!.hidden).toBe(false);
    expect(shown.find(e => e.id === 'bc')!.hidden).toBe(true);
  });

  it('leaves objects alone when nothing changed, so React can skip the render', () => {
    const once = applyPage(nodes, edges, 'Rocket');
    const twice = applyPage(once.nodes, once.edges, 'Rocket');
    expect(twice.nodes[0]).toBe(once.nodes[0]);
    expect(twice.edges[0]).toBe(once.edges[0]);
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
