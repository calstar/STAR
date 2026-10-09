// A section watching the rubber band for itself.
//
// regionNode.test.ts runs a whole band against React Flow's own hit test and
// the rule that lets a section go; these check that a mounted section is the
// thing applying it. Mounting it means running its effects, which a server
// render never does, so it is run through the hook runtime in hookRuntime.ts
// against a stand-in for React Flow's store.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { InternalNode, NodeChange, NodeProps, ReactFlowState } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});

type State = Pick<ReactFlowState, 'userSelectionRect' | 'userSelectionActive' | 'transform' | 'nodeLookup' | 'triggerNodeChanges'>;
const flow = vi.hoisted(() => {
  const listeners = new Set<(s: unknown, prev: unknown) => void>();
  const store = {
    state: {} as Record<string, unknown>,
    getState() { return store.state; },
    setState(patch: Record<string, unknown>) {
      const prev = store.state;
      store.state = { ...prev, ...patch };
      listeners.forEach(l => l(store.state, prev));
    },
    subscribe(l: (s: unknown, prev: unknown) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { store, listeners };
});
vi.mock('@xyflow/react', async (orig) => {
  const X = await orig<typeof import('@xyflow/react')>();
  return {
    ...X,
    useReactFlow: () => ({ setNodes: () => {} }),
    useStoreApi: () => flow.store,
    useStore: (select: (s: unknown) => unknown) => select(flow.store.getState()),
  };
});

import { NodeResizer } from '@xyflow/react';
import { find, rt } from './hookRuntime';
import { RegionNode } from './nodes/RegionNode';

const sent: NodeChange[][] = [];
const R1 = () => ({
  id: 'R1', selected: true, measured: { width: 320, height: 220 },
  internals: { positionAbsolute: { x: 400, y: 60 }, handleBounds: { source: [], target: [] }, z: 0, userNode: {} },
}) as unknown as InternalNode;

beforeEach(() => {
  rt.reset();
  sent.length = 0;
  flow.store.state = {
    userSelectionRect: null, userSelectionActive: false, transform: [0, 0, 1],
    nodeLookup: new Map([['R1', R1()]]),
    triggerNodeChanges: (c: NodeChange[]) => { sent.push(c); },
  } satisfies State;
});

const section = () => rt.settle(() => RegionNode({
  id: 'R1', type: 'REGION', selected: true, data: { componentType: 'REGION', label: 'Bay' },
} as unknown as NodeProps)) as ReactElement<{ children: unknown }>;
const resizerShown = (tree: unknown) =>
  find(tree, e => e.type === NodeResizer)[0].props.isVisible as boolean;
const band = (x: number, y: number, width: number, height: number) =>
  ({ userSelectionActive: true, userSelectionRect: { x, y, width, height, startX: x, startY: y } });

describe('a mounted section', () => {
  it('lets itself go when a band that covered only part of it is let go', () => {
    section();
    flow.store.setState(band(420, 120, 290, 100));
    expect(sent).toEqual([]);
    flow.store.setState({ userSelectionActive: false, userSelectionRect: null });
    expect(sent).toEqual([[{ id: 'R1', type: 'select', selected: false }]]);
  });

  it('stays selected when the band enclosed it', () => {
    section();
    flow.store.setState(band(380, 40, 360, 260));
    flow.store.setState({ userSelectionActive: false, userSelectionRect: null });
    expect(sent).toEqual([]);
  });

  it('stops watching when it is gone', () => {
    section();
    expect(flow.listeners.size).toBe(1);
    rt.reset();
    expect(flow.listeners.size).toBe(0);
  });

  it('keeps its resize handles hidden while a band covers only part of it', () => {
    expect(resizerShown(section())).toBe(true);
    flow.store.setState(band(420, 120, 290, 100));
    expect(resizerShown(section())).toBe(false);
    flow.store.setState(band(380, 40, 360, 260));
    expect(resizerShown(section())).toBe(true);
  });
});
