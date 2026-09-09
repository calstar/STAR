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

  it('never clips one instrument to another', () => {
    const withProbe = [...nodes, node('PT-1', 'PT', 20, 40)];
    expect(targetAt({ x: 30, y: 50 }, withProbe, edges)).toEqual({ id: 'TANK', kind: 'node' });
  });

  it('does not clip a probe to itself', () => {
    const withProbe = [...nodes, node('PT-1', 'PT', 500, 500)];
    expect(targetAt({ x: 520, y: 520 }, withProbe, edges, 'PT-1')).toBeNull();
  });
});

describe('instruments follow what they measure', () => {
  it('moves everything clipped to a component by the same delta', () => {
    const nodes = [
      node('TANK', 'TANK', 0, 0, 60, 100),
      node('PT-1', 'PT', 80, -10, 60, 60, { attachedTo: 'TANK' }),
      node('PT-2', 'PT', 400, 400, 60, 60, { attachedTo: 'SOL' }),
    ];
    const moved = dragAttached(nodes, 'TANK', { x: 25, y: -15 });
    expect(moved.find(n => n.id === 'PT-1')!.position).toEqual({ x: 105, y: -25 });
    // Clipped to something else, so untouched.
    expect(moved.find(n => n.id === 'PT-2')!.position).toEqual({ x: 400, y: 400 });
  });

  it('leaves the array alone when nothing actually moved', () => {
    const nodes = [node('TANK', 'TANK', 0, 0)];
    expect(dragAttached(nodes, 'TANK', { x: 0, y: 0 })).toBe(nodes);
  });
});

describe('which components attach rather than connect', () => {
  it('counts the instruments and nothing else', () => {
    expect(['RTD', 'TC', 'PT', 'PG', 'LC'].every(isInstrument)).toBe(true);
    expect(['TANK', 'SOL', 'PR', 'QD', 'ENGINE'].some(isInstrument)).toBe(false);
  });
});
