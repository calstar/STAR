import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { mergedLineData, rejoinAfterDelete, splitEdgeAt } from './splitEdge';
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

  it('ignores a delete with no junction in it', () => {
    expect(rejoinAfterDelete(
      [{ id: 'V', type: 'MAN', position: { x: 0, y: 0 }, data: { componentType: 'MAN' } }],
      [wire('a', 'A', 'V'), wire('b', 'V', 'B')],
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
