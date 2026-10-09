// How the canvas tells the reseat a drag is on (PIDDesigner.tsx).
//
// While a symbol is dragged, the reseat puts each tee the drag does not pick
// up on its pipe from where the tee was when the drag began, and takes what
// is dragged to be in the way only of what it drags (`Dragging`; what that
// does is dragReseat.test.ts's). It knows a drag is on only because the
// canvas says so: React Flow tells the canvas a drag has begun
// (`onNodeDragStart` on `<ReactFlow>`), the canvas notes it, and the reseat
// reads the note every time it runs (`drag` in its options). Leave out either
// half and nothing in reseat.ts or pipes.ts can notice -- the reseat is just
// never told, and a pipe a symbol is dragged across bends round it, its tee
// shoved along the bend. The canvas cannot be mounted here, so, as
// canvasWiring.test.ts does, its code is cut out of the file as written and
// run with stand-ins for what it closes over.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { J_END, centreOfJunction, dragging, isJunction, junctionEnd, reseatJunctions } from './junctions';
import type { Dragging, EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { obstaclesByPage } from './routeGrid';
import { pathPoints, routeOrthogonal } from './route';
import type { Pt } from './route';
import type { ReseatOptions } from './reseat';
import { canvasElementProp, canvasStatement, compiled } from './canvasSource';

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
const E = (s: string, sh: string, t: string, th: string): Edge =>
  ({ id: `${s}-${t}`, source: s, sourceHandle: sh, target: t, targetHandle: th, type: 'smoothstep', data: {} });

/** A.r -> B.l with a tee at x = 200 branched down to C, and U, a symbol wired to nothing, above it. */
function bay() {
  const A = part('A', 0, 0), B = part('B', 400, 0), C = part('C', 170, 200), U = part('U', 170, -200);
  const points = pathPoints(routeOrthogonal(endOf(A, 'r')!, endOf(B, 'l')!).d);
  const split = splitEdgeAt([A, B, C, U], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30), 'Main', { points })!;
  const g = reseatJunctions(split.nodes, [...split.edges, E(split.junctionId, 'b', 'C', 't')], endOf);
  return { ...g, tee: split.junctionId };
}

/**
 * The canvas's note of the drag, the reseat it is handed to, and the handler
 * `<ReactFlow>` is given for a drag beginning -- as PIDDesigner.tsx writes
 * them. `options` is what the canvas hands the reseat.
 */
function canvas(g: { nodes: Node[]; edges: Edge[] }, readOnly = false) {
  const start = canvasElementProp('ReactFlow', 'onNodeDragStart');
  if (!start) throw new Error('<ReactFlow> is not told what to do when a drag begins (onNodeDragStart)');
  let options: ReseatOptions | null = null;
  const names = {
    useRef: <T>(v: T) => ({ current: v }), useCallback: <T>(f: T) => f,
    useReseat: (o: ReseatOptions) => { options = o; return () => {}; },
    nodes: g.nodes, edges: g.edges, endOfClear: endOf, obstacles: obstaclesByPage(g.nodes), nodesReady: true, ports: '',
    setNodes: () => {}, setEdges: () => {}, markCorrection: () => {}, keepBaseline: () => {},
    readOnlyRef: { current: readOnly }, dragging, snapshot: { current: g },
  };
  const code = [
    canvasStatement('const dragRef = useRef'),
    canvasStatement('const dragNow = useCallback('),
    canvasStatement('const settleAgain = useReseat('),
    canvasStatement('const onNodeDragStart = useCallback('),
  ].join('\n');
  const out = compiled(code, Object.keys(names), `{ start: (${start}) }`)(...Object.values(names)) as {
    start: (e: unknown, node: Node, dragged: Node[]) => void;
  };
  if (!options) throw new Error('the canvas never runs the reseat');
  return { ...out, options: options as ReseatOptions };
}

/** What the reseat reads when it runs: the drag the canvas hands it, if any. */
const told = (o: ReseatOptions): Dragging | null => {
  expect(o.drag, 'the reseat is not handed the drag in progress').toBeTypeOf('function');
  return o.drag!();
};

describe('the canvas telling the reseat a drag is on', () => {
  it('from the moment React Flow says a drag began, the reseat is told what it picks up and where every other tee was', () => {
    const g = bay();
    const cv = canvas(g);
    expect(told(cv.options)).toBeNull();
    const U = g.nodes.find(n => n.id === 'U')!;
    cv.start({}, U, [U]);
    const drag = told(cv.options)!;
    expect(drag).not.toBeNull();
    expect([...drag.moving]).toEqual(['U']);
    expect([...drag.anchors]).toEqual([[g.tee, centreOfJunction(g.nodes.find(n => n.id === g.tee)!)]]);
    // One drag, read by every tick of it, not a new one each time.
    expect(told(cv.options)).toBe(drag);
    // A group picked up is all of it; one picked up alone, itself.
    const A = g.nodes.find(n => n.id === 'A')!, C = g.nodes.find(n => n.id === 'C')!;
    cv.start({}, A, [A, C]);
    expect([...told(cv.options)!.moving].sort()).toEqual(['A', 'C']);
    cv.start({}, C, []);
    expect([...told(cv.options)!.moving]).toEqual(['C']);
  });

  it('is what keeps a pipe a symbol is dragged across where it was', () => {
    // U dragged down onto the run, over the tee: told of the drag, the
    // reseat leaves the pipe and its tee where they were for U to pass over.
    const g = bay();
    const cv = canvas(g);
    const U = g.nodes.find(n => n.id === 'U')!;
    cv.start({}, U, [U]);
    const over = g.nodes.map(n => (n.id === 'U' ? { ...n, position: P(170, 0) } : n));
    const seated = reseatJunctions(over, g.edges, cv.options.endOf, obstaclesByPage(over), told(cv.options));
    const at = (h: { nodes: Node[] }) => centreOfJunction(h.nodes.find(n => n.id === g.tee)!);
    expect(at(seated)).toEqual(at(g));
    expect(seated.edges).toBe(g.edges);
  });

  it('tells it of no drag a viewer makes', () => {
    const g = bay();
    const cv = canvas(g, true);
    const U = g.nodes.find(n => n.id === 'U')!;
    cv.start({}, U, [U]);
    expect(told(cv.options)).toBeNull();
  });
});
