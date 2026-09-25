// What a line draws, and what a hand edit on it writes.
//
// The line is a React Flow edge; there is no DOM here, so it is called
// through the small hook runtime in hookRuntime.ts, with React Flow's hooks
// stood in for by the drawing under test: `useStore` hands its selector the
// store's nodes, `useStoreApi` the same store to read and listen to,
// `useNodesData` the two ends, `useReactFlow` the drawing and a setter that
// records what the line writes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Position } from '@xyflow/react';
import type { Edge, EdgeProps, Node } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});
const flow = vi.hoisted(() => ({
  nodes: [] as import('@xyflow/react').Node[],
  edges: [] as import('@xyflow/react').Edge[],
  writes: [] as ((eds: import('@xyflow/react').Edge[]) => import('@xyflow/react').Edge[])[],
  nodeWrites: [] as import('@xyflow/react').Node[][],
  edgeSets: [] as import('@xyflow/react').Edge[][],
  zoom: 1,
  connecting: false,
  // React Flow's store, as `useStoreApi` hands it out: one object for the
  // canvas's life, told of every change (`changedStore`).
  listeners: new Set<() => void>(),
  api: null as unknown as { getState(): { nodes: import('@xyflow/react').Node[] }; subscribe(l: () => void): () => void },
}));
flow.api = {
  getState: () => ({ nodes: flow.nodes }),
  subscribe: (l: () => void) => { flow.listeners.add(l); return () => { flow.listeners.delete(l); }; },
};
/** The canvas's store has changed: its listeners are told. */
const changedStore = () => { for (const l of [...flow.listeners]) l(); };
vi.mock('@xyflow/react', async (orig) => {
  const X = await orig<typeof import('@xyflow/react')>();
  return {
    ...X,
    useStore: (select: (s: unknown) => unknown) => select({ nodes: flow.nodes, transform: [0, 0, flow.zoom] }),
    useStoreApi: () => flow.api,
    useConnection: (select: (c: unknown) => unknown) => select({ inProgress: flow.connecting }),
    useNodesData: (ids: string[]) => ids.map(id => {
      const n = flow.nodes.find(x => x.id === id)!;
      return { id, type: n.type, data: n.data };
    }),
    useReactFlow: () => ({
      getNodes: () => flow.nodes,
      getEdges: () => flow.edges,
      getZoom: () => flow.zoom,
      setNodes: (v: import('@xyflow/react').Node[]) => { flow.nodeWrites.push(v); },
      setEdges: (f: import('@xyflow/react').Edge[] | ((eds: import('@xyflow/react').Edge[]) => import('@xyflow/react').Edge[])) => {
        if (typeof f === 'function') flow.writes.push(f); else flow.edgeSets.push(f);
      },
      screenToFlowPosition: (p: { x: number; y: number }) => p,
    }),
  };
});
// The pull a press begins, and the designer's lookups the line reads.
const branch = vi.hoisted(() => ({
  begun: [] as unknown[],
  drop: null as import('./BranchDrag').DropLookups | null,
}));
vi.mock('./BranchDrag', async (orig) => {
  const B = await orig<typeof import('./BranchDrag')>();
  return { ...B, useBranchDrag: () => ({ begin: (s: unknown) => { branch.begun.push(s); }, active: false, drop: branch.drop }) };
});
// A line draws as the store of every line's route says (edgeGeometry.ts).
// Most cases here draw one line on its own, which publishes nowhere and so
// draws its own route; the cases about lines drawn together turn it on.
const store = vi.hoisted(() => ({ on: false }));
vi.mock('./edgeGeometry', async (orig) => {
  const G = await orig<typeof import('./edgeGeometry')>();
  return {
    ...G,
    publishEdge: (...a: Parameters<typeof G.publishEdge>) => { if (store.on) G.publishEdge(...a); },
    unpublishEdge: (...a: Parameters<typeof G.unpublishEdge>) => { if (store.on) G.unpublishEdge(...a); },
  };
});

import { find, rt } from './hookRuntime';
import { BranchableEdge, END_REACH, forgetHover, hitWidth, hoverSpot, leaveHover } from './BranchableEdge';
import { handToLine } from './lineHit';
import { J_END, J_HALF, isJunction, junctionEnd, reseatJunctions, splitSpot } from './junctions';
import type { EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { pathPoints, pointAtArc, pointsToPath, polylineLength, routeOrthogonal, segmentEntersBox, simplifyPoints } from './route';
import type { Pt } from './route';
import { obstaclesByPage } from './routeGrid';
import { lineView, publishEdge, unpublishEdge } from './edgeGeometry';

const P = (x: number, y: number): Pt => ({ x, y });
const part = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id },
});
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
  const { x, y } = node.position;
  switch (handle) {
    case 'l': return { x: x - 3, y: y + 30, side: Position.Left };
    case 'r': return { x: x + 63, y: y + 30, side: Position.Right };
    case 't': return { x: x + 30, y: y - 3, side: Position.Top };
    case 'b': return { x: x + 30, y: y + 63, side: Position.Bottom };
    default: return null;
  }
};
const dataOf = (e: Edge) => (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean };

/** The props React Flow hands a line: its ends where the ports are. */
function propsOf(e: Edge, selected = false): EdgeProps {
  const s = flow.nodes.find(n => n.id === e.source)!, t = flow.nodes.find(n => n.id === e.target)!;
  const a = endOf(s, e.sourceHandle)!, b = endOf(t, e.targetHandle)!;
  return {
    id: e.id, source: e.source, target: e.target, sourceHandleId: e.sourceHandle, targetHandleId: e.targetHandle,
    sourceX: a.x, sourceY: a.y, targetX: b.x, targetY: b.y, sourcePosition: a.side, targetPosition: b.side,
    data: e.data, selected,
  } as EdgeProps;
}
const drawnOf = (tree: unknown): Pt[] =>
  pathPoints(find(tree, e => typeof e.props.path === 'string')[0].props.path as string);
const box = (n: Node) => ({ x: n.position.x, y: n.position.y, w: 60, h: 60 });
const enters = (pts: Pt[], n: Node) => pts.some((p, i) => i + 1 < pts.length && segmentEntersBox(p, pts[i + 1], box(n), 2));

/** A Z from A to B with a tee on its vertical leg, seated: each half carries a corner of the pipe, as the pipe's. */
function teedZ() {
  const nodes = [part('A', 0, 0), part('B', 400, 300)];
  const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
  const pts = pathPoints(routeOrthogonal(endOf(nodes[0], 'r')!, endOf(nodes[1], 'l')!).d);
  const split = splitEdgeAt(nodes, [run], 'A-B', P(pts[1].x, 180), undefined, { points: pts })!;
  const seated = reseatJunctions(split.nodes, split.edges, endOf);
  return { ...seated, tee: split.junctionId };
}

type G = { window?: unknown };
beforeEach(() => {
  rt.reset();
  flow.writes = [];
  flow.nodeWrites = [];
  flow.edgeSets = [];
  flow.zoom = 1;
  flow.connecting = false;
  branch.begun = [];
  branch.drop = null;
  (globalThis as unknown as G).window = new EventTarget();
  // The dot is the page's, not a line's: start each case with none.
  leaveHover();
});
const pointer = (type: string, x: number, y: number) => Object.assign(new Event(type), { clientX: x, clientY: y });
const press = (x: number, y: number, altKey = false) =>
  ({ button: 0, altKey, clientX: x, clientY: y, stopPropagation() {}, preventDefault() {} });

describe('a line', () => {
  it('that routes itself is drawn round the symbols in its way', () => {
    const T = part('T', 200, 0), V2 = part('V2', 200, 200), V3 = part('V3', 300, 200);
    flow.nodes = [T, V2, V3];
    const e: Edge = { id: 'T-V3', source: 'T', sourceHandle: 'b', target: 'V3', targetHandle: 'l', data: {} };
    const drawn = drawnOf(rt.settle(() => BranchableEdge(propsOf(e))));
    expect(enters(pathPoints(routeOrthogonal(endOf(T, 'b')!, endOf(V3, 'l')!).d), V2)).toBe(true);
    expect(enters(drawn, V2)).toBe(false);
  });

  it('of a pipe is drawn as its pipe drew it, whatever it passes', () => {
    const { nodes, edges, tee } = teedZ();
    // Its halves carry corners; a straight half is the pipe's too. Two tees
    // on the vertical leg leave a straight piece between them, and a symbol
    // dropped across it since the pipe was routed.
    const split = splitEdgeAt(nodes, edges, edges.find(e => e.source === tee)!.id, P(230, 300), undefined, {
      points: pathPoints(routeOrthogonal(endOf(nodes.find(n => n.id === tee)!, 'b')!, endOf(nodes[1], 'l')!).d),
    })!;
    const seated = reseatJunctions(split.nodes, split.edges, endOf);
    flow.nodes = [...seated.nodes, part('X', 200, 210)];
    const straight = seated.edges.find(e => e.source === tee && e.target === split.junctionId)!;
    expect(dataOf(straight).waypoints ?? []).toEqual([]);
    const drawn = drawnOf(rt.settle(() => BranchableEdge(propsOf(straight))));
    expect(drawn).toHaveLength(2);
  });
});

describe('a line drawn with the lines around it', () => {
  // Two feeds between two columns, each dropping further than they are
  // apart: alone, each is a Z with its crossbar at x = 180, and together the
  // second turns a grid step earlier (tracks.ts).
  const nodes = [part('HV1', 0, 0), part('HV2', 0, 100), part('SV1', 300, 120), part('SV2', 300, 220)];
  const first: Edge = { id: 'HV1-SV1', source: 'HV1', sourceHandle: 'r', target: 'SV1', targetHandle: 'l', data: {} };
  const second: Edge = { id: 'HV2-SV2', source: 'HV2', sourceHandle: 'r', target: 'SV2', targetHandle: 'l', data: {} };
  const settled = () => new Promise(r => setTimeout(r, 0));
  /** Another line, publishing as it does when it draws: the route it routed itself, and its ends. */
  const other = (e: Edge) => {
    const a = endOf(nodes.find(n => n.id === e.source)!, e.sourceHandle)!, b = endOf(nodes.find(n => n.id === e.target)!, e.targetHandle)!;
    publishEdge(e.id, pathPoints(routeOrthogonal(a, b).d), { a, b, free: true });
  };
  /** A line drawn, and drawn again once the store has caught up with what it published. */
  const drawTwice = async (e: Edge, selected = false) => {
    rt.settle(() => BranchableEdge(propsOf(e, selected)));
    await settled();
    return rt.settle(() => BranchableEdge(propsOf(e, selected)));
  };
  beforeEach(() => { store.on = true; flow.nodes = nodes; flow.edges = [first, second]; });
  afterEach(async () => {
    rt.reset();
    unpublishEdge(first.id);
    unpublishEdge('H');
    await settled();
    store.on = false;
  });

  it('is drawn where the store puts it, off the line it would lie on, and publishes the route it routed', async () => {
    other(first);
    const drawn = drawnOf(await drawTwice(second));
    expect(drawn).toEqual([P(63, 130), P(170, 130), P(170, 250), P(297, 250)]);
    // What it told the store is its own route, not where it was drawn.
    expect(lineView(second.id)!.base.map(p => p.x)).toEqual([63, 180, 180, 297]);
  });

  it('shows its grips on the segments as drawn, and a segment drag starts from there', async () => {
    other(first);
    const tree = await drawTwice(second, true);
    const grip = find(tree, e => 'data-grip' in e.props).find(g => g.key === '1')!;
    const target = (grip.props.children as ReactElement<{ x: number }>[])[0];
    expect(target.props.x + 8).toBe(170);
    (grip.props.onPointerDown as (e: unknown) => void)(press(170, 190));
    rt.settle(() => BranchableEdge(propsOf(second, true)));
    ((globalThis as unknown as G).window as EventTarget).dispatchEvent(pointer('pointermove', 190, 190));
    const written = dataOf(flow.writes[0]([first, second]).find(e => e.id === second.id)!).waypoints!;
    expect(written.map(p => p.x)).toEqual([190, 190]);
  });

  it('with corners of its own is drawn through them, and the line beside it moves off it instead', async () => {
    const hand: Edge = { ...second, data: { waypoints: [P(180, 130), P(180, 250)] } };
    flow.edges = [first, hand];
    other(first);
    const drawn = drawnOf(await drawTwice(hand));
    expect(drawn.map(p => p.x)).toEqual([63, 180, 180, 297]);
    // Two grid steps off it, not one: a line moved off one that cannot move
    // keeps as far from it as a line the reseat chooses would.
    expect(lineView(first.id)!.pts.map(p => p.x)).toEqual([63, 200, 200, 297]);
  });

  it('when it moves, draws where it routed at once, not where it was drawn before', async () => {
    other(first);
    expect(drawnOf(await drawTwice(second)).map(p => p.x)).toEqual([63, 170, 170, 297]);
    // SV2 slides right: the crossbar's midpoint is now x = 200, clear of the
    // other line, and the store has not yet heard.
    flow.nodes = nodes.map(n => (n.id === 'SV2' ? part('SV2', 340, 220) : n));
    const drawn = simplifyPoints(drawnOf(rt.settle(() => BranchableEdge(propsOf(second)))));
    expect(drawn.map(p => p.x)).toEqual([63, 200, 200, 337]);
  });

  it('off a tee, says its end is a tee\'s, so it steps down as far as a tee\'s short stub allows', async () => {
    // Three free tees at x = 30 with branches to valves 60 px across: the
    // first two branches are drawn already, at x = 67.5 and 57.5.
    const tee = (id: string, y: number): Node =>
      ({ id, type: 'JUNCTION', position: { x: 25, y: y - 5 }, data: { componentType: 'JUNCTION' } });
    flow.nodes = [tee('t1', 150), tee('t2', 190), tee('t3', 230), part('V1', 100, 160), part('V2', 100, 260), part('V3', 100, 360)];
    const branch = (t: string, v: string): Edge => ({ id: `${t}-${v}`, source: t, sourceHandle: 'r', target: v, targetHandle: 'l', data: {} });
    for (const e of [branch('t1', 'V1'), branch('t2', 'V2')]) {
      const a = endOf(flow.nodes.find(n => n.id === e.source)!, 'r')!, b = endOf(flow.nodes.find(n => n.id === e.target)!, 'l')!;
      publishEdge(e.id, pathPoints(routeOrthogonal(a, b).d), { a, b, free: true });
    }
    const third = branch('t3', 'V3');
    flow.edges = [third];
    const drawn = drawnOf(await drawTwice(third));
    expect(drawn[1].x).toBe(47.5);
    unpublishEdge('t1-V1');
    unpublishEdge('t2-V2');
  });

  it('keeps its moved segment out of the symbols on the page', async () => {
    // A valve standing just where the step to x = 170 would run, clear of
    // both lines as they route themselves.
    flow.nodes = [...nodes, part('X', 115, 150)];
    other(first);
    // Its corners: at x = 190 it crosses the other line, and the hop's entry is in the path too.
    const drawn = simplifyPoints(drawnOf(await drawTwice(second)));
    expect(drawn.map(p => p.x)).toEqual([63, 190, 190, 297]);
  });

  it('is told when a symbol is put down on its moved segment, through the canvas\'s own store, though its route has not changed', async () => {
    other(first);
    expect(drawnOf(await drawTwice(second)).map(p => p.x)).toEqual([63, 170, 170, 297]);
    rt.heard();
    // An instrument on the moved crossbar, clear of both lines as they route
    // themselves at x = 180: nothing about this line changes, so it is not
    // drawn again of itself.
    flow.nodes = [...nodes, { ...part('PI', 158, 180), measured: { width: 20, height: 20 } }];
    changedStore();
    await settled();
    expect(rt.heard()).toBeGreaterThan(0);
    const drawn = simplifyPoints(drawnOf(rt.settle(() => BranchableEdge(propsOf(second)))));
    expect(drawn.map(p => p.x)).toEqual([63, 150, 150, 297]);
  });

  it('hops a line where it is drawn across it, not where it routed', async () => {
    other(first);
    publishEdge('H', [P(100, 200), P(250, 200)]);
    const tree = await drawTwice(second);
    const path = find(tree, e => typeof e.props.path === 'string')[0].props.path as string;
    expect(path).toMatch(/L 170,195 A /);
    expect(path).not.toMatch(/L 180,195 A /);
  });
});

describe('a hand edit', () => {
  it('writes a person\'s corners, and makes the whole pipe a person\'s', () => {
    const { nodes, edges, tee } = teedZ();
    flow.nodes = nodes; flow.edges = edges;
    const down = edges.find(e => e.source === tee)!, up = edges.find(e => e.target === tee)!;
    expect(dataOf(down).viaRun).toBe(true);
    expect(dataOf(up).viaRun).toBe(true);
    const props = propsOf(down, true);
    const tree = rt.settle(() => BranchableEdge(props));
    // The grip on the downstream half's horizontal leg.
    const drawn = drawnOf(tree);
    const leg = drawn.findIndex((p, i) => i + 1 < drawn.length && p.y === drawn[i + 1].y);
    const grips = find(tree, e => 'data-grip' in e.props);
    const grip = grips.find(g => (g.key as string) === String(leg))!;
    const at = P((drawn[leg].x + drawn[leg + 1].x) / 2, drawn[leg].y);
    (grip.props.onPointerDown as (e: unknown) => void)(press(at.x, at.y));
    rt.settle(() => BranchableEdge(props));
    ((globalThis as unknown as G).window as EventTarget).dispatchEvent(pointer('pointermove', at.x, at.y + 40));
    expect(flow.writes).toHaveLength(1);
    const after = flow.writes[0](edges);
    const d = after.find(e => e.id === down.id)!, u = after.find(e => e.id === up.id)!;
    expect(dataOf(d).viaRun).toBeUndefined();
    expect(dataOf(d).waypoints!.some(p => p.y === drawn[leg].y + 40)).toBe(true);
    // The rest of the pipe keeps its slice, as its own.
    expect(dataOf(u).viaRun).toBeUndefined();
    expect(dataOf(u).waypoints).toEqual(dataOf(up).waypoints);
    // And a reseat leaves the edit where it was put.
    const re = reseatJunctions(nodes, after, endOf);
    expect(dataOf(re.edges.find(e => e.id === down.id)!).waypoints).toEqual(dataOf(d).waypoints);
  });

  it('is undone for the whole pipe by a double-click on a grip', () => {
    const { nodes, edges, tee } = teedZ();
    flow.nodes = nodes; flow.edges = edges;
    const down = edges.find(e => e.source === tee)!;
    const frozen = edges.map(e => {
      const { viaRun: _v, ...rest } = dataOf(e) as Record<string, unknown>;
      void _v;
      return { ...e, data: rest };
    });
    const tree = rt.settle(() => BranchableEdge(propsOf(frozen.find(e => e.id === down.id)!, true)));
    // A grip, by its mark: the line's own element takes double-clicks too,
    // to hand one aimed at a nearer line to that line.
    const grip = find(tree, e => 'data-grip' in e.props)[0];
    (grip.props.onDoubleClick as (e: unknown) => void)({ stopPropagation() {}, preventDefault() {} });
    const after = flow.writes[0](frozen);
    for (const e of after) expect(dataOf(e).waypoints).toBeUndefined();
  });
});

// ── The pointer ──────────────────────────────────────────────────────────────

type El = ReactElement<Record<string, unknown>>;
const draw = (e: Edge, selected = false) => rt.settle(() => BranchableEdge(propsOf(e, selected))) as El;
/** The line's own element: the handlers React Flow's wrapper sits round. */
const root = (tree: El) => tree.props as Record<string, (e: unknown) => void>;
const gripsIn = (tree: El) => find(tree, e => 'data-grip' in e.props);
const dotIn = (tree: El) => find(tree, e => e.type === 'circle')[0]?.props as { cx: number; cy: number } | undefined;
/** A pointer event as React hands it over, recording what the handler did with it. */
function ev(x: number, y: number, more: Record<string, unknown> = {}) {
  const did = { stopped: false, prevented: false };
  return {
    did, e: {
      button: 0, altKey: false, clientX: x, clientY: y, target: { closest: () => null },
      stopPropagation() { did.stopped = true; }, preventDefault() { did.prevented = true; }, ...more,
    },
  };
}
/** The lookups the designer lends: here, only the ports as measured. */
const lend = () => { branch.drop = { scene: () => ({ nodes: flow.nodes, edges: flow.edges, endOf }), under: () => ({}), carrying: () => null }; };

/**
 * A page with these lines drawn on it, as React Flow renders them -- each
 * its own element, its path readable -- recording what is dispatched on
 * each. Taken down after the test that put it up.
 */
function page(lines: { id: string; pts: Pt[] }[], arrived?: (id: string, e: { type: string; clientX: number; clientY: number }) => void) {
  const sent: { id: string; type: string; x: number; y: number }[] = [];
  const els = lines.map(l => ({
    getAttribute: (a: string) => (a === 'data-id' ? l.id : null),
    querySelector: () => ({ getAttribute: () => pointsToPath(l.pts) }),
    dispatchEvent: (e: { type: string; clientX: number; clientY: number }) => {
      sent.push({ id: l.id, type: e.type, x: e.clientX, y: e.clientY });
      arrived?.(l.id, e);
      return true;
    },
  }));
  const g = globalThis as unknown as { document?: unknown; MouseEvent?: unknown };
  g.document = { querySelectorAll: () => els };
  class Mouse extends Event {
    clientX: number; clientY: number;
    constructor(type: string, init: EventInit & { clientX: number; clientY: number }) { super(type, init); this.clientX = init.clientX; this.clientY = init.clientY; }
  }
  g.MouseEvent = Mouse;
  return { sent, down: () => { delete g.document; delete g.MouseEvent; } };
}

/** Two lines side by side, 8 px apart: A.r -> B.l along y = 33, C.r -> D.l along y = 41. */
function pair() {
  const nodes = [part('A', 0, 3), part('B', 400, 3), part('C', 0, 11), part('D', 400, 11)];
  const edges: Edge[] = [
    { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} },
    { id: 'C-D', source: 'C', sourceHandle: 'r', target: 'D', targetHandle: 'l', data: {} },
  ];
  flow.nodes = nodes; flow.edges = edges;
  return { edges, lines: edges.map(e => ({ id: e.id, pts: pathPoints(routeOrthogonal(endOf(nodes.find(n => n.id === e.source)!, 'r')!, endOf(nodes.find(n => n.id === e.target)!, 'l')!).d) })) };
}

describe('what takes the pointer', () => {
  it('is one band, hitWidth across on the screen, and never narrower than that on the drawing', () => {
    const e: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
    flow.nodes = [part('A', 0, 0), part('B', 400, 0)];
    for (const [zoom, width] of [[1, 9], [2, 9], [0.5, 18], [0.7, 13]] as const) {
      rt.reset();
      flow.zoom = zoom;
      expect(hitWidth(zoom)).toBe(width);
      const tree = draw(e);
      const base = find(tree, x => typeof x.props.path === 'string');
      expect(base).toHaveLength(1);
      expect(base[0].props.interactionWidth, `zoom ${zoom}`).toBe(width);
      // No second, wider path of its own over React Flow's.
      expect(find(tree, x => x.type === 'path')).toEqual([]);
    }
  });
});

describe('segment grips', () => {
  const run = (): Edge => {
    flow.nodes = [part('A', 0, 0), part('B', 400, 200)];
    return { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
  };

  it('are on a line only while it is picked: the pointer crossing it shows the tee dot and no grip', () => {
    const e = run();
    let tree = draw(e);
    expect(gripsIn(tree)).toEqual([]);
    root(tree).onMouseMove(ev(230, 150).e);
    tree = draw(e);
    expect(dotIn(tree)).toBeDefined();
    expect(gripsIn(tree)).toEqual([]);
    rt.reset();
    expect(gripsIn(draw(e, true)).length).toBeGreaterThan(0);
  });

  it('let the pointer\'s moves through to React Flow, and show no tee dot over themselves', () => {
    const e = run();
    const tree = draw(e, true);
    for (const g of gripsIn(tree)) expect(g.props.onMouseMove).toBeUndefined();
    root(tree).onMouseMove(ev(230, 150, { target: { closest: (sel: string) => (sel === '[data-grip]' ? {} : null) } }).e);
    expect(dotIn(draw(e, true))).toBeUndefined();
  });

  it('and the tee dot are not shown while a port drag is in progress', () => {
    const e = run();
    root(draw(e)).onMouseMove(ev(230, 150).e);
    expect(dotIn(draw(e, true))).toBeDefined();
    flow.connecting = true;
    const tree = draw(e, true);
    expect(gripsIn(tree)).toEqual([]);
    expect(dotIn(tree)).toBeUndefined();
    // Nor does the pointer crossing the line during one put a dot on it.
    flow.connecting = false;
    rt.reset();
    root(draw(e)).onMouseMove(ev(230, 150).e);
    flow.connecting = true;
    root(draw(e)).onMouseMove(ev(230, 120).e);
    flow.connecting = false;
    expect(dotIn(draw(e))).toEqual(expect.objectContaining({ cy: 150 }));
  });
});

/** A short vertical piece of a pipe between two tees, where the pipe keeps a tee somewhere else than the piece alone would. */
function crowded() {
  let nodes = [part('A', 0, 0), part('B', 140, 60)];
  const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
  const drawnOf = (e: Edge, ns: Node[]) => pathPoints(routeOrthogonal(endOf(ns.find(n => n.id === e.source)!, e.sourceHandle)!, endOf(ns.find(n => n.id === e.target)!, e.targetHandle)!).d);
  const pts = drawnOf(run, nodes);
  const one = splitEdgeAt(nodes, [run], 'A-B', pointAtArc(pts, 0.3 * polylineLength(pts))!.point, undefined, { points: pts, endOf, obstacles: obstaclesByPage(nodes) })!;
  let g = reseatJunctions(one.nodes, one.edges, endOf, obstaclesByPage(one.nodes));
  const second = g.edges.find(e => e.source === one.junctionId)!;
  const p1 = (() => { const s = g.nodes.find(n => n.id === second.source)!, t = g.nodes.find(n => n.id === second.target)!; return pathPoints(routeOrthogonal(endOf(s, second.sourceHandle)!, endOf(t, second.targetHandle)!).d); })();
  const two = splitEdgeAt(g.nodes, g.edges, second.id, pointAtArc(p1, 0.5 * polylineLength(p1))!.point, undefined, { points: p1, endOf, obstacles: obstaclesByPage(g.nodes) })!;
  g = reseatJunctions(two.nodes, two.edges, endOf, obstaclesByPage(two.nodes));
  nodes = g.nodes;
  const piece = g.edges.find(e => e.source === one.junctionId && e.target === two.junctionId)!;
  return { nodes, edges: g.edges, piece };
}

/**
 * The crowded piece, drawn, and a point along it where the pipe's answer to
 * "where would a tee land" and the piece's own answer differ -- and the
 * pipe's answer.
 */
function crowdedAt() {
  const { nodes, edges, piece } = crowded();
  flow.nodes = nodes; flow.edges = edges;
  lend();
  const tree = draw(piece);
  const pts = pathPoints(find(tree, x => typeof x.props.path === 'string')[0].props.path as string);
  const geometry = { endOf, obstacles: obstaclesByPage(nodes) };
  // The piece alone has nowhere a tee can sit: its answer is the pointer.
  const at = Array.from({ length: 40 }, (_, i) => pointAtArc(pts, (i / 39) * polylineLength(pts))!.point).find(p => {
    const a = splitSpot(nodes, edges, piece.id, pts, p)?.point ?? p, b = splitSpot(nodes, edges, piece.id, pts, p, undefined, geometry)!.point;
    return Math.hypot(a.x - b.x, a.y - b.y) > 1;
  })!;
  expect(at).toBeDefined();
  const want = splitSpot(nodes, edges, piece.id, pts, at, undefined, geometry)!.point;
  expect(Math.hypot(want.x - at.x, want.y - at.y)).toBeGreaterThan(1);
  return { nodes, piece, tree, at, want };
}

describe('the tee dot', () => {
  it('is where a tee put in there lands -- on the whole pipe, as the reseat keeps it -- not the point under the pointer', () => {
    const { piece, tree, at, want } = crowdedAt();
    root(tree).onMouseMove(ev(at.x + 3, at.y).e);
    expect(dotIn(draw(piece))).toEqual(expect.objectContaining({ cx: want.x, cy: want.y }));
  });

  it('is put in where it shows by an Alt-click', () => {
    const { nodes, piece, tree, at, want } = crowdedAt();
    root(tree).onMouseMove(ev(at.x, at.y).e);
    const dot = dotIn(draw(piece))!;
    expect({ x: dot.cx, y: dot.cy }).toEqual(want);
    const { e, did } = ev(at.x, at.y, { altKey: true });
    root(draw(piece)).onPointerDown(e);
    expect(did.stopped).toBe(true);
    const put = flow.nodeWrites.at(-1)!.find(n => isJunction(n) && !nodes.some(o => o.id === n.id))!;
    expect({ cx: put.position.x + J_HALF, cy: put.position.y + J_HALF }).toEqual({ cx: dot.cx, cy: dot.cy });
    expect(branch.begun).toEqual([]);
  });
});

describe('a press', () => {
  it('goes to the drawn line nearest the pointer, whichever line\'s band it landed in', () => {
    const { edges, lines } = pair();
    const shown = page(lines);
    try {
      // In A-B's band, 3 px from it and 5 px from C-D: A-B's.
      root(draw(edges[0])).onPointerDown(ev(200, 36).e);
      // In A-B's band too, but 3 px from C-D and 5 px from A-B: C-D's.
      rt.reset();
      const { e, did } = ev(200, 38);
      root(draw(edges[0])).onPointerDown(e);
      expect(did.stopped).toBe(true);
      expect(branch.begun).toEqual([
        { kind: 'line', edgeId: 'A-B', at: P(200, 33), dir: P(1, 0), points: lines[0].pts },
        { kind: 'line', edgeId: 'C-D', at: P(200, 41), dir: P(1, 0), points: lines[1].pts },
      ]);
    } finally { shown.down(); }
  });

  it('and a hover the same: the dot goes on the nearer line', () => {
    const { edges, lines } = pair();
    const shown = page(lines);
    try {
      root(draw(edges[0])).onMouseMove(ev(200, 38).e);
      expect(dotIn(draw(edges[0]))).toBeUndefined();
      // Read off the store: drawing C-D here would take A-B off the page,
      // and the dot A-B's band put on C-D with it.
      expect(hoverSpot()).toEqual({ id: 'C-D', point: P(200, 41) });
    } finally { shown.down(); }
  });

  it('within END_REACH of a symbol\'s port is the end\'s: no branch starts there, and React Flow gets the press', () => {
    flow.nodes = [part('A', 0, 0), part('B', 400, 0)];
    const e: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
    for (const x of [63 + 2, 63 + END_REACH - 1, 397 - END_REACH + 1]) {
      const { e: press, did } = ev(x, 33);
      root(draw(e)).onPointerDown(press);
      expect(did.stopped, `x ${x}`).toBe(false);
    }
    expect(branch.begun).toEqual([]);
    root(draw(e)).onPointerDown(ev(63 + END_REACH + 2, 33).e);
    expect(branch.begun).toHaveLength(1);
  });

  it('beside a tee\'s end pulls a branch as anywhere else: a tee\'s end is not carried', () => {
    const { nodes, edges, tee } = teedZ();
    flow.nodes = nodes; flow.edges = edges;
    const down = edges.find(x => x.source === tee)!;
    const t = nodes.find(n => n.id === tee)!;
    const start = junctionEnd(t.position, down.sourceHandle as Face);
    const tree = draw(down);
    const pts = pathPoints(find(tree, x => typeof x.props.path === 'string')[0].props.path as string);
    const at = pointAtArc(pts, 4)!.point;
    expect(Math.hypot(at.x - start.x, at.y - start.y)).toBeLessThan(END_REACH);
    root(tree).onPointerDown(ev(at.x, at.y).e);
    expect(branch.begun).toHaveLength(1);
  });
});

describe('a click', () => {
  it('nearer another line is that line\'s: handed to its element, and kept from this one\'s', () => {
    const { edges, lines } = pair();
    const shown = page(lines);
    try {
      for (const type of ['click', 'dblclick', 'contextmenu']) {
        const { e, did } = ev(200, 38, { type });
        root(draw(edges[0]))[type === 'click' ? 'onClick' : type === 'dblclick' ? 'onDoubleClick' : 'onContextMenu'](e);
        expect(did.stopped, type).toBe(true);
      }
      expect(shown.sent).toEqual(['click', 'dblclick', 'contextmenu'].map(type => ({ id: 'C-D', type, x: 200, y: 38 })));
      // On its own line it is left to React Flow.
      const { e, did } = ev(200, 34, { type: 'click' });
      root(draw(edges[0])).onClick(e);
      expect(did.stopped).toBe(false);
      expect(shown.sent).toHaveLength(3);
    } finally { shown.down(); }
  });

  it('handed on to a line is kept by it, whatever it would judge itself', () => {
    // A tee hands on a click nearer another line than its own centre, having
    // left its own lines out; the line it goes to may find one of those, or
    // another, nearer still. Judged again, the click went on to that one.
    const { edges, lines } = pair();
    let kept: { stopped: boolean; prevented: boolean } | null = null;
    const shown = page(lines, (id, sent) => {
      if (id !== 'C-D') return;
      const { e, did } = ev(sent.clientX, sent.clientY, { type: sent.type });
      root(draw(edges[1])).onClick(e);
      kept = did;
    });
    try {
      // 2 px from A-B, 6 from C-D: C-D's band would pass it to A-B.
      const { e, did } = ev(200, 35, { type: 'click' });
      expect(handToLine('C-D', { ...e, type: 'click' })).toBe(true);
      expect(did).toEqual({ stopped: true, prevented: true });
      expect(kept).toEqual({ stopped: false, prevented: false });
      expect(shown.sent.map(x => x.id)).toEqual(['C-D']);
      // Once it has been, the line judges its own clicks again.
      const { e: after, did: judged } = ev(200, 35, { type: 'click' });
      root(draw(edges[1])).onClick(after);
      expect(judged.stopped).toBe(true);
      expect(shown.sent.map(x => x.id)).toEqual(['C-D', 'A-B']);
    } finally { shown.down(); }
  });
});

describe('the hover dot', () => {
  it('goes with the line it is on when that line leaves the page, and does not come back with it', () => {
    const { edges, lines } = pair();
    const shown = page(lines);
    try {
      root(draw(edges[0])).onMouseMove(ev(200, 34).e);
      expect(dotIn(draw(edges[0]))).toEqual(expect.objectContaining({ cy: 33 }));
      // Deleted from the keyboard, the pointer where it was: no mouseleave.
      rt.reset();
      expect(hoverSpot()).toBeNull();
      // Put back by an undo, somewhere the pointer no longer is.
      expect(dotIn(draw(edges[0]))).toBeUndefined();
    } finally { shown.down(); }
  });

  it('goes with the line whose band it was put from, though it is on another', () => {
    const { edges, lines } = pair();
    const shown = page(lines);
    try {
      root(draw(edges[0])).onMouseMove(ev(200, 38).e);
      expect(hoverSpot()?.id).toBe('C-D');
      rt.reset();
      expect(hoverSpot()).toBeNull();
    } finally { shown.down(); }
  });

  it('asked for by a line that leaves the page before the frame it waits for, is never put', () => {
    const { edges, lines } = pair();
    const frames: (() => void)[] = [];
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    g.requestAnimationFrame = (f: () => void) => { frames.push(f); return frames.length; };
    const shown = page(lines);
    try {
      root(draw(edges[0])).onMouseMove(ev(200, 34).e);
      rt.reset();
      frames.splice(0).forEach(f => f());
      expect(hoverSpot()).toBeNull();
      // And a line still on the page is answered at its frame.
      root(draw(edges[1])).onMouseMove(ev(200, 40).e);
      expect(hoverSpot()).toBeNull();
      frames.splice(0).forEach(f => f());
      expect(hoverSpot()).toEqual({ id: 'C-D', point: P(200, 41) });
    } finally {
      frames.splice(0).forEach(f => f());
      delete g.requestAnimationFrame;
      shown.down();
    }
  });

  it('goes with the line it is on, whatever put it there, and stays when some other line or tee leaves', () => {
    const { edges, lines } = pair();
    const shown = page(lines);
    try {
      // Put on C-D from its own band: A-B leaving, or a tee, has nothing to do with it.
      root(draw(edges[1])).onMouseMove(ev(200, 40).e);
      forgetHover('A-B');
      forgetHover('tee:T');
      expect(hoverSpot()).toEqual({ id: 'C-D', point: P(200, 41) });
      // Put on C-D from A-B's band: C-D leaving takes it all the same.
      rt.reset();
      root(draw(edges[0])).onMouseMove(ev(200, 38).e);
      expect(hoverSpot()?.id).toBe('C-D');
      forgetHover('tee:T');
      expect(hoverSpot()?.id).toBe('C-D');
      forgetHover('C-D');
      expect(hoverSpot()).toBeNull();
    } finally { shown.down(); }
  });
});

// The runtime hands back element trees; this keeps the import honest.
export type { ReactElement };
