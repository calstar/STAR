import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { runChecks, countProblems } from './checks';

const node = (id: string, componentType: string, data: Record<string, unknown> = {}): Node =>
  ({ id, position: { x: 0, y: 0 }, data: { componentType, label: id, ...data } }) as unknown as Node;

const qd = (id: string, side: string, pairedWith = ''): Node =>
  node(id, 'QD', { options: { side, service: 'fluid', pairedWith } });

const edge = (id: string, source: string, target: string,
              sourceHandle: string | null = null, targetHandle: string | null = null): Edge =>
  ({ id, source, target, sourceHandle, targetHandle }) as unknown as Edge;

const titles = (nodes: Node[], edges: Edge[] = []) => runChecks(nodes, edges).map(f => f.title);
const ids = (nodes: Node[], edges: Edge[] = []) => runChecks(nodes, edges).map(f => f.id);

describe('quick disconnect pairing', () => {
  it('is an error when a flight half has nothing to mate with', () => {
    const found = runChecks([qd('QD-R1', 'rocket')], []);
    const f = found.find(x => x.id.startsWith('qd-unpaired'))!;
    expect(f.severity).toBe('error');
    expect(f.title).toContain('QD-R1');
  });

  it('is only a note when a ground half is unpaired', () => {
    // A ground half on its own is usually a drawing in progress; a flight half
    // on its own is a vehicle that cannot be disconnected.
    const found = runChecks([qd('QD-G1', 'ground')], []);
    expect(found.find(x => x.id.startsWith('qd-unpaired'))!.severity).toBe('info');
  });

  it('says nothing about a half declared to need no pair', () => {
    const found = runChecks([qd('QD-R1', 'rocket', 'none')], []);
    expect(found.some(f => f.id.includes('qd-'))).toBe(false);
  });

  it('catches two halves on the same side of the umbilical', () => {
    const found = runChecks([qd('A', 'rocket', 'B'), qd('B', 'rocket', 'A')], []);
    const f = found.find(x => x.id.startsWith('qd-sameside'))!;
    expect(f.severity).toBe('error');
  });

  it('catches a pairing only one of the two agrees with', () => {
    const nodes = [qd('A', 'rocket', 'B'), qd('B', 'ground', 'C'), qd('C', 'ground', 'B')];
    expect(ids(nodes)).toContain('qd-asym-A');
  });

  it('catches a pair whose other half has been deleted', () => {
    const found = runChecks([qd('A', 'rocket', 'GONE')], []);
    expect(found.find(x => x.id.startsWith('qd-missing'))!.severity).toBe('error');
  });

  it('is quiet about a correct pair', () => {
    const nodes = [qd('A', 'rocket', 'B'), qd('B', 'ground', 'A')];
    expect(ids(nodes).filter(i => i.startsWith('qd-'))).toEqual([]);
  });
});

describe('fluids', () => {
  const tank = (id: string, fluid: string) => node(id, 'TANK', {
    fluid,
    params: {
      pressure: { value: 500, unit: 'psi', source: 'measured' },
      temperature: { value: 90, unit: 'K', source: 'measured' },
    },
  });

  it('reports two fluids arriving at one component', () => {
    const nodes = [tank('TK-LOX', 'oxygen'), tank('TK-ETH', 'ethanol'), node('TEE', 'JUNCTION')];
    const edges = [edge('a', 'TK-LOX', 'TEE', 'b'), edge('b', 'TK-ETH', 'TEE', 'b')];
    const f = runChecks(nodes, edges).find(x => x.id.startsWith('fluid-conflict'))!;
    expect(f.severity).toBe('error');
    expect(f.title).toContain('TEE');
  });

  it('says nothing about a nitrogen-pressurised LOX tank', () => {
    const nodes = [tank('TK-LOX', 'oxygen'), tank('TK-N2', 'nitrogen'), node('PR-1', 'PR')];
    const edges = [edge('a', 'TK-N2', 'PR-1', 'b'), edge('b', 'PR-1', 'TK-LOX', 'r', 't')];
    expect(ids(nodes, edges).some(i => i.startsWith('fluid-conflict'))).toBe(false);
  });

  it('says nothing about fuel and oxidiser meeting at an engine', () => {
    const nodes = [tank('TK-LOX', 'oxygen'), tank('TK-ETH', 'ethanol'),
                   node('ENG', 'ENGINE', { params: { chamber_pressure: { value: 300, unit: 'psi', source: 'estimated' } } })];
    const edges = [edge('a', 'TK-LOX', 'ENG', 'b', 'ox'), edge('b', 'TK-ETH', 'ENG', 'b', 'fuel')];
    expect(ids(nodes, edges).some(i => i.startsWith('fluid-conflict'))).toBe(false);
  });
});

describe('boundary conditions a solve cannot start without', () => {
  it('asks a tank for pressure, temperature and a fluid', () => {
    const t = titles([node('TK-1', 'TANK')]);
    expect(t.some(x => x.includes('operating pressure'))).toBe(true);
    expect(t.some(x => x.includes('propellant temperature'))).toBe(true);
    expect(t.some(x => x.includes('fluid'))).toBe(true);
  });

  it('asks an engine for a chamber pressure', () => {
    expect(titles([node('ENG', 'ENGINE')]).some(x => x.includes('chamber pressure'))).toBe(true);
  });
});

describe('instruments', () => {
  it('warns about a probe wired into the flow path', () => {
    const nodes = [node('TK', 'TANK'), node('PT-1', 'PT')];
    const edges = [edge('a', 'TK', 'PT-1', 'b', 'l')];
    const f = runChecks(nodes, edges).find(x => x.id === 'instruments-wired')!;
    expect(f.severity).toBe('warning');
  });

  it('says nothing about a probe clipped to what it measures', () => {
    const nodes = [node('TK', 'TANK'), node('PT-1', 'PT', { attachedTo: 'TK' })];
    expect(ids(nodes).includes('instruments-wired')).toBe(false);
  });
});

describe('what the badge counts', () => {
  it('counts errors and checks, but not notes', () => {
    // An unfinished drawing is Tuesday, not a fault; a badge that says 40 on
    // every drawing is a badge nobody reads.
    const findings = runChecks([node('SOL-1', 'SOL')], []);
    expect(findings.every(f => f.severity === 'info')).toBe(true);
    expect(countProblems(findings)).toBe(0);
  });

  it('sorts the worst first', () => {
    const nodes = [qd('QD-R1', 'rocket'), node('TK-1', 'TANK')];
    const severities = runChecks(nodes, []).map(f => f.severity);
    expect(severities).toEqual([...severities].sort(
      (a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]));
  });
});
