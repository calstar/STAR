// A line on a port its symbol no longer has: the manifold cut from four
// outlets to three with a transducer still on p4. React Flow cannot draw it,
// so the check names it, a click shows where, and OrphanLayer draws it red.
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { orphanedLines, runChecks } from './checks';
import { orphanPaths } from './OrphanLayer';
import { centreOf } from './attach';
import { unmeasuredEnd } from './unmeasured';

const mf = (outlets: string, ports: Record<string, unknown> = {}): Node =>
  ({ id: 'mf', type: 'MANIFOLD', position: { x: 300, y: 100 }, measured: { width: 20, height: 90 },
     data: { componentType: 'MANIFOLD', label: 'MF-3', options: { outlets, orientation: 'vertical' }, ports } }) as Node;
const pt: Node = { id: 'pt', type: 'PT', position: { x: 100, y: 100 }, measured: { width: 60, height: 60 },
  data: { componentType: 'PT', label: 'OU-PT-R' } } as Node;
const onP4: Edge = { id: 'pt-mf', source: 'pt', sourceHandle: 'b', target: 'mf', targetHandle: 'p4' } as Edge;

describe('a line on a port that is gone', () => {
  it('is found, with the symbol, the port, and the ports the symbol has now', () => {
    expect(orphanedLines([pt, mf('3')], [onP4]).map(o => ({ edge: o.edge.id, node: o.nodeId, handle: o.handle, available: o.available })))
      .toEqual([{ edge: 'pt-mf', node: 'mf', handle: 'p4', available: ['in', 'p', 'p2', 'p3'] }]);
    expect(orphanedLines([pt, mf('4')], [onP4])).toEqual([]);
  });

  it('is found on a plugged port too', () => {
    expect(orphanedLines([pt, mf('4', { p4: { kind: 'plug' } })], [onP4]).map(o => o.handle)).toEqual(['p4']);
  });

  it('is a finding of its own that says which line, which symbol and which port, and goes to the symbol', () => {
    const f = runChecks([pt, mf('3')], [onP4]).find(x => x.id === 'line-orphaned-port-pt-mf')!;
    expect(f.severity).toBe('error');
    expect(f.title).toBe('Line from OU-PT-R to MF-3 is on a port that is gone');
    expect(f.detail).toContain('port p4 of MF-3');
    expect(f.detail).toContain('in, p, p2, p3');
    expect(f.edgeIds).toEqual(['pt-mf']);
    expect(f.focusIds).toEqual(['mf']);
    // Not selected: a Delete meant for the line would take the manifold too.
    expect(f.nodeIds ?? []).toEqual([]);
  });

  it('is drawn from the port still attached to the symbol whose port is gone', () => {
    const [p] = orphanPaths([pt, mf('3')], [onP4]);
    const from = unmeasuredEnd(pt, 'b')!;
    expect(p).toEqual({ edgeId: 'pt-mf', from: { x: from.x, y: from.y }, to: centreOf(mf('3')) });
    // Not drawn when it is on another page than the one in view.
    expect(orphanPaths([pt, { ...mf('3'), hidden: true }], [onP4])).toEqual([]);
    expect(orphanPaths([pt, mf('4')], [onP4])).toEqual([]);
  });
});
