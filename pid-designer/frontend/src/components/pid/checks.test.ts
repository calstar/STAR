import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { runChecks, countProblems } from './checks';

const node = (id: string, componentType: string, data: Record<string, unknown> = {}): Node =>
  ({ id, position: { x: 0, y: 0 }, data: { componentType, label: id, ...data } }) as unknown as Node;

const qd = (id: string, service: string, pairedWith = ''): Node =>
  node(id, 'QD', { options: { service, pairedWith } });

const edge = (id: string, source: string, target: string,
              sourceHandle: string | null = null, targetHandle: string | null = null): Edge =>
  ({ id, source, target, sourceHandle, targetHandle }) as unknown as Edge;

const titles = (nodes: Node[], edges: Edge[] = []) => runChecks(nodes, edges).map(f => f.title);
const ids = (nodes: Node[], edges: Edge[] = []) => runChecks(nodes, edges).map(f => f.id);

describe('quick disconnect pairing', () => {
  it('notes a disconnect with no mate chosen', () => {
    const found = runChecks([qd('QD-1', 'fluid')], []);
    const f = found.find(x => x.id.startsWith('qd-unpaired'))!;
    expect(f.severity).toBe('info');
    expect(f.title).toContain('QD-1');
  });

  it('says nothing about a half declared to need no pair', () => {
    const found = runChecks([qd('QD-1', 'fluid', 'none')], []);
    expect(found.some(f => f.id.includes('qd-'))).toBe(false);
  });

  it('catches a hydraulic half mated to a fluid one', () => {
    const found = runChecks([qd('A', 'fluid', 'B'), qd('B', 'hydraulic', 'A')], []);
    expect(found.find(x => x.id.startsWith('qd-service'))!.severity).toBe('error');
  });

  it('catches a pairing only one of the two agrees with', () => {
    const nodes = [qd('A', 'fluid', 'B'), qd('B', 'fluid', 'C'), qd('C', 'fluid', 'B')];
    expect(ids(nodes)).toContain('qd-asym-A');
  });

  it('catches a pair whose other half has been deleted', () => {
    const found = runChecks([qd('A', 'fluid', 'GONE')], []);
    expect(found.find(x => x.id.startsWith('qd-missing'))!.severity).toBe('error');
  });

  it('is quiet about a correct pair', () => {
    const nodes = [qd('A', 'fluid', 'B'), qd('B', 'fluid', 'A')];
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
  it('asks a tank for pressure, temperature and a fluid, in one breath', () => {
    // One row naming all three, not three rows. See the grouped form below.
    const t = titles([node('TK-1', 'TANK')]);
    const row = t.find(x => x.startsWith('TK-1 has no'))!;
    expect(row).toContain('pressure');
    expect(row).toContain('temperature');
    expect(row).toContain('fluid');
    expect(t.filter(x => x.startsWith('TK-1 has no'))).toHaveLength(1);
  });

  it('asks an engine for a chamber pressure', () => {
    expect(titles([node('ENG', 'ENGINE')]).some(x => x.includes('chamber pressure'))).toBe(true);
  });
});

describe('instruments', () => {
  it('warns about a probe wired into the flow path', () => {
    const nodes = [node('TK', 'TANK'), node('RTD-1', 'RTD')];
    const edges = [edge('a', 'TK', 'RTD-1', 'b', 'l')];
    const f = runChecks(nodes, edges).find(x => x.id === 'instruments-wired')!;
    expect(f.severity).toBe('warning');
  });

  it('says nothing about a probe clipped to what it measures', () => {
    const nodes = [node('TK', 'TANK'), node('RTD-1', 'RTD', { attachedTo: 'TK' })];
    expect(ids(nodes).includes('instruments-wired')).toBe(false);
  });
});

describe('tags', () => {
  it('catches two components answering to one tag', () => {
    // feedtwin.solve.Node calls its id "the tags on the P&ID": a tag is the
    // name one piece of hardware has in a solve, a report and a procedure.
    const nodes = [node('a', 'SOL', { label: 'SOL-01' }), node('b', 'SOL', { label: 'SOL-01' })];
    const f = runChecks(nodes, []).find(x => x.id === 'tag-duplicate-SOL-01')!;
    expect(f.severity).toBe('warning');
    expect(f.nodeIds).toEqual(['a', 'b']);
  });

  it('ignores annotation, which is not hardware', () => {
    const nodes = [node('a', 'REGION', { label: 'GSE' }), node('b', 'REGION', { label: 'GSE' })];
    expect(ids(nodes).some(i => i.startsWith('tag-duplicate'))).toBe(false);
  });

  it('is quiet when tags are distinct', () => {
    const nodes = [node('a', 'SOL', { label: 'SOL-01' }), node('b', 'SOL', { label: 'SOL-02' })];
    expect(ids(nodes).some(i => i.startsWith('tag-duplicate'))).toBe(false);
  });
});

describe('what the badge counts', () => {
  it('counts errors and checks, but not notes', () => {
    // An unfinished drawing is Tuesday, not a fault; a badge that says 40 on
    // every drawing is a badge nobody reads.
    const findings = runChecks([node('SOL-1', 'SOL', { label: 'SOL-1' })], []);
    expect(findings.every(f => f.severity === 'info')).toBe(true);
    expect(countProblems(findings)).toBe(0);
  });

  it('sorts the worst first', () => {
    const nodes = [qd('QD-1', 'fluid'), node('TK-1', 'TANK')];
    const severities = runChecks(nodes, []).map(f => f.severity);
    expect(severities).toEqual([...severities].sort(
      (a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]));
  });
});

describe('a relief valve against the vessel it protects', () => {
  const psi = (value: number, source = 'manufacturer') => ({ value, unit: 'psi', source });
  const tank = (id: string, pressure?: number, burst?: number) => node(id, 'TANK', {
    fluid: 'oxygen',
    params: {
      ...(pressure !== undefined ? { pressure: psi(pressure) } : {}),
      temperature: { value: 90, unit: 'K', source: 'measured' },
      ...(burst !== undefined ? { burst_pressure: psi(burst) } : {}),
    },
  });
  const rv = (id: string, set: number) => node(id, 'RV', { params: { set_pressure: psi(set) } });
  const onTank = [edge('e', 'RV-1', 'TK-1', 'r', 't2')];

  it('is quiet when the relief lifts between operating pressure and burst', () => {
    const found = ids([tank('TK-1', 500, 1200), rv('RV-1', 650)], onTank);
    expect(found.filter(i => /relief|burst|sf/.test(i))).toEqual([]);
  });

  it('flags a relief set at or above the burst pressure', () => {
    // It would not open before the tank failed.
    const found = runChecks([tank('TK-1', 500, 800), rv('RV-1', 900)], onTank);
    const f = found.find(x => x.id === 'relief-over-burst-RV-1')!;
    expect(f.severity).toBe('error');
    expect(f.nodeIds).toEqual(['RV-1', 'TK-1']);
  });

  it('flags a relief set at or below the operating pressure', () => {
    // It would be open the whole time.
    expect(ids([tank('TK-1', 500, 800), rv('RV-1', 500)], onTank)).toContain('relief-under-operating-RV-1');
  });

  it('flags a tank run at or above its burst pressure', () => {
    expect(ids([tank('TK-1', 900, 800)])).toContain('vessel-over-burst-TK-1');
  });

  it('warns about a factor of safety below two', () => {
    // 500 on 800 is 1.6x; 500 on 1200 is 2.4x.
    expect(ids([tank('TK-1', 500, 800)])).toContain('vessel-low-sf-TK-1');
    expect(ids([tank('TK-1', 500, 1200)])).not.toContain('vessel-low-sf-TK-1');
  });

  it('compares across units', () => {
    // 60 bar is 870 psi, above an 800 psi rating.
    const t = node('TK-1', 'TANK', { fluid: 'oxygen', params: {
      pressure: psi(500), temperature: { value: 90, unit: 'K', source: 'measured' }, burst_pressure: psi(800) } });
    const r = node('RV-1', 'RV', { params: { set_pressure: { value: 60, unit: 'bar', source: 'manufacturer' } } });
    expect(ids([t, r], onTank)).toContain('relief-over-burst-RV-1');
  });

  it('finds the tank through a junction, but not through a valve', () => {
    const j = node('J', 'JUNCTION');
    const viaJunction = [edge('a', 'RV-1', 'J', 'r', 'l'), edge('b', 'J', 'TK-1', 't', 't2')];
    expect(ids([tank('TK-1', 500, 800), rv('RV-1', 900), j], viaJunction)).toContain('relief-over-burst-RV-1');
    // Past a valve it is protecting something else, and this drawing has not
    // said what.
    const v = node('SOL-1', 'SOL');
    const viaValve = [edge('a', 'RV-1', 'SOL-1', 'r', 'l'), edge('b', 'SOL-1', 'TK-1', 'r', 't2')];
    expect(ids([tank('TK-1', 500, 800), rv('RV-1', 900), v], viaValve)).not.toContain('relief-over-burst-RV-1');
  });

  it('says nothing when either number is not stated', () => {
    // A missing burst pressure is not a fault, it is Tuesday.
    expect(ids([tank('TK-1', 500), rv('RV-1', 900)], onTank).filter(i => /relief/.test(i))).toEqual([]);
  });
});

describe('a check valve against the flow', () => {
  const tank = (id: string) => node(id, 'TANK', { fluid: 'oxygen', params: {
    pressure: { value: 500, unit: 'psi', source: 'measured' },
    temperature: { value: 90, unit: 'K', source: 'measured' } } });
  const cv = (id: string) => node(id, 'CV');
  const valve = (id: string) => node(id, 'MAN');

  it('is quiet when the inlet faces the source', () => {
    // tank -> CV(l ... r) -> valve
    const edges = [edge('a', 'TK-1', 'CV-1', 'b', 'l'), edge('b', 'CV-1', 'MV-1', 'r', 'l')];
    expect(ids([tank('TK-1'), cv('CV-1'), valve('MV-1')], edges)).not.toContain('cv-backwards-CV-1');
  });

  it('flags one whose inlet is on the far side from the source', () => {
    const edges = [edge('a', 'TK-1', 'CV-1', 'b', 'r'), edge('b', 'CV-1', 'MV-1', 'l', 'l')];
    const f = runChecks([tank('TK-1'), cv('CV-1'), valve('MV-1')], edges).find(x => x.id === 'cv-backwards-CV-1')!;
    expect(f.severity).toBe('warning');
  });

  it('does not judge one plumbed on a single side, or with no source', () => {
    expect(ids([tank('TK-1'), cv('CV-1')], [edge('a', 'TK-1', 'CV-1', 'b', 'r')])).not.toContain('cv-backwards-CV-1');
    const edges = [edge('a', 'MV-2', 'CV-1', 'r', 'r'), edge('b', 'CV-1', 'MV-1', 'l', 'l')];
    expect(ids([valve('MV-2'), cv('CV-1'), valve('MV-1')], edges)).not.toContain('cv-backwards-CV-1');
  });
});

describe('what a fresh drawing says about itself', () => {
  it('lists everything a tank lacks on one row', () => {
    // Two fresh tanks used to put six amber rows in the panel.
    const found = runChecks([node('TK-1', 'TANK'), node('TK-2', 'TANK')], []);
    const rows = found.filter(f => f.id.startsWith('missing-'));
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('TK-1 has no fluid, pressure or temperature');
  });

  it('counts joints priced from an unchecked NPT figure', () => {
    const e = {
      id: 'L1', source: 'A', target: 'B',
      data: { segments: [{
        id: 's', standard: 'NPT', tubeSize: '1/2', joinBy: 'NPT', joinSize: '1/2',
        fittings: [{ id: 'f', kind: 'elbow_90', count: 3 }],
      }] },
    } as unknown as Edge;
    const f = runChecks([node('A', 'MAN'), node('B', 'MAN')], [e]).find(x => x.id === 'joints-unchecked')!;
    expect(f.severity).toBe('info');
    expect(f.title).toMatch(/^2 joints/);
    expect(f.edgeIds).toEqual(['L1']);
  });
});
