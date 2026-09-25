// How the canvas hands a drag to drop.ts, and what React Flow hands the
// canvas.
//
// drop.test.ts says what each drop means. What it cannot see is the canvas
// wiring it up wrongly: a validator that lets React Flow stack a second line
// on a port, a connect-on-click left on, an `onConnectEnd` that gives up
// whenever React Flow names a handle -- which it does for a refused one too --
// or a carried end that tees the end that stays. The canvas cannot be mounted
// here (it needs React Flow's store and a DOM), so, as canvasWiring.test.ts
// does, the handlers are cut out of PIDDesigner.tsx as written and run; and
// the drags are run through React Flow's own drag code, XYHandle from
// @xyflow/system, over a stand-in page.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionMode, Position, XYHandle } from '@xyflow/system';
import { applyEdgeChanges } from '@xyflow/react';
import type { Connection, Edge, EdgeChange, FinalConnectionState, Node } from '@xyflow/react';
import { J_END, isJunction, junctionData, junctionEnd, reseatJunctions, setHandCorners } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { afterDelete } from './canvasEdits';
import type { EndLookup, Face } from './junctions';
import { pathPoints, pointsToPath, routeOrthogonal } from './route';
import type { Pt } from './route';
import {
  canJoin, clientOf, commitDrop, connectLine, drawnPoints, lineUnder, partOnLine, plainChanges, reconnectLine,
  reconnectMoving, reconnectableEnds, resolveDrop,
} from './drop';
import { clearOfHost, clipAt, isInstrument, nodeSize } from './attach';
import { defFor } from './types';
import { numberTag } from './tags';
import { nextNodeId } from './ids';
import { COMPONENT_SPECS } from './spec';
import { canvasSource as SOURCE, canvasStatement, canvasStatements, compiled } from './canvasSource';
const useCallback = <T>(f: T) => f;
const useRef = <T>(v: T) => ({ current: v });

// ── A drawing, and the page it is on ─────────────────────────────────────────

const P = (x: number, y: number): Pt => ({ x, y });
const PORTS: Record<string, string[]> = {};
const sym = (id: string, x: number, y: number, ports = ['l', 'r']): Node => {
  PORTS[id] = ports;
  return { id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id } };
};
const tee = (id: string, x: number, y: number): Node =>
  ({ id, type: 'JUNCTION', position: { x: x - 5, y: y - 5 }, data: { componentType: 'JUNCTION', label: id } });
const E = (s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${s}-${t}`, source: s, sourceHandle: sh, target: t, targetHandle: th, type: 'smoothstep', data });
const PORT_AT: Record<string, (w: number, h: number) => [number, number, Position]> = {
  l: (_w, h) => [0, h / 2, Position.Left], r: (w, h) => [w, h / 2, Position.Right],
  t: w => [w / 2, 0, Position.Top], b: (w, h) => [w / 2, h, Position.Bottom],
};
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
  if (!handle || !(PORTS[node.id] ?? []).includes(handle)) return null;
  const [x, y, side] = PORT_AT[handle](60, 60);
  return { x: node.position.x + x, y: node.position.y + y, side };
};
const HANDLE = 6;

interface El {
  kind: 'handle' | 'node' | 'pane';
  classList: { contains(c: string): boolean };
  getAttribute(a: string): string | null;
  dataset: Record<string, string | undefined>;
  closest(sel: string): El | null;
}
/**
 * The page as both React Flow and the canvas ask it: a port's handle under
 * the pointer (6 px, as the stylesheet draws it), else the node, else the
 * pane. A tee's faces take no pointer (JunctionNode), its dot and halo do.
 */
function page(g: () => { nodes: Node[]; edges: Edge[] }) {
  const el = (kind: El['kind'], nodeId?: string, handleId?: string): El => {
    const self: El = {
      kind,
      classList: { contains: c => (kind === 'handle' ? ['react-flow__handle', 'source', 'connectable', 'connectableend'].includes(c) : false) },
      getAttribute: a => (a === 'data-nodeid' ? nodeId ?? null : a === 'data-handleid' ? handleId ?? null : a === 'data-id' ? nodeId ?? null : null),
      dataset: kind === 'handle' ? { nodeid: nodeId, handleid: handleId } : kind === 'node' ? { id: nodeId } : {},
      closest: sel => (sel.includes('handle') ? (kind === 'handle' ? self : null)
        : sel.includes('node') ? (kind === 'pane' ? null : kind === 'node' ? self : el('node', nodeId)) : null),
    };
    return self;
  };
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f); },
    removeEventListener: (t: string, f: (e: unknown) => void) => { listeners.get(t)?.delete(f); },
    fire: (t: string, e: unknown) => { for (const f of [...(listeners.get(t) ?? [])]) f(e); },
    querySelector: (sel: string) => {
      const m = /data-id="rf-(.+)-([^-]+)-source"/.exec(sel);
      return m ? el('handle', m[1], m[2]) : null;
    },
    elementFromPoint: (x: number, y: number): El => {
      const { nodes } = g();
      for (const n of nodes) {
        if (isJunction(n)) continue;
        for (const h of PORTS[n.id] ?? []) {
          const p = endOf(n, h)!;
          if (Math.abs(p.x - x) <= HANDLE / 2 && Math.abs(p.y - y) <= HANDLE / 2) return el('handle', n.id, h);
        }
      }
      for (const n of nodes) {
        const c = isJunction(n) ? { x: n.position.x + 5, y: n.position.y + 5 } : null;
        if (c ? Math.hypot(x - c.x, y - c.y) <= 12 : x >= n.position.x && x <= n.position.x + 60 && y >= n.position.y && y <= n.position.y + 60) return el('node', n.id);
      }
      return el('pane');
    },
  };
}

/** React Flow's measured nodes: each port a 6 px handle centred on its side. */
function internalNode(n: Node) {
  const source = isJunction(n) ? [] : (PORTS[n.id] ?? []).map(h => {
    const [x, y, position] = PORT_AT[h](60, 60);
    return { id: h, nodeId: n.id, type: 'source' as const, position, x: x - HANDLE / 2, y: y - HANDLE / 2, width: HANDLE, height: HANDLE };
  });
  return { ...n, internals: { positionAbsolute: { ...n.position }, z: 0, userNode: n, handleBounds: { source, target: null } } };
}

// ── The canvas, cut out of PIDDesigner.tsx ───────────────────────────────────

/** The drawing as last rendered, the setters React runs, and the drag handlers as written. */
function canvas(start: { nodes: Node[]; edges: Edge[] }, readOnly = false, zoom = 1) {
  const snapshot = { current: start };
  const committed: { nodes: Node[]; edges: Edge[] }[] = [];
  const commitGraph = (nodes: Node[], edges: Edge[]) => { snapshot.current = { nodes, edges }; committed.push({ nodes, edges }); };
  const setEdges = (f: (e: Edge[]) => Edge[]) => { snapshot.current = { ...snapshot.current, edges: f(snapshot.current.edges) }; };
  const doc = page(() => snapshot.current);
  const drawnLines = () => snapshot.current.edges.map(e => {
    const s = snapshot.current.nodes.find(n => n.id === e.source)!, t = snapshot.current.nodes.find(n => n.id === e.target)!;
    return { id: e.id, d: pointsToPath(pathPoints(routeOrthogonal(endOf(s, e.sourceHandle)!, endOf(t, e.targetHandle)!).d)) };
  });
  const getInternalNode = (id: string) => {
    const n = snapshot.current.nodes.find(x => x.id === id);
    return n ? internalNode(n) : undefined;
  };
  const names = {
    useCallback, useRef, snapshot, readOnlyRef: { current: readOnly }, pageRef: { current: 'Main' },
    endOfClear: endOf, getInternalNode, getZoom: () => zoom, document: doc, drawnLines, drawnPoints, lineUnder,
    screenToFlowPosition: (p: Pt) => p, clientOf, resolveDrop, commitDrop, commitGraph, setEdges,
    reconnectLine, reconnectMoving, connectLine, canJoin, obstaclesRef: { current: undefined },
  };
  const code = [
    canvasStatement('const onConnect = useCallback('),
    canvasStatements('const connectingFrom = useRef', 'const carried = useCallback('),
    canvasStatement('const isValidConnection = useCallback('),
  ].join('\n');
  const handlers = compiled(code, Object.keys(names), `{ onConnect, connectingFrom, onConnectStart, onConnectEnd,
    onBranchDrop, onReconnectStart, onReconnect, onReconnectEnd, isValidConnection }`)(...Object.values(names)) as {
    onConnect: (c: Connection) => void;
    connectingFrom: { current: unknown };
    onConnectStart: (e: unknown, p: { nodeId: string | null; handleId: string | null }) => void;
    onConnectEnd: (e: unknown, s: FinalConnectionState) => void;
    onBranchDrop: (source: unknown, at: Pt, client: Pt) => void;
    onReconnectStart: (e: unknown, edge: Edge, handleType: 'source' | 'target') => void;
    onReconnect: (edge: Edge, c: Connection) => void;
    onReconnectEnd: (e: unknown, edge: Edge, handleType: 'source' | 'target', s: FinalConnectionState) => void;
    isValidConnection: (c: Connection | Edge) => boolean;
  };
  return { ...handlers, snapshot, committed, doc };
}
type Canvas = ReturnType<typeof canvas>;

/** The `<ReactFlow>` props PIDDesigner passes, as written. */
const props = (() => {
  const i = SOURCE.indexOf('<ReactFlow\n');
  return SOURCE.slice(i, SOURCE.indexOf('\n      >\n', i));
})();
const prop = (name: string) => new RegExp(`\\n\\s*${name}=\\{([^}]*)\\}`).exec(props)?.[1];

// ── Driving React Flow's own drag ────────────────────────────────────────────

let saved: unknown;
beforeAll(() => {
  const g = globalThis as { cancelAnimationFrame?: unknown };
  saved = g.cancelAnimationFrame;
  g.cancelAnimationFrame = () => {};
});
afterAll(() => { (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = saved; });

interface Seen { connect: Connection[]; end: FinalConnectionState | null }

/**
 * Press a port and let go at `to`, through XYHandle.onPointerDown with the
 * radius and validator PIDDesigner gives React Flow, handing what it calls
 * to the canvas's handlers the way React Flow's store does. `reconnect`
 * carries that line's end instead, as EdgeUpdateAnchors starts it: a drag out
 * of the end that stays, with onReconnectStart said before onConnectStart.
 */
function drag(cv: Canvas, from: { node: string; handle: string }, to: Pt, reconnect?: Edge): Seen {
  const seen: Seen = { connect: [], end: null };
  const lookup = new Map(cv.snapshot.current.nodes.map(n => [n.id, internalNode(n)]));
  const fromEnd = endOf(cv.snapshot.current.nodes.find(n => n.id === from.node)!, from.handle)!;
  const isTarget = !!reconnect && reconnect.target === from.node && reconnect.targetHandle === from.handle;
  const target = { getRootNode: () => cv.doc };
  XYHandle.onPointerDown({ clientX: fromEnd.x, clientY: fromEnd.y, target } as unknown as MouseEvent, {
    connectionMode: ConnectionMode.Loose,
    connectionRadius: Number(prop('connectionRadius')),
    handleId: from.handle,
    nodeId: from.node,
    edgeUpdaterType: reconnect ? (isTarget ? 'target' : 'source') : undefined,
    isTarget,
    domNode: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 4000, bottom: 4000, width: 4000, height: 4000 }) } as unknown as Element,
    nodeLookup: lookup as never,
    lib: 'react',
    flowId: 'rf',
    autoPanOnConnect: false,
    panBy: async () => false,
    cancelConnection: () => {},
    isValidConnection: cv.isValidConnection,
    onConnectStart: (e: unknown, p: { nodeId: string | null; handleId: string | null }) => {
      if (reconnect) cv.onReconnectStart(e, reconnect, isTarget ? 'target' : 'source');
      cv.onConnectStart(e, p);
    },
    onConnect: (c: Connection) => { seen.connect.push(c); if (reconnect) cv.onReconnect(reconnect, c); else cv.onConnect(c); },
    onConnectEnd: (e: unknown, s: FinalConnectionState) => { seen.end = s; cv.onConnectEnd(e, s); },
    onReconnectEnd: (e: unknown, s: FinalConnectionState) => cv.onReconnectEnd(e, reconnect!, isTarget ? 'target' : 'source', s),
    updateConnection: () => {},
    getTransform: () => [0, 0, 1],
    getFromHandle: () => ({ nodeId: from.node, id: from.handle, type: 'source' }) as never,
    dragThreshold: 1,
    handleDomNode: cv.doc.querySelector(`[data-id="rf-${from.node}-${from.handle}-source"]`) as unknown as Element,
  } as never);
  cv.doc.fire('mousemove', { clientX: (fromEnd.x + to.x) / 2, clientY: (fromEnd.y + to.y) / 2 });
  cv.doc.fire('mousemove', { clientX: to.x, clientY: to.y });
  cv.doc.fire('mouseup', { clientX: to.x, clientY: to.y });
  return seen;
}

const linesOn = (g: { edges: Edge[] }, node: string, handle: string) =>
  g.edges.filter(e => (e.source === node && e.sourceHandle === handle) || (e.target === node && e.targetHandle === handle));

// ── What PIDDesigner hands React Flow ────────────────────────────────────────

describe('the <ReactFlow> connection props', () => {
  it('turns click-to-connect off, takes a drop on a port only right over it, and validates every connection', () => {
    expect(prop('connectOnClick')).toBe('false');
    // Under the 3 px from a 6 px handle's centre to its edge: nothing past
    // the handle itself is taken for it.
    expect(Number(prop('connectionRadius'))).toBeLessThan(HANDLE / 2);
    expect(prop('isValidConnection')).toBe('isValidConnection');
    expect(prop('onReconnectStart')).toBe('onReconnectStart');
    expect(prop('onReconnectEnd')).toBe('onReconnectEnd');
  });

  it('offers a viewer no line end to carry, marked or not', () => {
    // React Flow draws a line's carry anchors whenever it has onReconnect and
    // the line is marked, whatever edgesReconnectable says.
    const handler = () => {};
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const given = (readOnly: boolean) => new Function('readOnly', 'onReconnect', `return (${prop('onReconnect')});`)(readOnly, handler);
    expect(given(false)).toBe(handler);
    expect(given(true)).toBeUndefined();
  });

  it('hands React Flow lines whose tee ends cannot be carried', () => {
    expect(/nodes=\{view\.nodes\} edges=\{viewEdges\}/.test(props)).toBe(true);
    expect(/const viewEdges = useMemo\(\(\) => reconnectableEnds\(view\.nodes, view\.edges\), \[view\]\);/.test(SOURCE)).toBe(true);
    expect(reconnectableEnds).toBeTypeOf('function');
  });
});

describe('isValidConnection', () => {
  const g = { nodes: [sym('A', 0, 0), sym('B', 200, 0), sym('C', 200, 200), tee('T', 100, 300), { ...tee('U', 300, 300), data: {} }], edges: [E('A', 'r', 'B', 'l')] };
  const v = canvas(g).isValidConnection;
  const c = (source: string, sourceHandle: string, target: string, targetHandle: string): Connection => ({ source, sourceHandle, target, targetHandle });
  it('lets React Flow join two free ports of two symbols', () => {
    expect(v(c('A', 'l', 'C', 'l'))).toBe(true);
    expect(v(c('C', 'r', 'B', 'r'))).toBe(true);
  });
  it('refuses a symbol joined to itself, a port that has a line at either end, and a tee either way it is marked', () => {
    expect(v(c('C', 'l', 'C', 'r'))).toBe(false);
    expect(v(c('C', 'l', 'B', 'l'))).toBe(false);
    expect(v(c('A', 'r', 'C', 'l'))).toBe(false);
    expect(v(c('C', 'l', 'T', 't'))).toBe(false);
    expect(v(c('U', 'b', 'C', 'l'))).toBe(false);
  });
});

// ── React Flow's drag, let go ────────────────────────────────────────────────

describe("a port drag through React Flow's own code", () => {
  const bay = () => ({ nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('D', 170, 200, ['t'])], edges: [E('A', 'r', 'B', 'l')] });

  it('let go right on a free port: React Flow joins it, and onConnectEnd adds nothing', () => {
    const cv = canvas({ nodes: [sym('A', 0, 0), sym('C', 200, 100)], edges: [] });
    const seen = drag(cv, { node: 'A', handle: 'r' }, P(201, 129));
    expect(seen.connect).toEqual([{ source: 'A', sourceHandle: 'r', target: 'C', targetHandle: 'l' }]);
    expect(seen.end?.isValid).toBe(true);
    expect(cv.committed).toEqual([]);
  });

  it('let go on a port that has a line: React Flow is refused but names the port, and the canvas tees its line', () => {
    const cv = canvas(bay());
    const seen = drag(cv, { node: 'D', handle: 't' }, P(399, 31));
    expect(seen.connect).toEqual([]);
    expect(seen.end?.isValid).toBe(false);
    expect(seen.end?.toHandle).toMatchObject({ nodeId: 'B', id: 'l' });
    expect(cv.committed).toHaveLength(1);
    const g = cv.snapshot.current;
    expect(linesOn(g, 'B', 'l')).toHaveLength(1);
    const branch = g.edges.find(e => e.source === 'D')!;
    const t = g.nodes.find(n => n.id === branch.target)!;
    expect(isJunction(t) && junctionData(t).along).toBeTruthy();
  });

  it('let go near a port but not on it: the line there is teed, not the port joined', () => {
    const cv = canvas(bay());
    const seen = drag(cv, { node: 'D', handle: 't' }, P(386, 31));
    expect(seen.connect).toEqual([]);
    expect(seen.end?.toHandle ?? null).toBeNull();
    const g = cv.snapshot.current;
    expect(g.edges.some(e => e.id === 'A-B')).toBe(false);
    expect(linesOn(g, 'B', 'l')).toHaveLength(1);
    expect(isJunction(g.nodes.find(n => n.id === g.edges.find(e => e.source === 'D')!.target))).toBe(true);
  });

  it('out of a port that has a line: a branch out of that line, and the port keeps one line', () => {
    const cv = canvas({ ...bay(), nodes: [...bay().nodes, sym('C', 300, 200)] });
    const seen = drag(cv, { node: 'A', handle: 'r' }, P(300, 230));
    expect(seen.connect).toEqual([]);
    const g = cv.snapshot.current;
    expect(linesOn(g, 'A', 'r')).toHaveLength(1);
    expect(linesOn(g, 'C', 'l')).toHaveLength(1);
  });

  it('let go back over its own symbol: nothing', () => {
    const cv = canvas({ nodes: [sym('V', 0, 0)], edges: [] });
    const seen = drag(cv, { node: 'V', handle: 'r' }, P(12, 30));
    expect(seen.connect).toEqual([]);
    expect(cv.committed).toEqual([]);
  });

  it('read-only: nothing, however it is let go', () => {
    const cv = canvas(bay(), true);
    drag(cv, { node: 'D', handle: 't' }, P(399, 31));
    cv.onBranchDrop({ kind: 'line', edgeId: 'A-B', at: P(150, 30), dir: P(1, 0), points: [P(60, 30), P(400, 30)] }, P(150, 150), P(150, 150));
    const e = cv.snapshot.current.edges[0];
    cv.onReconnectEnd({ clientX: 200, clientY: 230 }, e, 'source', { isValid: false, toHandle: { nodeId: 'D', id: 't' } } as unknown as FinalConnectionState);
    expect(cv.committed).toEqual([]);
    // The same three, editable: each one draws.
    const live = canvas(bay());
    drag(live, { node: 'D', handle: 't' }, P(399, 31));
    expect(live.committed).toHaveLength(1);
  });

  it('a refused port React Flow names but the page does not show under the pointer is still the target', () => {
    // A symbol drawn over B's port, say: the page answers with the pane, and
    // React Flow, within its radius, with B.l.
    const cv = canvas(bay());
    cv.onConnectStart({}, { nodeId: 'D', handleId: 't' });
    cv.onConnectEnd({ clientX: 700, clientY: 700 }, {
      isValid: false, fromNode: { id: 'D' }, fromHandle: { nodeId: 'D', id: 't' }, toHandle: { nodeId: 'B', id: 'l' },
    } as unknown as FinalConnectionState);
    const g = cv.snapshot.current;
    const branch = g.edges.find(e => e.source === 'D')!;
    const t = g.nodes.find(n => n.id === branch.target)!;
    expect(isJunction(t) && junctionData(t).along).toBeTruthy();
    expect(g.edges.some(e => e.id === 'A-B')).toBe(false);
    expect(linesOn(g, 'B', 'l')).toHaveLength(1);
  });

  it('measures a pull on the screen: the same 25 px on the drawing is nothing at zoom 1, a line at zoom 2', () => {
    const g = () => ({ nodes: [sym('A', 0, 0)], edges: [] });
    const near = canvas(g());
    drag(near, { node: 'A', handle: 'r' }, P(85, 30));
    expect(near.committed).toEqual([]);
    const zoomed = canvas(g(), false, 2);
    drag(zoomed, { node: 'A', handle: 'r' }, P(85, 30));
    expect(zoomed.committed).toHaveLength(1);
  });
});

describe("carrying a line's end through React Flow's own code", () => {
  const bay = () => ({
    nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('C', 300, 200), sym('Z', 0, 400), sym('W', 400, 400)],
    edges: [E('A', 'r', 'B', 'l', { params: { bore: 6 }, waypoints: [P(230, 30)], viaRun: true }), E('Z', 'r', 'W', 'l')],
  });

  it('dragged to a free port, re-points the same line there; the end that stays is never teed or left open', () => {
    const cv = canvas(bay());
    const ab = cv.snapshot.current.edges[0];
    // B's end carried: React Flow drags out of A.r, the end that stays.
    const seen = drag(cv, { node: 'A', handle: 'r' }, P(301, 229), ab);
    // Refused, since A.r has the carried line on it -- so it is the resolver's.
    expect(seen.connect).toEqual([]);
    expect(cv.committed).toHaveLength(1);
    const g = cv.snapshot.current;
    expect(g.edges).toHaveLength(2);
    expect(g.nodes.filter(isJunction)).toEqual([]);
    expect(g.edges.find(e => e.id === 'A-B')).toMatchObject({ source: 'A', sourceHandle: 'r', target: 'C', targetHandle: 'l', data: { params: { bore: 6 } } });
  });

  it('dragged to a port that has a line, tees that line; dragged to nothing, leaves it as it was', () => {
    const tees = canvas(bay());
    drag(tees, { node: 'A', handle: 'r' }, P(401, 431), tees.snapshot.current.edges[0]);
    const g = tees.snapshot.current;
    expect(isJunction(g.nodes.find(n => n.id === g.edges.find(e => e.id === 'A-B')!.target))).toBe(true);
    expect(linesOn(g, 'W', 'l')).toHaveLength(1);

    const nothing = canvas(bay());
    drag(nothing, { node: 'A', handle: 'r' }, P(250, 150), nothing.snapshot.current.edges[0]);
    expect(nothing.committed).toEqual([]);
  });

  it("a carry whose end never arrived does not mark the next drag as a carry", () => {
    const cv = canvas({ nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('C', 200, 200)], edges: [E('A', 'r', 'B', 'l')] });
    cv.onReconnectStart({}, cv.snapshot.current.edges[0], 'source');
    // The pointer went up outside the window: no onConnectEnd. Then an
    // ordinary drag out of C.
    const seen = drag(cv, { node: 'C', handle: 'r' }, P(300, 100));
    expect(seen.connect).toEqual([]);
    expect(cv.committed).toHaveLength(1);
  });
});

describe('a part from the palette let go on a line', () => {
  /**
   * The palette's drop handler as written, over a drawing whose lines are
   * drawn as the canvas draws them, at a zoom where the pointer's place on
   * the drawing is never a whole pixel.
   */
  function palette(start: { nodes: Node[]; edges: Edge[] }) {
    const snapshot = { current: start };
    const committed: { nodes: Node[]; edges: Edge[] }[] = [];
    const names = {
      useCallback, readOnlyRef: { current: false }, defFor, screenToFlowPosition: (p: Pt) => p, isInstrument, clipAt,
      snapshot, pageRef: { current: 'Main' }, clearOfHost, page: 'Main', numberTag, COMPONENT_SPECS, nextNodeId,
      partOnLine, endOfClear: endOf, obstaclesRef: { current: undefined },
      drawnLines: () => snapshot.current.edges.map(e => {
        const s = snapshot.current.nodes.find(n => n.id === e.source)!, t = snapshot.current.nodes.find(n => n.id === e.target)!;
        return { id: e.id, d: pointsToPath(pathPoints(routeOrthogonal(endOf(s, e.sourceHandle)!, endOf(t, e.targetHandle)!).d)) };
      }),
      commitGraph: (nodes: Node[], edges: Edge[]) => { snapshot.current = { nodes, edges }; committed.push({ nodes, edges }); },
    };
    const onDrop = compiled(canvasStatement('const onDrop = useCallback('), Object.keys(names), 'onDrop')(...Object.values(names)) as
      (e: unknown) => void;
    const letGo = (entry: string, at: Pt) => onDrop({
      preventDefault: () => {}, dataTransfer: { getData: (k: string) => (k === 'application/pid-entry' ? entry : '') },
      clientX: at.x, clientY: at.y,
    });
    return { letGo, snapshot, committed };
  }
  const bay = () => ({ nodes: [sym('A', 0, 0), sym('B', 400, 0)], edges: [E('A', 'r', 'B', 'l')] });

  it('puts a valve into the line on the grid, wherever between grid lines the pointer was', () => {
    for (const x of [183.7, 206.4]) {
      const cv = palette(bay());
      cv.letGo('SOL', P(x, 33.3));
      expect(cv.committed).toHaveLength(1);
      const g = cv.snapshot.current;
      const v = g.nodes.find(n => (n.data as { componentType?: string }).componentType === 'SOL')!;
      const { w, h } = nodeSize(v);
      expect(P(v.position.x + w / 2, v.position.y + h / 2), String(x)).toEqual(P(Math.round(x / 10) * 10, 30));
      expect(g.edges.map(e => [e.source, e.target])).toEqual([['A', v.id], [v.id, 'B']]);
    }
  });

  it('taps the line with a transducer on a tee on the grid, wherever between grid lines the pointer was', () => {
    for (const x of [183.7, 206.4]) {
      const cv = palette(bay());
      cv.letGo('PT_HP', P(x, 41.3));
      expect(cv.committed).toHaveLength(1);
      const g = cv.snapshot.current;
      const tee = g.nodes.find(n => isJunction(n))!;
      expect(P(tee.position.x + 5, tee.position.y + 5), String(x)).toEqual(P(Math.round(x / 10) * 10, 30));
      const pt = g.nodes.find(n => (n.data as { componentType?: string }).componentType === 'PT')!;
      expect(g.edges.find(e => e.source === pt.id)).toMatchObject({ target: tee.id });
    }
  });

  it('leaves a part let go clear of every line where it was let go, joined to nothing', () => {
    const cv = palette(bay());
    cv.letGo('SOL', P(200, 200));
    expect(cv.snapshot.current.edges).toEqual(bay().edges);
    expect(cv.snapshot.current.nodes).toHaveLength(3);
  });
});

describe('a line pulled out of a line, let go', () => {
  it('reaches the same resolver, with what the page says is under the pointer', () => {
    const cv = canvas({ nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('C', 300, 150)], edges: [E('A', 'r', 'B', 'l')] });
    const points = [P(60, 30), P(400, 30)];
    cv.onBranchDrop({ kind: 'line', edgeId: 'A-B', at: P(150, 30), dir: P(1, 0), points }, P(330, 180), P(330, 180));
    const g = cv.snapshot.current;
    const branch = g.edges.find(e => e.target === 'C' || e.source === 'C')!;
    // The body resolved to its best free port, not an open end inside it.
    expect(branch.targetHandle).toBe('l');
    expect(g.nodes.filter(isJunction)).toHaveLength(1);
  });

  it("out of an open end's ring and on straight ahead, is the line it ends made longer", () => {
    // A port dragged out to empty canvas leaves an open end; its ring pulled
    // on in line with it leaves one line, not a dot where the end was.
    const cv = canvas({ nodes: [sym('B5', 940, 720)], edges: [] });
    drag(cv, { node: 'B5', handle: 'r' }, P(1100, 750));
    const [open] = cv.snapshot.current.nodes.filter(isJunction);
    const [line] = cv.snapshot.current.edges;
    expect(line).toMatchObject({ source: 'B5', target: open.id });
    const c = P(open.position.x + 5, open.position.y + 5);
    cv.onBranchDrop({ kind: 'node', nodeId: open.id, at: c }, P(1160, 750), P(1160, 750));
    const g = cv.snapshot.current;
    expect(g.edges).toEqual([expect.objectContaining({ id: line.id, source: 'B5', sourceHandle: 'r' })]);
    const ends = g.nodes.filter(isJunction);
    expect(ends.map(n => P(n.position.x + 5, n.position.y + 5))).toEqual([P(1160, 750)]);
    expect(g.edges[0].target).toBe(ends[0].id);
  });
});

describe('a line React Flow joins by itself', () => {
  it('is named afresh: a line carried off both its ports keeps its name, and joining those ports again names another', () => {
    const cv = canvas({ nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('C', 400, 200), sym('D', 0, 200)], edges: [] });
    drag(cv, { node: 'A', handle: 'r' }, P(401, 31));
    const [first] = cv.snapshot.current.edges;
    expect(first).toMatchObject({ source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l' });
    // B's end carried to C.l, then A's end to D.r: the same line, by name.
    drag(cv, { node: 'A', handle: 'r' }, P(401, 229), first);
    drag(cv, { node: 'C', handle: 'l' }, P(59, 229), cv.snapshot.current.edges[0]);
    expect(cv.snapshot.current.edges).toEqual([expect.objectContaining({ id: first.id, source: 'D', target: 'C' })]);
    // A.r and B.l are free again; React Flow joins them.
    const seen = drag(cv, { node: 'A', handle: 'r' }, P(401, 31));
    expect(seen.connect).toHaveLength(1);
    const ids = cv.snapshot.current.edges.map(e => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("React Flow's own lines, handed back", () => {
  /** A.r -> B.l with a tee settled in it at x=200: both halves marked in the view. */
  function teed() {
    const nodes = [sym('A', 0, 0), sym('B', 400, 0)];
    const e = E('A', 'r', 'B', 'l');
    const points = pathPoints(routeOrthogonal(endOf(nodes[0], 'r')!, endOf(nodes[1], 'l')!).d);
    const split = splitEdgeAt(nodes, [e], e.id, P(200, 30), undefined, { points })!;
    const g = reseatJunctions(split.nodes, split.edges, endOf);
    const view = reconnectableEnds(g.nodes, g.edges);
    expect(view.every(x => x.reconnectable !== undefined)).toBe(true);
    return { ...g, tee: split.junctionId, view };
  }

  it('a line changed through useReactFlow().setEdges comes into the drawing without the view mark', () => {
    const g = teed();
    let state = g.edges;
    // The canvas hands React Flow's changes on as `plainChanges` makes them.
    expect(canvasStatement('const onLinesChange = useCallback(')).toContain('onEdgesChange(plainChanges(changes))');
    const onLinesChange = (changes: EdgeChange<Edge>[]) => { state = applyEdgeChanges(plainChanges(changes), state); };
    // A segment drag: the updater is handed React Flow's lines, and what it
    // returns goes back as a replace of each line that changed.
    const up = g.view.find(e => e.source === 'A')!;
    const next = setHandCorners(g.nodes, g.view, up.id, [P(120, 30), P(120, 60), P(170, 60), P(170, 30)]);
    onLinesChange(next.filter(e => !g.view.includes(e)).map(e => ({ id: e.id, item: e, type: 'replace' as const })));
    expect(state.find(e => e.id === up.id)!.data).toMatchObject({ waypoints: [P(120, 30), P(120, 60), P(170, 60), P(170, 30)] });
    expect(state.filter(e => 'reconnectable' in e)).toEqual([]);
    // And one added the same way.
    onLinesChange([{ type: 'add', item: { ...E('A', 'l', 'B', 'r'), reconnectable: 'source' } }]);
    expect(state.filter(e => 'reconnectable' in e)).toEqual([]);
  });

  it('a tee deleted through them heals its run into a line without the view mark, both ends free to carry', () => {
    const g = teed();
    const commits: { nodes: Node[]; edges: Edge[] }[] = [];
    const onDelete = compiled(canvasStatement('const onDelete = useCallback('),
      ['useCallback', 'readOnlyRef', 'drawnCorners', 'afterDelete', 'snapshot', 'commitGraph'], 'onDelete')(
      useCallback, { current: false }, () => new Map(), afterDelete, { current: { nodes: g.nodes, edges: g.edges } },
      (nodes: Node[], edges: Edge[]) => commits.push({ nodes, edges })) as (x: { nodes: Node[]; edges: Edge[] }) => void;
    // What React Flow hands over: its own objects, the view's.
    onDelete({ nodes: g.nodes.filter(n => n.id === g.tee), edges: g.view.filter(e => e.source === g.tee || e.target === g.tee) });
    expect(commits).toHaveLength(1);
    const [healed] = commits[0].edges;
    expect(healed).toMatchObject({ source: 'A', target: 'B' });
    expect('reconnectable' in healed).toBe(false);
    expect(reconnectableEnds(commits[0].nodes, commits[0].edges)[0].reconnectable).toBeUndefined();
  });
});
