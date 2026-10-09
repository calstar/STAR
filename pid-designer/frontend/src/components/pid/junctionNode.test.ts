// A tee's pointer targets (nodes/JunctionNode.tsx): the halo that makes the
// dot easier to grab and the ring that pulls a branch out of it -- where they
// are, how far they reach at each zoom, and that a press on either nearer
// another line's centreline than the tee's centre is that line's.
//
// No DOM: the tee runs through the hook runtime in hookRuntime.ts, with
// React Flow's hooks stood in for; the page's lines are a stand-in document.
// Every node is drawn above every line, so whatever the tee's own elements
// cover is the tee's unless the tee hands it on: the press, the click after
// it, and the hover dot.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Edge, NodeProps } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});
/** The tee T, its top-left at (175, 25): its centre is (180, 30), on a run along y = 30. */
const view = vi.hoisted(() => ({ zoom: 1, edges: [] as import('@xyflow/react').Edge[] }));
vi.mock('@xyflow/react', async (orig) => {
  const X = await orig<typeof import('@xyflow/react')>();
  const flow = {
    getInternalNode: () => ({ internals: { positionAbsolute: { x: 175, y: 25 } } }),
    getNodes: () => [],
    getEdges: () => view.edges,
    getZoom: () => view.zoom,
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  };
  return {
    ...X,
    useReactFlow: () => flow,
    useStore: (select: (s: unknown) => unknown) => select({ edges: view.edges, transform: [0, 0, view.zoom] }),
  };
});
vi.mock('./FluidContext', () => ({ useNodeFluid: () => undefined }));
const branch = vi.hoisted(() => ({ begun: [] as unknown[] }));
vi.mock('./BranchDrag', async (orig) => {
  const B = await orig<typeof import('./BranchDrag')>();
  return { ...B, useBranchDrag: () => ({ begin: (s: unknown) => { branch.begun.push(s); }, active: false, drop: null }) };
});

import { find, rt } from './hookRuntime';
import { JunctionNode, haloRadius, ringBand } from './nodes/JunctionNode';
import { J_HALF } from './junctions';
import { hoverSpot, leaveHover } from './BranchableEdge';
import { pointsToPath } from './route';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });
type El = ReactElement<Record<string, unknown>>;
const draw = (selected = true) => rt.settle(() => JunctionNode({ id: 'T', selected } as unknown as NodeProps)) as El;

/** The halo: the dot's round, absolutely placed child. Its centre and radius, from the dot's corner. */
function halo(tree: El) {
  const el = find(tree, e => e.type === 'div' && (e.props.style as { borderRadius?: string } | undefined)?.borderRadius === '50%'
    && (e.props.style as { position?: string }).position === 'absolute')[0];
  const s = el.props.style as { left: number; top: number; width: number };
  // Placed from inside the dot's 2 px border: every box is border-box (index.css).
  return { el, cx: 2 + s.left + s.width / 2, cy: 2 + s.top + s.width / 2, r: s.width / 2 };
}
/** The ring's hit band: its centre from the dot's corner, and how far in and out it reaches. */
function ring(tree: El) {
  const svg = find(tree, e => e.type === 'svg')[0];
  const hit = find(tree, e => e.type === 'circle' && e.props.className === 'nodrag')[0];
  const s = svg.props.style as { left: number; top: number };
  const r = hit.props.r as number, w = hit.props.strokeWidth as number;
  return { el: hit, cx: 2 + s.left + (hit.props.cx as number), cy: 2 + s.top + (hit.props.cy as number), inner: r - w / 2, outer: r + w / 2 };
}

const own: Edge[] = [
  { id: 'A-T', source: 'A', sourceHandle: 'r', target: 'T', targetHandle: 'l' },
  { id: 'T-B', source: 'T', sourceHandle: 'r', target: 'B', targetHandle: 'l' },
];
/** What the page was sent: a click, say, handed on to a line's own element. */
const sent: { id: string; type: string; x: number; y: number }[] = [];
/** The page: the tee's own run through its centre, and another line `gap` below it. */
function page(gap: number) {
  const lines = [
    { id: 'A-T', pts: [P(60, 30), P(172, 30)] },
    { id: 'T-B', pts: [P(188, 30), P(400, 30)] },
    { id: 'C-D', pts: [P(60, 30 + gap), P(400, 30 + gap)] },
  ];
  const els = lines.map(l => ({
    getAttribute: (a: string) => (a === 'data-id' ? l.id : null),
    querySelector: () => ({ getAttribute: () => pointsToPath(l.pts) }),
    dispatchEvent: (e: { type: string; clientX: number; clientY: number }) => {
      sent.push({ id: l.id, type: e.type, x: e.clientX, y: e.clientY });
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
  return () => { delete g.document; delete g.MouseEvent; };
}
function press(x: number, y: number, more: Record<string, unknown> = {}) {
  const did = { stopped: false, prevented: false };
  return { did, e: { button: 0, buttons: 0, clientX: x, clientY: y, stopPropagation() { did.stopped = true; }, preventDefault() { did.prevented = true; }, ...more } };
}
/** The dot's own element, which the halo, the ring and the dot all bubble to on their way to React Flow. */
const dot = (tree: El) => tree.props as Record<string, (e: unknown) => void>;

beforeEach(() => {
  rt.reset();
  view.zoom = 1;
  view.edges = own;
  branch.begun = [];
  sent.length = 0;
  leaveHover();
});

describe('a tee\'s halo', () => {
  it('is centred on the dot, allowing for its border', () => {
    for (const zoom of [1, 0.7, 0.5, 2]) {
      rt.reset();
      view.zoom = zoom;
      const h = halo(draw(false));
      expect({ cx: h.cx, cy: h.cy }, `zoom ${zoom}`).toEqual({ cx: J_HALF, cy: J_HALF });
    }
  });

  it('reaches eight pixels on the screen, never less on the drawing, and never past fourteen', () => {
    expect([1, 2, 0.7, 0.5, 0.25].map(haloRadius)).toEqual([8, 8, 11.5, 14, 14]);
    view.zoom = 0.7;
    expect(halo(draw(false)).r).toBe(11.5);
    rt.reset();
    view.zoom = 1;
    // At full size it stays inside a grid step: a line ten pixels away is never under it.
    expect(halo(draw(false)).r).toBeLessThan(10);
  });

  it('drags the tee -- unless the press is nearer another line than the tee\'s centre, which it pulls from', () => {
    const down = page(9);
    try {
      const h = halo(draw(false)).el;
      const onDot = press(180, 31);
      (h.props.onPointerDown as (e: unknown) => void)(onDot.e);
      expect(onDot.did).toEqual({ stopped: false, prevented: false });
      expect(branch.begun).toEqual([]);
      // 6 below the centre, 3 above the other line.
      const nearLine = press(182, 36);
      (h.props.onPointerDown as (e: unknown) => void)(nearLine.e);
      // Kept from React Flow, which would have dragged the tee.
      expect(nearLine.did).toEqual({ stopped: true, prevented: true });
      expect(branch.begun).toEqual([{ kind: 'line', edgeId: 'C-D', at: P(182, 39), dir: P(1, 0), points: [P(60, 39), P(400, 39)] }]);
    } finally { down(); }
  });
});

describe('a tee\'s ring', () => {
  it('is centred on the dot, from just inside its edge, three pixels across on the screen, and never past fourteen', () => {
    expect([1, 2, 0.5, 0.25].map(z => ringBand(z))).toEqual([
      { inner: 6.5, outer: 9.5 }, { inner: 6.5, outer: 9.5 }, { inner: 6.5, outer: 12.5 }, { inner: 6.5, outer: 14 },
    ]);
    for (const zoom of [1, 0.5, 0.25]) {
      rt.reset();
      view.zoom = zoom;
      const r = ring(draw());
      expect({ cx: r.cx, cy: r.cy, inner: r.inner, outer: r.outer }, `zoom ${zoom}`)
        .toEqual({ cx: J_HALF, cy: J_HALF, ...ringBand(zoom) });
    }
  });

  it('pulls a branch out of the tee -- unless another line is nearer the pointer than the tee\'s centre', () => {
    const down = page(9);
    try {
      const r = ring(draw()).el;
      const pull = (x: number, y: number) => {
        const p = press(x, y);
        (r.props.onPointerDown as (e: unknown) => void)(p.e);
        expect(p.did.stopped).toBe(true);
      };
      pull(180, 22);                  // above: the other line is 17 away, the tee 8
      pull(188, 30);                  // on the tee's own run, which meets at its dot
      pull(180, 38.5);                // below: the other line 0.5 away, the tee 8.5
      expect(branch.begun).toEqual([
        { kind: 'node', nodeId: 'T', at: P(180, 30) },
        { kind: 'node', nodeId: 'T', at: P(180, 30) },
        { kind: 'line', edgeId: 'C-D', at: P(180, 39), dir: P(1, 0), points: [P(60, 39), P(400, 39)] },
      ]);
    } finally { down(); }
  });

  it('is not drawn before the tee is hovered or picked', () => {
    expect(find(draw(false), e => e.type === 'svg')).toEqual([]);
    expect(find(draw(true), e => e.type === 'svg')).toHaveLength(1);
  });
});

describe('a tee, where another line is nearer the pointer than its centre', () => {
  it('hands that line the click, the double-click and the right-click, as it did the press', () => {
    const down = page(9);
    try {
      const tree = draw();
      const on = { click: 'onClick', dblclick: 'onDoubleClick', contextmenu: 'onContextMenu' } as const;
      // Over the halo (6 below the centre, 3 above C-D) and over the ring (8.5 and 0.5).
      for (const [x, y] of [[182, 36], [180, 38.5]]) {
        for (const type of ['click', 'dblclick', 'contextmenu'] as const) {
          const { e, did } = press(x, y, { type });
          dot(tree)[on[type]](e);
          // Kept from React Flow, which would pick the tee, paint it, or open its colours.
          expect(did, `${type} at ${x},${y}`).toEqual({ stopped: true, prevented: true });
        }
      }
      expect(sent).toEqual([[182, 36], [180, 38.5]].flatMap(([x, y]) =>
        ['click', 'dblclick', 'contextmenu'].map(type => ({ id: 'C-D', type, x, y }))));
      // Nearer the tee's centre, or its own run, it is the tee's: left to React Flow.
      for (const [x, y] of [[180, 31], [180, 22], [188, 30]]) {
        const { e, did } = press(x, y, { type: 'click' });
        dot(tree).onClick(e);
        expect(did, `${x},${y}`).toEqual({ stopped: false, prevented: false });
      }
      expect(sent).toHaveLength(6);
    } finally { down(); }
  });

  it('puts the hover dot on that line, and none over the rest of the tee', () => {
    const down = page(9);
    try {
      const tree = draw();
      dot(tree).onMouseMove(press(182, 36).e);
      // Where on the line is the line's own rule (branchableEdge.test.ts);
      // this line is not in the drawing, so it is the foot of the pointer,
      // on the grid.
      expect(hoverSpot()).toEqual({ id: 'C-D', point: P(180, 39) });
      dot(tree).onMouseMove(press(180, 31).e);
      expect(hoverSpot()).toBeNull();
      dot(tree).onMouseMove(press(180, 38.5).e);
      expect(hoverSpot()?.id).toBe('C-D');
      // With a button held the tee is being dragged, or something passes over it: nothing asked.
      dot(tree).onMouseMove(press(180, 31, { buttons: 1 }).e);
      expect(hoverSpot()?.id).toBe('C-D');
      dot(tree).onMouseLeave(press(190, 50).e);
      expect(hoverSpot()).toBeNull();
      // A press that pulls from the line takes it away, as one on the line does,
      // on the halo or on the ring.
      dot(tree).onMouseMove(press(182, 36).e);
      (halo(tree).el.props.onPointerDown as (e: unknown) => void)(press(182, 36).e);
      expect(hoverSpot()).toBeNull();
      dot(tree).onMouseMove(press(180, 38.5).e);
      expect(hoverSpot()?.id).toBe('C-D');
      (ring(tree).el.props.onPointerDown as (e: unknown) => void)(press(180, 38.5).e);
      expect(hoverSpot()).toBeNull();
      expect(branch.begun.map(b => (b as { edgeId: string }).edgeId)).toEqual(['C-D', 'C-D']);
    } finally { down(); }
  });

  it('takes away a dot it put there when it leaves the page', () => {
    const down = page(9);
    try {
      dot(draw()).onMouseMove(press(182, 36).e);
      expect(hoverSpot()?.id).toBe('C-D');
      // Deleted from the keyboard, the pointer still over it: no mouseleave.
      rt.reset();
      expect(hoverSpot()).toBeNull();
    } finally { down(); }
  });
});
