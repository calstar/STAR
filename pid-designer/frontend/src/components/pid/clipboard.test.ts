import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { copySelection, pasteClip } from './clipboard';

const node = (id: string, componentType: string, label: string, extra: Record<string, unknown> = {}, selected = true): Node =>
  ({ id, type: componentType, position: { x: 100, y: 100 }, selected,
     data: { componentType, label, page: 'Main', ...extra } }) as unknown as Node;
const edge = (source: string, target: string): Edge =>
  ({ id: `${source}-${target}`, source, target, sourceHandle: 'r', targetHandle: 'l', data: {} }) as unknown as Edge;
const labelOf = (n: Node) => (n.data as { label?: string }).label;

describe('copying a selection', () => {
  it('takes the selected symbols and the lines between them only', () => {
    const nodes = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2'), node('c', 'SOL', 'SOL-3', {}, false)];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const clip = copySelection(nodes, edges)!;
    expect(clip.nodes.map(n => n.id)).toEqual(['a', 'b']);
    // b-c has one end outside the selection: half a pipe is worse than none.
    expect(clip.edges.map(e => e.id)).toEqual(['a-b']);
  });

  it('is nothing when nothing is selected', () => {
    expect(copySelection([node('a', 'SOL', 'SOL-1', {}, false)], [])).toBeNull();
  });

  it('does not carry view state', () => {
    const clip = copySelection([node('a', 'SOL', 'SOL-1')], [])!;
    expect('selected' in clip.nodes[0]).toBe(false);
  });
});

describe('pasting', () => {
  it('lands fresh symbols with fresh ids and fresh tags, offset and selected', () => {
    const original = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2')];
    const clip = copySelection(original, [edge('a', 'b')])!;
    const out = pasteClip(clip, original, 'Main');
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes.map(n => n.id)).not.toContain('a');
    // Two valves both called SOL-1 is the duplicate the checks catch.
    expect(out.nodes.map(labelOf)).toEqual(['SOL-3', 'SOL-4']);
    expect(out.nodes[0].position).toEqual({ x: 140, y: 140 });
    expect(out.nodes.every(n => n.selected)).toBe(true);
    // The line between them comes along, rewired to the copies.
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].source).toBe(out.nodes[0].id);
    expect(out.edges[0].target).toBe(out.nodes[1].id);
  });

  it('numbers from the stem, so a renamed valve copies as its type', () => {
    const original = [node('a', 'SOL', 'SV-LOX-VENT')];
    const out = pasteClip(copySelection(original, [])!, original, 'Main');
    // The stem is what was there; the number is what is free.
    expect(labelOf(out.nodes[0])).toBe('SV-LOX-VENT-1');
  });

  it('lands on the page being looked at', () => {
    const original = [node('a', 'SOL', 'SOL-1')];
    const out = pasteClip(copySelection(original, [])!, original, 'GSE');
    expect((out.nodes[0].data as { page?: string }).page).toBe('GSE');
  });

  it('keeps a probe clipped to a copied host, and frees one clipped outside', () => {
    const host = node('t', 'TANK', 'TK-1');
    const probe = node('p', 'RTD', 'RTD-1', { attachedTo: 't' });
    const stray = node('q', 'RTD', 'RTD-2', { attachedTo: 'elsewhere' });
    const out = pasteClip(copySelection([host, probe, stray], [])!, [host, probe, stray], 'Main');
    const [t, p, q] = out.nodes;
    expect((p.data as { attachedTo?: string }).attachedTo).toBe(t.id);
    expect((q.data as { attachedTo?: string }).attachedTo).toBeUndefined();
  });

  it('gives a junction a junction id', () => {
    const j = { id: 'junc_1', type: 'JUNCTION', position: { x: 0, y: 0 }, selected: true, data: { page: 'Main' } } as unknown as Node;
    const out = pasteClip(copySelection([j], [])!, [j], 'Main');
    expect(out.nodes[0].id).toMatch(/^junc_\d+$/);
  });

  it('leaves annotation text and section names as they are', () => {
    const box = node('r', 'REGION', 'GSE bay');
    const out = pasteClip(copySelection([box], [])!, [box], 'Main');
    expect(labelOf(out.nodes[0])).toBe('GSE bay');
  });
});
