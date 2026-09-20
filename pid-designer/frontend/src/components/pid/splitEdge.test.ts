import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { insertInline, mergedLineData, rejoinAfterDelete, rotationAlong, splitEdgeAt } from './splitEdge';
import { faceTowards } from './BranchableEdge';

const node = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y },
  measured: { width: 60, height: 60 },
  data: { componentType: 'MAN', label: id },
});

/** A → B, left to right, with a stated run in it. */
function line() {
  const nodes = [node('A', 0, 0), node('B', 400, 0)];
  const edges: Edge[] = [{
    id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l',
    type: 'smoothstep',
    data: {
      lineType: 'pipe',
      params: {
        length:    { value: 3, unit: 'ft',  source: 'estimate' },
        bore:      { value: 0.5, unit: 'in', source: 'verified' },
        roughness: { value: 1.5e-3, unit: 'mm', source: 'estimate' },
      },
      segments: [{ id: 'seg_1', fittings: [{ id: 'f1', kind: 'elbow_90', count: 2 }] }],
    },
  }];
  return { nodes, edges };
}

describe('the face a split line meets', () => {
  it('points at where the line came from', () => {
    expect(faceTowards(0, 30, 200, 30)).toBe('l');
    expect(faceTowards(400, 30, 200, 30)).toBe('r');
    expect(faceTowards(200, 0, 200, 200)).toBe('t');
    expect(faceTowards(200, 400, 200, 200)).toBe('b');
  });
});

describe('dropping a junction into a line', () => {
  it('leaves two halves that meet it head-on', () => {
    const { nodes, edges } = line();
    const split = splitEdgeAt(nodes, edges, 'A-B', { x: 200, y: 30 })!;

    expect(split.nodes).toHaveLength(3);
    expect(split.edges).toHaveLength(2);

    const [up, down] = split.edges;
    // A horizontal run stays horizontal: it enters the left face and leaves
    // the right one, rather than going up and over the junction.
    expect(up).toMatchObject({ source: 'A', target: split.junctionId, targetHandle: 'l' });
    expect(down).toMatchObject({ source: split.junctionId, sourceHandle: 'r', target: 'B' });
    // and the ends it did not touch are untouched
    expect(up.sourceHandle).toBe('r');
    expect(down.targetHandle).toBe('l');
  });

  it('does not double the pipe', () => {
    const { nodes, edges } = line();
    const [up, down] = splitEdgeAt(nodes, edges, 'A-B', { x: 200, y: 30 })!.edges;

    // What there is only one of stays with the upstream half...
    expect(up.data!.segments).toHaveLength(1);
    expect((up.data!.params as Record<string, unknown>).length).toMatchObject({ value: 3 });
    // ...so that the pair still adds up to three feet and two elbows.
    expect(down.data!.segments).toBeUndefined();
    expect((down.data!.params as Record<string, unknown>).length).toBeUndefined();

    // Bore and roughness are true of both halves, so both get them.
    for (const half of [up, down]) {
      expect((half.data!.params as Record<string, unknown>).bore).toMatchObject({ value: 0.5 });
      expect((half.data!.params as Record<string, unknown>).roughness).toBeDefined();
      expect(half.data!.lineType).toBe('pipe');
    }
  });

  it('puts the junction on the line it landed on, not the page it was drawn from', () => {
    const { nodes, edges } = line();
    const split = splitEdgeAt(nodes, edges, 'A-B', { x: 200, y: 30 }, 'gse')!;
    const junction = split.nodes.find(n => n.id === split.junctionId)!;
    expect(junction.data.page).toBe('gse');
  });

  it('refuses a line it cannot find both ends of', () => {
    const { nodes, edges } = line();
    expect(splitEdgeAt(nodes, edges, 'nope', { x: 0, y: 0 })).toBeNull();
    expect(splitEdgeAt([nodes[0]], edges, 'A-B', { x: 0, y: 0 })).toBeNull();
  });
});

describe('taking the junction back out', () => {
  it('gives back the line that was split', () => {
    const { nodes, edges } = line();
    const [up, down] = splitEdgeAt(nodes, edges, 'A-B', { x: 200, y: 30 })!.edges;

    expect(mergedLineData(up.data, down.data)).toMatchObject({
      lineType: 'pipe',
      segments: edges[0].data!.segments,
      params: edges[0].data!.params,
    });
  });

  it('adds up what both halves came to say', () => {
    const merged = mergedLineData(
      { segments: [{ id: 's1' }], params: { length: { value: 3, unit: 'ft', source: 'estimate' } } },
      { segments: [{ id: 's2' }], params: { length: { value: 2, unit: 'ft', source: 'estimate' } } },
    );
    expect(merged.segments).toHaveLength(2);
    expect((merged.params as Record<string, unknown>).length).toMatchObject({ value: 5, unit: 'ft' });
  });

  it('keeps the order the run is built in', () => {
    const merged = mergedLineData(
      { segments: [{ id: 'half_inch' }] },
      { segments: [{ id: 'quarter_inch' }] },
    );
    expect((merged.segments as { id: string }[]).map(s => s.id))
      .toEqual(['half_inch', 'quarter_inch']);
  });

  it('says nothing rather than the wrong thing when the units disagree', () => {
    const merged = mergedLineData(
      { params: { length: { value: 3, unit: 'ft', source: 'estimate' } } },
      { params: { length: { value: 600, unit: 'mm', source: 'estimate' } } },
    );
    // Not 3, not 603. There is no conversion at this layer, and "not stated"
    // is a thing feed-twin reports; a wrong length is not.
    expect((merged.params as Record<string, unknown>).length).toBeUndefined();
  });
});

describe('what a delete puts back', () => {
  const junction = (id: string): Node => ({
    id, type: 'JUNCTION', position: { x: 0, y: 0 },
    data: { componentType: 'JUNCTION', label: id },
  });
  const wire = (id: string, source: string, target: string, data?: Record<string, unknown>): Edge =>
    ({ id, source, target, sourceHandle: 'r', targetHandle: 'l', data });

  it('rejoins a run through the junction that was taken out', () => {
    const back = rejoinAfterDelete(
      [junction('j1')],
      [wire('a', 'A', 'j1', { lineType: 'pipe' }), wire('b', 'j1', 'B')],
    );
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ source: 'A', target: 'B', data: { lineType: 'pipe' } });
  });

  it('follows a chain, so two junctions in a row still leave one line', () => {
    const back = rejoinAfterDelete(
      [junction('j1'), junction('j2')],
      [wire('a', 'A', 'j1'), wire('b', 'j1', 'j2'), wire('c', 'j2', 'B')],
    );
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ source: 'A', target: 'B' });
  });

  it('leaves a branch alone: three legs are not one run', () => {
    // A tee with a relief valve on it. There is no single line to give back,
    // so deleting it takes what was attached, as it always did.
    expect(rejoinAfterDelete(
      [junction('j1')],
      [wire('a', 'A', 'j1'), wire('b', 'j1', 'B'), wire('c', 'RV', 'j1')],
    )).toEqual([]);
  });

  it('does not rejoin to something that was deleted too', () => {
    expect(rejoinAfterDelete(
      [junction('j1'), { id: 'B', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'j1'), wire('b', 'j1', 'B')],
    )).toEqual([]);
  });

  it('ignores a delete with nothing mid-run in it', () => {
    expect(rejoinAfterDelete(
      [{ id: 'T', type: 'TANK', position: { x: 0, y: 0 }, data: { componentType: 'TANK' } }],
      [wire('a', 'A', 'T'), wire('b', 'T', 'B')],
    )).toEqual([]);
  });

  it('heals the run when a valve is taken out of it', () => {
    // A valve is a part *in* a run, so taking it out leaves the run, exactly
    // as putting it in left the run. A tank is a place, and is not rejoined.
    const [back] = rejoinAfterDelete(
      [{ id: 'V', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'V'), wire('b', 'V', 'B')],
    );
    expect(back).toMatchObject({ source: 'A', target: 'B' });
  });

  it('does not heal round a valve that vents: one line is not a run', () => {
    expect(rejoinAfterDelete(
      [{ id: 'V', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'V')],
    )).toEqual([]);
  });

  it('adds the two halves back up', () => {
    const { nodes, edges } = line();
    const split = splitEdgeAt(nodes, edges, 'A-B', { x: 200, y: 30 })!;
    const j = split.nodes.find(n => n.id === split.junctionId)!;
    const [back] = rejoinAfterDelete([j], split.edges);
    expect(back.data).toMatchObject({
      segments: edges[0].data!.segments,
      params: edges[0].data!.params,
    });
  });
});

describe('dropping a part into a line', () => {
  const part = (id: string) => ({
    id, type: 'MAN', position: { x: 999, y: 999 }, measured: { width: 60, height: 60 },
    data: { componentType: 'MAN', label: id },
  });

  it('breaks the run around it, upstream to the inlet and outlet to downstream', () => {
    const { nodes, edges } = line();
    const ins = insertInline(nodes, edges, 'A-B', { x: 200, y: 30 }, part('V'))!;
    const into = ins.edges.find(e => e.target === 'V')!;
    const outOf = ins.edges.find(e => e.source === 'V')!;
    expect(into).toMatchObject({ source: 'A', targetHandle: 'l' });
    expect(outOf).toMatchObject({ target: 'B', sourceHandle: 'r' });
    expect(ins.edges.find(e => e.id === 'A-B')).toBeUndefined();
  });

  it('is centred on the cut, so its ports sit on the pipe', () => {
    const { nodes, edges } = line();
    const ins = insertInline(nodes, edges, 'A-B', { x: 200, y: 30 }, part('V'))!;
    expect(ins.nodes.find(n => n.id === 'V')!.position).toEqual({ x: 170, y: 0 });
  });

  it('is turned to face the way the run goes', () => {
    expect(rotationAlong({ x: 1, y: 0 })).toBe(0);
    expect(rotationAlong({ x: 0, y: 1 })).toBe(90);
    expect(rotationAlong({ x: -1, y: 0 })).toBe(180);
    expect(rotationAlong({ x: 0, y: -1 })).toBe(270);
    const { nodes, edges } = line();
    const ins = insertInline(nodes, edges, 'A-B', { x: 200, y: 30 }, part('V'))!;
    expect((ins.nodes.find(n => n.id === 'V')!.data as { rotation: number }).rotation).toBe(0);
  });

  it('drops a corner its body has swallowed, so the outlet line does not double back', () => {
    // A run that turns 20 px past where the valve goes in: the corner is
    // inside the 60 px valve, and a line from the outlet that went back to
    // it would run through the valve to get there.
    const nodes = [node('A', 0, 0), node('B', 400, 200)];
    const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} }];
    const drawn = [{ x: 60, y: 30 }, { x: 220, y: 30 }, { x: 220, y: 230 }, { x: 400, y: 230 }];
    const ins = insertInline(nodes, edges, 'A-B', { x: 200, y: 30 }, part('V'), { points: drawn })!;
    const outOf = ins.edges.find(e => e.source === 'V')!.data as { waypoints?: { x: number; y: number }[] };
    expect(outOf.waypoints).toBeUndefined();
  });

  it('does not double the pipe either', () => {
    const { nodes, edges } = line();
    const ins = insertInline(nodes, edges, 'A-B', { x: 200, y: 30 }, part('V'))!;
    const outOf = ins.edges.find(e => e.source === 'V')!;
    expect((outOf.data as { params: Record<string, unknown> }).params.length).toBeUndefined();
    expect((outOf.data as { segments?: unknown }).segments).toBeUndefined();
  });
});

describe('a run routed by hand keeps its corners when it is cut', () => {
  it('gives each half the corners on its side of the cut', () => {
    const nodes = [node('A', 0, 0), node('B', 400, 200)];
    const edges: Edge[] = [{
      id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep',
      data: { waypoints: [{ x: 100, y: 30 }, { x: 100, y: 230 }] },
    }];
    const drawn = [{ x: 60, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 230 }, { x: 400, y: 230 }];
    const split = splitEdgeAt(nodes, edges, 'A-B', { x: 100, y: 130 }, undefined, { points: drawn })!;
    const up = split.edges.find(e => e.source === 'A')!.data as { waypoints?: unknown[] };
    const down = split.edges.find(e => e.target === 'B')!.data as { waypoints?: unknown[] };
    expect(up.waypoints).toEqual([{ x: 100, y: 30 }]);
    expect(down.waypoints).toEqual([{ x: 100, y: 230 }]);
    // Rejoined, the corners a person set come back together, in order.
    const j = split.nodes.find(n => n.id === split.junctionId)!;
    const [back] = rejoinAfterDelete([j], split.edges);
    expect((back.data as { waypoints?: unknown }).waypoints).toEqual([{ x: 100, y: 30 }, { x: 100, y: 230 }]);
    expect((j.data as { along: { t: number } }).along.t).toBeCloseTo((40 + 100) / (40 + 200 + 300));
  });
});

describe('cutting a half that carries the run\'s own corners', () => {
  it('treats it as routed by the run, not by hand', () => {
    const nodes = [node('A', 0, 0), node('B', 400, 200)];
    const edges: Edge[] = [{
      id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep',
      data: { waypoints: [{ x: 230, y: 30 }, { x: 230, y: 230 }], viaRun: true },
    }];
    const drawn = [{ x: 60, y: 30 }, { x: 230, y: 30 }, { x: 230, y: 230 }, { x: 400, y: 230 }];
    const split = splitEdgeAt(nodes, edges, 'A-B', { x: 230, y: 130 }, undefined, { points: drawn })!;
    const up = split.edges.find(e => e.source === 'A')!.data as { viaRun?: boolean };
    const down = split.edges.find(e => e.target === 'B')!.data as { viaRun?: boolean };
    expect(up.viaRun).toBe(true);
    expect(down.viaRun).toBe(true);
  });
});

describe('healing a run drops the corners the part had made', () => {
  it('keeps a person\'s corners elsewhere and forgets the ones inside the valve', () => {
    const valve = { id: 'V', type: 'MAN', position: { x: 170, y: 0 }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN' } };
    const [back] = rejoinAfterDelete([valve], [
      { id: 'a', source: 'A', sourceHandle: 'r', target: 'V', targetHandle: 'l', data: { waypoints: [{ x: 100, y: 30 }, { x: 100, y: -40 }, { x: 160, y: -40 }, { x: 160, y: 30 }] } },
      { id: 'b', source: 'V', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: { waypoints: [{ x: 225, y: 30 }, { x: 300, y: 30 }] } },
    ]);
    // (160, 30) is ten pixels short of the valve and stays; (225, 30) was
    // inside it and goes.
    expect((back.data as { waypoints: { x: number; y: number }[] }).waypoints)
      .toEqual([{ x: 100, y: 30 }, { x: 100, y: -40 }, { x: 160, y: -40 }, { x: 160, y: 30 }, { x: 300, y: 30 }]);
  });
});
