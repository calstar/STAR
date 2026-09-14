import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { migrate } from './migrate';

describe('an older drawing opens in today\'s vocabulary', () => {
  it('reads a standalone injector as an engine', () => {
    const inj = { id: 'n1', type: 'INJECTOR', position: { x: 0, y: 0 },
      data: { componentType: 'INJECTOR', label: 'INJ-1' } } as unknown as Node;
    const [out] = migrate({ nodes: [inj], edges: [] }).nodes;
    expect(out.type).toBe('ENGINE');
    expect((out.data as { componentType: string }).componentType).toBe('ENGINE');
    expect((out.data as { label: string }).label).toBe('INJ-1');
  });

  it('leaves everything else alone', () => {
    const tank = { id: 'n2', type: 'TANK', position: { x: 0, y: 0 },
      data: { componentType: 'TANK', label: 'TK-1' } } as unknown as Node;
    expect(migrate({ nodes: [tank], edges: [] }).nodes[0]).toBe(tank);
  });
});
