import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { findVents } from './vents';

const node = (id: string, componentType: string): Node =>
  ({ id, position: { x: 0, y: 0 }, data: { componentType, label: id } }) as unknown as Node;

const edge = (id: string, source: string, sourceHandle: string,
              target: string, targetHandle: string): Edge =>
  ({ id, source, sourceHandle, target, targetHandle }) as unknown as Edge;

describe('a valve open on one side vents to atmosphere', () => {
  it('finds a valve plumbed on one side only', () => {
    const nodes = [node('TK', 'TANK'), node('SOL-V', 'SOL')];
    const edges = [edge('a', 'TK', 'b', 'SOL-V', 'l')];
    expect(findVents(nodes, edges)).toEqual([{ nodeId: 'SOL-V', handle: 'r' }]);
  });

  it('names the port that is actually free', () => {
    const nodes = [node('TK', 'TANK'), node('SOL-V', 'SOL')];
    const edges = [edge('a', 'SOL-V', 'r', 'TK', 't')];
    expect(findVents(nodes, edges)).toEqual([{ nodeId: 'SOL-V', handle: 'l' }]);
  });

  it('says nothing about a valve plumbed at both ends', () => {
    const nodes = [node('A', 'TANK'), node('V', 'MAN'), node('B', 'ENGINE')];
    const edges = [edge('a', 'A', 'b', 'V', 'l'), edge('b', 'V', 'r', 'B', 'fuel')];
    expect(findVents(nodes, edges)).toEqual([]);
  });

  it('says nothing about a valve nobody has plumbed yet', () => {
    // Most valves, most of the time a diagram is being drawn. Reporting these
    // would bury the real vents.
    expect(findVents([node('V', 'SOL')], [])).toEqual([]);
  });

  it('counts a relief valve, which vents by definition when unplumbed', () => {
    const nodes = [node('TK', 'TANK'), node('RV-1', 'RV')];
    const edges = [edge('a', 'TK', 't', 'RV-1', 'l')];
    expect(findVents(nodes, edges).map(v => v.nodeId)).toEqual(['RV-1']);
  });

  it('never fires on anything that is not a valve', () => {
    // A spare manifold port or a blanked tee branch is a plug, and a plug holds
    // pressure. Inferring atmosphere there would vent a tank through a fitting.
    const nodes = [node('TK', 'TANK'), node('MF', 'MANIFOLD'), node('QD', 'QD'), node('T', 'JUNCTION')];
    const edges = [edge('a', 'TK', 'b', 'MF', 'in')];
    expect(findVents(nodes, edges)).toEqual([]);
  });

  it('stops firing on a fill valve once its supply is drawn', () => {
    // The one exception that looked real, closed by the dewar being a symbol.
    const nodes = [node('DW', 'DEWAR'), node('FILL', 'MAN'), node('TK', 'TANK')];
    const before = [edge('a', 'FILL', 'r', 'TK', 't')];
    expect(findVents(nodes, before).map(v => v.nodeId)).toEqual(['FILL']);

    const after = [...before, edge('b', 'DW', 'r', 'FILL', 'l')];
    expect(findVents(nodes, after)).toEqual([]);
  });
});
