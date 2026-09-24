import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { canvasStatement, compiled } from './canvasSource';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import {
  HISTORY_DEBOUNCE_MS, MAX_HISTORY, currentGraph, historyReducer, startHistory, storedText,
  useHistory,
} from './history';
import type { Graph, History } from './history';
import { J_END, isJunction, junctionEnd } from './junctions';
import type { EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { turn } from './route';
import { useReseat } from './reseat';

/** Whether there is a step to go back, or forward, to. */
const canUndo = (h: History) => h.index > 0;
const canRedo = (h: History) => h.index < h.entries.length - 1;

const valve = (id: string, x: number, extra: Partial<Node> = {}): Node =>
  ({ id, type: 'MAN', position: { x, y: 0 }, data: { componentType: 'MAN', label: id }, ...extra }) as Node;
const line = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, target: t, data: {} });

/** A drawing with valve A at `x` and valve B at 300, joined. */
const drawing = (x = 0): Graph => ({ nodes: [valve('A', x), valve('B', 300)], edges: [line('A', 'B')] });

const record = (h: History, g: Graph) => historyReducer(h, { type: 'record', graph: g });
const correct = (h: History, before: Graph, after: Graph) => historyReducer(h, { type: 'correct', before, after });
const undo = (h: History) => historyReducer(h, { type: 'undo' });
const redo = (h: History) => historyReducer(h, { type: 'redo' });
const at = (h: History) => storedText(currentGraph(h));

describe('what history records', () => {
  it('records what would be saved, so a selection or a measurement is not a step', () => {
    let h = startHistory(drawing());
    h = record(h, { ...drawing(), nodes: drawing().nodes.map(n => ({ ...n, selected: true, measured: { width: 60, height: 60 } })) });
    expect(h.entries).toHaveLength(1);
  });

  it('pushes an edit, and an edit after an undo throws redo away', () => {
    let h = startHistory(drawing());
    h = record(h, drawing(40));
    h = record(h, drawing(80));
    expect(h.entries).toHaveLength(3);
    h = undo(h);
    h = record(h, drawing(120));
    expect(h.entries.map(e => JSON.parse(e).nodes[0].position.x)).toEqual([0, 40, 120]);
    expect(canRedo(h)).toBe(false);
  });

  it('keeps at most MAX_HISTORY steps', () => {
    let h = startHistory(drawing());
    for (let i = 1; i <= MAX_HISTORY + 5; i++) h = record(h, drawing(i));
    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.index).toBe(MAX_HISTORY - 1);
  });
});

describe('the drawing as opened is the floor', () => {
  it('reset makes the opened drawing the only step, and undo has nowhere to go', () => {
    let h = startHistory();
    h = record(h, drawing(40));                              // something before the load
    h = historyReducer(h, { type: 'reset', graph: drawing() });
    expect(h.entries).toHaveLength(1);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    expect(at(h)).toBe(storedText(drawing()));
  });

  it('the empty canvas a history starts on is never a step undo can reach', () => {
    // No reset: the first drawing recorded takes the empty canvas's place, so
    // a held Ctrl+Z stops at it instead of blanking the drawing.
    let h = startHistory();
    h = record(h, { nodes: [], edges: [] });                 // the canvas before anything arrived
    expect(h.provisional).toBe(true);
    h = record(h, drawing());
    expect(h.entries).toHaveLength(1);
    expect(canUndo(h)).toBe(false);
    h = record(h, drawing(40));
    h = undo(undo(undo(h)));
    expect(at(h)).toBe(storedText(drawing()));
  });

  it('a history reset to an empty drawing keeps it as a real step', () => {
    // A new diagram, or a load that failed: the first thing drawn is undoable.
    let h = historyReducer(startHistory(), { type: 'reset', graph: { nodes: [], edges: [] } });
    h = record(h, drawing());
    expect(h.entries).toHaveLength(2);
    expect(JSON.parse(at(undo(h))).nodes).toEqual([]);
  });
});

describe('a correction is not an edit', () => {
  // The reseat moving a tee after the fact, modelled as moving B: what
  // matters here is only who made the change.
  const settledOf = (g: Graph): Graph => ({ ...g, nodes: g.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 310, y: 0 } } : n)) });

  it('replaces the step it corrected instead of stacking on top of it', () => {
    let h = startHistory(drawing());
    h = record(h, drawing(40));                              // the edit, recorded unsettled
    const before = { ...drawing(40), nodes: drawing(40).nodes.map(n => ({ ...n, selected: false })) };
    h = correct(h, before, settledOf(drawing(40)));          // a click lets the reseat run
    h = record(h, settledOf(drawing(40)));
    expect(h.entries).toHaveLength(2);
    expect(at(h)).toBe(storedText(settledOf(drawing(40))));
    // So one Ctrl+Z undoes the edit.
    expect(at(undo(h))).toBe(storedText(drawing()));
  });

  it('corrects a restored step in place, and redo survives it', () => {
    let h = startHistory(drawing());
    h = record(h, drawing(40));
    h = record(h, drawing(80));
    h = undo(h);                                             // back on drawing(40)
    h = correct(h, drawing(40), settledOf(drawing(40)));
    h = record(h, settledOf(drawing(40)));
    expect(h.index).toBe(1);
    expect(canRedo(h)).toBe(true);
    expect(at(redo(h))).toBe(storedText(drawing(80)));
  });

  it('is an edit when something else changed first', () => {
    let h = startHistory(drawing());
    h = correct(h, drawing(40), settledOf(drawing(40)));     // the reseat corrected a user's move
    expect(h.edited).toBe(true);
    h = record(h, settledOf(drawing(40)));
    expect(h.entries).toHaveLength(2);
    expect(at(undo(h))).toBe(storedText(drawing()));
  });

  it('is still an edit when the reseat corrects again after one', () => {
    let h = startHistory(drawing());
    h = correct(h, drawing(40), settledOf(drawing(40)));
    h = correct(h, settledOf(drawing(40)), settledOf(drawing(40)));
    h = record(h, settledOf(drawing(40)));
    expect(h.entries).toHaveLength(2);
  });

  it('costs nothing once an edit is known, since a drag is corrected every tick', () => {
    const h = correct(startHistory(drawing()), drawing(40), settledOf(drawing(40)));
    expect(correct(h, drawing(50), settledOf(drawing(50)))).toBe(h);
  });

  it('forgets what the step it left had settled, so redoing an edit by hand is an edit', () => {
    // Undo, then drag the valve back to exactly where the undone edit had
    // it: that is the reader's edit, pushed on top, and the step undone to
    // stays underneath it rather than being overwritten.
    let h = startHistory(drawing());
    h = record(h, drawing(40));
    h = undo(h);
    h = record(h, drawing(40));
    expect(h.index).toBe(1);
    expect(at(undo(h))).toBe(storedText(drawing()));
  });

  it('is a correction again once the drawing is put back where the step was by hand', () => {
    // A drag, every tick of it corrected and the first already an edit, and
    // then the valve dragged back to exactly where it was: the record finds
    // the step's own drawing, so nothing is edited any more. The reseat then
    // settling that step is a correction of it, and takes its place -- were
    // the drag still counted, it would be a second step for Ctrl+Z to undo.
    let h = startHistory(drawing());
    h = correct(h, drawing(40), settledOf(drawing(40)));
    expect(h.edited).toBe(true);
    h = record(h, drawing());
    expect(h.edited).toBe(false);
    h = correct(h, drawing(), settledOf(drawing()));
    h = record(h, settledOf(drawing()));
    expect(h.entries).toHaveLength(1);
    expect(canUndo(h)).toBe(false);
    expect(at(h)).toBe(storedText(settledOf(drawing())));
  });

  it('keeps what the reseat settled when a record lands before the corrected drawing renders', () => {
    let h = startHistory(drawing());
    h = record(h, drawing(40));
    h = correct(h, drawing(40), settledOf(drawing(40)));
    h = record(h, drawing(40));                              // the timer fired first
    h = record(h, settledOf(drawing(40)));
    expect(h.entries).toHaveLength(2);
  });
});

// ── the hook, in a React root ────────────────────────────────────────────────

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

function mount(opened: Graph) {
  const box: {
    g: Graph; set?: (g: Graph) => void; hook?: ReturnType<typeof useHistory>;
  } = { g: { nodes: [], edges: [] } };
  function Canvas() {
    const [nodes, setNodes] = React.useState<Node[]>([]);
    const [edges, setEdges] = React.useState<Edge[]>([]);
    box.g = { nodes, edges };
    box.set = g => { setNodes(g.nodes); setEdges(g.edges); };
    box.hook = useHistory(nodes, edges, setNodes, setEdges);
    return null;
  }
  const root = createRoot(container());
  React.act(() => { root.render(React.createElement(Canvas)); });
  const wait = (ms: number) => React.act(() => { vi.advanceTimersByTime(ms); });
  // The load effect: the drawing arrives, and the history is reset to it.
  React.act(() => { box.set!(opened); box.hook!.reset(opened); });
  wait(1000);
  return {
    get: () => storedText(box.g),
    edit: (g: Graph) => React.act(() => { box.set!(g); }),
    undo: () => React.act(() => { box.hook!.undo(); }),
    redo: () => React.act(() => { box.hook!.redo(); }),
    hook: () => box.hook!,
    wait,
    unmount: () => React.act(() => root.unmount()),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useHistory', () => {
  it('undo straight after an edit undoes that edit, not the one before it', () => {
    const c = mount(drawing());
    c.edit(drawing(40)); c.wait(1000);                       // A, recorded
    c.edit(drawing(80)); c.wait(HISTORY_DEBOUNCE_MS / 3);    // B, still pending
    c.undo(); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(40)));
    c.redo(); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(80)));
    c.unmount();
  });

  it('never undoes past the drawing as opened', () => {
    const c = mount(drawing());
    c.edit(drawing(40)); c.wait(1000);
    for (let i = 0; i < 5; i++) { c.undo(); c.wait(50); }
    expect(c.get()).toBe(storedText(drawing()));
    c.unmount();
  });

  it('a correction marked by the reseat replaces the step, so undo still goes back', () => {
    const c = mount(drawing());
    c.edit(drawing(40)); c.wait(1000);
    const settled = { ...drawing(40), nodes: drawing(40).nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 310, y: 0 } } : n)) };
    React.act(() => { c.hook().markCorrection(drawing(40), settled); });
    c.edit(settled); c.wait(1000);
    expect(c.hook().peek().entries).toHaveLength(2);
    c.undo(); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing()));
    c.unmount();
  });

  it('flush records a pending edit now, for an import about to replace the drawing', () => {
    const c = mount(drawing());
    c.edit(drawing(40)); c.wait(HISTORY_DEBOUNCE_MS / 3);
    React.act(() => { c.hook().flush(); });
    expect(c.hook().peek().entries).toHaveLength(2);
    c.unmount();
  });
});

// ── the canvas's use of it ───────────────────────────────────────────────────
//
// Which of the canvas's own changes reset the history and which record what
// was pending first is decided in PIDDesigner.tsx, not here, and history.ts
// cannot notice being called wrongly. The canvas needs React Flow and a DOM to
// mount, so its load effect and its import and restore callbacks are cut out
// of the file as written, compiled, and run inside a component that holds the
// drawing in state, with the server stood in for.

/** The canvas statement opening with `start`, as a function of `names` (canvasSource.ts). */
const canvasCode = (start: string, names: string[]) => compiled(canvasStatement(start), names);
const loadEffect = canvasCode(
  "// Load the selected diagram's working copy",
  ['useEffect', 'loadedId', 'api', 'diagramRef', 'migrate', 'seedIdsFrom', 'setNodes', 'setEdges', 'resetHistory',
    'lastSaved', 'diagramKey'],
);
const importCallback = canvasCode(
  'loadRef.current  = useCallback(',
  ['useCallback', 'loadRef', 'readOnlyRef', 'flushHistory', 'migrate', 'seedIdsFrom', 'setNodes', 'setEdges'],
);
const restoreCallback = canvasCode(
  'restoreMicroRef.current = useCallback(',
  ['useCallback', 'restoreMicroRef', 'readOnlyRef', 'api', 'diagramRef', 'flushHistory', 'migrate', 'seedIdsFrom',
    'setNodes', 'setEdges', 'diagramKey'],
);
const releaseCallback = canvasCode(
  'restoreReleaseRef.current = useCallback(',
  ['useCallback', 'restoreReleaseRef', 'readOnlyRef', 'api', 'diagramRef', 'flushHistory', 'migrate', 'seedIdsFrom',
    'setNodes', 'setEdges', 'diagramKey'],
);

/** The canvas, opening whatever `opened` resolves to (or failing to). */
async function openCanvas(opened: Promise<Graph>, versions: Record<string, Graph> = {}) {
  const box: { g: Graph; set?: (g: Graph) => void; hook?: ReturnType<typeof useHistory> } = { g: { nodes: [], edges: [] } };
  const loadRef: { current: (d: Graph) => void } = { current: () => {} };
  const restoreRef: { current: (id: string) => Promise<void> } = { current: async () => {} };
  const releaseRef: { current: (label: string) => Promise<void> } = { current: async () => {} };
  const server = {
    loadDiagram: () => opened,
    getVersion: async (_: unknown, id: string) => structuredClone(versions[id]),
    getRelease: async (_: unknown, label: string) => structuredClone(versions[label]),
    toStored: (g: Graph) => JSON.parse(storedText(g)) as Graph,
  };
  const none = () => {};
  const same = (g: Graph) => g;
  function Canvas() {
    const [nodes, setNodes] = React.useState<Node[]>([]);
    const [edges, setEdges] = React.useState<Edge[]>([]);
    box.g = { nodes, edges };
    box.set = g => { setNodes(g.nodes); setEdges(g.edges); };
    const hook = useHistory(nodes, edges, setNodes, setEdges);
    box.hook = hook;
    const loadedId = React.useRef<string | null>(null);
    const lastSaved = React.useRef('');
    const readOnlyRef = React.useRef(false);
    loadEffect(React.useEffect, loadedId, server, { id: 'd' }, (g: Graph) => g, none, setNodes, setEdges,
      hook.reset, lastSaved, 'd');
    importCallback(React.useCallback, loadRef, readOnlyRef, hook.flush, same, none, setNodes, setEdges);
    restoreCallback(React.useCallback, restoreRef, readOnlyRef, server, { id: 'd' }, hook.flush, same, none, setNodes,
      setEdges, 'd');
    releaseCallback(React.useCallback, releaseRef, readOnlyRef, server, { id: 'd' }, hook.flush, same, none, setNodes,
      setEdges, 'd');
    return null;
  }
  const root = createRoot(container());
  React.act(() => { root.render(React.createElement(Canvas)); });
  await React.act(async () => { await opened.catch(() => {}); });
  const wait = (ms: number) => React.act(() => { vi.advanceTimersByTime(ms); });
  wait(1000);
  return {
    get: () => storedText(box.g),
    edit: (g: Graph) => React.act(() => { box.set!(g); }),
    importDrawing: (g: Graph) => React.act(() => { loadRef.current(structuredClone(g)); }),
    restore: (id: string) => React.act(async () => { await restoreRef.current(id); }),
    restoreRelease: (label: string) => React.act(async () => { await releaseRef.current(label); }),
    undo: () => React.act(() => { box.hook!.undo(); }),
    wait,
    unmount: () => React.act(() => root.unmount()),
  };
}

describe('the canvas', () => {
  it('stops undo at the drawing it opened', async () => {
    const c = await openCanvas(Promise.resolve(drawing()));
    c.edit(drawing(40)); c.wait(1000);
    for (let i = 0; i < 3; i++) { c.undo(); c.wait(50); }
    expect(c.get()).toBe(storedText(drawing()));
    c.unmount();
  });

  it('lets the first symbol on a new, empty diagram be undone', async () => {
    // Opening an empty diagram is still opening one: the empty sheet is the
    // floor, and what is drawn on it is an edit.
    const c = await openCanvas(Promise.resolve({ nodes: [], edges: [] }));
    c.edit({ nodes: [valve('A', 0)], edges: [] }); c.wait(1000);
    c.undo(); c.wait(1000);
    expect(JSON.parse(c.get()).nodes).toEqual([]);
    c.unmount();
  });

  it('treats a load that failed as an empty sheet opened', async () => {
    const c = await openCanvas(Promise.reject(new Error('offline')));
    c.edit({ nodes: [valve('A', 0)], edges: [] }); c.wait(1000);
    c.undo(); c.wait(1000);
    expect(JSON.parse(c.get()).nodes).toEqual([]);
    c.unmount();
  });

  it('records what was drawn a moment before an import, so undoing the import lands on it', async () => {
    const c = await openCanvas(Promise.resolve(drawing()));
    c.edit(drawing(40)); c.wait(HISTORY_DEBOUNCE_MS / 3);
    c.importDrawing(drawing(80)); c.wait(1000);
    c.undo(); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(40)));
    c.unmount();
  });

  it('records what was drawn a moment before a restore, and the restore can be undone', async () => {
    const c = await openCanvas(Promise.resolve(drawing()), { v1: drawing(80) });
    c.edit(drawing(40)); c.wait(HISTORY_DEBOUNCE_MS / 3);
    await c.restore('v1'); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(80)));
    c.undo(); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(40)));
    c.unmount();
  });

  it('does the same for a restore of a release', async () => {
    const c = await openCanvas(Promise.resolve(drawing()), { 'Rev A': drawing(80) });
    c.edit(drawing(40)); c.wait(HISTORY_DEBOUNCE_MS / 3);
    await c.restoreRelease('Rev A'); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(80)));
    c.undo(); c.wait(1000);
    expect(c.get()).toBe(storedText(drawing(40)));
    c.unmount();
  });
});

// ── the reseat's corrections ─────────────────────────────────────────────────
//
// Whether the reseat's change is a correction or an edit is also decided
// outside history.ts: the reseat effect (useReseat, reseat.ts, which the
// canvas calls with the history's markCorrection) has to say so before it
// sets the drawing, and nothing in history.ts can notice it not saying so.
// So the effect is run as the canvas runs it, with the history, over a teed
// run, with just enough of React Flow stood in for the ports to be read the
// way the canvas reads them:
//
// - a symbol's ports come from its handle bounds, which React Flow measures
//   from the DOM. A turn re-measures them a frame later (Frame.tsx calls
//   updateNodeInternals in a requestAnimationFrame), and a 60 px valve's box
//   does not change size, so no change of the drawing announces it. The
//   canvas hands the reseat a fingerprint of the measured ports so the
//   re-measure itself runs it; this stand-in fingerprints its own record of
//   the measurements, read on the first render after -- any click -- which
//   is what then corrects the turned drawing;
// - a node handed over without `measured` (as every node a restore hands
//   over is) has no handle bounds until it has been measured afresh, and
//   the canvas is not ready until every node has.

const turnOf = (n: Node) => (n.data as { rotation?: number }).rotation ?? 0;

/** Where a 60 px valve's `l` or `r` port is, when its DOM was last measured turned by `rotation`. */
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

/**
 * Valve A, a tee, valve B, with a branch from the tee down to valve C: the tee
 * made the way a pulled branch makes it, its faces left for the reseat to
 * choose as the canvas leaves them.
 */
function teedRun(): Graph {
  const at = (id: string, x: number, y: number, rotation = 0): Node =>
    ({ id, type: 'MAN', position: { x, y }, data: { componentType: 'MAN', label: id, rotation } }) as Node;
  const A = at('A', 0, 100), B = at('B', 360, 100), C = at('C', 100, 240, 90);
  const run: Edge = { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} };
  const split = splitEdgeAt([A, B, C], [run], run.id, { x: 130, y: 130 }, undefined,
    { a: valvePort(A, 'r', 0), b: valvePort(B, 'l', 0) });
  if (!split) throw new Error('the run would not take a tee');
  const branch: Edge = { id: 'tee-C', source: split.junctionId, sourceHandle: 'b', target: 'C', targetHandle: 'l', data: {} };
  return { nodes: split.nodes, edges: [...split.edges, branch] };
}

/** The canvas, opened on `opened`, with the history, the reseat and React Flow's measuring. */
function openReseating(opened: Graph) {
  /** Each symbol's handle bounds, as the turn its DOM had when it was last measured. */
  const measuredAt = new Map<string, number>();
  const endOf: EndLookup = (node, handle) => {
    if (isJunction(node)) return handle ? junctionEnd(node.position, handle as Face) : null;
    const r = measuredAt.get(node.id);
    return r === undefined || !handle ? null : valvePort(node, handle, r);
  };
  // As the canvas's own endOfClear: a tee end keeps its short clearance.
  const endOfClear: EndLookup = (node, handle) => {
    const e = endOf(node, handle);
    return e && isJunction(node) && e.clear === undefined ? { ...e, ...J_END } : e;
  };
  const box: { g: Graph; set?: (g: Graph) => void; hook?: ReturnType<typeof useHistory> } = { g: { nodes: [], edges: [] } };
  function Canvas() {
    const [nodes, setNodes] = React.useState<Node[]>([]);
    const [edges, setEdges] = React.useState<Edge[]>([]);
    box.g = { nodes, edges };
    box.set = g => { setNodes(g.nodes); setEdges(g.edges); };
    const hook = useHistory(nodes, edges, setNodes, setEdges);
    box.hook = hook;
    for (const n of nodes) if (!n.measured) measuredAt.delete(n.id);
    const nodesReady = nodes.length > 0 && nodes.every(n => !!n.measured);
    React.useEffect(() => {
      if (!nodes.some(n => !n.measured)) return;
      for (const n of nodes) if (!n.measured && !isJunction(n)) measuredAt.set(n.id, turnOf(n));
      setNodes(nodes.map(n => (n.measured ? n : { ...n, measured: isJunction(n) ? { width: 10, height: 10 } : { width: 60, height: 60 } })));
    }, [nodes]);
    const ports = [...measuredAt].map(([id, r]) => `${id}@${r}`).join();
    useReseat({ nodes, edges, endOf: endOfClear, ready: nodesReady, ports, setNodes, setEdges, markCorrection: hook.markCorrection });
    return null;
  }
  const root = createRoot(container());
  React.act(() => { root.render(React.createElement(Canvas)); });
  /** A second passes: a frame re-measures any symbol that was turned, then the timers run. */
  const wait = (ms: number) => {
    for (const n of box.g.nodes) if (n.measured && !isJunction(n)) measuredAt.set(n.id, turnOf(n));
    React.act(() => { vi.advanceTimersByTime(ms); });
  };
  // The load effect: the drawing arrives, and the history is reset to it.
  React.act(() => { box.set!(opened); box.hook!.reset(opened); });
  wait(1000);
  const edit = (f: (n: Node) => Node) => React.act(() => { box.set!({ nodes: box.g.nodes.map(f), edges: box.g.edges }); });
  return {
    get: () => storedText(box.g),
    turnOfA: () => turnOf(box.g.nodes.find(n => n.id === 'A')!),
    steps: () => box.hook!.peek().entries.length,
    /** Select A, press R, then click the empty canvas, a second apart. */
    turnAThenClick() {
      edit(n => ({ ...n, selected: n.id === 'A' })); wait(1000);
      edit(n => (n.selected ? { ...n, data: { ...n.data, rotation: (turnOf(n) + 90) % 360 } } : n)); wait(1000);
      const turned = storedText(box.g);
      edit(n => ({ ...n, selected: false })); wait(1000);
      return turned;
    },
    /** Drag valve C `dx` to the right. */
    moveC(dx: number) {
      edit(n => (n.id === 'C' ? { ...n, position: { x: n.position.x + dx, y: n.position.y } } : n)); wait(1000);
    },
    undo: () => { React.act(() => { box.hook!.undo(); }); wait(1000); },
    redo: () => { React.act(() => { box.hook!.redo(); }); wait(1000); },
    unmount: () => React.act(() => root.unmount()),
  };
}

describe('the reseat', () => {
  it('settling the drawing as opened is not a step', () => {
    const c = openReseating(teedRun());
    expect(c.steps()).toBe(1);
    c.unmount();
  });

  it('corrects a turn after the fact without making the correction an edit: one Ctrl+Z undoes the turn', () => {
    const c = openReseating(teedRun());
    const opened = c.get();
    const turned = c.turnAThenClick();
    const settled = c.get();
    // The click is what let the reseat read A's new ports. Were nothing
    // corrected here, there would be nothing to test.
    expect(settled).not.toBe(turned);
    expect(c.steps()).toBe(2);
    c.undo();
    expect(c.get()).toBe(opened);
    expect(c.turnOfA()).toBe(0);
    c.unmount();
  });

  it('keeps redo through it: undo a turn and a move, redo both, and the move is back', () => {
    const c = openReseating(teedRun());
    const opened = c.get();
    c.turnAThenClick();
    c.moveC(40);
    const moved = c.get();
    c.undo(); c.undo();
    expect(c.get()).toBe(opened);
    c.redo(); c.redo();
    expect(c.turnOfA()).toBe(90);
    expect(c.get()).toBe(moved);
    c.unmount();
  });
});
