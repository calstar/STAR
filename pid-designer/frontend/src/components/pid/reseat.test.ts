import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Position } from '@xyflow/react';
import type { Edge, InternalNode, Node } from '@xyflow/react';
import { J_END, isJunction, junctionEnd, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { pathPoints, routeOrthogonal, segmentEntersBox, turn } from './route';
import { drawnRoute } from './lineRoute';
import type { Pt } from './route';
import { obstacleBoxes, obstaclesByPage } from './routeGrid';
import type { Graph } from './history';
import { RUNAWAY, carryBaseline, freshGuard, handleSignature, reseatOnce, useReseat } from './reseat';

const P = (x: number, y: number): Pt => ({ x, y });
const graph = (): Graph => ({ nodes: [], edges: [] });

// ── The guard ────────────────────────────────────────────────────────────────

describe('the reseat guard', () => {
  it('reseats every change made from outside, however many arrive together', () => {
    // A drag at an ordinary speed makes far more than RUNAWAY changes in a
    // second; each is followed by the effect running once more on what the
    // reseat set, which is settled and is not seated again.
    const guard = freshGuard();
    const warnings: string[] = [];
    let seats = 0;
    let settled: Graph | null = null;
    // Each step a symbol a pixel further on; each settled with its tee moved.
    const at = (x: number): Graph => ({ nodes: [{ id: 'A', position: { x, y: 0 }, data: {} }], edges: [] });
    for (let k = 0; k < 10 * RUNAWAY; k++) {
      const edit = at(k);
      const seat = (g: Graph) => { seats++; return g === edit ? (settled = at(k + 0.5)) : g; };
      expect(reseatOnce(guard, edit, seat, m => warnings.push(m))).toBe(settled);
      expect(reseatOnce(guard, settled!, seat, m => warnings.push(m))).toBeNull();
    }
    expect(seats).toBe(10 * RUNAWAY);
    expect(warnings).toEqual([]);
  });

  it('takes what it settled as settled: its own answer, or the same drawing selected, is not seated again', () => {
    // The reseat is idempotent; proving it again on every answer cost as much
    // as the run that mattered, and a click on a symbol cost a whole run.
    const guard = freshGuard();
    let seats = 0;
    const node = (id: string, x: number): Node => ({ id, position: { x, y: 0 }, data: {} });
    const edit: Graph = { nodes: [node('A', 0), node('B', 100)], edges: [] };
    const settled: Graph = { nodes: [edit.nodes[0], node('B', 110)], edges: [] };
    const seat = (g: Graph) => { seats++; return g === edit ? settled : g; };
    const ports = 'measured';
    expect(reseatOnce(guard, edit, seat, undefined, [ports])).toBe(settled);
    expect(reseatOnce(guard, settled, seat, undefined, [ports])).toBeNull();
    expect(seats).toBe(1);
    // A click selects what was settled: new objects, the same drawing.
    const picked = { nodes: settled.nodes.map(n => ({ ...n, selected: true })), edges: settled.edges };
    expect(reseatOnce(guard, picked, seat, undefined, [ports])).toBeNull();
    expect(seats).toBe(1);
    // The ports measured again under it are something else to seat on.
    expect(reseatOnce(guard, picked, seat, undefined, ['re-measured'])).toBeNull();
    expect(seats).toBe(2);
    // And so is a node that moved.
    const moved = { nodes: [picked.nodes[0], { ...picked.nodes[1], position: { x: 120, y: 0 } }], edges: [] };
    reseatOnce(guard, moved, seat, undefined, ['re-measured']);
    expect(seats).toBe(3);
  });

  it('stops a reseat that never settles, says so once, and starts again on a change from outside', () => {
    // What else it runs on changing under every answer it gives -- the ports
    // re-measured after each one, say -- is how a reseat that never settles
    // would still run itself for ever.
    const guard = freshGuard();
    const warnings: string[] = [];
    const never = (g: Graph) => ({ nodes: [...g.nodes], edges: [...g.edges] });
    let g = graph(), runs = 0;
    for (;;) {
      const next = reseatOnce(guard, g, never, m => warnings.push(m), [runs]);
      if (!next) break;
      g = next;
      runs++;
      if (runs > 10 * RUNAWAY) throw new Error('never stopped');
    }
    // The first run is on a change from outside; RUNAWAY more on its own output.
    expect(runs).toBe(RUNAWAY + 1);
    expect(warnings).toHaveLength(1);
    // Held while nothing else changes, and quiet about it.
    expect(reseatOnce(guard, g, never, m => warnings.push(m), [-1])).toBeNull();
    expect(warnings).toHaveLength(1);
    // Anything else changing is not the reseat running itself.
    expect(reseatOnce(guard, graph(), never, m => warnings.push(m), [-1])).not.toBeNull();
  });

  it('does not count a run on a drawing it left settled', () => {
    // The ports being measured again, a page shown, a drag let go of: the
    // drawing is the one the last run left alone, and running on it again is
    // not the reseat running itself.
    const guard = freshGuard();
    const warnings: string[] = [];
    const g = graph();
    for (let k = 0; k < 5 * RUNAWAY; k++) expect(reseatOnce(guard, g, x => x, m => warnings.push(m))).toBeNull();
    expect(warnings).toEqual([]);
    expect(guard.runs).toBe(0);
  });
});

// ── The effect, in a React root ──────────────────────────────────────────────

// Tests run in node: react-dom needs a `window` to read the current event
// from, and a container that looks enough like an element to mount into.
const g = globalThis as unknown as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof g.window === 'undefined') g.window = { event: undefined };
const doc: Record<string, unknown> = { nodeType: 9, activeElement: null, body: null, addEventListener() {}, removeEventListener() {} };
doc.defaultView = { document: doc, HTMLIFrameElement: class {}, event: undefined };
const container = () => ({
  nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
  addEventListener() {}, removeEventListener() {}, textContent: '', firstChild: null, removeChild() {}, appendChild() {},
}) as unknown as Element;

const turnOf = (n: Node) => (n.data as { rotation?: number }).rotation ?? 0;
const valve = (id: string, x: number, y: number, rotation = 0): Node =>
  ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, rotation } });

/** A 60 px valve's `l` or `r` port, as React Flow measured it when the valve was turned by `rotation`. */
function valvePort(n: Node, handle: string, rotation: number) {
  const side = turn(handle === 'l' ? Position.Left : Position.Right, rotation);
  const { x, y } = n.position;
  switch (side) {
    case Position.Left: return { x: x - 3, y: y + 30, side };
    case Position.Right: return { x: x + 63, y: y + 30, side };
    case Position.Top: return { x: x + 30, y: y - 3, side };
    default: return { x: x + 30, y: y + 63, side };
  }
}

/** Valve A, a tee, valve B, and a branch from the tee down to valve C. */
function teedRun(): Graph {
  const A = valve('A', 0, 100), B = valve('B', 360, 100), C = valve('C', 100, 240, 90);
  const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
  const split = splitEdgeAt([A, B, C], [run], run.id, P(180, 130), undefined,
    { a: valvePort(A, 'r', 0), b: valvePort(B, 'l', 0) })!;
  const branch: Edge = { id: 'tee-C', source: split.junctionId, sourceHandle: 'b', target: 'C', targetHandle: 'l', data: {} };
  return { nodes: split.nodes, edges: [...split.edges, branch] };
}

/**
 * The canvas's use of the reseat: the drawing in state, the ports read off
 * what React Flow last measured (`measuredAt`, each symbol's turn when it
 * was measured), and a fingerprint of them (`ports`) that the test changes
 * as React Flow's store would after a re-measure.
 */
function mount(opened: Graph, opts: { ready?: boolean; reseat?: typeof reseatJunctions } = {}) {
  const measuredAt = new Map<string, number>();
  for (const n of opened.nodes) if (!isJunction(n)) measuredAt.set(n.id, turnOf(n));
  const endOf: EndLookup = (node, handle) => {
    if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
    const r = measuredAt.get(node.id);
    return r === undefined || !handle ? null : valvePort(node, handle, r);
  };
  const log: string[] = [];
  const box: { g: Graph; set?: (g: Graph) => void; ports?: (p: string) => void; again?: () => void } = { g: opened };
  let ready = opts.ready ?? true;
  let setReady: (r: boolean) => void = () => {};
  function Canvas() {
    const [nodes, setNodes] = React.useState<Node[]>(opened.nodes);
    const [edges, setEdges] = React.useState<Edge[]>(opened.edges);
    const [ports, setPorts] = React.useState('first');
    const [isReady, setIsReady] = React.useState(ready);
    setReady = setIsReady;
    box.g = { nodes, edges };
    box.set = x => { setNodes(x.nodes); setEdges(x.edges); };
    box.ports = setPorts;
    box.again = useReseat({
      nodes, edges, endOf, ready: isReady, ports,
      setNodes: n => { log.push('setNodes'); setNodes(n); },
      setEdges: e => { log.push('setEdges'); setEdges(e); },
      markCorrection: (before, after) => { log.push(`mark ${before.nodes === nodes && before.edges === edges} ${after !== null}`); },
      onCorrect: () => { log.push('baseline'); },
      reseat: opts.reseat ?? ((n, e, f, o) => { log.push('reseat'); return reseatJunctions(n, e, f, o); }),
      warn: m => { log.push(`warn ${m}`); },
    });
    return null;
  }
  const root = createRoot(container());
  React.act(() => { root.render(React.createElement(Canvas)); });
  return {
    get: () => box.g,
    log,
    endOf,
    /** R: the drawing says the symbol is turned; React Flow has not measured it yet. */
    turn: (id: string) => React.act(() => {
      box.set!({ nodes: box.g.nodes.map(n => (n.id === id ? { ...n, data: { ...n.data, rotation: (turnOf(n) + 90) % 360 } } : n)), edges: box.g.edges });
    }),
    /** A frame later: React Flow re-measures the symbol and tells its store's subscribers. */
    remeasure: (id: string) => React.act(() => {
      measuredAt.set(id, turnOf(box.g.nodes.find(n => n.id === id)!));
      box.ports!(`${id}@${measuredAt.get(id)}`);
    }),
    ready: () => React.act(() => { ready = true; setReady(true); }),
    again: () => React.act(() => { box.again!(); }),
    unmount: () => React.act(() => root.unmount()),
  };
}

const settledOn = (g: Graph, endOf: EndLookup) => {
  const re = reseatJunctions(g.nodes, g.edges, endOf);
  return re.nodes === g.nodes && re.edges === g.edges;
};

describe('the reseat effect', () => {
  it('seats a quarter-turned square symbol\'s tees on the ports it has once they are measured', () => {
    // R on a 60 px valve changes its data and not its size, and React Flow
    // re-measures its handles a frame later without a change to the drawing.
    // The reseat of the turn reads the old ports; the re-measure is what
    // must run it again.
    const c = mount(teedRun());
    expect(settledOn(c.get(), c.endOf)).toBe(true);
    c.turn('A');
    // Seated on the ports A had before the turn: not what is drawn.
    const stale = c.get();
    const fresh = new Map([['A', 90]]);
    const freshEnd: EndLookup = (n, h) => (fresh.has(n.id) && h ? valvePort(n, h, fresh.get(n.id)!) : c.endOf(n, h));
    expect(settledOn(stale, freshEnd)).toBe(false);
    c.remeasure('A');
    expect(c.get()).not.toBe(stale);
    expect(settledOn(c.get(), c.endOf)).toBe(true);
    c.unmount();
  });

  it('says a change is a correction, and tells the baseline, before it sets it', () => {
    const c = mount(teedRun());
    c.log.length = 0;
    c.turn('A');
    c.remeasure('A');
    const set = c.log.findIndex(l => l.startsWith('set'));
    expect(set).toBeGreaterThan(0);
    expect(c.log.slice(0, set)).toEqual(expect.arrayContaining(['mark true true', 'baseline']));
    expect(c.log.indexOf('mark true true')).toBeLessThan(c.log.indexOf('baseline'));
    c.unmount();
  });

  it('waits until every node has been measured', () => {
    const c = mount(teedRun(), { ready: false });
    c.turn('A');
    c.remeasure('A');
    expect(c.log).not.toContain('reseat');
    c.ready();
    expect(c.log).toContain('reseat');
    expect(settledOn(c.get(), c.endOf)).toBe(true);
    c.unmount();
  });

  it('never sets a drawing that has moved on since it seated it', () => {
    // A drag reports its next step before the effect of the last one has
    // run: the step's update is queued first, and a settled drawing of the
    // step before set outright after it threw the step away -- a bay dragged
    // whole lost that step's corner shift while its nodes kept theirs.
    const endOf: EndLookup = (node, handle) => {
      if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
      return handle ? valvePort(node, handle, turnOf(node)) : null;
    };
    // B moved down since the run was drawn: its pipe has to be routed afresh.
    const run = teedRun();
    const opened = { nodes: run.nodes.map(n => (n.id === 'B' ? { ...n, position: P(360, 140) } : n)), edges: run.edges };
    const box: { g: Graph } = { g: opened };
    let raced = false;
    function Canvas() {
      const [nodes, setNodes] = React.useState<Node[]>(opened.nodes);
      const [edges, setEdges] = React.useState<Edge[]>(opened.edges);
      box.g = { nodes, edges };
      useReseat({
        nodes, edges, endOf, ready: true, setNodes, setEdges,
        reseat: (n, e, f, o) => {
          const re = reseatJunctions(n, e, f, o);
          // The next drag step arrives while this run is under way, before
          // it sets anything: every line marked, as a carried corner would be.
          if (!raced && re.edges !== e) {
            raced = true;
            setEdges(eds => eds.map(x => ({ ...x, data: { ...x.data, stepped: true } })));
          }
          return re;
        },
      });
      return null;
    }
    const root = createRoot(container());
    React.act(() => { root.render(React.createElement(Canvas)); });
    expect(raced).toBe(true);
    // The step survived, and the drawing it made was settled in turn.
    expect(box.g.edges.every(e => (e.data as { stepped?: boolean }).stepped)).toBe(true);
    expect(reseatJunctions(box.g.nodes, box.g.edges, endOf).edges).toBe(box.g.edges);
    React.act(() => root.unmount());
  });

  it('runs once more when asked, whatever the guard has made of what it has', () => {
    // What the reseat handed back is taken as settled, even from a reseat
    // that would change it again; a drag let go of asks for the drawing to
    // be settled regardless, and gets another run.
    const never: typeof reseatJunctions = (n, e) => ({ nodes: [...n], edges: [...e] });
    const c = mount(teedRun(), { reseat: never });
    expect(c.log.filter(l => l === 'reseat' || l === 'setNodes').length).toBeGreaterThan(0);
    const before = c.log.filter(l => l === 'setNodes').length;
    c.again();
    expect(c.log.filter(l => l === 'setNodes').length).toBeGreaterThan(before);
    c.unmount();
  });
});

// ── What the reseat is told ──────────────────────────────────────────────────

describe('handleSignature', () => {
  const internal = (id: string, handleBounds?: { source: { id: string; position: Position; x: number; y: number; width: number; height: number }[] }) =>
    ({ id, internals: { handleBounds } }) as unknown as InternalNode;
  const hb = (turned: boolean) => ({
    source: turned
      ? [{ id: 'l', position: Position.Top, x: 27, y: -3, width: 6, height: 6 }, { id: 'r', position: Position.Bottom, x: 27, y: 57, width: 6, height: 6 }]
      : [{ id: 'l', position: Position.Left, x: -3, y: 27, width: 6, height: 6 }, { id: 'r', position: Position.Right, x: 57, y: 27, width: 6, height: 6 }],
  });

  it('changes when a node\'s handles are measured again turned, and not otherwise', () => {
    const a = hb(false), b = hb(false);
    const before = handleSignature(new Map([['A', internal('A', a)], ['B', internal('B', b)]]));
    // The same bounds, whatever else about the store changed.
    expect(handleSignature(new Map([['A', internal('A', a)], ['B', internal('B', b)]]))).toBe(before);
    // Re-measured the same: no change to report.
    expect(handleSignature(new Map([['A', internal('A', hb(false))], ['B', internal('B', b)]]))).toBe(before);
    // Re-measured turned: the same size, new ports.
    expect(handleSignature(new Map([['A', internal('A', hb(true))], ['B', internal('B', b)]]))).not.toBe(before);
  });

  it('tells a node that has not been measured from one that has', () => {
    expect(handleSignature(new Map([['A', internal('A')]]))).not.toBe(handleSignature(new Map([['A', internal('A', hb(false))]])));
  });
});

describe('a reseat on one page of several', () => {
  const on = (n: Node, page: string): Node => ({ ...n, data: { ...n.data, page } });
  it('routes a pipe round the symbols on its own page, and only those', () => {
    // Pages share one plane. A valve on the GSE page stands exactly where a
    // pipe on the Main page runs straight; it is in nobody's way there.
    const main = (n: Node) => on(n, 'Main');
    const A = main(valve('A', 0, 0)), B = main(valve('B', 400, 0));
    const ghost = on(valve('G', 200, 0), 'GSE');
    const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
    const endOf: EndLookup = (n, h) => (isJunction(n)
      ? (h ? { ...junctionEnd(n.position, h as Face), ...J_END } : null)
      : h ? valvePort(n, h, 0) : null);
    const split = splitEdgeAt([A, B, ghost], [run], 'A-B', P(120, 30), 'Main',
      { points: pathPoints(routeOrthogonal(valvePort(A, 'r', 0), valvePort(B, 'l', 0)).d) })!;
    const byPage = reseatJunctions(split.nodes, split.edges, endOf, obstaclesByPage(split.nodes));
    const flat = reseatJunctions(split.nodes, split.edges, endOf, obstacleBoxes(split.nodes));
    const corners = (r: Graph) => r.edges.map(e => ((e.data as { waypoints?: Pt[] }).waypoints ?? []).length);
    expect(corners(byPage)).toEqual([0, 0]);
    // The same valve on the pipe's own page is in its way.
    const mine = split.nodes.map(n => (n.id === 'G' ? on(n, 'Main') : n));
    expect(corners(reseatJunctions(mine, split.edges, endOf, obstaclesByPage(mine))).some(k => k > 0)).toBe(true);
    // One list for every page sent it round the GSE valve.
    expect(corners(flat).some(k => k > 0)).toBe(true);
    // And a symbol moving on another page is no change to this one.
    const moved = split.nodes.map(n => (n.id === 'G' ? { ...n, position: P(200, 40) } : n));
    const again = reseatJunctions(byPage.nodes.map(n => (n.id === 'G' ? moved.find(m => m.id === 'G')! : n)), byPage.edges, endOf,
      obstaclesByPage(moved));
    expect(again.edges).toBe(byPage.edges);
  });

  it('routes a pipe as the plain router does when it is told of nothing in the way', () => {
    // Told nothing, a reseat has no page to go by: its pipes run where the
    // plain router puts them, through a valve on their own page if need be.
    const main = (n: Node) => on(n, 'Main');
    const A = main(valve('A', 0, 0)), B = main(valve('B', 400, 0)), X = main(valve('X', 200, 0));
    const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
    const endOf: EndLookup = (n, h) => (isJunction(n)
      ? (h ? { ...junctionEnd(n.position, h as Face), ...J_END } : null)
      : h ? valvePort(n, h, 0) : null);
    const split = splitEdgeAt([A, B, X], [run], 'A-B', P(120, 30), 'Main',
      { points: pathPoints(routeOrthogonal(valvePort(A, 'r', 0), valvePort(B, 'l', 0)).d) })!;
    const corners = (r: Graph) => r.edges.map(e => ((e.data as { waypoints?: Pt[] }).waypoints ?? []).length);
    expect(corners(reseatJunctions(split.nodes, split.edges, endOf, obstaclesByPage(split.nodes))).some(k => k > 0)).toBe(true);
    expect(corners(reseatJunctions(split.nodes, split.edges, endOf))).toEqual([0, 0]);
  });
});

describe('a face chosen round the symbols on its page', () => {
  it('takes a branch round a symbol under its tee rather than back over its own pipe', () => {
    // The plain route out of the tee's bottom face runs into a valve; the
    // route that goes round it is still better than leaving by the top and
    // crossing the pipe to come back down. Priced by the plain route, the
    // valve cost that face as much as crossing the pipe did, and the branch
    // went over the top.
    const main = (n: Node): Node => ({ ...n, data: { ...n.data, page: 'Main' } });
    const A = main(valve('A', 0, 100)), B = main(valve('B', 400, 100)), C = main(valve('C', 280, 210, 270));
    const X1 = main(valve('X1', 150, 240)), X2 = main(valve('X2', 170, 220));
    const endOf: EndLookup = (n, h) => (isJunction(n)
      ? (h ? { ...junctionEnd(n.position, h as Face), ...J_END } : null)
      : h ? valvePort(n, h, turnOf(n)) : null);
    const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
    const s = splitEdgeAt([A, B, C, X1, X2], [run], 'A-B', P(200, 130), 'Main', { a: valvePort(A, 'r', 0), b: valvePort(B, 'l', 0) })!;
    const edges = [...s.edges, { id: 'T-C', source: s.junctionId, sourceHandle: 't', target: 'C', targetHandle: 'l', data: {} } as Edge];
    const obstacles = obstaclesByPage(s.nodes);
    const re = reseatJunctions(s.nodes, edges, endOf, obstacles);
    const branch = re.edges.find(e => e.id === 'T-C')!;
    expect(branch.sourceHandle).toBe('b');
    const drawn = drawnRoute(branch, new Map(re.nodes.map(n => [n.id, n])), endOf, obstacles)!;
    for (const bx of obstacles('Main')) {
      expect(drawn.some((p, i) => i + 1 < drawn.length && segmentEntersBox(p, drawn[i + 1], bx, 1))).toBe(false);
    }
    // Nowhere above the pipe.
    expect(Math.min(...drawn.map(p => p.y))).toBeGreaterThan(130);
  });

  it('is the one whose line, as drawn, is the cheapest', () => {
    // An open end joined to a valve, among other valves on its page and on
    // another. Every face the end could give the line is drawn as the line is
    // drawn (round what is in its way on its page); the one the reseat chose
    // costs no more than the best of them.
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const at = (n: number) => Math.round(rnd() * n) * 10;
    const cost = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0), 0)
      + 12 * Math.max(0, pts.length - 2);
    const endOf: EndLookup = (n, h) => (isJunction(n)
      ? (h ? { ...junctionEnd(n.position, h as Face), ...J_END } : null)
      : h ? valvePort(n, h, turnOf(n)) : null);
    const page = (n: Node, p: string): Node => ({ ...n, data: { ...n.data, page: p } });
    let chosenBest = 0, differed = 0;
    for (let k = 0; k < 150; k++) {
      const O: Node = page({ id: 'O', type: 'JUNCTION', position: P(195, 195), data: { componentType: 'JUNCTION', label: 'O' } }, 'Main');
      const S = page(valve('S', 150 + at(20), 100 + at(20), [0, 90, 180, 270][Math.floor(rnd() * 4)]), 'Main');
      const others = Array.from({ length: 6 }, (_, i) => page(valve(`X${i}`, at(40), at(40)), rnd() < 0.5 ? 'Main' : 'GSE'))
        .filter(x => ![S, O].some(n => Math.abs(x.position.x - n.position.x) < 80 && Math.abs(x.position.y - n.position.y) < 80));
      const nodes = [O, S, ...others];
      const line: Edge = { id: 'S-O', source: 'S', sourceHandle: 'r', target: 'O', targetHandle: 'l', data: {} };
      const byPage = obstaclesByPage(nodes);
      const re = reseatJunctions(nodes, [line], endOf, byPage);
      const byId = new Map(re.nodes.map(n => [n.id, n]));
      const drawnOn = (face: Face) => drawnRoute({ ...line, targetHandle: face }, byId, endOf, byPage)!;
      const clear = (pts: Pt[]) => !byPage('Main').some(bx => pts.some((p, i) => i + 1 < pts.length && segmentEntersBox(p, pts[i + 1], bx, 1)));
      const faces = (['t', 'b', 'l', 'r'] as Face[]).map(f => ({ f, pts: drawnOn(f) })).filter(o => clear(o.pts));
      if (!faces.length) continue;
      const chosen = re.edges[0].targetHandle as Face;
      const best = Math.min(...faces.map(o => cost(o.pts)));
      const mine = cost(drawnOn(chosen));
      expect(mine).toBeLessThanOrEqual(best + 1e-6);
      chosenBest++;
      // Cases where the face drawn cheapest has to go round something.
      const plainBest = Math.min(...faces.map(o => cost(pathPoints(routeOrthogonal(endOf(S, 'r')!, endOf(byId.get('O')!, o.f)!).d))));
      if (plainBest < best - 1e-6) differed++;
    }
    expect(chosenBest).toBeGreaterThan(100);
    expect(differed).toBeGreaterThan(0);
  });
});

// ── The autosave's baseline ──────────────────────────────────────────────────

describe('carryBaseline', () => {
  const text = (x: Graph) => JSON.stringify(x.nodes.map(n => [n.id, n.position]));
  const drawing = (x: number): Graph => ({ nodes: [valve('A', x, 0)], edges: [] });

  it('moves with a correction of the drawing as saved: opening a drawing does not save it back', () => {
    const opened = drawing(0), corrected = drawing(5);
    const b = carryBaseline({ saved: '', edited: false }, text(opened), opened, corrected, text);
    expect(b).toEqual({ saved: text(corrected), edited: false });
    // And again, for a correction of that correction.
    const again = drawing(7);
    expect(carryBaseline(b, b.saved, corrected, again, text).saved).toBe(text(again));
  });

  it('stays put for a correction of an edit, which the autosave saves corrected', () => {
    const saved = text(drawing(0));
    expect(carryBaseline({ saved: '', edited: false }, saved, drawing(40), drawing(45), text)).toEqual({ saved, edited: true });
  });

  it('writes the drawing out once to find it edited, and not again until it is saved', () => {
    let writes = 0;
    const counted = (x: Graph) => { writes++; return text(x); };
    const saved = text(drawing(0));
    let b = carryBaseline({ saved: '', edited: false }, saved, drawing(40), drawing(45), counted);
    for (let k = 0; k < 20; k++) b = carryBaseline(b, saved, drawing(40 + k), drawing(45 + k), counted);
    expect(writes).toBe(1);
    // Saved since: the next correction looks again.
    const now = text(drawing(60));
    b = carryBaseline(b, now, drawing(60), drawing(65), counted);
    expect(b).toEqual({ saved: text(drawing(65)), edited: false });
  });
});
