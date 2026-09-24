// A pull out of a line or a tee (BranchDrag.tsx): what the provider hands
// the lines and tees, how often it works the preview out, and what the
// preview draws.
//
// No DOM: the provider runs through the hook runtime in hookRuntime.ts, the
// window is an EventTarget, and animation frames are queued here and run
// when the test says, as the browser runs them between pointer moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});
const view = vi.hoisted(() => ({ zoom: 1 }));
vi.mock('@xyflow/react', async (orig) => {
  const X = await orig<typeof import('@xyflow/react')>();
  // One object, as React Flow's own hook keeps its functions from render to render.
  const flow = { screenToFlowPosition: (p: { x: number; y: number }) => ({ x: p.x / view.zoom, y: p.y / view.zoom }) };
  return { ...X, useReactFlow: () => flow };
});

import { find, rt } from './hookRuntime';
import { BranchDragProvider, previewSvg } from './BranchDrag';
import type { BranchSource, BranchState, DropLookups } from './BranchDrag';
import { isJunction, junctionEnd } from './junctions';
import type { EndLookup, Face } from './junctions';
import { resolveDrop } from './drop';
import type { DropScene, Under } from './drop';
import { previewOf } from './preview';
import type { PreviewShape } from './preview';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });
const sym = (id: string, x: number, y: number): Node =>
  ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id } });
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? junctionEnd(node.position, handle as Face) : null;
  const { x, y } = node.position;
  return handle === 'l' ? { x, y: y + 30, side: Position.Left } : handle === 'r' ? { x: x + 60, y: y + 30, side: Position.Right } : null;
};
const nodes = [sym('A', 0, 0), sym('B', 400, 0)];
const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} }];
const run = [P(60, 30), P(400, 30)];
const scene: DropScene = { nodes, edges, endOf, portsOf: () => ['l', 'r'], lines: [{ id: 'A-B', points: run }] };
const pull: BranchSource = { kind: 'line', edgeId: 'A-B', at: P(200, 30), dir: P(1, 0), points: run };

// ── The browser, as far as a pull needs it ───────────────────────────────────

let frames: (() => void)[] = [];
const flushFrames = () => { const f = frames; frames = []; f.forEach(g => g()); };
type Win = { window?: EventTarget; requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const g = globalThis as unknown as Win;
beforeEach(() => {
  rt.reset();
  view.zoom = 1;
  frames = [];
  g.window = new EventTarget();
  g.requestAnimationFrame = (f: () => void) => { frames.push(f); return frames.length; };
  g.cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
});
afterEach(() => { delete g.requestAnimationFrame; delete g.cancelAnimationFrame; });
const fire = (type: string, x: number, y: number) =>
  g.window!.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }));

/** The designer's lookups, counting how often each is asked. */
function lookups() {
  const asked = { scene: 0, under: 0 };
  const drop: DropLookups = {
    scene: () => { asked.scene++; return scene; },
    under: (): Under => { asked.under++; return {}; },
    carrying: () => null,
  };
  return { drop, asked };
}

type Api = { begin: (s: BranchSource, e: { clientX: number; clientY: number }) => void; active: boolean; drop: DropLookups | null };
/** The provider, rendered: the API it hands out and the state it holds. */
function provider(props: { onDrop?: (s: BranchSource, at: Pt, client: Pt) => void; drop?: DropLookups | null } = {}) {
  const draw = () => BranchDragProvider({
    readOnly: false, onDrop: props.onDrop ?? (() => {}),
    ...(props.drop ? { scene: props.drop.scene, under: props.drop.under, carrying: props.drop.carrying } : {}),
    children: null,
  }) as ReactElement<{ value: Api; children: ReactElement<{ value: BranchState | null }> }>;
  return {
    render() {
      const tree = rt.settle(draw);
      return { api: tree.props.value, state: tree.props.children.props.value };
    },
  };
}

describe('the pull provider', () => {
  it('hands every line and tee one API object for as long as nothing about it changes', () => {
    const { drop } = lookups();
    const p = provider({ drop });
    const first = p.render().api;
    expect(p.render().api).toBe(first);
    expect(p.render().api).toBe(first);
    // A pull under way is news to every line: a new object then, and the lookups still the same.
    first.begin(pull, { clientX: 200, clientY: 30 });
    p.render();
    fire('pointermove', 200, 60);
    flushFrames();
    const pulling = p.render().api;
    expect(pulling).not.toBe(first);
    expect(pulling.active).toBe(true);
    expect(pulling.drop).toBe(first.drop);
    expect(p.render().api).toBe(pulling);
  });

  it('works the preview out once a frame, however often the pointer moves, and reads the drawing once a pull', () => {
    const { drop, asked } = lookups();
    const p = provider({ drop });
    p.render().api.begin(pull, { clientX: 200, clientY: 30 });
    p.render();
    for (const y of [40, 60, 80, 100, 120]) fire('pointermove', 200, y);
    expect(asked.under).toBe(0);
    flushFrames();
    expect(asked.under).toBe(1);
    const { state } = p.render();
    expect(state!.moved).toBe(true);
    expect(state!.cursor).toEqual(P(200, 120));
    // What letting go at the last point the pointer reached would make.
    expect(state!.preview).toEqual(previewOf(resolveDrop(pull, P(200, 120), {}, scene), scene, { from: pull.at, to: P(200, 120) }));
    for (const y of [140, 160]) fire('pointermove', 200, y);
    flushFrames();
    expect(asked.under).toBe(2);
    expect(asked.scene).toBe(1);
    expect(p.render().state!.cursor).toEqual(P(200, 160));
  });

  it('asks nothing while the press has not become a pull', () => {
    const { drop, asked } = lookups();
    const p = provider({ drop });
    p.render().api.begin(pull, { clientX: 200, clientY: 30 });
    p.render();
    fire('pointermove', 203, 33);
    flushFrames();
    const { state, api } = p.render();
    expect(state!.moved).toBe(false);
    expect(api.active).toBe(false);
    expect(asked.under + asked.scene).toBe(0);
  });

  it('lets go of a pull whose last move had not been drawn yet', () => {
    const dropped: unknown[] = [];
    const p = provider({ onDrop: (s, at, client) => dropped.push({ s, at, client }) });
    p.render().api.begin(pull, { clientX: 200, clientY: 30 });
    p.render();
    fire('pointermove', 200, 150);
    fire('pointerup', 200, 150);
    expect(dropped).toEqual([{ s: pull, at: P(200, 150), client: P(200, 150) }]);
    expect(p.render().state).toBeNull();
    // And a press let go where it was pressed is a click.
    p.render().api.begin(pull, { clientX: 200, clientY: 30 });
    p.render();
    fire('pointerup', 202, 31);
    expect(dropped).toHaveLength(1);
  });

  it('measures a pull on the screen: the same hand movement starts one at every zoom', () => {
    for (const zoom of [0.5, 2]) {
      rt.reset();
      view.zoom = zoom;
      const p = provider();
      p.render().api.begin(pull, { clientX: 200, clientY: 30 });
      p.render();
      fire('pointermove', 200, 38);
      flushFrames();
      expect(p.render().state!.moved, `zoom ${zoom}`).toBe(true);
      fire('pointerup', 200, 38);
    }
  });
});

// ── What the preview draws ───────────────────────────────────────────────────

type El = ReactElement<Record<string, unknown>>;
const svgOf = (state: BranchState) => previewSvg(state) as El;
const polyline = (tree: El) => (find(tree, e => e.type === 'polyline')[0].props.points as string)
  .split(' ').map(s => { const [x, y] = s.split(',').map(Number); return P(x, y); });
const circles = (tree: El) => find(tree, e => e.type === 'circle').map(c => c.props as { cx: number; cy: number; r: number; fill: string });

describe('the preview', () => {
  const shape: PreviewShape = {
    points: [P(200, 38), P(200, 110), P(330, 110), P(330, 192)],
    tees: [{ at: P(200, 30), open: false }, { at: P(330, 200), open: true }],
    ring: null, cancel: false,
  };

  it('draws the plan: its route, a dot on each tee it puts in, a hollow one on an open end, a ring on what it joins', () => {
    const tree = svgOf({ source: pull, cursor: P(330, 200), moved: true, preview: shape });
    expect(polyline(tree)).toEqual(shape.points);
    expect((tree.props.style as { opacity: number }).opacity).toBe(1);
    const dots = circles(tree);
    expect(dots.map(c => [c.cx, c.cy])).toEqual([[200, 30], [330, 200]]);
    expect(dots[0].fill).not.toBe(dots[1].fill);
    const joined = svgOf({ source: pull, cursor: P(400, 30), moved: true, preview: { ...shape, tees: [], ring: P(400, 30) } });
    expect(circles(joined).map(c => [c.cx, c.cy, c.r])).toEqual([[400, 30, 7]]);
  });

  it('fades a pull that letting go would make nothing of', () => {
    const tree = svgOf({ source: pull, cursor: P(210, 40), moved: true, preview: { points: [P(200, 30), P(210, 40)], tees: [], ring: null, cancel: true } });
    expect((tree.props.style as { opacity: number }).opacity).toBeLessThan(0.5);
    expect(polyline(tree)).toEqual([P(200, 30), P(210, 40)]);
  });

  it('with nothing resolved, leaves the line it was pulled from across it', () => {
    const tree = svgOf({ source: pull, cursor: P(330, 200), moved: true });
    expect(polyline(tree)).toEqual([P(200, 30), P(200, 200), P(330, 200)]);
  });
});
