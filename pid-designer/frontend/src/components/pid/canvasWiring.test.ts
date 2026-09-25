// How the canvas hands its drawing to the reseat, the moves, the drop snap
// and the delete clean-up.
//
// What each of those does is tested with its module (reseat.test.ts,
// canvasEdits.test.ts, snap.test.ts); what is decided in PIDDesigner.tsx is
// what it passes them, and in what order it writes their answers back, and
// nothing in those modules can notice being called wrongly. The canvas needs
// React Flow and a DOM to mount, so, as history.test.ts and pageScope.test.ts
// do, each handler is cut out of the file as written, compiled, and run with
// the names it closes over handed in.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, InternalNode, Node, NodeChange } from '@xyflow/react';
import * as api from '../../api/diagrams';
import { J_END, dragging, isJunction, junctionEnd, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { dragSegment, pathPoints, routeOrthogonal, routeThrough, waypointsOf } from './route';
import type { Pt } from './route';
import { translateSubgraph } from './graphOps';
import { afterDelete, applyMoves, carriedWith, followCorners } from './canvasEdits';
import { snapOnDrop } from './snap';
import { handleCentre } from './ports';
import { carryBaseline, handleSignature } from './reseat';
import { obstaclesByPage } from './routeGrid';
import type { ReseatOptions } from './reseat';
import { canvasStatement, canvasStatements, compiled } from './canvasSource';

/**
 * The canvas statement opening with `start` -- through the one opening with
 * `through`, when given -- as a function of `names` returning `result`
 * (canvasSource.ts).
 */
function canvasCode(start: string, through: string | null, names: string[], result: string) {
  return compiled(through ? canvasStatements(start, through) : canvasStatement(start), names, result);
}
const useCallback = <T>(f: T) => f;
const useRef = <T>(v: T) => ({ current: v });

const P = (x: number, y: number): Pt => ({ x, y });
const part = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, page: 'Main' },
});
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
  const { x, y } = node.position;
  switch (handle) {
    case 'l': return { x, y: y + 30, side: Position.Left };
    case 'r': return { x: x + 60, y: y + 30, side: Position.Right };
    case 't': return { x: x + 30, y, side: Position.Top };
    case 'b': return { x: x + 30, y: y + 60, side: Position.Bottom };
    default: return null;
  }
};
const E = (s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${s}-${t}`, source: s, sourceHandle: sh, target: t, targetHandle: th, type: 'smoothstep', data });
const wp = (e: Edge) => (e.data as { waypoints?: Pt[] }).waypoints;

/**
 * The canvas's two setters, as React runs them: updaters queued in the order
 * they were called, the nodes' run before the lines' (the order the two
 * states are declared in), then the result is what renders.
 */
function state(g: { nodes: Node[]; edges: Edge[] }) {
  const queue: { nodes: ((n: Node[]) => Node[])[]; edges: ((e: Edge[]) => Edge[])[] } = { nodes: [], edges: [] };
  const setNodes = (v: Node[] | ((n: Node[]) => Node[])) => queue.nodes.push(typeof v === 'function' ? v : () => v);
  const setEdges = (v: Edge[] | ((e: Edge[]) => Edge[])) => queue.edges.push(typeof v === 'function' ? v : () => v);
  const render = () => {
    for (const f of queue.nodes.splice(0)) g = { ...g, nodes: f(g.nodes) };
    for (const f of queue.edges.splice(0)) g = { ...g, edges: f(g.edges) };
    return g;
  };
  return { setNodes, setEdges, render, get: () => g };
}

/** A.r -> B.l hand-routed round a U, with a tee on its bottom leg and a branch down to C. */
function handBay() {
  const A = part('A', 0, 0), B = part('B', 300, 0), C = part('C', 120, 200);
  const plain = pathPoints(routeOrthogonal(endOf(A, 'r')!, endOf(B, 'l')!).d);
  const hand = E('A', 'r', 'B', 'l', { waypoints: waypointsOf(dragSegment(plain, 0, P(0, 60))) });
  const drawn = pathPoints(routeThrough(endOf(A, 'r')!, endOf(B, 'l')!, wp(hand)!).d);
  const split = splitEdgeAt([A, B, C], [hand], 'A-B', P(150, 90), undefined, { points: drawn })!;
  const seated = reseatJunctions(split.nodes, [...split.edges, E(split.junctionId, 'b', 'C', 't')], endOf);
  return { ...seated, tee: split.junctionId };
}

describe('the canvas moving nodes', () => {
  const handler = canvasCode('const handleNodesChange = useCallback(', null,
    ['useCallback', 'setNodes', 'setEdges', 'applyMoves', 'followCorners', 'snapshot', 'endOfClear', 'obstaclesRef'],
    'handleNodesChange');

  it('carries a bay picked up whole, tee and corners, as one piece', () => {
    const bay = handBay();
    const s = state(bay);
    const handle = handler(useCallback, s.setNodes, s.setEdges, applyMoves, followCorners, { current: bay }, endOf,
      { current: undefined }) as (c: NodeChange<Node>[]) => void;
    const tee = bay.nodes.find(n => n.id === bay.tee)!;
    const at = (id: string) => bay.nodes.find(n => n.id === id)!.position;
    handle(['A', 'B', 'C', bay.tee].map(id => ({
      id, type: 'position' as const, dragging: true,
      position: P(at(id).x + 40 + (id === bay.tee ? 0.3 : 0), at(id).y + 20),
    })));
    const after = s.render();
    expect(after.nodes.find(n => n.id === bay.tee)!.position).toEqual(P(tee.position.x + 40, tee.position.y + 20));
    for (const e of after.edges) {
      const before = bay.edges.find(x => x.id === e.id)!;
      expect(wp(e) ?? []).toEqual((wp(before) ?? []).map(p => P(p.x + 40, p.y + 20)));
    }
    expect(reseatJunctions(after.nodes, after.edges, endOf).edges).toBe(after.edges);
  });
});

describe('the canvas starting a drag', () => {
  const handler = canvasCode('const onNodeDragStart = useCallback(', null,
    ['useCallback', 'readOnlyRef', 'dragRef', 'dragging', 'snapshot'], 'onNodeDragStart');

  it('tells the reseat what it picks up, and the drawing as it was, lines and all', () => {
    // What a pipe carried whole is put back to, moved, every tick: without
    // the lines, a drag of a bay put its corners back from nowhere.
    const bay = handBay();
    const dragRef = { current: null as ReturnType<typeof dragging> | null };
    const start = handler(useCallback, { current: false }, dragRef, dragging, { current: bay }) as
      (e: unknown, node: Node, dragged: Node[]) => void;
    start({}, bay.nodes[0], bay.nodes.filter(n => n.id === 'A' || n.id === 'B'));
    expect([...dragRef.current!.moving]).toEqual(['A', 'B']);
    expect(dragRef.current!.start!.edges.size).toBe(bay.edges.length);
    for (const e of bay.edges) expect(dragRef.current!.start!.edges.get(e.id)).toBe(e);
    expect(dragRef.current!.anchors.has(bay.tee)).toBe(true);
  });
});

describe('the canvas letting go of a drag', () => {
  const handler = canvasCode('const onNodeDragStop = useCallback((', null,
    ['useCallback', 'readOnlyRef', 'getInternalNode', 'pageRef', 'setNodes', 'setEdges', 'snapshot', 'snapOnDrop',
      'translateSubgraph', 'settleAgain', 'dragRef', 'handleCentre', 'carriedWith'],
    'onNodeDragStop');
  /** React Flow's measured handles: 6 px, centred on each side of a 60 px symbol. */
  const internal = (): { internals: InternalNode['internals'] } => ({
    internals: {
      handleBounds: {
        source: [
          { id: 'l', type: 'source', position: Position.Left, x: -3, y: 27, width: 6, height: 6 },
          { id: 'r', type: 'source', position: Position.Right, x: 57, y: 27, width: 6, height: 6 },
          { id: 't', type: 'source', position: Position.Top, x: 27, y: -3, width: 6, height: 6 },
          { id: 'b', type: 'source', position: Position.Bottom, x: 27, y: 57, width: 6, height: 6 },
        ],
        target: [],
      },
    } as unknown as InternalNode['internals'],
  });
  const run = (g: { nodes: Node[]; edges: Edge[] }, dragged: string[], readOnly = false) => {
    const s = state(g);
    let again = 0;
    // The drag the reseat was told of while it lasted; letting go ends it.
    const dragRef = { current: { anchors: new Map(), moving: new Set(dragged) } as unknown };
    const stop = handler(useCallback, { current: readOnly }, (id: string) => (g.nodes.some(n => n.id === id) ? internal() : undefined),
      { current: 'Main' }, s.setNodes, s.setEdges, { current: g }, snapOnDrop, translateSubgraph, () => { again++; }, dragRef,
      handleCentre, carriedWith,
    ) as (e: unknown, node: Node, dragged: Node[]) => void;
    stop({}, g.nodes.find(n => n.id === dragged[0])!, g.nodes.filter(n => dragged.includes(n.id)));
    expect(dragRef.current).toBeNull();
    return { after: s.render(), again };
  };

  it('lines what was dragged up with what it is wired to, corners and all, and settles the drawing', () => {
    const A = part('A', 0, 0), B = part('B', 300, 0), M = part('M', 3, 200);
    const hand = E('A', 'r', 'B', 'l', { waypoints: [P(76, 30), P(76, 90), P(284, 90), P(284, 30)] });
    const g = { nodes: [A, B, M], edges: [hand, E('A', 'b', 'M', 't')] };
    const { after, again } = run(g, ['A', 'B']);
    expect(after.nodes.find(n => n.id === 'A')!.position).toEqual(P(3, 0));
    expect(after.nodes.find(n => n.id === 'B')!.position).toEqual(P(303, 0));
    expect(wp(after.edges[0])).toEqual([P(79, 30), P(79, 90), P(287, 90), P(287, 30)]);
    expect(again).toBe(1);
  });

  it('lines up a tee the selection left out with the pipe it rode, corners and all', () => {
    // A and B dragged, the tee on the U between them not: it rode the pipe
    // they carried whole, and the shift that lines A up with M moves it and
    // every corner of the pipe with them. Left behind, the U was bent three
    // pixels at the tee and the reseat moved the tee off where it was put.
    const A = part('A', 0, 0), B = part('B', 300, 0), M = part('M', 3, 200);
    const hand = E('A', 'r', 'B', 'l', { waypoints: [P(76, 30), P(76, 90), P(284, 90), P(284, 30)] });
    const drawn = pathPoints(routeThrough(endOf(A, 'r')!, endOf(B, 'l')!, wp(hand)!).d);
    const split = splitEdgeAt([A, B, M], [hand, E('A', 'b', 'M', 't')], 'A-B', P(180, 90), 'Main', { points: drawn })!;
    const g = reseatJunctions(split.nodes, split.edges, endOf);
    const { after } = run(g, ['A', 'B']);
    const tee = g.nodes.find(n => n.id === split.junctionId)!.position;
    expect(after.nodes.find(n => n.id === split.junctionId)!.position).toEqual(P(tee.x + 3, tee.y));
    for (const e of g.edges.filter(x => x.source === split.junctionId || x.target === split.junctionId)) {
      expect(wp(after.edges.find(x => x.id === e.id)!)).toEqual((wp(e) ?? []).map(p => P(p.x + 3, p.y)));
    }
    expect(reseatJunctions(after.nodes, after.edges, endOf)).toEqual(after);
  });

  it('straightens a pipe with a tee on it, and the tee lands on the straight pipe', () => {
    // A.r -> B.l teed at the middle, then A dragged dy off B's level with the
    // reseat running each tick, as the canvas does: the tee rides the Z.
    for (const dy of [-6, -3, 3, 6]) {
      const A = part('A', 0, 0), B = part('B', 400, 0);
      const drawn = pathPoints(routeOrthogonal(endOf(A, 'r')!, endOf(B, 'l')!).d);
      const split = splitEdgeAt([A, B], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30), 'Main', { points: drawn })!;
      let g = reseatJunctions(split.nodes, split.edges, endOf);
      g = reseatJunctions(g.nodes.map(n => (n.id === 'A' ? { ...n, position: P(0, dy) } : n)), g.edges, endOf);
      const { after } = run(g, ['A']);
      const settled = reseatJunctions(after.nodes, after.edges, endOf);
      const at = (id: string) => settled.nodes.find(n => n.id === id)!.position;
      expect(at('A'), `dy ${dy}`).toEqual(P(0, 0));
      expect(at(split.junctionId).y + 5, `dy ${dy}`).toBe(30);
    }
  });

  it('settles the drawing even when nothing lines up, and does nothing for a viewer', () => {
    const g = { nodes: [part('A', 0, 0), part('M', 40, 200)], edges: [E('A', 'b', 'M', 't')] };
    const moved = run(g, ['A']);
    expect(moved.after).toEqual(g);
    expect(moved.again).toBe(1);
    expect(run(g, ['A'], true).again).toBe(0);
  });
});

describe('the canvas deleting', () => {
  const handler = canvasCode('const onDelete = useCallback(', null,
    ['useCallback', 'readOnlyRef', 'drawnCorners', 'afterDelete', 'snapshot', 'commitGraph'], 'onDelete');
  const run = (g: { nodes: Node[]; edges: Edge[] }, goneIds: string[], readOnly = false, drawn = new Map<string, Pt[]>()) => {
    const commits: { nodes: Node[]; edges: Edge[] }[] = [];
    const del = handler(useCallback, { current: readOnly }, () => drawn, afterDelete, { current: g },
      (nodes: Node[], edges: Edge[]) => commits.push({ nodes, edges })) as (x: { nodes: Node[]; edges: Edge[] }) => void;
    const gone = new Set(goneIds);
    del({ nodes: g.nodes.filter(n => gone.has(n.id)), edges: g.edges.filter(e => gone.has(e.id) || gone.has(e.source) || gone.has(e.target)) });
    return commits;
  };

  it('keeps the pipe a deleted tee was on, as one line', () => {
    const bay = handBay();
    const commits = run(bay, [bay.tee]);
    expect(commits).toHaveLength(1);
    expect(commits[0].edges.filter(e => e.source === 'A' && e.target === 'B')).toHaveLength(1);
    expect(commits[0].nodes.some(n => n.id === bay.tee)).toBe(false);
  });

  it('puts a probe on the healed pipe where it was on the pipe as the lines were drawn', () => {
    // The bay's two run halves as the canvas drew them: A's port, round the
    // U's first corners, to the tee; then on to B. 150 and 210 long.
    const bay = handBay();
    const into = bay.edges.find(e => e.source === 'A' && e.target === bay.tee)!;
    const onTo = bay.edges.find(e => e.source === bay.tee && e.target === 'B')!;
    const drawn = new Map<string, Pt[]>([
      [into.id, [P(60, 30), P(76, 30), P(76, 90), P(150, 90)]],
      [onTo.id, [P(150, 90), P(284, 90), P(284, 30), P(300, 30)]],
    ]);
    // Clipped halfway along the first half: 75 along the pipe, on the U's left leg.
    const probe: Node = { id: 'PT1', type: 'PT', position: P(90, 70), data: { componentType: 'PT', label: 'PT1', page: 'Main', attachedTo: into.id, attachedAt: 0.5 } };
    const commits = run({ nodes: [...bay.nodes, probe], edges: bay.edges }, [bay.tee], false, drawn);
    const healed = commits[0].edges.find(e => e.source === 'A' && e.target === 'B')!;
    const clip = commits[0].nodes.find(n => n.id === 'PT1')!.data as { attachedTo?: string; attachedAt?: number };
    expect(clip.attachedTo).toBe(healed.id);
    expect(clip.attachedAt).toBeCloseTo(75 / 360, 9);
  });

  it('leaves a delete with nothing to heal to React Flow, and does nothing for a viewer', () => {
    const g = { nodes: [part('A', 0, 0), part('V', 200, 0)], edges: [E('A', 'r', 'V', 'l')] };
    expect(run(g, ['V'])).toEqual([]);
    const bay = handBay();
    expect(run(bay, [bay.tee], true)).toEqual([]);
  });
});

describe('the canvas running the reseat', () => {
  const block = canvasCode('const ports = useStore(', 'const settleAgain = useReseat(',
    ['useStore', 'handleSignature', 'useRef', 'useCallback', 'carryBaseline', 'lastSaved', 'loadedId', 'diagramKey', 'api',
      'useReseat', 'nodes', 'edges', 'endOfClear', 'obstacles', 'nodesReady', 'setNodes', 'setEdges', 'markCorrection'],
    '{ ports, keepBaseline }');
  const lookup = new Map([['A', { id: 'A', internals: { handleBounds: { source: [{ id: 'r', position: Position.Right, x: 57, y: 27, width: 6, height: 6 }] } } }]]) as unknown as Map<string, InternalNode>;

  function wire(saved: string, loaded = 'd') {
    let options: ReseatOptions | null = null;
    const lastSaved = { current: saved };
    const obstacles = () => [];
    const mark = () => {};
    const nodes: Node[] = [], edges: Edge[] = [];
    const out = block(
      (select: (s: unknown) => unknown) => select({ nodeLookup: lookup }), handleSignature, useRef, useCallback, carryBaseline,
      lastSaved, { current: loaded }, 'd', api,
      (o: ReseatOptions) => { options = o; return () => {}; },
      nodes, edges, endOf, obstacles, true, () => {}, () => {}, mark,
    ) as { ports: string };
    return { options: options! as ReseatOptions, lastSaved, out, obstacles, mark, nodes, edges };
  }

  it('hands it the drawing, the ports as measured, each page\'s obstacles and the history', () => {
    const w = wire('');
    expect(w.options.ports).toBe(handleSignature(lookup));
    expect(w.options.obstacles).toBe(w.obstacles);
    expect(w.options.endOf).toBe(endOf);
    expect(w.options.ready).toBe(true);
    expect(w.options.nodes).toBe(w.nodes);
    expect(w.options.markCorrection).toBe(w.mark);
  });

  it('gives it, for each page, the boxes of that page\'s symbols and nothing else', () => {
    // Pages share one plane: the GSE symbol sits on Main's pipe's line, and is
    // in nobody's way there. Tees, section boxes and text are never in the way.
    const cut = canvasCode('const obstacles = useMemo(', 'obstaclesRef.current = obstacles;',
      ['useMemo', 'useRef', 'obstaclesByPage', 'nodes'], '{ obstacles, obstaclesRef }');
    const useMemo = <T>(f: () => T) => f();
    const onGse = (n: Node): Node => ({ ...n, data: { ...n.data, page: 'GSE' } });
    const other = (id: string, type: string, x: number, y: number): Node =>
      ({ id, type, position: P(x, y), measured: { width: 300, height: 200 }, data: { componentType: type, label: id, page: 'Main' } });
    const nodes = [part('A', 0, 0), part('B', 300, 20), onGse(part('G', 150, 0)),
      other('J', 'JUNCTION', 100, 25), other('R', 'REGION', -40, -40), other('T', 'TEXT', 120, 120)];
    const { obstacles, obstaclesRef } = cut(useMemo, useRef, obstaclesByPage, nodes) as
      { obstacles: (page: string) => unknown[]; obstaclesRef: { current: unknown } };
    expect(obstacles('Main')).toEqual([{ x: 0, y: 0, w: 60, h: 60 }, { x: 300, y: 20, w: 60, h: 60 }]);
    expect(obstacles('GSE')).toEqual([{ x: 150, y: 0, w: 60, h: 60 }]);
    expect(obstaclesRef.current).toBe(obstacles);
  });

  it('moves the autosave\'s baseline with a correction of the drawing as saved, and not before it has loaded', () => {
    const opened = { nodes: [part('A', 0, 0)], edges: [] };
    const corrected = { nodes: [part('A', 5, 0)], edges: [] };
    const text = (g: { nodes: Node[]; edges: Edge[] }) => JSON.stringify(api.toStored(g));
    const w = wire(text(opened));
    w.options.onCorrect!(opened, corrected);
    expect(w.lastSaved.current).toBe(text(corrected));
    const early = wire(text(opened), 'another drawing');
    early.options.onCorrect!(opened, corrected);
    expect(early.lastSaved.current).toBe(text(opened));
  });
});

describe('the canvas importing and restoring', () => {
  it('brings an imported drawing up to date, as opening one does', () => {
    const imported = canvasCode('loadRef.current  = useCallback(', null,
      ['useCallback', 'loadRef', 'readOnlyRef', 'flushHistory', 'migrate', 'seedIdsFrom', 'setNodes', 'setEdges'], 'loadRef');
    const migrated = { nodes: [part('M', 0, 0)], edges: [] };
    let set: Node[] = [];
    const loadRef = { current: (_: unknown) => {} };
    imported(useCallback, loadRef, { current: false }, () => {}, () => migrated, () => {}, (n: Node[]) => { set = n; }, () => {});
    loadRef.current({ nodes: [part('Old', 0, 0)], edges: [] });
    expect(set).toBe(migrated.nodes);
  });

  // A stand-in for `migrate` that answers only for the drawing the server
  // sent, so what reaches the canvas can only be the migrated drawing.
  const bringsUp = (sent: unknown, migrated: { nodes: Node[]; edges: Edge[] }) =>
    (d: unknown) => { expect(d).toEqual(sent); return migrated; };
  const whatIsSet = () => {
    const out: { nodes?: Node[]; edges?: Edge[]; seeded?: Node[] } = {};
    return { out, setNodes: (n: Node[]) => { out.nodes = n; }, setEdges: (e: Edge[]) => { out.edges = e; }, seed: (n: Node[]) => { out.seeded = n; } };
  };

  it('opens a drawing brought up to date, and takes that as the drawing the autosave last saved', async () => {
    const effect = canvasCode("// Load the selected diagram's working copy", null,
      ['useEffect', 'loadedId', 'api', 'diagramRef', 'migrate', 'seedIdsFrom', 'setNodes', 'setEdges', 'resetHistory',
        'lastSaved', 'diagramKey'], 'null');
    const sent = { nodes: [part('Old', 0, 0)], edges: [] };
    const migrated = { nodes: [part('New', 0, 0)], edges: [E('New', 'r', 'New', 'l')] };
    const set = whatIsSet();
    const loadedId = { current: null as string | null }, lastSaved = { current: '' };
    let history: unknown = null;
    const opened = Promise.resolve(sent);
    effect((f: () => void) => f(), loadedId, { loadDiagram: () => opened, toStored: api.toStored }, { id: 'd' },
      bringsUp(sent, migrated), set.seed, set.setNodes, set.setEdges, (g: unknown) => { history = g; }, lastSaved, 'd');
    await opened; await Promise.resolve();
    expect(set.out.nodes).toBe(migrated.nodes);
    expect(set.out.edges).toBe(migrated.edges);
    expect(set.out.seeded).toBe(migrated.nodes);
    expect(history).toBe(migrated);
    expect(lastSaved.current).toBe(JSON.stringify(api.toStored(migrated)));
    expect(loadedId.current).toBe('d');
  });

  for (const [what, ref, fetch] of [
    ['a micro version', 'restoreMicroRef', 'getVersion'],
    ['a release', 'restoreReleaseRef', 'getRelease'],
  ] as const) {
    it(`restores ${what} brought up to date, as opening one does`, async () => {
      const restore = canvasCode(`${ref}.current = useCallback(`, null,
        ['useCallback', ref, 'readOnlyRef', 'api', 'diagramRef', 'flushHistory', 'migrate', 'seedIdsFrom', 'setNodes',
          'setEdges', 'diagramKey'], ref);
      const sent = { nodes: [part('Old', 0, 0)], edges: [] };
      const migrated = { nodes: [part('New', 0, 0)], edges: [E('New', 'r', 'New', 'l')] };
      const set = whatIsSet();
      const target = { current: async (_: string) => {} };
      restore(useCallback, target, { current: false }, { [fetch]: async () => sent }, { id: 'd' }, () => {},
        bringsUp(sent, migrated), set.seed, set.setNodes, set.setEdges, 'd');
      await target.current('v1');
      expect(set.out.nodes).toBe(migrated.nodes);
      expect(set.out.edges).toBe(migrated.edges);
      expect(set.out.seeded).toBe(migrated.nodes);
    });
  }
});
