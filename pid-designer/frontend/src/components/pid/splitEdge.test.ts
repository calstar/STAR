import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  dissolveAfterDelete, healThrough, insertInline, isMidRun, mergedLineData, reclipAfterRejoin, rejoinChains,
  rotationAlong, splitEdgeAt, tapLine,
} from './splitEdge';
import { faceTowards } from './BranchableEdge';
import { Position } from '@xyflow/react';
import { J_END, isJunction, junctionEnd, pipeGeometry, pipesOf, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { pathPoints, routeOrthogonal, routeThrough } from './route';
import type { End, Pt } from './route';

/** The lines a delete puts back, given the ids left on the drawing (none, unless said). */
const rejoin = (deletedNodes: Node[], deletedEdges: Edge[], taken: ReadonlySet<string> = new Set()) =>
  rejoinChains(deletedNodes, deletedEdges, taken).map(r => r.edge);

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

  it('keeps the router\'s corners of both halves, as the router\'s, so the run keeps its shape', () => {
    const up = { waypoints: [{ x: 230, y: 30 }], viaRun: true, offset: 0 };
    const down = { waypoints: [{ x: 230, y: 330 }], viaRun: true, offset: 0 };
    expect(mergedLineData(up, down)).toMatchObject({ waypoints: [{ x: 230, y: 30 }, { x: 230, y: 330 }], viaRun: true });
    // A person's corners on either half make the whole run a person's.
    const byHand = mergedLineData(up, { waypoints: [{ x: 230, y: 330 }] });
    expect(byHand.waypoints).toEqual([{ x: 230, y: 30 }, { x: 230, y: 330 }]);
    expect(byHand.viaRun).toBeUndefined();
    expect(mergedLineData({ offset: 0 }, {}).waypoints).toBeUndefined();
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
    const back = rejoin(
      [junction('j1')],
      [wire('a', 'A', 'j1', { lineType: 'pipe' }), wire('b', 'j1', 'B')],
    );
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ source: 'A', target: 'B', data: { lineType: 'pipe' } });
  });

  it('follows a chain, so two junctions in a row still leave one line', () => {
    const back = rejoin(
      [junction('j1'), junction('j2')],
      [wire('a', 'A', 'j1'), wire('b', 'j1', 'j2'), wire('c', 'j2', 'B')],
    );
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ source: 'A', target: 'B' });
  });

  it('leaves a branch alone: three legs are not one run', () => {
    // A tee with a relief valve on it. There is no single line to give back,
    // so deleting it takes what was attached, as it always did.
    expect(rejoin(
      [junction('j1')],
      [wire('a', 'A', 'j1'), wire('b', 'j1', 'B'), wire('c', 'RV', 'j1')],
    )).toEqual([]);
  });

  it('does not rejoin to something that was deleted too', () => {
    expect(rejoin(
      [junction('j1'), { id: 'B', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'j1'), wire('b', 'j1', 'B')],
    )).toEqual([]);
  });

  it('ignores a delete with nothing mid-run in it', () => {
    expect(rejoin(
      [{ id: 'T', type: 'TANK', position: { x: 0, y: 0 }, data: { componentType: 'TANK' } }],
      [wire('a', 'A', 'T'), wire('b', 'T', 'B')],
    )).toEqual([]);
  });

  it('heals the run when a valve is taken out of it', () => {
    // A valve is a part *in* a run, so taking it out leaves the run, exactly
    // as putting it in left the run. A tank is a place, and is not rejoined.
    const [back] = rejoin(
      [{ id: 'V', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'V'), wire('b', 'V', 'B')],
    );
    expect(back).toMatchObject({ source: 'A', target: 'B' });
  });

  it('does not heal round a valve that vents: one line is not a run', () => {
    expect(rejoin(
      [{ id: 'V', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'V')],
    )).toEqual([]);
  });

  it('adds the two halves back up', () => {
    const { nodes, edges } = line();
    const split = splitEdgeAt(nodes, edges, 'A-B', { x: 200, y: 30 })!;
    const j = split.nodes.find(n => n.id === split.junctionId)!;
    const [back] = rejoin([j], split.edges);
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

  it('goes in clear of a bend, so the outlet line does not double back', () => {
    // A run that turns 20 px past where the valve is dropped. Put in there,
    // the bend would be inside the valve and the line from its outlet would
    // have to double back through it; the corner used to be dropped
    // instead, which moved the bend. The valve slides back along the leg
    // until the bend is a stub of line past its outlet, and the bend stays.
    const nodes = [node('A', 0, 0), node('B', 400, 200)];
    const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} }];
    const drawn = [{ x: 60, y: 30 }, { x: 220, y: 30 }, { x: 220, y: 230 }, { x: 400, y: 230 }];
    const ins = insertInline(nodes, edges, 'A-B', { x: 200, y: 30 }, part('V'), { points: drawn })!;
    const v = ins.nodes.find(n => n.id === 'V')!;
    // Its outlet is at x = centre + 30 + 3; the bend at 220 is a stub past it.
    const centreX = v.position.x + 30;
    expect(centreX + 30 + 3 + 16).toBeCloseTo(220);
    const outOf = ins.edges.find(e => e.source === 'V')!.data as { waypoints?: { x: number; y: number }[]; viaRun?: boolean };
    expect(outOf.waypoints).toEqual([{ x: 220, y: 30 }, { x: 220, y: 230 }]);
    expect(outOf.viaRun).toBe(true);
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
    const [back] = rejoin([j], split.edges);
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
    const [back] = rejoin([valve], [
      { id: 'a', source: 'A', sourceHandle: 'r', target: 'V', targetHandle: 'l', data: { waypoints: [{ x: 100, y: 30 }, { x: 100, y: -40 }, { x: 160, y: -40 }, { x: 160, y: 30 }] } },
      { id: 'b', source: 'V', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: { waypoints: [{ x: 225, y: 30 }, { x: 300, y: 30 }] } },
    ]);
    // (160, 30) is ten pixels short of the valve and stays; (225, 30) was
    // inside it and goes.
    expect((back.data as { waypoints: { x: number; y: number }[] }).waypoints)
      .toEqual([{ x: 100, y: 30 }, { x: 100, y: -40 }, { x: 160, y: -40 }, { x: 160, y: 30 }, { x: 300, y: 30 }]);
  });
});

// ── Where the cut goes, and what each half keeps ─────────────────────────────

describe('a tee put into a line goes where it can sit', () => {
  const nodes = () => [node('A', 0, 0), node('B', 400, 300)];
  const zPts = [{ x: 60, y: 30 }, { x: 230, y: 30 }, { x: 230, y: 330 }, { x: 400, y: 330 }];
  const zEdge = (data: Record<string, unknown> = {}): Edge => ({ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data });
  const teeAt = (s: { nodes: Node[]; junctionId: string }) => {
    const j = s.nodes.find(n => n.id === s.junctionId)!;
    return { x: j.position.x + 5, y: j.position.y + 5 };
  };

  it('off a bend, by a tee\'s reach, on the leg it was pressed on', () => {
    const s = splitEdgeAt(nodes(), [zEdge()], 'A-B', { x: 227, y: 30 }, undefined, { points: zPts })!;
    expect(teeAt(s)).toEqual({ x: 216, y: 30 });
    // The downstream half keeps both corners, the upstream half none.
    expect(s.edges.find(e => e.target === s.junctionId)!.data!.waypoints).toBeUndefined();
    expect(s.edges.find(e => e.source === s.junctionId)!.data).toMatchObject({ waypoints: [{ x: 230, y: 30 }, { x: 230, y: 330 }], viaRun: true });
  });

  it('clear of a port at the end of the line', () => {
    const s = splitEdgeAt(nodes(), [zEdge()], 'A-B', { x: 63, y: 30 }, undefined, { points: zPts })!;
    expect(teeAt(s)).toEqual({ x: 74, y: 30 });
  });

  it('with a person\'s corners dealt out by distance along the line, and still a person\'s', () => {
    const wp = [{ x: 230, y: 30 }, { x: 230, y: 330 }];
    const s = splitEdgeAt(nodes(), [zEdge({ waypoints: wp })], 'A-B', { x: 230, y: 200 }, undefined, { points: zPts })!;
    const up = s.edges.find(e => e.target === s.junctionId)!.data as { waypoints?: unknown; viaRun?: boolean };
    const down = s.edges.find(e => e.source === s.junctionId)!.data as { waypoints?: unknown; viaRun?: boolean };
    expect(up).toMatchObject({ waypoints: [{ x: 230, y: 30 }] });
    expect(down).toMatchObject({ waypoints: [{ x: 230, y: 330 }] });
    expect(up.viaRun).toBeUndefined();
    expect(down.viaRun).toBeUndefined();
  });

  it('under ids nothing else on the drawing has', () => {
    // A second line from A to V, drawn earlier, already has the natural name
    // of the upstream half.
    const v: Node = { id: 'V', type: 'MAN', position: { x: 0, y: 0 }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN' } };
    const taken: Edge = { id: 'A-V', source: 'A', sourceHandle: 't', target: 'B', targetHandle: 't', data: {} };
    const ins = insertInline(nodes(), [zEdge(), taken], 'A-B', { x: 120, y: 30 }, v, { points: zPts })!;
    expect(ins.edges.map(x => x.id).sort()).toEqual(['A-V', 'A-V-2', 'V-B']);
  });

  it('re-clips a probe on the line to the half it was on', () => {
    const tc: Node = { id: 'TC1', type: 'TC', position: { x: 0, y: 0 }, data: { componentType: 'TC', attachedTo: 'A-B', attachedAt: 0.1 } };
    const s = splitEdgeAt([...nodes(), tc], [zEdge()], 'A-B', { x: 230, y: 200 }, undefined, { points: zPts })!;
    const up = s.edges.find(e => e.target === s.junctionId)!;
    expect(s.nodes.find(n => n.id === 'TC1')!.data.attachedTo).toBe(up.id);
    const late: Node = { ...tc, data: { ...tc.data, attachedAt: 0.9 } };
    const s2 = splitEdgeAt([...nodes(), late], [zEdge()], 'A-B', { x: 230, y: 200 }, undefined, { points: zPts })!;
    expect(s2.nodes.find(n => n.id === 'TC1')!.data.attachedTo).toBe(s2.edges.find(e => e.source === s2.junctionId)!.id);
  });
});

describe('a part put into a line goes where it fits', () => {
  const part = (id: string): Node => ({ id, type: 'MAN', position: { x: 0, y: 0 }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id } });

  it('slid along the leg until the bend is a stub past its outlet', () => {
    const nodes = [node('A', 0, 0), node('B', 400, 300)];
    const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} }];
    const pts = [{ x: 60, y: 30 }, { x: 230, y: 30 }, { x: 230, y: 330 }, { x: 400, y: 330 }];
    const ins = insertInline(nodes, edges, 'A-B', { x: 215, y: 30 }, part('V'), { points: pts })!;
    // Its reach: half its 60, the 3 px handle, a 16 px stub.
    expect(ins.nodes.find(n => n.id === 'V')!.position).toEqual({ x: 230 - 49 - 30, y: 0 });
  });

  it('is not put into a gap narrower than itself, and is into one it clears without its stubs', () => {
    // A.r at 60 and B.l at `60 + gap`: a 60 px valve and its two 3 px handles
    // need 68 of it. Put into less, it sat on both its neighbours.
    const into = (gap: number) => {
      const nodes = [node('A', 0, 0), node('B', 60 + gap, 0)];
      const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} }];
      return insertInline(nodes, edges, 'A-B', { x: 60 + gap / 2, y: 30 }, part('V'), { points: [{ x: 60, y: 30 }, { x: 60 + gap, y: 30 }] });
    };
    for (const gap of [10, 30, 50, 66]) expect(into(gap), `${gap}`).toBeNull();
    for (const gap of [70, 90, 120]) {
      const v = into(gap)!.nodes.find(n => n.id === 'V')!;
      expect(v.position.x, `${gap}`).toBe(60 + gap / 2 - 30);
    }
  });

  it('re-clips a probe on the line to the half it was on', () => {
    const nodes = [node('A', 0, 0), node('B', 400, 0)];
    const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} }];
    const tc: Node = { id: 'TC1', type: 'TC', position: { x: 0, y: 0 }, data: { componentType: 'TC', attachedTo: 'A-B', attachedAt: 0.8 } };
    const ins = insertInline([...nodes, tc], edges, 'A-B', { x: 150, y: 30 }, part('V'), { points: [{ x: 60, y: 30 }, { x: 400, y: 30 }] })!;
    expect(ins.nodes.find(n => n.id === 'TC1')!.data.attachedTo).toBe(ins.edges.find(e => e.source === 'V')!.id);
  });
});

describe('an instrument dropped on a line', () => {
  const pt = (id: string): Node => ({ id, type: 'PT', position: { x: 0, y: 0 }, data: { componentType: 'PT', label: id } });
  const tee = (r: { nodes: Node[]; junctionId: string }) => {
    const n = r.nodes.find(x => x.id === r.junctionId)!;
    return { x: n.position.x + 5, y: n.position.y + 5 };
  };

  it('stands straight off the tee, wherever along the line the tee has to go', () => {
    // Dropped 5 px before the bend: the tee goes 14 px clear of it, and the
    // transducer over the tee, not over where it was dropped.
    const nodes = [node('A', 0, 0), node('B', 170, 200)];
    const e: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 't', data: {} };
    const r = tapLine(nodes, [e], 'A-B', { x: 195, y: 30 }, { x: 195, y: 0 }, pt('PT1'),
      { points: [{ x: 60, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 200 }] })!;
    const c = tee(r);
    expect(c).toEqual({ x: 186, y: 30 });
    const placed = r.nodes.find(n => n.id === 'PT1')!;
    // Its port, the middle of its bottom side, straight above the tee.
    expect(placed.position).toEqual({ x: c.x - 30, y: c.y - 90 });
    expect(r.edges.find(x => x.source === 'PT1')).toMatchObject({ target: r.junctionId, targetHandle: 't' });
  });

  it('meets the tee across the run the tee is on, not the leg it was dropped on', () => {
    // A 20 px leg holds no tee: it goes onto a leg that runs across the one
    // dropped on, and the tapping still goes in across the tee's own run.
    const nodes = [node('A', 0, 0), node('B', 300, 20)];
    const e: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
    const r = tapLine(nodes, [e], 'A-B', { x: 150, y: 40 }, { x: 170, y: 40 }, pt('PT1'),
      { points: [{ x: 60, y: 30 }, { x: 150, y: 30 }, { x: 150, y: 50 }, { x: 300, y: 50 }] })!;
    const line = r.edges.find(x => x.source === 'PT1')!;
    expect(['t', 'b']).toContain(line.targetHandle);
    const placed = r.nodes.find(n => n.id === 'PT1')!;
    expect(placed.position.x).toBe(tee(r).x - 30);
  });
});

describe('what a delete puts back, and takes away', () => {
  const riding = (id: string, cx: number): Node => ({
    id, type: 'JUNCTION', position: { x: cx - 5, y: 25 },
    data: { componentType: 'JUNCTION', label: id, along: { t: 0.5, in: 'l', out: 'r', from: 'A', to: 'B' } },
  });
  const line = (id: string, s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
    ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th, data });
  const bore = (v: number) => ({ params: { bore: { value: v, unit: 'in', source: 'estimated' } } });

  it('keeps a manifold\'s pipe when a tee with a branch on it is deleted', () => {
    const back = rejoin([riding('j', 200)], [
      line('a', 'A', 'r', 'j', 'l'), line('b', 'j', 'r', 'B', 'l'), line('c', 'j', 'b', 'RV', 't'),
    ]);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l' });
  });

  it('heals a run drawn in either direction, a person\'s corners in order along it', () => {
    const back = rejoin([riding('j', 200)], [
      line('a', 'A', 'r', 'j', 'l', { waypoints: [{ x: 100, y: 30 }] }),
      line('b', 'B', 'l', 'j', 'r', { waypoints: [{ x: 350, y: 30 }, { x: 300, y: 30 }] }),
    ]);
    expect(back[0]).toMatchObject({ source: 'A', target: 'B' });
    expect(back[0].data!.waypoints).toEqual([{ x: 100, y: 30 }, { x: 300, y: 30 }, { x: 350, y: 30 }]);
  });

  it('never hands out an id another line has: one delete healing two runs, or one after another', () => {
    // A bypass: V on the main run and BV on the loop over it, both between J1 and J2.
    const v = (id: string): Node => ({ id, type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } });
    const deleted = [line('J1-V', 'J1', 'r', 'V', 'l'), line('V-J2', 'V', 'r', 'J2', 'l'), line('J1-BV', 'J1', 't', 'BV', 'l'), line('BV-J2', 'BV', 'r', 'J2', 't')];
    const both = rejoin([v('V'), v('BV')], deleted);
    expect(both).toHaveLength(2);
    expect(new Set(both.map(e => e.id)).size).toBe(2);
    // Told what is left on the drawing, it takes the natural name when free and numbers past it when not.
    const told = rejoin([v('V'), v('BV')], deleted, new Set(['J1-J2']));
    expect(told.map(e => e.id)).toEqual(['J1-J2-2', 'J1-J2-3']);
    expect(rejoin([v('V')], deleted.slice(0, 2), new Set<string>())[0].id).toBe('J1-J2');
  });

  it('re-clips probes on the lines it healed', () => {
    const rejoins = rejoinChains([riding('j', 200)], [line('a', 'A', 'r', 'j', 'l'), line('b', 'j', 'r', 'B', 'l')], new Set());
    const tc: Node = { id: 'TC', type: 'TC', position: { x: 0, y: 0 }, data: { componentType: 'TC', attachedTo: 'b' } };
    const out = reclipAfterRejoin([tc], rejoins);
    expect(out[0].data.attachedTo).toBe(rejoins[0].edge.id);
  });

  it('re-clips a probe on the line whose id the healed line takes, to where it was along the pipe', () => {
    // The upstream half was named for the whole line and the delete has freed
    // the name, so the healed line takes it. A probe 90% along that half
    // (x ~ 179) is 35% along the healed line, not 90%.
    const rejoins = rejoinChains([riding('j', 200)], [line('A-B', 'A', 'r', 'j', 'l'), line('b', 'j', 'r', 'B', 'l')], new Set());
    expect(rejoins[0].edge.id).toBe('A-B');
    const old: Record<string, { x: number; y: number }[]> = { 'A-B': [{ x: 60, y: 30 }, { x: 192, y: 30 }], b: [{ x: 208, y: 30 }, { x: 400, y: 30 }] };
    const probe = (id: string, on: string, at: number): Node =>
      ({ id, type: 'TC', position: { x: 0, y: 0 }, data: { componentType: 'TC', attachedTo: on, attachedAt: at } });
    const out = reclipAfterRejoin([probe('P1', 'A-B', 0.9), probe('P2', 'b', 0.1)], rejoins, {
      old: id => old[id], healed: () => [{ x: 60, y: 30 }, { x: 400, y: 30 }],
    });
    expect(out.map(n => n.data.attachedTo)).toEqual(['A-B', 'A-B']);
    expect(out[0].data.attachedAt as number).toBeCloseTo((60 + 0.9 * 132 - 60) / 340, 3);
    expect(out[1].data.attachedAt as number).toBeCloseTo((208 + 0.1 * 192 - 60) / 340, 3);
    // Not told where the healed line is drawn, it is drawn where the two it
    // replaces were, end to end: the heal keeps the pipe's shape.
    const guessed = reclipAfterRejoin([probe('P1', 'A-B', 0.9)], rejoins, { old: id => old[id] });
    expect(guessed[0].data.attachedAt as number).toBeCloseTo(out[0].data.attachedAt as number, 2);
  });

  it('re-clips the probes on a dissolved tee\'s two lines to where they were along the pipe', () => {
    const tee = riding('j', 200);
    const a = line('a', 'A', 'r', 'j', 'l', bore(0.5)), b = line('b', 'j', 'r', 'B', 'l', bore(0.5));
    const probe = (id: string, on: string, at: number): Node =>
      ({ id, type: 'TC', position: { x: 0, y: 0 }, data: { componentType: 'TC', attachedTo: on, attachedAt: at } });
    const old: Record<string, { x: number; y: number }[]> = { a: [{ x: 60, y: 30 }, { x: 192, y: 30 }], b: [{ x: 208, y: 30 }, { x: 400, y: 30 }] };
    const out = dissolveAfterDelete([], [line('c', 'j', 'b', 'C', 't')],
      [node('A', 0, 0), node('B', 400, 0), tee, probe('P1', 'a', 0.9), probe('P2', 'b', 0.1)], [a, b], { old: id => old[id] });
    const healed = out.edges[0].id;
    expect(out.nodes.filter(n => n.type === 'TC').map(n => [n.data.attachedTo, Math.round((n.data.attachedAt as number) * 1000) / 1000]))
      .toEqual([[healed, 0.349], [healed, 0.492]]);
  });

  it('counts a tee saved with only its node type as mid-run', () => {
    expect(isMidRun({ id: 'j', type: 'JUNCTION', position: { x: 0, y: 0 }, data: {} })).toBe(true);
  });

  it('dissolves a riding tee left with only its run once its branch goes', () => {
    const tee = riding('j', 200);
    const a = line('a', 'A', 'r', 'j', 'l', { ...bore(0.5), segments: [{ id: 's1' }] });
    const b = line('b', 'j', 'r', 'B', 'l', bore(0.5));
    const branch = line('c', 'j', 'b', 'C', 't');
    const out = dissolveAfterDelete([], [branch], [node('A', 0, 0), node('B', 400, 0), node('C', 170, 200), tee], [a, b]);
    expect(out.nodes.map(n => n.id)).toEqual(['A', 'B', 'C']);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: 'A', target: 'B', data: { segments: [{ id: 's1' }] } });
  });

  it('keeps a tee between two different bores: that is a reducer', () => {
    const tee = riding('j', 200);
    const a = line('a', 'A', 'r', 'j', 'l', bore(0.5)), b = line('b', 'j', 'r', 'B', 'l', bore(0.25));
    const remainingNodes = [node('A', 0, 0), node('B', 400, 0), tee];
    const out = dissolveAfterDelete([], [line('c', 'j', 'b', 'C', 't')], remainingNodes, [a, b]);
    expect(out.nodes).toBe(remainingNodes);
    expect(out.edges).toEqual([a, b]);
  });

  it('keeps a tee between two kinds of pipe, however the two differ', () => {
    // Bore is not the only thing a pipe is: a stainless half and an aluminium
    // half, a pipe and a hose, two part numbers, or the same number in two
    // units are each two pipes, and healing them into one line handed
    // feed-twin one pipe of the first half's kind.
    const tee = riding('j', 200);
    const nodes = [node('A', 0, 0), node('B', 400, 0), tee];
    const keeps = (x: Record<string, unknown>, y: Record<string, unknown>) => {
      const out = dissolveAfterDelete([], [line('c', 'j', 'b', 'C', 't')], nodes, [line('a', 'A', 'r', 'j', 'l', x), line('b', 'j', 'r', 'B', 'l', y)]);
      return out.nodes.some(n => n.id === 'j');
    };
    const same = { ...bore(0.5), lineType: 'pipe', options: { material: 'ss316' } };
    expect(keeps(same, same)).toBe(false);
    expect(keeps(same, { ...same, options: { material: 'al6061' } })).toBe(true);
    expect(keeps(same, { ...same, lineType: 'flex_hose' })).toBe(true);
    expect(keeps({ ...same, partNumber: 'P-1' }, { ...same, partNumber: 'P-2' })).toBe(true);
    expect(keeps(same, { ...same, params: { bore: { value: 0.5, unit: 'mm', source: 'estimated' } } })).toBe(true);
  });

  it('never heals a loop from a tee\'s pipe back into the same symbol', () => {
    // A pipe out of one port of A and back into another, with a branch off
    // it: taking the branch away leaves the tee, not a line from A to A.
    const tee = riding('j', 200);
    const out = dissolveAfterDelete([], [line('c', 'j', 'b', 'C', 't')],
      [node('A', 0, 0), tee], [line('a', 'A', 'r', 'j', 'l'), line('b', 'j', 'r', 'A', 't')]);
    expect(out.nodes.some(n => n.id === 'j')).toBe(true);
    expect(out.edges.some(e => e.source === e.target)).toBe(false);
  });

  it('never heals a part in a loop on one symbol into a line from the symbol to itself', () => {
    // A bypass valve across two ports of one symbol: drawable, two lines
    // between two symbols. Deleting the valve takes both with it.
    const v = (id: string): Node => ({ id, type: 'SOL', position: { x: 100, y: 0 }, data: { componentType: 'SOL' } });
    expect(rejoin([v('V1')], [line('T-V1', 'T', 'r', 'V1', 'l'), line('V1-T', 'V1', 'r', 'T', 'l')])).toEqual([]);
    // Nor through two of them, deleted together.
    expect(rejoin([v('V1'), v('V2')], [
      line('T-V1', 'T', 'r', 'V1', 'l'), line('V1-V2', 'V1', 'r', 'V2', 'l'), line('V2-T', 'V2', 'r', 'T', 'l'),
    ])).toEqual([]);
  });

  it('reads a half drawn the other way as it runs: its rise, its fittings and their ends turned round', () => {
    // A pipe drawn from both ends until they met: V1.r -> j and V2.l -> j.
    // Along each half as stored, the V1 half climbs 1 m to the tee and the V2
    // half 2 m; from V1 to V2 the pipe climbs 1 m and falls 2.
    const m = (v: number) => ({ value: v, unit: 'm', source: 'measured' });
    const up = line('V1-j', 'V1', 'r', 'j', 'l', { segments: [{ id: 'a', elevation_change: m(1) }] });
    const back = line('V2-j', 'V2', 'l', 'j', 'r', {
      params: { elevation_change: m(2) },
      segments: [{
        id: 'b', elevation_change: m(2),
        fittings: [
          { id: 'f1', kind: 'contraction', count: 1 },
          { id: 'f2', kind: 'adapter', count: 1, ends: { a: { thread: 'npt' }, b: { thread: 'jic' } } },
        ],
      }],
    });
    const rise = (e: Edge) => ((e.data!.segments as { elevation_change?: { value: number } }[])
      .reduce((t, sg) => t + (sg.elevation_change?.value ?? 0), 0));
    const [healed] = rejoin([riding('j', 200)], [up, back]);
    expect(healed).toMatchObject({ source: 'V1', target: 'V2' });
    expect(rise(healed)).toBe(-1);
    const b = (healed.data!.segments as { id: string; fittings?: { kind: string; ends?: unknown }[] }[])[1];
    expect(b.fittings!.map(f => f.kind)).toEqual(['adapter', 'expansion']);
    expect(b.fittings![0].ends).toEqual({ a: { thread: 'jic' }, b: { thread: 'npt' } });
    // The same, dissolved once its branch goes.
    const tee = riding('j', 200);
    const plain = { ...back, data: { segments: back.data!.segments } };
    const out = dissolveAfterDelete([], [line('c', 'j', 'b', 'C', 't')], [node('V1', 0, 0), node('V2', 400, 0), tee], [plain, up]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: 'V1', target: 'V2' });
    expect(rise(out.edges[0])).toBe(-1);
    // The line's own rise, which the healed line takes from its first half,
    // read the healed line's way when that half is the one turned round.
    const first = rejoin([riding('j', 200)], [back, up])[0];
    expect(first).toMatchObject({ source: 'V2', target: 'V1' });
    expect((first.data!.params as Record<string, { value: number }>).elevation_change.value).toBe(2);
    expect(rise(first)).toBe(1);
  });

  it('takes away an open end left with no line, and leaves a tee nothing was deleted from', () => {
    const open: Node = { id: 'o', type: 'JUNCTION', position: { x: 0, y: 0 }, data: { componentType: 'JUNCTION' } };
    const bare = riding('k', 300);
    const lines = [line('a', 'A', 'r', 'k', 'l'), line('b', 'k', 'r', 'B', 'l')];
    const out = dissolveAfterDelete([], [line('c', 'X', 'r', 'o', 'l')], [node('A', 0, 0), node('B', 400, 0), open, bare], lines);
    expect(out.nodes.map(n => n.id)).toEqual(['A', 'B', 'k']);
    expect(out.edges).toBe(lines);
  });

  it('takes away a tee whose pipe lost its far end, healing what is left of its run into its branch', () => {
    // A -- j -- B with a branch from j down to C, and A deleted: j keeps the
    // half out to B and the branch, both leaving it, and is a dot on a line
    // from B round to C. Healed, B's half is read backwards, its rise with
    // it: 1 m up from the tee to B is 1 m down from B to the tee, then 2 up.
    const m = (v: number) => ({ value: v, unit: 'm', source: 'measured' });
    const tee = riding('j', 200);
    const toB = line('j-B', 'j', 'r', 'B', 'l', { segments: [{ id: 'b', elevation_change: m(1) }] });
    const toC = line('j-C', 'j', 'b', 'C', 't', { segments: [{ id: 'c', elevation_change: m(2) }] });
    const out = dissolveAfterDelete([node('A', 0, 0)], [line('A-j', 'A', 'r', 'j', 'l')],
      [node('B', 400, 0), node('C', 170, 200), tee], [toB, toC]);
    expect(out.nodes.map(n => n.id)).toEqual(['B', 'C']);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: 'B', sourceHandle: 'l', target: 'C', targetHandle: 't' });
    const segs = out.edges[0].data!.segments as { id: string; elevation_change: { value: number } }[];
    expect(segs.map(s => [s.id, s.elevation_change.value])).toEqual([['b', -1], ['c', 2]]);
  });
});

describe('a junction that branches nowhere, taken out of its line', () => {
  const junction = (id: string, cx: number, along?: Record<string, unknown>): Node => ({
    id, type: 'JUNCTION', position: { x: cx - 5, y: 25 },
    data: { componentType: 'JUNCTION', label: id, ...(along ? { along } : {}) },
  });
  const line = (id: string, s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
    ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th, data });
  const bore = (v: number) => ({ params: { bore: { value: v, unit: 'in', source: 'estimated' } } });

  it('makes an open end pulled on straight ahead the line made longer', () => {
    // S.r out to an open end O, then O pulled on to a new open end O2: one
    // line from S to O2, saying what the line out of S said, and no dot.
    const S = node('S', 0, 0), O2 = junction('O2', 260);
    const first = line('S-O', 'S', 'r', 'O', 'l', { lineType: 'pipe', segments: [{ id: 's1' }] });
    const on = line('O-O2', 'O', 'r', 'O2', 'l', { lineType: 'pipe' });
    for (const O of [junction('O', 200), junction('O', 200, { t: 0.7, in: 'l', out: 'r', from: 'S', to: 'O2' })]) {
      const healed = healThrough([S, O, O2], [first, on], 'O')!;
      expect(healed.nodes.map(n => n.id)).toEqual(['S', 'O2']);
      expect(healed.edges).toHaveLength(1);
      expect(healed.lineId).toBe('S-O2');
      expect(healed.edges[0]).toMatchObject({
        id: 'S-O2', source: 'S', sourceHandle: 'r', target: 'O2', targetHandle: 'l',
        data: { lineType: 'pipe', segments: [{ id: 's1' }] },
      });
    }
  });

  it('reads a pair drawn one after the other the way it was drawn', () => {
    // A branch drawn from C into the tee, and the tee's half on to B: C to B,
    // neither half turned round.
    const m = (v: number) => ({ value: v, unit: 'm', source: 'measured' });
    const tee = junction('j', 200, { t: 0.5, in: 'l', out: 'r', from: 'A', to: 'B' });
    const fromC = line('C-j', 'C', 't', 'j', 'b', { segments: [{ id: 'c', elevation_change: m(2) }] });
    const toB = line('j-B', 'j', 'r', 'B', 'l', { segments: [{ id: 'b', elevation_change: m(1) }] });
    for (const edges of [[fromC, toB], [toB, fromC]]) {
      const healed = healThrough([node('B', 400, 0), node('C', 170, 200), tee], edges, 'j')!;
      expect(healed.edges[0]).toMatchObject({ source: 'C', sourceHandle: 't', target: 'B', targetHandle: 'l' });
      const segs = healed.edges[0].data!.segments as { id: string; elevation_change: { value: number } }[];
      expect(segs.map(s => [s.id, s.elevation_change.value])).toEqual([['c', 2], ['b', 1]]);
    }
  });

  it('gives the line an id nothing else has, and follows its probes onto it', () => {
    const tc: Node = { id: 'TC', type: 'TC', position: { x: 0, y: 0 }, data: { componentType: 'TC', attachedTo: 'O-O2' } };
    const taken = line('S-O2', 'S', 't', 'O2', 't');
    const healed = healThrough([node('S', 0, 0), junction('O', 200), junction('O2', 260), tc],
      [line('S-O', 'S', 'r', 'O', 'l'), line('O-O2', 'O', 'r', 'O2', 'l'), taken], 'O')!;
    expect(healed.lineId).toBe('S-O2-2');
    expect(healed.edges.map(e => e.id)).toEqual(['S-O2', 'S-O2-2']);
    expect(healed.nodes.find(n => n.id === 'TC')!.data.attachedTo).toBe('S-O2-2');
  });

  it('leaves a junction that still branches, a reducer, a loop, and anything that is not a junction', () => {
    const nodes = [node('A', 0, 0), node('B', 400, 0), node('C', 170, 200), junction('j', 200)];
    const a = line('a', 'A', 'r', 'j', 'l'), b = line('b', 'j', 'r', 'B', 'l');
    expect(healThrough(nodes, [a, b, line('c', 'j', 'b', 'C', 't')], 'j')).toBeNull();
    expect(healThrough(nodes, [a], 'j')).toBeNull();
    expect(healThrough(nodes, [{ ...a, data: bore(0.5) }, { ...b, data: bore(0.25) }], 'j')).toBeNull();
    expect(healThrough(nodes, [a, line('b', 'j', 'r', 'A', 't')], 'j')).toBeNull();
    expect(healThrough(nodes, [line('x', 'A', 'r', 'C', 'l'), line('y', 'C', 'r', 'B', 'l')], 'C')).toBeNull();
    // What it does take out, it takes out whole: nothing is left on the junction.
    const healed = healThrough(nodes, [a, b], 'j')!;
    expect(healed.edges.some(e => e.source === 'j' || e.target === 'j')).toBe(false);
  });
});

describe('taking a tee back out of a pipe', () => {
  // Ports at the middle of each side of a 60 px symbol; a tee's faces with J_END.
  const endOf: EndLookup = (n, h) => {
    if (isJunction(n)) return h ? { ...junctionEnd(n.position, h as Face), ...J_END } : null;
    const { x, y } = n.position;
    const at: Record<string, End> = {
      l: { x, y: y + 30, side: Position.Left }, r: { x: x + 60, y: y + 30, side: Position.Right },
      t: { x: x + 30, y, side: Position.Top }, b: { x: x + 30, y: y + 60, side: Position.Bottom },
    };
    return h ? at[h] ?? null : null;
  };
  const settle = (nodes: Node[], edges: Edge[]) => {
    for (let i = 0; i < 10; i++) {
      const re = reseatJunctions(nodes, edges, endOf);
      if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
      nodes = re.nodes; edges = re.edges;
    }
    throw new Error('the reseat did not settle');
  };
  const drawn = (e: Edge, nodes: Node[]) => {
    const m = new Map(nodes.map(n => [n.id, n]));
    const a = endOf(m.get(e.source)!, e.sourceHandle)!, b = endOf(m.get(e.target)!, e.targetHandle)!;
    const d = (e.data ?? {}) as { waypoints?: Pt[]; offset?: number };
    return pathPoints((d.waypoints?.length ? routeThrough(a, b, d.waypoints) : routeOrthogonal(a, b, d.offset ?? 0)).d);
  };
  const pathOf = (st: { nodes: Node[]; edges: Edge[] }, teeId: string) => {
    const pipe = pipesOf(st.nodes, st.edges).find(p => p.tees.includes(teeId))!;
    return pipeGeometry(pipe, new Map(st.nodes.map(n => [n.id, n])), new Map(st.edges.map(e => [e.id, e])), endOf)!.pts;
  };

  /**
   * A crossbar a person shifted, as older drawings have it: A.r (60,30) to
   * B.l (400,330) with its crossbar at x=170, not the router's 230. A tee on
   * the first leg with a branch to C, and one on the crossbar with a branch
   * to D.
   */
  function shifted() {
    const nodes = [node('A', 0, 0), node('B', 400, 300), node('C', 60, 150), node('D', 450, 150)];
    const e: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: { offset: -60 } };
    const s1 = splitEdgeAt(nodes, [e], 'A-B', { x: 100, y: 30 }, undefined, { points: drawn(e, nodes) })!;
    let st = settle(s1.nodes, s1.edges);
    const down = st.edges.find(x => x.source === s1.junctionId)!;
    const s2 = splitEdgeAt(st.nodes, st.edges, down.id, { x: 170, y: 200 }, undefined, { points: drawn(down, st.nodes) })!;
    st = settle(s2.nodes, s2.edges);
    const branches: Edge[] = [
      { id: 'T1-C', source: s1.junctionId, sourceHandle: 'b', target: 'C', targetHandle: 't', data: {} },
      { id: 'T2-D', source: s2.junctionId, sourceHandle: 'r', target: 'D', targetHandle: 'l', data: {} },
    ];
    return { ...settle(st.nodes, [...st.edges, ...branches]), t1: s1.junctionId, t2: s2.junctionId };
  }

  it('gives back the pipe it was in, whose shape is not the router\'s, and moves no other tee', () => {
    const st = shifted();
    const before = pathOf(st, st.t2);
    expect(before).toEqual([{ x: 60, y: 30 }, { x: 170, y: 30 }, { x: 170, y: 330 }, { x: 400, y: 330 }]);
    const t2At = st.nodes.find(n => n.id === st.t2)!.position;

    // The branch goes, and the tee it leaves dissolves.
    const branch = st.edges.find(e => e.id === 'T1-C')!;
    const d = dissolveAfterDelete([], [branch], st.nodes, st.edges.filter(e => e !== branch));
    const dissolved = settle(d.nodes, d.edges);
    expect(pathOf(dissolved, st.t2)).toEqual(before);
    expect(dissolved.nodes.find(n => n.id === st.t2)!.position).toEqual(t2At);

    // The tee itself goes, with its branch.
    const tee = st.nodes.find(n => n.id === st.t1)!;
    const gone = st.edges.filter(e => e.source === st.t1 || e.target === st.t1);
    const left = st.edges.filter(e => !gone.includes(e));
    const healed = rejoinChains([tee], gone, new Set(left.map(e => e.id))).map(r => r.edge);
    const rejoined = settle(st.nodes.filter(n => n.id !== st.t1), [...left, ...healed]);
    expect(pathOf(rejoined, st.t2)).toEqual(before);
    expect(rejoined.nodes.find(n => n.id === st.t2)!.position).toEqual(t2At);
  });

  it('puts no tee into a line with nowhere a tee can sit', () => {
    // A 20 px line with its bend in the middle: no spot on it is legal, and
    // the least bad one is on the bend. A tee put there hooked both its
    // halves round it; a pipe that tightens round a tee it has already got
    // is the reseat's to deal with (pipes.test.ts).
    const nodes = [node('A', 0, 0), node('B', 100, 100)];
    const e: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 't', data: {} };
    expect(splitEdgeAt(nodes, [e], 'A-B', { x: 70, y: 30 }, undefined, { points: [{ x: 60, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 40 }] })).toBeNull();
  });
});
