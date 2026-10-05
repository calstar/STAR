// Duplicating a page (clipboard.ts `duplicatePage`, PageBar's right-click
// menu): another version of the same stand -- hotfire and launch -- as a copy
// of everything on the page, under fresh ids and the same tags.
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { duplicatePage } from './clipboard';
import { copyName } from './PageBar';
import { pageOf } from './pages';

const sym = (id: string, type: string, page: string, data: Record<string, unknown> = {}): Node =>
  ({ id, type, position: { x: id.length * 100, y: 50 }, data: { componentType: type, label: id.toUpperCase(), page, ...data } }) as Node;
const line = (id: string, s: string, t: string, data: Record<string, unknown> = {}): Edge =>
  ({ id, source: s, sourceHandle: 'r', target: t, targetHandle: 'l', type: 'smoothstep', data }) as Edge;

function stand() {
  const nodes: Node[] = [
    sym('kb', 'KBOTTLE', 'Hotfire'),
    sym('sol', 'SOL', 'Hotfire', { options: { failState: 'closed' } }),
    sym('qda', 'QD', 'Hotfire', { options: { pairedWith: 'qdb' } }),
    sym('qdb', 'QD', 'Hotfire', { options: { pairedWith: 'qda' } }),
    sym('qdg', 'QD', 'Hotfire', { options: { pairedWith: 'gse' } }),
    sym('pt', 'PT', 'Hotfire', { attachedTo: 'kb-sol' }),
    sym('vb', 'VALVE_BANK', 'Hotfire', { options: { outlets: '1' }, signals: { p: { to: 'sol', at: { x: 5, y: 5 } } } }),
    sym('gse', 'QD', 'GSE', { options: { pairedWith: 'qdg' } }),
  ];
  const edges: Edge[] = [line('kb-sol', 'kb', 'sol', { params: { bore: { value: 9.5, unit: 'mm', source: 'measured' } } }), line('sol-gse', 'sol', 'gse')];
  return { nodes, edges };
}

describe('duplicating a page', () => {
  it('copies every symbol and line on it to the new page, in place, under fresh ids and the same tags', () => {
    const before = stand();
    const after = duplicatePage(before.nodes, before.edges, 'Hotfire', 'Hotfire (copy)');
    const copies = after.nodes.filter(n => pageOf(n.data as { page?: string }) === 'Hotfire (copy)');
    expect(copies).toHaveLength(7);
    expect(new Set(copies.map(n => n.id)).size).toBe(7);
    for (const c of copies) expect(before.nodes.some(n => n.id === c.id)).toBe(false);
    const byTag = (tag: string) => copies.find(n => (n.data as { label: string }).label === tag)!;
    expect(byTag('SOL').position).toEqual(before.nodes[1].position);
    expect(byTag('SOL').data).toMatchObject({ componentType: 'SOL', options: { failState: 'closed' } });
    // The line between two copied symbols comes along, with what was typed into it.
    const copied = after.edges.filter(e => !before.edges.some(b => b.id === e.id));
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ source: byTag('KB').id, target: byTag('SOL').id, data: { params: { bore: { value: 9.5 } } } });
  });

  it('leaves the original exactly as it was, and selects nothing', () => {
    const before = stand();
    const snapshot = structuredClone(before);
    const after = duplicatePage(before.nodes, before.edges, 'Hotfire', 'Launch');
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(snapshot.nodes);
    expect(after.edges.slice(0, before.edges.length)).toEqual(snapshot.edges);
    expect(after.nodes.some(n => n.selected) || after.edges.some(e => e.selected)).toBe(false);
  });

  it('does not copy a line that crosses to another page', () => {
    const before = stand();
    const after = duplicatePage(before.nodes, before.edges, 'Hotfire', 'Launch');
    expect(after.edges.filter(e => e.target === 'gse')).toHaveLength(1);
  });

  it('points what the copy refers to at the copies: a probe, a QD pair, a dotted line', () => {
    const before = stand();
    const after = duplicatePage(before.nodes, before.edges, 'Hotfire', 'Launch');
    const copies = after.nodes.filter(n => pageOf(n.data as { page?: string }) === 'Launch');
    const id = (tag: string) => copies.find(n => (n.data as { label: string }).label === tag)!;
    const newLine = after.edges.find(e => e.source === id('KB').id)!;
    expect(id('PT').data).toMatchObject({ attachedTo: newLine.id });
    expect(id('QDA').data).toMatchObject({ options: { pairedWith: id('QDB').id } });
    expect(id('QDB').data).toMatchObject({ options: { pairedWith: id('QDA').id } });
    // Its mate is on another page and was not copied: still its mate.
    expect(id('QDG').data).toMatchObject({ options: { pairedWith: 'gse' } });
    expect(id('VB').data).toMatchObject({ signals: { p: { to: id('SOL').id } } });
  });
});

describe('the name a copy takes', () => {
  it('is the page with (copy) after it, numbered on when that is taken', () => {
    expect(copyName('Hotfire', ['Hotfire'])).toBe('Hotfire (copy)');
    expect(copyName('Hotfire', ['Hotfire', 'Hotfire (copy)'])).toBe('Hotfire (copy 2)');
    expect(copyName('Hotfire', ['Hotfire', 'Hotfire (copy)', 'Hotfire (copy 2)'])).toBe('Hotfire (copy 3)');
  });
});
