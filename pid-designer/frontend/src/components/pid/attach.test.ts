import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { targetAt, dragAttached, isInstrument } from './attach';

const node = (id: string, componentType: string, x: number, y: number,
              w = 60, h = 60, data: Record<string, unknown> = {}): Node =>
  ({ id, position: { x, y }, measured: { width: w, height: h },
     data: { componentType, label: id, ...data } }) as unknown as Node;

const edge = (id: string, source: string, target: string): Edge =>
  ({ id, source, target }) as unknown as Edge;

describe('what an instrument clips to', () => {
  const nodes = [
    node('TANK', 'TANK', 0, 0, 60, 100),
    node('SOL', 'SOL', 300, 20),
  ];
  const edges = [edge('e1', 'TANK', 'SOL')];

  it('picks the component under the drop', () => {
    expect(targetAt({ x: 30, y: 50 }, nodes, edges)).toEqual({ id: 'TANK', kind: 'node' });
  });

  it('picks the line when the drop is near it but on nothing', () => {
    // Centres are (30,50) and (330,50), so the run is along y = 50.
    expect(targetAt({ x: 180, y: 54 }, nodes, edges)).toEqual({ id: 'e1', kind: 'edge' });
  });

  it('attaches to nothing out in open canvas', () => {
    expect(targetAt({ x: 180, y: 400 }, nodes, edges)).toBeNull();
  });

  it('prefers the component over the line running through it', () => {
    // A valve sits on its own line; dropping a probe on the valve means the
    // valve, which is the more specific of the two answers.
    expect(targetAt({ x: 330, y: 50 }, nodes, edges)).toEqual({ id: 'SOL', kind: 'node' });
  });

  it('never clips one probe to another', () => {
    const withProbe = [...nodes, node('TC-1', 'TC', 20, 40)];
    expect(targetAt({ x: 30, y: 50 }, withProbe, edges)).toEqual({ id: 'TANK', kind: 'node' });
  });

  it('does not clip a probe to itself', () => {
    const withProbe = [...nodes, node('TC-1', 'TC', 500, 500)];
    expect(targetAt({ x: 520, y: 520 }, withProbe, edges, 'TC-1')).toBeNull();
  });
});

describe('instruments follow what they measure', () => {
  it('moves everything clipped to a component by the same delta', () => {
    const nodes = [
      node('TANK', 'TANK', 0, 0, 60, 100),
      node('TC-1', 'TC', 80, -10, 60, 60, { attachedTo: 'TANK' }),
      node('TC-2', 'TC', 400, 400, 60, 60, { attachedTo: 'SOL' }),
    ];
    const moved = dragAttached(nodes, 'TANK', { x: 25, y: -15 });
    expect(moved.find(n => n.id === 'TC-1')!.position).toEqual({ x: 105, y: -25 });
    // Clipped to something else, so untouched.
    expect(moved.find(n => n.id === 'TC-2')!.position).toEqual({ x: 400, y: 400 });
  });

  it('leaves the array alone when nothing actually moved', () => {
    const nodes = [node('TANK', 'TANK', 0, 0)];
    expect(dragAttached(nodes, 'TANK', { x: 0, y: 0 })).toBe(nodes);
  });
});

describe('which components attach rather than connect', () => {
  it('counts the probes, and not the fittings', () => {
    // A gauge or a transducer screws into a tee and is part of the feed
    // system, so it connects like anything else.
    expect(['RTD', 'TC', 'LC'].every(isInstrument)).toBe(true);
    expect(['PT', 'PG', 'TANK', 'SOL', 'PR', 'QD', 'ENGINE'].some(isInstrument)).toBe(false);
  });
});

describe('the page you are looking at', () => {
  const gse: Node[] = [
    { id: 'TANK', type: 'TANK', position: { x: 0, y: 0 },
      measured: { width: 60, height: 100 },
      data: { componentType: 'TANK', label: 'TANK', page: 'GSE' } },
    { id: 'SOL', type: 'SOL', position: { x: 300, y: 20 },
      measured: { width: 60, height: 60 },
      data: { componentType: 'SOL', label: 'SOL', page: 'GSE' } },
  ];
  const wire: Edge[] = [{ id: 'e1', source: 'TANK', target: 'SOL' }];

  it('is the only page a drop can land on', () => {
    // The graph is whole so fluid and checks span pages -- which means an
    // unscoped hit test would clip a probe to a tank that is not on screen.
    expect(targetAt({ x: 30, y: 50 }, gse, wire, undefined, 'GSE'))
      .toEqual({ id: 'TANK', kind: 'node' });
    expect(targetAt({ x: 30, y: 50 }, gse, wire, undefined, 'Main')).toBeNull();
  });

  it('hides the lines on it too', () => {
    expect(targetAt({ x: 180, y: 54 }, gse, wire, undefined, 'GSE'))
      .toEqual({ id: 'e1', kind: 'edge' });
    expect(targetAt({ x: 180, y: 54 }, gse, wire, undefined, 'Main')).toBeNull();
  });

  it('hits everything when no page is named', () => {
    expect(targetAt({ x: 30, y: 50 }, gse, wire)).toEqual({ id: 'TANK', kind: 'node' });
  });
});
