// The line a port drag shows while it is dragged (ConnectionLine.tsx): the
// drop letting go there makes, as drop.ts resolves it and the canvas draws
// it; a carried end as the carry it is; and React Flow's props alone where
// there is no designer to ask.
//
// No DOM: the component runs through the hook runtime in hookRuntime.ts,
// and animation frames are queued here and run when the test says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Position } from '@xyflow/react';
import type { ConnectionLineComponentProps, Edge, Node } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});
/** The canvas sits at (100, 50) on the page; zoom 1, no pan. */
const BOX = vi.hoisted(() => ({ left: 100, top: 50 }));
vi.mock('@xyflow/react', async (orig) => {
  const X = await orig<typeof import('@xyflow/react')>();
  const flow = { screenToFlowPosition: (p: { x: number; y: number }) => ({ x: p.x - BOX.left, y: p.y - BOX.top }) };
  const store = { getState: () => ({ domNode: { getBoundingClientRect: () => BOX } }) };
  return { ...X, useReactFlow: () => flow, useStoreApi: () => store };
});
const branch = vi.hoisted(() => ({ drop: null as import('./BranchDrag').DropLookups | null }));
vi.mock('./BranchDrag', async (orig) => {
  const B = await orig<typeof import('./BranchDrag')>();
  return { ...B, useBranchDrag: () => ({ begin: () => {}, active: false, drop: branch.drop }) };
});

import { find, rt } from './hookRuntime';
import { ConnectionLine } from './ConnectionLine';
import { isJunction, junctionEnd } from './junctions';
import type { EndLookup, Face } from './junctions';
import { reconnectMoving, resolveDrop } from './drop';
import type { DropScene, DropSource, Under } from './drop';
import { pathPoints, pointsToPath, routeOrthogonal } from './route';
import type { Pt } from './route';
import { previewOf } from './preview';

const P = (x: number, y: number): Pt => ({ x, y });
const sym = (id: string, x: number, y: number): Node =>
  ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id } });
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? junctionEnd(node.position, handle as Face) : null;
  const { x, y } = node.position;
  return handle === 'l' ? { x, y: y + 30, side: Position.Left } : handle === 'r' ? { x: x + 60, y: y + 30, side: Position.Right } : null;
};
const nodes = [sym('A', 0, 0), sym('B', 400, 0), sym('C', 300, 200)];
const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} }];
const scene: DropScene = { nodes, edges, endOf, portsOf: () => ['l', 'r'], lines: [{ id: 'A-B', points: [P(60, 30), P(400, 30)] }] };

let frames: (() => void)[] = [];
const flushFrames = () => { const f = frames; frames = []; f.forEach(g => g()); };
type Win = { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const g = globalThis as unknown as Win;
beforeEach(() => {
  rt.reset();
  frames = [];
  branch.drop = null;
  g.requestAnimationFrame = (f: () => void) => { frames.push(f); return frames.length; };
  g.cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
});
afterEach(() => { delete g.requestAnimationFrame; delete g.cancelAnimationFrame; });

/** The lookups PIDDesigner lends, recording what the page is asked. */
function lend(under: (at: Pt) => Under = () => ({}), carrying: string | null = null) {
  const asked: { client: Pt; at: Pt; near: unknown }[] = [];
  let scenes = 0;
  branch.drop = {
    scene: () => { scenes++; return scene; },
    under: (client, at, _sc, near) => { asked.push({ client, at, near: near ?? null }); return under(at); },
    carrying: () => carrying,
  };
  return { asked, scenes: () => scenes };
}

/** React Flow's props for a drag out of `from`, with the pointer at `at` on the drawing. */
function props(from: { node: string; handle: string; type?: 'source' | 'target' }, at: Pt, toHandle: { nodeId: string; id: string } | null = null): ConnectionLineComponentProps {
  const n = nodes.find(x => x.id === from.node)!;
  const e = endOf(n, from.handle)!;
  return {
    connectionLineType: 'default', fromNode: { id: from.node }, fromHandle: { id: from.handle, nodeId: from.node, type: from.type ?? 'source', position: e.side },
    fromX: e.x, fromY: e.y, fromPosition: e.side, toX: at.x, toY: at.y, toPosition: Position.Left,
    connectionStatus: null, toNode: null, toHandle, pointer: P(at.x, at.y),
  } as unknown as ConnectionLineComponentProps;
}
type El = ReactElement<Record<string, unknown>>;
const draw = (p: ConnectionLineComponentProps) => rt.settle(() => ConnectionLine(p)) as El;
const pathOf = (tree: El) => find(tree, e => e.type === 'path')[0].props.d as string;

describe('the port drag line', () => {
  it('draws the drop letting go there makes, routed as the canvas will route it', () => {
    const { asked } = lend();
    const p = props({ node: 'C', handle: 'l' }, P(200, 30));
    draw(p);
    flushFrames();
    const tree = draw(p);
    const source: DropSource = { kind: 'port', nodeId: 'C', handle: 'l' };
    const shape = previewOf(resolveDrop(source, P(200, 30), {}, scene), scene, { from: P(300, 230), to: P(200, 30) });
    expect(shape.cancel).toBe(false);
    expect(pathOf(tree)).toBe(pointsToPath(shape.points));
    // The page is asked where the pointer is on the page, not in the canvas.
    expect(asked).toEqual([{ client: P(300, 80), at: P(200, 30), near: null }]);
    // A tee goes in where the line is let go on.
    expect(find(tree, e => e.type === 'circle').length).toBeGreaterThan(0);
  });

  it('keeps working the drop out after StrictMode mounts it twice, as the dev server does', () => {
    lend();
    // The first frame is asked for on mount; StrictMode then unmounts and
    // mounts again at once, which cancels that frame.
    draw(props({ node: 'C', handle: 'l' }, P(250, 40)));
    rt.strictRemount();
    const p = props({ node: 'C', handle: 'l' }, P(200, 30));
    draw(p);
    flushFrames();
    const tree = draw(p);
    const source: DropSource = { kind: 'port', nodeId: 'C', handle: 'l' };
    const shape = previewOf(resolveDrop(source, P(200, 30), {}, scene), scene, { from: P(300, 230), to: P(200, 30) });
    expect(pathOf(tree)).toBe(pointsToPath(shape.points));
  });

  it('passes on the port React Flow found, which it names even when its validator refused it', () => {
    const { asked } = lend(() => ({ handle: { nodeId: 'B', handleId: 'l' }, node: 'B' }));
    const p = props({ node: 'C', handle: 'l' }, P(400, 30), { nodeId: 'B', id: 'l' });
    draw(p);
    flushFrames();
    expect(asked[0].near).toEqual({ nodeId: 'B', id: 'l' });
  });

  it('draws a carried end as the carry: from the end that stays to where the carried one goes', () => {
    lend(() => ({ handle: { nodeId: 'C', handleId: 'l' }, node: 'C' }), 'A-B');
    // React Flow drags a carried end out of the end that stays: here A.r, carrying B's end to C.l.
    const p = props({ node: 'A', handle: 'r' }, P(300, 230));
    draw(p);
    flushFrames();
    const tree = draw(p);
    const carry: DropSource = { kind: 'reconnect', edgeId: 'A-B', moving: reconnectMoving(edges[0], 'source', { nodeId: 'A', handle: 'r' }) };
    const under: Under = { handle: { nodeId: 'C', handleId: 'l' }, node: 'C' };
    const shape = previewOf(resolveDrop(carry, P(300, 230), under, scene), scene, { from: P(60, 30), to: P(300, 230) });
    expect(shape.cancel).toBe(false);
    expect(pathOf(tree)).toBe(pointsToPath(shape.points));
    // Not a new line out of A.r, which a port with a line on it would tee.
    const asNew = previewOf(resolveDrop({ kind: 'port', nodeId: 'A', handle: 'r' }, P(300, 230), under, scene), scene, { from: P(60, 30), to: P(300, 230) });
    expect(pointsToPath(asNew.points)).not.toBe(pathOf(tree));
  });

  it('fades a drag that letting go would make nothing of', () => {
    lend();
    const p = props({ node: 'C', handle: 'l' }, P(290, 235));
    draw(p);
    flushFrames();
    const tree = draw(p);
    expect((tree.props.style as { opacity: number }).opacity).toBeLessThan(0.5);
    expect(pathOf(tree)).toBe(pointsToPath([P(300, 230), P(290, 235)]));
  });

  it('works the drop out once a frame, and reads the drawing once a drag', () => {
    const { asked, scenes } = lend();
    for (const x of [200, 190, 180]) draw(props({ node: 'C', handle: 'l' }, P(x, 100)));
    expect(asked).toHaveLength(0);
    flushFrames();
    expect(asked.map(a => a.at)).toEqual([P(180, 100)]);
    draw(props({ node: 'C', handle: 'l' }, P(170, 100)));
    flushFrames();
    expect(asked).toHaveLength(2);
    expect(scenes()).toBe(1);
  });

  it('with no designer to ask, draws the plain route from the port to the pointer', () => {
    const p = props({ node: 'C', handle: 'l' }, P(200, 30));
    const tree = draw(p);
    flushFrames();
    expect(pathOf(draw(p))).toBe(pathOf(tree));
    const plain = pathPoints(routeOrthogonal({ x: 300, y: 230, side: Position.Left }, { x: 200, y: 30, side: Position.Left }).d);
    expect(pathOf(tree)).toBe(pointsToPath(plain));
  });
});
