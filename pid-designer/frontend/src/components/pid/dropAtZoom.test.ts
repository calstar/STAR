// What a line pull and a port drop store, at a zoom other than one.
//
// React Flow reads a handle off the screen and divides by the zoom, and the
// screen is a float grid under a pan that is almost never whole: at any zoom
// but one -- and at one, under a pan left fractional by a fit -- a port it
// reports is a hundred-thousandth of a pixel off, and differently off at
// every zoom. The canvas's own lookups are rid of that (`handleEnd`), but a
// line is drawn from React Flow's numbers, and a pull or a drop reads the
// line as drawn: taken as it came, the noise went into the new tee's place,
// the ends its pipe was put down between, and the corners of the two halves
// -- saved, and a stored shape that no longer fitted the ports once they
// were measured at another zoom.
//
// So the canvas is driven here as it runs: its handlers cut out of
// PIDDesigner.tsx as written (as dropWiring.test.ts does), the ports as
// React Flow measures them at the zoom and pan given, the lines drawn from
// React Flow's own anchors, the pull started where a press on a line starts
// one (`lineSourceAt`), and every place the drawing is left with read back.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, FinalConnectionState, Node } from '@xyflow/react';
import { J_END, isJunction, junctionData, junctionEnd, reseatJunctions } from './junctions';
import type { EndLookup } from './junctions';
import { drawnRoute } from './lineRoute';
import { pointsToPath } from './route';
import type { Pt } from './route';
import {
  canJoin, clientOf, commitDrop, connectLine, drawnPoints, lineUnder, partOnLine, reconnectLine, reconnectMoving,
  resolveDrop,
} from './drop';
import { handleEnd } from './ports';
import { lineSourceAt } from './BranchDrag';
import { canvasStatements, compiled } from './canvasSource';

const useCallback = <T>(f: T) => f;
const useRef = <T>(v: T) => ({ current: v });

const sym = (id: string, x: number, y: number): Node =>
  ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, page: 'Main' } });
const E = (s: string, sh: string, t: string, th: string): Edge =>
  ({ id: `${s}-${t}`, source: s, sourceHandle: sh, target: t, targetHandle: th, type: 'smoothstep', data: {} });

/** A view: the zoom, and the pan a fit left, in screen pixels. */
interface View { zoom: number; pan: Pt }

/**
 * A valve's two ports as React Flow measures them in `view`: each handle's
 * box and the node's read off the screen -- single-precision, as a browser
 * lays them out -- and the difference divided back by the zoom. The handle's
 * size is its own, unscaled.
 */
function measuredHandles(n: Node, view: View) {
  const screen = (v: number, pan: number) => Math.fround(pan + v * view.zoom);
  const off = (node: number, by: number, pan: number) => (screen(node + by, pan) - screen(node, pan)) / view.zoom;
  const { x, y } = n.position;
  return [
    { id: 'l', nodeId: n.id, type: 'source' as const, position: Position.Left, x: off(x, -3, view.pan.x), y: off(y, 27, view.pan.y), width: 6, height: 6 },
    { id: 'r', nodeId: n.id, type: 'source' as const, position: Position.Right, x: off(x, 57, view.pan.x), y: off(y, 27, view.pan.y), width: 6, height: 6 },
  ];
}

/** React Flow's anchor for a line on a measured handle (`getHandlePosition`), as it hands it to the line: unrounded. */
function flowAnchor(n: Node, hb: ReturnType<typeof measuredHandles>[number]) {
  const x = n.position.x + hb.x, y = n.position.y + hb.y;
  return hb.position === Position.Right ? { x: x + hb.width, y: y + hb.height / 2, side: hb.position }
    : { x, y: y + hb.height / 2, side: hb.position };
}

/** The canvas at `view`: its drop handlers as written, and the page they read. */
function canvas(start: { nodes: Node[]; edges: Edge[] }, view: View) {
  const snapshot = { current: start };
  const committed: { nodes: Node[]; edges: Edge[] }[] = [];
  const commitGraph = (nodes: Node[], edges: Edge[]) => { snapshot.current = { nodes, edges }; committed.push({ nodes, edges }); };
  const setEdges = (f: (e: Edge[]) => Edge[]) => { snapshot.current = { ...snapshot.current, edges: f(snapshot.current.edges) }; };
  const getInternalNode = (id: string) => {
    const n = snapshot.current.nodes.find(x => x.id === id);
    if (!n) return undefined;
    const source = isJunction(n) ? [] : measuredHandles(n, view);
    return { ...n, internals: { positionAbsolute: { ...n.position }, z: 0, userNode: n, handleBounds: { source, target: null } } };
  };
  // Each line as BranchableEdge draws it: from React Flow's anchors, not the canvas's.
  const drawnFrom: EndLookup = (node, handle) => {
    if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as 'l'), ...J_END } : null;
    const hb = getInternalNode(node.id)!.internals.handleBounds.source.find(h => h.id === handle);
    return hb ? flowAnchor(node, hb) : null;
  };
  const drawnLines = () => {
    const byId = new Map(snapshot.current.nodes.map(n => [n.id, n]));
    return snapshot.current.edges.map(e => ({ id: e.id, d: pointsToPath(drawnRoute(e, byId, drawnFrom)!) }));
  };
  // A pull or a drop let go on open canvas: nothing but the pane under it.
  const pane = { closest: () => null, dataset: {} };
  const document = { elementFromPoint: () => pane };
  const screenToFlowPosition = (c: Pt) => ({ x: (c.x - view.pan.x) / view.zoom, y: (c.y - view.pan.y) / view.zoom });
  const lookups = { useCallback, getInternalNode, handleEnd, isJunction, junctionEnd, J_END };
  const { endOfClear } = compiled(
    canvasStatements('const endOf = useCallback<EndLookup>', 'const endOfClear = useCallback<EndLookup>'),
    Object.keys(lookups), '{ endOf, endOfClear }')(...Object.values(lookups)) as { endOfClear: EndLookup };
  const names = {
    useCallback, useRef, snapshot, readOnlyRef: { current: false }, pageRef: { current: 'Main' },
    endOfClear, getInternalNode, getZoom: () => view.zoom, document, drawnLines, drawnPoints, lineUnder,
    screenToFlowPosition, clientOf, resolveDrop, commitDrop, commitGraph, setEdges,
    reconnectLine, reconnectMoving, connectLine, canJoin, obstaclesRef: { current: undefined },
  };
  const handlers = compiled(
    canvasStatements('const connectingFrom = useRef', 'const carried = useCallback('),
    Object.keys(names), '{ onConnectStart, onConnectEnd, onBranchDrop }')(...Object.values(names)) as {
    onConnectStart: (e: unknown, p: { nodeId: string | null; handleId: string | null }) => void;
    onConnectEnd: (e: unknown, s: FinalConnectionState) => void;
    onBranchDrop: (source: unknown, at: Pt, client: Pt) => void;
  };
  /** Where on the screen a place on the drawing is: the whole pixel a pointer would be at. */
  const client = (p: Pt) => ({ x: Math.round(p.x * view.zoom + view.pan.x), y: Math.round(p.y * view.zoom + view.pan.y) });
  return {
    ...handlers, snapshot, committed, endOfClear,
    /** Press on the drawn line nearest `from` and let go at `to`, as BranchableEdge and BranchDrag hand it over. */
    pull(from: Pt, to: Pt) {
      const press = screenToFlowPosition(client(from));
      const line = lineSourceAt(press, view.zoom, undefined, drawnPoints(drawnLines()));
      expect(line, 'a line under the press').not.toBeNull();
      const up = client(to);
      handlers.onBranchDrop(line!.source, screenToFlowPosition(up), up);
    },
    /** A drag out of a port, let go at `to`, as React Flow ends one that nothing took. */
    portDrop(node: string, handle: string, to: Pt) {
      handlers.onConnectStart({}, { nodeId: node, handleId: handle });
      const up = client(to);
      handlers.onConnectEnd({ clientX: up.x, clientY: up.y }, {
        isValid: false, fromNode: { id: node }, fromHandle: { nodeId: node, id: handle }, toHandle: null,
      } as unknown as FinalConnectionState);
    },
    /** The lines as the page draws them. */
    lines: drawnLines,
    /** Every number the lines are drawn with: whether this view has noise in it to keep out. */
    drawnNumbers: () => drawnLines().flatMap(l => l.d.match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number)),
  };
}

/**
 * Every number the drawing places something with: positions, where each
 * tee's pipe was put down between, each tee's home, and corners.
 */
function placesIn(g: { nodes: Node[]; edges: Edge[] }): { what: string; v: number }[] {
  const out: { what: string; v: number }[] = [];
  const pt = (what: string, p: Pt) => { out.push({ what: `${what}.x`, v: p.x }, { what: `${what}.y`, v: p.y }); };
  for (const n of g.nodes) {
    pt(`${n.id} position`, n.position);
    const along = isJunction(n) ? junctionData(n).along : undefined;
    if (along?.ends) { pt(`${n.id} along.ends.a`, along.ends.a); pt(`${n.id} along.ends.b`, along.ends.b); }
    if (along?.home) { pt(`${n.id} along.home.a`, along.home.a); pt(`${n.id} along.home.b`, along.home.b); pt(`${n.id} along.home.at`, along.home.at); }
  }
  for (const e of g.edges) {
    ((e.data as { waypoints?: Pt[] } | undefined)?.waypoints ?? []).forEach((w, i) => pt(`${e.id} waypoint ${i}`, w));
  }
  return out;
}

/** The places that are not whole pixels. Every port, grid line and symbol here is on one. */
const noisy = (g: { nodes: Node[]; edges: Edge[] }) => placesIn(g).filter(p => !Number.isInteger(p.v));

// Two fitted views from the drawings the noise was found on, and zoom 1
// under the pan a fit leaves.
const VIEWS: [string, View][] = [
  ['zoom 1.5348', { zoom: 1.5348, pan: { x: 41.37, y: -12.62 } }],
  ['zoom 2', { zoom: 2, pan: { x: 37.3, y: 211.17 } }],
  ['zoom 1, after a fit', { zoom: 1, pan: { x: 103.17, y: 17.43 } }],
];

describe.each(VIEWS)('at %s', (_name, view) => {
  /** Settled as the canvas settles a drawing after an edit, on its own lookups. */
  const settled = (cv: ReturnType<typeof canvas>) => {
    const g = cv.snapshot.current;
    return reseatJunctions(g.nodes, g.edges, cv.endOfClear);
  };

  it('is a view whose lines are drawn off the pixel, so what follows has noise to keep out', () => {
    const cv = canvas({ nodes: [sym('A', 100, 100), sym('B', 500, 100)], edges: [E('A', 'r', 'B', 'l')] }, view);
    expect(cv.drawnNumbers().some(v => !Number.isInteger(v))).toBe(true);
  });

  it('a line pulled out of a straight line stores whole pixels: the tee, the open end, and the ends the tee was put down between', () => {
    const cv = canvas({ nodes: [sym('A', 100, 100), sym('B', 500, 100)], edges: [E('A', 'r', 'B', 'l')] }, view);
    cv.pull({ x: 300, y: 130 }, { x: 300, y: 200 });
    expect(cv.committed).toHaveLength(1);
    const g = cv.snapshot.current;
    const tee = g.nodes.find(n => isJunction(n) && junctionData(n).along)!;
    expect(junctionData(tee).along!.ends).toEqual({ a: { x: 163, y: 130 }, b: { x: 497, y: 130 } });
    expect(noisy(g)).toEqual([]);
    expect(noisy(settled(cv))).toEqual([]);
  });

  it('a line pulled out of the crossbar of a Z stores whole pixels, the corners of both halves too', () => {
    const cv = canvas({ nodes: [sym('A', 100, 100), sym('B', 400, 400)], edges: [E('A', 'r', 'B', 'l')] }, view);
    cv.pull({ x: 280, y: 250 }, { x: 200, y: 250 });
    expect(cv.committed).toHaveLength(1);
    const g = cv.snapshot.current;
    // Corners were written: the halves carry the Z's two bends.
    expect(g.edges.filter(e => (e.data as { waypoints?: Pt[] }).waypoints?.length).length).toBeGreaterThan(0);
    expect(noisy(g)).toEqual([]);
    expect(noisy(settled(cv))).toEqual([]);
  });

  it('a port dragged onto a line stores whole pixels for the tee it puts in', () => {
    const cv = canvas({ nodes: [sym('A', 100, 100), sym('B', 500, 100), sym('C', 200, 300)], edges: [E('A', 'r', 'B', 'l')] }, view);
    cv.portDrop('C', 'r', { x: 350, y: 131 });
    expect(cv.committed).toHaveLength(1);
    const g = cv.snapshot.current;
    expect(g.nodes.some(n => isJunction(n) && junctionData(n).along)).toBe(true);
    expect(noisy(g)).toEqual([]);
    expect(noisy(settled(cv))).toEqual([]);
  });

  it('a pull and then a port drop, one on the other\'s drawing, leave it on whole pixels', () => {
    const cv = canvas({ nodes: [sym('A', 100, 100), sym('B', 500, 100), sym('C', 200, 300)], edges: [E('A', 'r', 'B', 'l')] }, view);
    cv.pull({ x: 250, y: 130 }, { x: 250, y: 230 });
    cv.portDrop('C', 'r', { x: 330, y: 331 });
    expect(cv.committed).toHaveLength(2);
    expect(noisy(cv.snapshot.current)).toEqual([]);
    expect(noisy(settled(cv))).toEqual([]);
  });

  it('a valve or a transducer from the palette let go on a line lands on whole pixels', () => {
    // As the canvas's onDrop hands it over: the drop point snapped to the
    // grid, the line as the page draws it.
    for (const [type, at] of [['SOL', { x: 300, y: 130 }], ['PT', { x: 300, y: 120 }]] as const) {
      const g = { nodes: [sym('A', 100, 100), sym('B', 500, 100)], edges: [E('A', 'r', 'B', 'l')] };
      const cv = canvas(g, view);
      const part: Node = { id: 'P', type, position: at, data: { componentType: type, label: type, page: 'Main' } };
      const made = partOnLine(g, cv.lines(), at, part, { endOf: cv.endOfClear, page: 'Main' });
      expect(made, type).not.toBeNull();
      expect(noisy(made!), type).toEqual([]);
      expect(noisy(reseatJunctions(made!.nodes, made!.edges, cv.endOfClear)), type).toEqual([]);
    }
  });
});

describe('a line pulled out from a press off the grid', () => {
  it('starts at the grid line the hover dot showed, and so does the open end let go below it', () => {
    // At full size and no pan, a press three pixels past a grid line: the
    // tee went in at the press, and the open end level with it, both off
    // the grid the symbols are on.
    const view = { zoom: 1, pan: { x: 0, y: 0 } };
    for (const press of [297, 303]) {
      const cv = canvas({ nodes: [sym('A', 100, 100), sym('B', 500, 100)], edges: [E('A', 'r', 'B', 'l')] }, view);
      cv.pull({ x: press, y: 130 }, { x: 300, y: 200 });
      const centres = cv.snapshot.current.nodes.filter(isJunction).map(n => ({ x: n.position.x + 5, y: n.position.y + 5 }));
      expect(centres, `pressed at ${press}`).toEqual(expect.arrayContaining([{ x: 300, y: 130 }, { x: 300, y: 200 }]));
      expect(centres).toHaveLength(2);
    }
  });
});
