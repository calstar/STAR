// What takes the pointer on the page as React Flow renders it: each line's
// elements, server-rendered through the real <ReactFlow> with the line
// component the canvas uses, and the band each path takes presses over --
// half its stroke width either side, whatever its colour, as
// `.react-flow__edge { pointer-events: visibleStroke }` makes every path in
// a line's element. Lines are sibling elements in the order they were made,
// so where two bands overlap the newer takes the press first -- and so do the
// anchors React Flow draws for carrying a line's end, which are the one
// target nothing here judges by distance.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionMode, Position, ReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { BranchableEdge, CARRY_RADIUS, END_REACH, hitWidth } from './BranchableEdge';
import { nearestOnPolyline, pathPoints } from './route';
import type { Pt } from './route';

const DESIGNER = Object.values(import.meta.glob('./PIDDesigner.tsx', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>)[0];

const sym = (id: string, x: number, y: number): Node => ({
  id, type: 'VALVE', position: { x, y }, measured: { width: 60, height: 60 },
  data: { componentType: 'VALVE', label: id, page: 'Main' },
});
const handles = [Position.Left, Position.Right].flatMap(position => (['source', 'target'] as const).map(type => ({
  id: position === Position.Left ? 'l' : 'r', type, position, x: position === Position.Left ? -3 : 57, y: 27, width: 6, height: 6,
})));

/** The page as React Flow renders it, cut into each line's element. */
function lineElements(nodes: Node[], edges: Edge[], more: Record<string, unknown> = {}) {
  const quiet = console.error;
  console.error = () => {};
  let html: string;
  try {
    html = renderToStaticMarkup(createElement(ReactFlow, {
      nodes: nodes.map(n => ({ ...n, width: 60, height: 60, handles })), edges,
      edgeTypes: { smoothstep: BranchableEdge, default: BranchableEdge }, width: 1000, height: 800,
      connectionMode: ConnectionMode.Loose, ...more,
    }));
  } finally { console.error = quiet; }
  const starts = [...html.matchAll(/<g[^>]*class="react-flow__edge[ "][^>]*>/g)];
  return starts.map((m, i) => ({ head: m[0], body: html.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index : undefined) }));
}

/** Every path in each line's element, with the width it takes presses over. */
function bands(nodes: Node[], edges: Edge[]) {
  return lineElements(nodes, edges).map(({ head, body }) => {
    const widths = [...body.matchAll(/<path[^>]*>/g)].map(p => {
      const style = /style="([^"]*)"/.exec(p[0])?.[1] ?? '';
      return Number(/stroke-width:\s*([\d.]+)/.exec(style)?.[1] ?? /stroke-width="([\d.]+)"/.exec(p[0])?.[1] ?? 1);
    });
    return { id: /data-id="([^"]*)"/.exec(head)![1], widths };
  });
}

/**
 * Each line as drawn, and the anchors React Flow draws at its ends for
 * carrying them -- given `onReconnect`, which is what makes it draw them, and
 * this radius.
 */
function anchors(nodes: Node[], edges: Edge[], reconnectRadius: number) {
  const marked = edges.map(e => ({ ...e, reconnectable: true }));
  return lineElements(nodes, marked, { onReconnect: () => {}, reconnectRadius }).map(({ head, body }) => ({
    id: /data-id="([^"]*)"/.exec(head)![1],
    points: pathPoints(/<path[^>]* d="([^"]*)"/.exec(body)![1]),
    discs: [...body.matchAll(/<circle[^>]*class="react-flow__edgeupdater[^>]*>/g)].map(c => ({
      x: Number(/cx="([\d.-]+)"/.exec(c[0])![1]), y: Number(/cy="([\d.-]+)"/.exec(c[0])![1]), r: Number(/ r="([\d.-]+)"/.exec(c[0])![1]),
    })),
  }));
}

/** Points of an anchor's disc, every half pixel out and every ten degrees round. */
function across(d: { x: number; y: number; r: number }): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= d.r * 2; k++) for (let a = 0; a < 360; a += 10) {
    const t = (a * Math.PI) / 180;
    out.push({ x: d.x + (k / 2) * Math.cos(t), y: d.y + (k / 2) * Math.sin(t) });
  }
  return out;
}

/** The points of any line's anchors nearer another line's centreline than its own. */
function strays(lines: ReturnType<typeof anchors>) {
  const dist = (pts: Pt[], p: Pt) => nearestOnPolyline(pts, p)!.dist;
  return lines.flatMap(l => l.discs.flatMap(across).filter(p =>
    lines.some(o => o.id !== l.id && dist(o.points, p) < dist(l.points, p) - 1e-9)).map(p => ({ id: l.id, p })));
}

describe('a line on the page', () => {
  const nodes = [sym('A', 0, 0), sym('B', 400, 0), sym('C', 0, 10), sym('D', 400, 10)];
  const edges: Edge[] = [
    { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} },
    { id: 'C-D', source: 'C', sourceHandle: 'r', target: 'D', targetHandle: 'l', type: 'smoothstep', data: {} },
  ];

  // Server rendering starts the store at full size whatever the viewport
  // asked for, so this is zoom 1; how the band follows the zoom is
  // branchableEdge.test.ts's.
  it('takes presses over its drawn stroke and one band, hitWidth across, and nothing else', () => {
    for (const line of bands(nodes, edges)) {
      expect([...line.widths].sort((a, b) => a - b), line.id).toEqual([2, hitWidth(1)]);
    }
  });

  it('at full size never reaches a line one grid step away, so the newer cannot take presses on the older\'s stroke', () => {
    // The two lines run 10 px apart (y = 30 and y = 40).
    const widest = Math.max(...bands(nodes, edges).flatMap(l => l.widths));
    expect(widest / 2 + 1).toBeLessThan(10);
  });
});

describe('the anchor a line\'s end is carried by', () => {
  const nodes = [sym('A', 0, 0), sym('B', 400, 0), sym('C', 0, 10), sym('D', 400, 10)];
  // Two lines leaving ports a grid step apart, as off a tank's lid or a manifold.
  const edges: Edge[] = [
    { id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} },
    { id: 'C-D', source: 'C', sourceHandle: 'r', target: 'D', targetHandle: 'l', type: 'smoothstep', data: {} },
  ];

  it('is sized by the canvas, to CARRY_RADIUS', () => {
    const i = DESIGNER.indexOf('<ReactFlow\n');
    const props = DESIGNER.slice(i, DESIGNER.indexOf('\n      >\n', i));
    expect(/\n\s*reconnectRadius=\{([^}]*)\}/.exec(props)?.[1]).toBe('CARRY_RADIUS');
    expect(DESIGNER).toMatch(/import \{[^}]*\bCARRY_RADIUS\b[^}]*\} from '\.\/BranchableEdge';/);
  });

  it('never reaches a point nearer another line than its own, though every one sits above the lines before it', () => {
    const lines = anchors(nodes, edges, CARRY_RADIUS);
    // Both ends of both lines: the anchors are there to be tested.
    expect(lines.map(l => l.discs.length)).toEqual([2, 2]);
    expect(strays(lines)).toEqual([]);
    // React Flow's own ten reached the other line's centreline, and past the midline for most of its width.
    expect(strays(anchors(nodes, edges, 10)).length).toBeGreaterThan(0);
  });

  it('reaches along its line as far as END_REACH, where a press on the line stops being a branch', () => {
    for (const l of anchors(nodes, edges, CARRY_RADIUS)) {
      const ends = [l.points[0], l.points[l.points.length - 1]];
      for (const d of l.discs) {
        const end = ends.reduce((a, b) => (Math.hypot(b.x - d.x, b.y - d.y) < Math.hypot(a.x - d.x, a.y - d.y) ? b : a));
        expect(Math.hypot(d.x - end.x, d.y - end.y) + d.r, l.id).toBeCloseTo(END_REACH, 6);
      }
    }
  });
});
