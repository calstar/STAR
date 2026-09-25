// What re-renders when the drawing changes.
//
// Every line, tee and port reads the tool, the fluid map and (for probes) the
// drawn routes through something shared, so anything shared that changes
// identity on every change to the drawing re-renders the whole drawing on
// every drag tick. These pin that each shared value only changes when what it
// says does. There is no DOM here, so components and hooks are called through
// the small hook runtime in hookRuntime.ts: one instance at a time, effects
// run after each call, state and memos kept between calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { Edge, Node } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});
// Where the ports at a line's ends are: nothing is measured here.
vi.mock('@xyflow/react', async (orig) => {
  const X = await orig<typeof import('@xyflow/react')>();
  return { ...X, useStore: (select: (s: unknown) => unknown) => select({ nodeLookup: new Map(), edgeLookup: new Map() }) };
});
const runs = vi.hoisted(() => ({ checks: 0 }));
vi.mock('./checks', async (orig) => {
  const C = await orig<typeof import('./checks')>();
  return { ...C, runChecks: (...a: Parameters<typeof C.runChecks>) => { runs.checks++; return C.runChecks(...a); } };
});

import { rt } from './hookRuntime';
import { ToolProvider } from './ToolContext';
import { FluidStore } from './FluidContext';
import type { FluidAssignment } from './fluids';
import { ChecksPanel, CHECKS_IDLE_MS } from './ChecksPanel';
import { AttachmentLayer, DrawnRoutes } from './AttachmentLayer';
import type { AttachmentLayerProps } from './AttachmentLayer';
import { publishEdge, unpublishEdge } from './edgeGeometry';
import { pathPoints, routeOrthogonal } from './route';
import type { End } from './route';
import { Position } from '@xyflow/react';

beforeEach(() => rt.reset());

describe('the tool', () => {
  it('is one object for as long as the tool is the same', () => {
    const done = () => {};
    const value = (tool: 'none' | 'junction') =>
      (rt.render(() => ToolProvider({ tool, onDone: done, children: null })) as ReactElement<{ value: unknown }>).props.value;
    const first = value('none');
    expect(value('none')).toBe(first);
    const armed = value('junction');
    expect(armed).not.toBe(first);
    expect(armed).toMatchObject({ tool: 'junction', done });
  });
});

describe('the fluid map', () => {
  const fluid = (species: FluidAssignment['species'], conflict = false): FluidAssignment =>
    ({ species, sources: species ? ['TK'] : [], conflict, mixing: false });
  const map = (byNode: Record<string, FluidAssignment>, byEdge: Record<string, FluidAssignment> = {}, taps: string[] = []) =>
    ({ byNode: new Map(Object.entries(byNode)), byEdge: new Map(Object.entries(byEdge)), taps: new Set(taps) });

  it('wakes only the readers whose entry changed', () => {
    const store = new FluidStore();
    store.publish(map({ a: fluid('oxygen'), b: fluid('oxygen') }, { e: fluid('oxygen') }));
    const woke: string[] = [];
    store.subscribe('node:a', m => m.byNode.get('a'), () => woke.push('a'));
    store.subscribe('node:b', m => m.byNode.get('b'), () => woke.push('b'));
    store.subscribe('edge:e', m => m.byEdge.get('e'), () => woke.push('e'));
    store.subscribe('tap:b:p', m => m.taps.has('b:p'), () => woke.push('tap'));

    // Worked out afresh, as it is on every drag tick: new objects throughout,
    // and only b's fluid different.
    store.publish(map({ a: fluid('oxygen'), b: fluid('ethanol') }, { e: fluid('oxygen') }));
    expect(woke).toEqual(['b']);

    store.publish(map({ a: fluid('oxygen'), b: fluid('ethanol') }, { e: fluid('oxygen', true) }, ['b:p']));
    expect(woke).toEqual(['b', 'e', 'tap']);
  });

  it('hands a reader the same object while its fluid is the same', () => {
    const store = new FluidStore();
    store.publish(map({ a: fluid('oxygen') }));
    const before = store.current.byNode.get('a');
    store.publish(map({ a: fluid('oxygen') }));
    expect(store.current.byNode.get('a')).toBe(before);
  });

  it('stops waking a reader that has gone', () => {
    const store = new FluidStore();
    let woke = 0;
    const stop = store.subscribe('node:a', m => m.byNode.get('a'), () => woke++);
    stop();
    store.publish(map({ a: fluid('oxygen') }));
    expect(woke).toBe(0);
  });
});

describe('the checks', () => {
  beforeEach(() => { vi.useFakeTimers(); runs.checks = 0; });
  afterEach(() => vi.useRealTimers());

  const tank = (x: number): Node =>
    ({ id: 'TK', position: { x, y: 0 }, data: { componentType: 'TANK', label: 'TK' } }) as unknown as Node;

  it('run once when a drag stops, not on every tick of it', () => {
    const edges: Edge[] = [];
    const panel = (nodes: Node[]) => rt.render(() => ChecksPanel({ nodes, edges, onSelect: () => {} }));
    panel([tank(0)]);
    expect(runs.checks).toBe(1);
    // Twenty ticks of a drag, each a new drawing, closer together than the wait.
    for (let x = 1; x <= 20; x++) {
      panel([tank(x * 10)]);
      vi.advanceTimersByTime(16);
    }
    expect(runs.checks).toBe(1);
    // Let go, and the panel catches up once.
    vi.advanceTimersByTime(CHECKS_IDLE_MS);
    panel([tank(200)]);
    expect(runs.checks).toBe(2);
  });
});

describe('the leaders', () => {
  afterEach(() => unpublishEdge('A-B'));

  const nodes = [
    { id: 'A', position: { x: 0, y: 0 }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN' } },
    { id: 'B', position: { x: 300, y: 0 }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN' } },
    { id: 'TC', position: { x: 150, y: -100 }, measured: { width: 60, height: 60 }, data: { componentType: 'TC', attachedTo: 'A-B' } },
  ] as unknown as Node[];
  const edges = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l' }] as unknown as Edge[];
  const layer = createElement(AttachmentLayer, { nodes, edges });
  const routes = () => (rt.render(() => DrawnRoutes({ children: layer })) as ReactElement<AttachmentLayerProps>).props.routes!;

  it('are drawn from the line as it drew itself after the render that drew them', () => {
    publishEdge('A-B', [{ x: 63, y: 30 }, { x: 297, y: 30 }]);
    expect(routes().get('A-B')).toEqual([{ x: 63, y: 30 }, { x: 297, y: 30 }]);

    // The line routes and publishes in the same commit the leaders are drawn
    // in, after them: the next look must see where it went.
    const moved = [{ x: 63, y: 30 }, { x: 180, y: 30 }, { x: 180, y: 80 }, { x: 297, y: 80 }];
    publishEdge('A-B', moved);
    routes();
    expect(routes().get('A-B')).toEqual(moved);
  });

  it('are told when a line they land on is drawn somewhere new because another line moved', async () => {
    // A line that routes itself, and one below it in the order that comes to
    // lie along it: the first is drawn a grid step over (tracks.ts), though
    // nothing about it or its ends changed.
    const line = (a: End, b: End) => [pathPoints(routeOrthogonal(a, b).d), { a, b, free: true }] as const;
    const R = (x: number, y: number): End => ({ x, y, side: Position.Right });
    const L = (x: number, y: number): End => ({ x, y, side: Position.Left });
    publishEdge('A-B', ...line(R(63, 130), L(297, 250)));
    expect(routes().get('A-B')![1].x).toBe(180);
    rt.heard();
    publishEdge('0-X', ...line(R(63, 30), L(297, 150)));
    await new Promise(r => setTimeout(r, 0));
    expect(rt.heard()).toBe(1);
    expect(routes().get('A-B')![1].x).toBe(170);
    unpublishEdge('0-X');
  });

  it('are not drawn again when no line they land on has moved', () => {
    publishEdge('A-B', [{ x: 63, y: 30 }, { x: 297, y: 30 }]);
    const first = routes();
    publishEdge('X-Y', [{ x: 0, y: 500 }, { x: 10, y: 500 }]);
    expect(routes()).toBe(first);
    unpublishEdge('X-Y');
  });
});

describe('the edge options', () => {
  // React Flow hands `defaultEdgeOptions` to every line, and compares it by
  // identity. Written as a literal in the canvas's JSX it was a new object on
  // every render of the canvas -- once a second for the checkout clock alone
  // -- and every line re-rendered with it. There is no DOM to render the
  // canvas into here, so this reads what the canvas passes.
  it('are one object for the life of the page, not a literal in the canvas', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as
      { readFileSync(path: URL, encoding: 'utf8'): string };
    const canvas = readFileSync(new URL('./PIDDesigner.tsx', import.meta.url), 'utf8');
    const passed = /defaultEdgeOptions=\{([^}]*)\}/.exec(canvas)?.[1] ?? '';
    expect(passed).toMatch(/^[A-Z_]+$/);
    expect(canvas).toMatch(new RegExp(`^const ${passed} = `, 'm'));
  });
});
