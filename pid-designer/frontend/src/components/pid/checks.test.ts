import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { runChecks, countProblems } from './checks';
import { reseatJunctions } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { translateSubgraph } from './graphOps';
import { unmeasuredEnd } from './unmeasured';
import { drawnRoute } from './lineRoute';
import { drawnScene } from './tracks';
import { DOT_CLEAR } from './routeGrid';
import { pathPoints, routeOrthogonal } from './route';
import type { Pt } from './route';

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
    // Nor calls it one measuring nothing: the symbol it is clipped to is there.
    expect(ids(nodes).includes('instruments-floating')).toBe(false);
  });

  it('says nothing about a probe clipped to a line that is there', () => {
    const nodes = [node('TK', 'TANK'), node('V', 'SOL'), node('TC-1', 'TC', { attachedTo: 'TK-V', attachedAt: 0.4 })];
    expect(ids(nodes, [edge('TK-V', 'TK', 'V')]).includes('instruments-floating')).toBe(false);
  });

  it('counts a probe clipped to something that is gone as measuring nothing', () => {
    // The line it was dropped on was cut in two by a tee, and the symbol
    // another one was on has been deleted: neither draws a leader any more,
    // so the checks cannot stay quiet about them.
    const nodes = [
      node('TK', 'TANK'), node('V', 'SOL'),
      node('TC-1', 'TC', { attachedTo: 'TK-V' }),
      node('RTD-1', 'RTD', { attachedTo: 'TK-2' }),
    ];
    const edges = [edge('TK-j', 'TK', 'j'), edge('j-V', 'j', 'V')];
    const f = runChecks(nodes, edges).find(x => x.id === 'instruments-floating')!;
    expect(f.nodeIds).toEqual(['TC-1', 'RTD-1']);
    expect(f.detail).toContain('2 of them were clipped to something');
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

describe('two lines on one port', () => {
  it('names the port and both lines, as a drawing saved before tees were made there can have', () => {
    // The oxidiser tank's lid, press line and vent both on `t`.
    const nodes = [node('OXT', 'TANK'), node('SVOP', 'SOL'), node('SVOV', 'SOL')];
    const edges = [edge('l_oxp', 'SVOP', 'OXT', 'r', 't'), edge('l_oxv', 'OXT', 'SVOV', 't', 'l')];
    const f = runChecks(nodes, edges).find(x => x.id.startsWith('lines-share-port'))!;
    expect(f.severity).toBe('warning');
    expect(f.title).toContain('OXT');
    expect(f.nodeIds).toEqual(['OXT']);
    expect(f.edgeIds).toEqual(['l_oxp', 'l_oxv']);
  });

  it('says nothing of one line a port, or of a tee, whose faces all carry lines', () => {
    const nodes = [node('OXT', 'TANK'), node('SVOP', 'SOL'), node('SVOV', 'SOL'), node('j', 'JUNCTION')];
    const edges = [edge('a', 'SVOP', 'OXT', 'r', 't'), edge('b', 'OXT', 'SVOV', 'b', 'l'),
      edge('c', 'j', 'SVOP', 'r', 'l'), edge('d', 'SVOV', 'j', 'r', 'r')];
    expect(ids(nodes, edges).some(id => id.startsWith('lines-share-port'))).toBe(false);
  });
});

// Symbols where they stand on the sheet, as the canvas has them measured.
const at = (id: string, componentType: string, x: number, y: number, page = 'Main'): Node => ({
  id, type: componentType, position: { x, y },
  measured: componentType === 'TANK' ? { width: 60, height: 100 } : { width: 60, height: 60 },
  data: { componentType, label: id, page },
});
const line = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): Edge =>
  ({ id, source, sourceHandle, target, targetHandle, type: 'smoothstep', data: {} });

describe('a line drawn through a symbol it does not join', () => {
  /**
   * A bay made as the canvas makes one -- MAN-1 to MAN-2, teed at x = 300
   * with a branch down to TK-1, settled -- and then picked up whole and let
   * go `by`, rigidly, as a group move puts it down.
   */
  function bay(by: { x: number; y: number }, others: Node[] = []) {
    const nodes = [at('MAN-1', 'MAN', 100, 100), at('MAN-2', 'MAN', 500, 100), at('TK-1', 'TANK', 270, 300)];
    const split = splitEdgeAt(nodes, [line('run', 'MAN-1', 'r', 'MAN-2', 'l')], 'run', { x: 300, y: 130 }, undefined,
      { points: [{ x: 163, y: 130 }, { x: 497, y: 130 }] })!;
    const settled = reseatJunctions(split.nodes, [...split.edges, line('branch', split.junctionId, 'b', 'TK-1', 't')], unmeasuredEnd);
    const moved = translateSubgraph(settled.nodes, settled.edges, settled.nodes.map(n => n.id), by);
    return { nodes: [...moved.nodes, ...others], edges: moved.edges, tee: split.junctionId };
  }
  const through = (g: { nodes: Node[]; edges: Edge[] }) => runChecks(g.nodes, g.edges).filter(f => f.id.startsWith('drawn-through'));

  it('names the symbol, the pipe and the branch through it, and the tee inside it, when a bay is let go onto a valve', () => {
    // The tee lands at (890, 150), inside SOL-1's box, 870..930 by 120..180.
    const g = bay({ x: 590, y: 20 }, [at('SOL-1', 'SOL', 870, 120)]);
    const [f, ...more] = through(g);
    expect(more).toEqual([]);
    expect(f).toMatchObject({ id: 'drawn-through-SOL-1', severity: 'warning' });
    expect(f.title).toBe('2 lines run through SOL-1 without joining it');
    expect(f.detail).toContain('MAN-1 to MAN-2');
    expect(f.detail).toContain('TK-1 to a tee');
    expect(f.detail).toContain('a tee inside it');
    expect(f.nodeIds).toEqual(['SOL-1', g.tee]);
    // Both halves of the pipe and the branch: what a click selects.
    expect([...f.edgeIds!].sort()).toEqual([...g.edges.map(e => e.id)].sort());
    expect(countProblems(runChecks(g.nodes, g.edges))).toBeGreaterThan(0);
  });

  it('says so of a single line across a symbol, with no tee in it', () => {
    // SOL-1 down on the pipe between MAN-1 and the tee.
    const g = bay({ x: 0, y: 0 }, [at('SOL-1', 'SOL', 200, 100)]);
    const [f, ...more] = through(g);
    expect(more).toEqual([]);
    expect(f.title).toBe('A line runs through SOL-1 without joining it');
    expect(f.nodeIds).toEqual(['SOL-1']);
    expect(f.edgeIds).toHaveLength(1);
  });

  it('says nothing of the same bay let go clear of the valve, or of a line into the valve\'s own port', () => {
    expect(through(bay({ x: 590, y: 20 }, [at('SOL-1', 'SOL', 1000, 250)]))).toEqual([]);
    const joined = bay({ x: 0, y: 0 }, [at('SOL-1', 'SOL', 600, 100)]);
    expect(through({ ...joined, edges: [...joined.edges, line('on', 'MAN-2', 'r', 'SOL-1', 'l')] })).toEqual([]);
  });

  it('says nothing of a line routed round a symbol in its way, or run along the edge of one', () => {
    // MAN-1 to MAN-2 straight across, with SOL-1 in the way: the line goes round it.
    const nodes = [at('MAN-1', 'MAN', 100, 100), at('MAN-2', 'MAN', 500, 100), at('SOL-1', 'SOL', 270, 100)];
    expect(through({ nodes, edges: [line('run', 'MAN-1', 'r', 'MAN-2', 'l')] })).toEqual([]);
    // Held by a person's corners along the top edge of a symbol: touching it,
    // not in it. Two pixels further down, it is in it.
    const hand = { ...line('run', 'MAN-1', 'r', 'MAN-2', 'l'), data: { waypoints: [{ x: 230, y: 130 }, { x: 400, y: 130 }] } };
    const beside = (y: number) => [at('MAN-1', 'MAN', 100, 100), at('MAN-2', 'MAN', 500, 100), at('SOL-1', 'SOL', 270, y)];
    expect(through({ nodes: beside(130), edges: [hand] })).toEqual([]);
    expect(through({ nodes: beside(128), edges: [hand] }).map(f => f.title)).toEqual(['A line runs through SOL-1 without joining it']);
  });

  it('says nothing of a section box or a probe over a line, or a symbol on another page', () => {
    for (const other of [at('GSE', 'REGION', 250, 100), at('RTD-1', 'RTD', 280, 110), at('SOL-1', 'SOL', 870, 120, 'Vehicle')]) {
      expect(through(bay({ x: 590, y: 20 }, [other])), other.id).toEqual([]);
    }
  });
});

describe('a line drawn through a tee or an open end it does not join', () => {
  const dot = (id: string, x: number, y: number, page = 'Main'): Node => ({
    id, type: 'JUNCTION', position: { x, y }, measured: { width: 10, height: 10 },
    data: { componentType: 'JUNCTION', label: id, page },
  });

  /**
   * MAN-1 to MAN-2 across the sheet at y = 130, teed at x = 300 as the
   * canvas tees one -- with a branch down to `branchTo` when given -- and
   * settled.
   */
  function header(branchTo?: Node) {
    const nodes = [at('MAN-1', 'MAN', 100, 100), at('MAN-2', 'MAN', 500, 100), ...(branchTo ? [branchTo] : [])];
    const split = splitEdgeAt(nodes, [line('run', 'MAN-1', 'r', 'MAN-2', 'l')], 'run', { x: 300, y: 130 }, undefined,
      { points: [{ x: 163, y: 130 }, { x: 497, y: 130 }] })!;
    const edges = branchTo ? [...split.edges, line('branch', split.junctionId, 'b', branchTo.id, 't')] : split.edges;
    return { ...reseatJunctions(split.nodes, edges, unmeasuredEnd), tee: split.junctionId };
  }
  /**
   * TK-A over TK-B, the line between them held by a person's corners
   * straight down at `x`. A line that routes itself goes around the dot of a
   * junction it does not end on (`routeGrid.lineGrid`), so it is never the
   * one drawn through a tee; a person's corners are drawn where they were
   * put, and a line held by them runs wherever they run.
   */
  const down = (x: number, page = 'Main') => ({
    nodes: [at('TK-A', 'TANK', x - 30, -200, page), at('TK-B', 'TANK', x - 30, 300, page)],
    edges: [{ ...line('down', 'TK-A', 'b', 'TK-B', 't'), data: { waypoints: [{ x, y: 0 }, { x, y: 250 }] } }],
  });
  /**
   * TK-14 to TK-15 straight down at x = 570, teed near its foot at y = 450
   * with a branch across to SOL-1, as the canvas makes one, and settled: a
   * pipe, whose lines draw their slices of the one route it was seated on.
   */
  function riser() {
    const nodes = [at('TK-14', 'TANK', 540, -200), at('TK-15', 'TANK', 540, 500), at('SOL-1', 'SOL', 440, 420)];
    const split = splitEdgeAt(nodes, [line('tt-tu', 'TK-14', 'b', 'TK-15', 't')], 'tt-tu', { x: 570, y: 450 }, undefined,
      { points: [{ x: 570, y: -97 }, { x: 570, y: 497 }] })!;
    const edges = [...split.edges, line('off', split.junctionId, 'l', 'SOL-1', 'r')];
    return { ...reseatJunctions(split.nodes, edges, unmeasuredEnd), tee: split.junctionId };
  }
  const plus = (g: { nodes: Node[]; edges: Edge[] }, more: { nodes: Node[]; edges: Edge[] }) =>
    ({ nodes: [...g.nodes, ...more.nodes], edges: [...g.edges, ...more.edges] });
  const onDots = (g: { nodes: Node[]; edges: Edge[] }) => runChecks(g.nodes, g.edges).filter(f => f.id.startsWith('on-junction'));
  /** How near a drawn line comes to a point. */
  const nearest = (run: Pt[], c: Pt) => Math.min(...run.slice(0, -1).map((p, i) => {
    const q = run[i + 1];
    return Math.hypot(c.x - Math.max(Math.min(p.x, q.x), Math.min(Math.max(p.x, q.x), c.x)), c.y - Math.max(Math.min(p.y, q.y), Math.min(Math.max(p.y, q.y), c.y)));
  }));

  it('names the line and the pipe the tee rides when a line is drawn through the tee', () => {
    const h = header();
    const g = plus(h, down(300));
    const [f, ...more] = onDots(g);
    expect(more).toEqual([]);
    expect(f).toMatchObject({ id: `on-junction-${h.tee}`, severity: 'warning' });
    expect(f.title).toBe('TK-A to TK-B runs through the tee on MAN-1 to MAN-2 without joining it');
    expect(f.detail).toContain('The tee on MAN-1 to MAN-2 is drawn on TK-A to TK-B');
    expect(f.nodeIds).toEqual([h.tee]);
    expect(f.edgeIds).toEqual(['down']);
    expect(countProblems(runChecks(g.nodes, g.edges))).toBeGreaterThan(0);
  });

  it('says so when a group move lets a bay go with its tee on another pipe', () => {
    // The bay's tee lands at (570, 160), on the pipe from TK-14 down to
    // TK-15, whose line then runs straight through its dot: a four-way joint
    // on the page, and nothing joins them. The pipe's line is where its pipe
    // was seated, and a tee let go on it does not move it; it is named by the
    // pipe's two ends, and it is the one line of the pipe through the dot.
    const bay = header(at('TK-1', 'TANK', 370, 300));
    const pipe = riser();
    expect(onDots(plus(bay, pipe))).toEqual([]);
    const moved = translateSubgraph(bay.nodes, bay.edges, bay.nodes.map(n => n.id), { x: 270, y: 30 });
    const [f, ...more] = onDots(plus(moved, pipe));
    expect(more).toEqual([]);
    expect(f.title).toBe('TK-14 to TK-15 runs through the tee on MAN-1 to MAN-2 without joining it');
    expect(f.nodeIds).toEqual([bay.tee]);
    expect(f.edgeIds).toEqual(pipe.edges.filter(e => e.source === 'TK-14').map(e => e.id));
  });

  it('takes a line nearer the dot than a line joined to it ends, and not one a grid step off', () => {
    for (const x of [300, 296, 305, 309]) expect(onDots(plus(header(), down(x))), `line at x = ${x}`).toHaveLength(1);
    // Ten pixels off the tee's centre is a crossing beside it, hopped as
    // any crossing is; further off it is nothing to do with the tee at all.
    for (const x of [310, 290, 320, 400]) expect(onDots(plus(header(), down(x))), `line at x = ${x}`).toEqual([]);
  });

  it('names an open end by where its line comes from', () => {
    // MAN-1's line ends in an open end at (400, 130), and TK-A to TK-B runs down through it.
    const g = {
      nodes: [at('MAN-1', 'MAN', 100, 100), dot('end', 395, 125), ...down(400).nodes],
      edges: [line('run', 'MAN-1', 'r', 'end', 'l'), ...down(400).edges],
    };
    const [f, ...more] = onDots(g);
    expect(more).toEqual([]);
    expect(f.title).toBe('TK-A to TK-B runs through the open end of the line from MAN-1 without joining it');
    expect(f.nodeIds).toEqual(['end']);
  });

  it('says a line ends on a tee when its open end is put down on the tee\'s ring, and that the pipe runs through the open end', () => {
    // TK-A's line comes down to an open end whose dot is 8 px over the tee's:
    // its anchor is on the far side of its own dot, and it still reads as a
    // line into the tee.
    const h = header();
    const g = plus(h, { nodes: [at('TK-A', 'TANK', 270, -200), dot('O', 295, 117)], edges: [line('down', 'TK-A', 'b', 'O', 't')] });
    const found = onDots(g);
    expect(found.map(f => f.title).sort()).toEqual([
      'MAN-1 to MAN-2 runs through the open end of the line from TK-A without joining it',
      'TK-A to an open end ends on the tee on MAN-1 to MAN-2 without joining it',
    ]);
    expect(found.find(f => f.nodeIds![0] === 'O')!.edgeIds!.sort()).toEqual(h.edges.map(e => e.id).sort());
  });

  it('names a tee that rides no pipe by what its lines join', () => {
    // A corner tee from MAN-1 up to an open end, and TK-B's line brought up
    // to an open end whose dot is 8 px under it.
    const g = {
      nodes: [at('MAN-1', 'MAN', 100, 100), dot('j', 295, 125), dot('up', 295, 40), at('TK-B', 'TANK', 270, 300), dot('low', 295, 133)],
      edges: [line('in', 'MAN-1', 'r', 'j', 'l'), line('rise', 'j', 't', 'up', 'b'), line('from-below', 'TK-B', 't', 'low', 'b')],
    };
    const f = onDots(g).find(x => x.nodeIds![0] === 'j')!;
    expect(f.title).toBe('TK-B to an open end ends on the tee joining MAN-1 and an open end without joining it');
    expect(f.detail).toContain('Move the tee or the line clear.');
  });

  it('judges a line that routes itself where the page draws it, clear of a dot its plain route would cross', () => {
    // SOL-A to SOL-B is a Z whose crossbar, drawn by its two ends alone, is
    // at x = 300, straight through the tee. That line can no longer be drawn
    // through the dot: a line that routes itself goes around the dots it does
    // not end on (`routeGrid.lineGrid`), and the page draws its crossbar two
    // grid steps over. So what is asserted is that the router keeps it clear
    // of the dot -- as far as a way around a dot keeps (`DOT_CLEAR`), on the
    // page and in the check's reading of it alike -- and that the check,
    // reading it there, says nothing.
    const g = plus(header(), {
      nodes: [at('SOL-A', 'SOL', 100, 70), at('SOL-B', 'SOL', 440, 300)],
      edges: [line('z', 'SOL-A', 'r', 'SOL-B', 'l')],
    });
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const z = g.edges.find(e => e.id === 'z')!;
    const plain = pathPoints(routeOrthogonal(unmeasuredEnd(byId.get('SOL-A')!, 'r')!, unmeasuredEnd(byId.get('SOL-B')!, 'l')!).d);
    expect(plain.some(p => p.x === 300)).toBe(true);
    const tee = { x: 300, y: 130 };
    for (const drawn of [drawnRoute(z, byId, unmeasuredEnd)!, drawnScene(g.nodes, g.edges, unmeasuredEnd).get('z')!]) {
      expect(nearest(drawn, tee), JSON.stringify(drawn)).toBeGreaterThanOrEqual(DOT_CLEAR);
    }
    expect(onDots(g)).toEqual([]);
  });

  it('says nothing of the lines on the tee, of a bay on its own, or of a line on another page', () => {
    expect(onDots(header())).toEqual([]);
    expect(onDots(header(at('TK-1', 'TANK', 270, 300)))).toEqual([]);
    expect(onDots(plus(header(), down(300, 'Vehicle')))).toEqual([]);
  });
});
