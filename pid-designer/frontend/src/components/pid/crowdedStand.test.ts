// A stand drawn by hand over an afternoon, as it was saved: three headers
// across, tanks under them with branches up into the headers, a feed from a
// tank at the top of the sheet to one at the bottom straight through the
// middle of it all, and two solenoids off to the right. Its ports are where
// the symbols draw them (`unmeasuredEnd`), the reseat runs round the page's
// symbols as the canvas runs it, and the lines are drawn as the canvas
// draws them (`tracks.drawnScene`).
import { describe, expect, it } from 'vitest';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import { dragging, pipesOf, reseatJunctions } from './junctions';
import type { Dragging } from './junctions';
import { unmeasuredEnd } from './unmeasured';
import { obstaclesByPage } from './routeGrid';
import { drawnScene } from './tracks';
import { copySelection, pasteClip } from './clipboard';
import { seedIdsFrom } from './ids';
import { applyMoves } from './canvasEdits';
import { DEFAULT_PAGE } from './pages';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });

const NODES: [string, string, number, number, Record<string, unknown>][] = [
  ['a1', 'MAN', 100, 130, {  }],
  ['b1', 'MAN', 800, 130, {  }],
  ['a2', 'MAN', 100, 170, {  }],
  ['b2', 'MAN', 460, 320, {  }],
  ['a3', 'MAN', 100, 240, {  }],
  ['b3', 'MAN', 610, 330, { rotation: 90 }],
  ['tk1', 'TANK', 250, 450, { options: { portsTop: '1', portsBottom: '1' } }],
  ['tk2', 'TANK', 450, 450, { options: { portsTop: '1', portsBottom: '1' } }],
  ['tk3', 'TANK', 650, 450, { options: { portsTop: '1', portsBottom: '1' } }],
  ['tt', 'TANK', 540, -200, { options: { portsTop: '1', portsBottom: '1' } }],
  ['tu', 'TANK', 150, 640, { options: { portsTop: '1', portsBottom: '1' } }],
  ['sx', 'SOL', 1000, 400, {  }],
  ['sy', 'SOL', 1000, 560, {  }],
  ['junc_1', 'JUNCTION', 275, 265, { along: { t: 0.18454257299870225, in: 'l', out: 'r', from: 'a3', to: 'b3', ends: { a: { x: 163.00001564873585, y: 269.9999968728161 }, b: { x: 796.9999780968964, y: 269.9999968728161 } } } }],
  ['junc_2', 'JUNCTION', 418, 345, { along: { t: 0.9234234234234234, in: 'l', out: 'r', from: 'a2', to: 'b2', ends: { a: { x: 163, y: 200 }, b: { x: 457, y: 350 } } } }],
  ['junc_3', 'JUNCTION', 585, 155, { along: { t: 0.43131868131868134, in: 'l', out: 'r', from: 'node_1', to: 'b1', ends: { a: { x: 433, y: 160 }, b: { x: 797, y: 160 } } } }],
  ['junc_4', 'JUNCTION', 515, 155, {  }],
  ['junc_5', 'JUNCTION', 438, 345, { along: { t: 0.9684684684684685, in: 'l', out: 'r', from: 'a2', to: 'b2', ends: { a: { x: 163, y: 200 }, b: { x: 457, y: 350 } } } }],
  ['junc_6', 'JUNCTION', 275, 55, {  }],
  ['junc_7', 'JUNCTION', 355, 375, {  }],
  ['junc_8', 'JUNCTION', 275, 375, { along: { t: 0.3964496259193705, in: 'b', out: 't', from: 'tk1', to: 'junc_1', ends: { a: { x: 279.9999968728161, y: 446.99997809689637 }, b: { x: 279.9999968728161, y: 278 } } } }],
  ['node_1', 'MAN', 370, 130, {  }],
  ['junc_9', 'JUNCTION', 755, 155, { along: { t: 0.8983516483516484, in: 'l', out: 'r', from: 'node_1', to: 'b1', ends: { a: { x: 433, y: 160 }, b: { x: 797, y: 160 } } } }],
  ['junc_10', 'JUNCTION', 455, 155, { along: { t: 0.07417582417582418, in: 'l', out: 'r', from: 'node_1', to: 'b1', ends: { a: { x: 433, y: 160 }, b: { x: 797, y: 160 } } } }],
  ['junc_12', 'JUNCTION', 675, 415, { along: { t: 0.07317073170731708, in: 'b', out: 't', from: 'tk3', to: 'junc_3', ends: { a: { x: 680, y: 447 }, b: { x: 590, y: 168 } } } }],
];
const EDGES: [string, string, string, string, string, Record<string, unknown>][] = [
  ['tt-tu', 'tt', 'b', 'tu', 't', {  }],
  ['sx-sy', 'sx', 'r', 'sy', 'r', {  }],
  ['a3-junc_1', 'a3', 'r', 'junc_1', 'l', { offset: 0 }],
  ['junc_1-b3', 'junc_1', 'r', 'b3', 'l', { waypoints: [{ x: 520, y: 270 }, { x: 520, y: 311 }, { x: 640, y: 311 }], offset: 0 }],
  ['a2-junc_2', 'a2', 'r', 'junc_2', 'l', { waypoints: [{ x: 310, y: 200 }, { x: 310, y: 350 }], viaRun: true, offset: 0 }],
  ['tk2-junc_2', 'tk2', 't', 'junc_2', 'b', {  }],
  ['junc_2-junc_5', 'junc_2', 'r', 'junc_5', 'l', { offset: 0 }],
  ['junc_5-b2', 'junc_5', 'r', 'b2', 'l', { offset: 0 }],
  ['junc_5-junc_4', 'junc_5', 't', 'junc_4', 'b', { offset: 81 }],
  ['junc_1-junc_6', 'junc_1', 't', 'junc_6', 'b', {  }],
  ['tk1-junc_8', 'tk1', 't', 'junc_8', 'b', { offset: 0 }],
  ['junc_8-junc_1', 'junc_8', 't', 'junc_1', 'b', { offset: 0 }],
  ['junc_8-junc_7', 'junc_8', 'r', 'junc_7', 'l', {  }],
  ['a1-node_1', 'a1', 'r', 'node_1', 'l', { offset: 0 }],
  ['junc_3-junc_9', 'junc_3', 'r', 'junc_9', 'l', { offset: 0 }],
  ['junc_9-b1', 'junc_9', 'r', 'b1', 'l', { offset: 0 }],
  ['sx-junc_9', 'tk2', 'b', 'junc_9', 'b', {  }],
  ['node_1-junc_10', 'node_1', 'r', 'junc_10', 'l', { offset: 0 }],
  ['junc_10-junc_3', 'junc_10', 'r', 'junc_3', 'l', { offset: 0 }],
  ['sy-junc_10', 'sy', 'l', 'junc_10', 'b', {  }],
  ['tk3-junc_12', 'tk3', 't', 'junc_12', 'b', { offset: 0 }],
  ['junc_12-junc_3', 'junc_12', 't', 'junc_3', 'b', { waypoints: [{ x: 680, y: 405 }, { x: 595, y: 405 }, { x: 595, y: 174 }, { x: 590, y: 174 }], viaRun: true, offset: 0 }],
  ['b3-junc_12', 'b3', 'r', 'junc_12', 'l', {  }],
];
const SIZE: Record<string, { width: number; height: number }> = {
  TANK: { width: 60, height: 100 }, JUNCTION: { width: 10, height: 10 },
};

interface G { nodes: Node[]; edges: Edge[] }

function stand(): G {
  return {
    nodes: NODES.map(([id, type, x, y, data]) => ({
      id, type, position: { x, y }, measured: SIZE[type] ?? { width: 60, height: 60 },
      data: { componentType: type, label: id, page: DEFAULT_PAGE, ...structuredClone(data) },
    })),
    edges: EDGES.map(([id, source, sourceHandle, target, targetHandle, data]) =>
      ({ id, source, sourceHandle, target, targetHandle, type: 'smoothstep', data: structuredClone(data) })),
  };
}

/** The reseat effect run to where it stops, as the canvas runs it. */
function settle(g: G, drag: Dragging | null = null): G {
  let { nodes, edges } = g;
  for (let i = 0; i < 12; i++) {
    const re = reseatJunctions(nodes, edges, unmeasuredEnd, obstaclesByPage(nodes), drag);
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}

const drawn = (g: G) => drawnScene(g.nodes, g.edges, unmeasuredEnd, obstaclesByPage(g.nodes));

/**
 * The longest stretch over which two drawn lines run side by side nearer
 * than two grid steps -- and further apart than half of one, where they
 * would be drawn as one, which is another fault.
 */
function beside(p: Pt[], q: Pt[]): number {
  let most = 0;
  for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
    const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
    const run = (u0: number, u1: number, v0: number, v1: number) => Math.max(0, Math.min(Math.max(u0, u1), Math.max(v0, v1)) - Math.max(Math.min(u0, u1), Math.min(v0, v1)));
    if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) >= 5 && Math.abs(a.y - c.y) < 20) most = Math.max(most, run(a.x, b.x, c.x, d.x));
    if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) >= 5 && Math.abs(a.x - c.x) < 20) most = Math.max(most, run(a.y, b.y, c.y, d.y));
  }
  return most;
}

describe('a crowded stand', () => {
  it('draws the feed through the middle of it, and the branches either side of it, two grid steps apart', () => {
    // Two branches cross the middle of the stand beside the feed: one up
    // from the middle header into an open end, one from the lower solenoid
    // round a valve and a tank up into a tee on the top header. The second
    // was routed with its crossbar ten pixels over the first's, both being
    // middles the page could have moved and did not. And the feed's own
    // crossbar, routed at the middle of its drop, lies along the lowest
    // header, and the page moves it off -- not a grid step either way,
    // where it would pass through a tee's dot on the header, but further:
    // a branch chosen to keep two grid steps off the crossbar where it was
    // routed kept them from where it is never drawn, and was drawn ten
    // pixels from where it is. Nowhere does one of the three run beside
    // another nearer than two grid steps for longer than a grid step.
    const s = settle(stand());
    const d = drawn(s);
    expect(d.get('tt-tu')![1].y).not.toBe(270);
    // The search the second branch is looked for among the other lines by
    // settles, on a page this crowded, for a good way rather than the best:
    // one that ran up beside the tank and stepped ten pixels over at its top
    // to run up the next column, for nothing. The step is taken out.
    expect(d.get('sy-junc_10')).toEqual([P(997, 590), P(535, 590), P(535, 291), P(470, 291), P(470, 240), P(460, 240), P(460, 168)]);
    const three = ['tt-tu', 'junc_5-junc_4', 'sy-junc_10'];
    for (const p of three) for (const q of three) {
      if (p < q) expect(beside(d.get(p)!, d.get(q)!), `${p}: ${JSON.stringify(d.get(p))}, ${q}: ${JSON.stringify(d.get(q))}`).toBeLessThanOrEqual(10);
    }
  });

  it('draws every line as it was when a copy of part of it is pasted beside it, and when the copy is taken away again', () => {
    // A header's first valve, its tee's open branch and a tank under it,
    // copied and pasted: the copy lands to the right, past the solenoids,
    // a few hundred pixels from the branch that runs up from the lower
    // solenoid. That branch's way round the valve and the tank in its path
    // took whichever of several levels as good as each other its search
    // came to first, and the copy's edges, in the corridor it searched,
    // gave it one more to come to: the branch moved to another level, and
    // then to another face of its tee; undone, it moved back.
    const s = settle(stand());
    const before = drawn(s);
    seedIdsFrom(s.nodes);
    const picked = new Set(['a3', 'junc_1', 'junc_6', 'tk1']);
    const clip = copySelection(s.nodes.map(n => ({ ...n, selected: picked.has(n.id) })), s.edges)!;
    const copy = pasteClip(clip, s.nodes, DEFAULT_PAGE, { edges: s.edges, offset: { x: 1000, y: 0 } });
    expect(copy.nodes.every(n => n.position.x >= 1100)).toBe(true);
    const pasted = settle({ nodes: [...s.nodes, ...copy.nodes], edges: [...s.edges, ...copy.edges] });
    const after = drawn(pasted);
    for (const e of s.edges) expect(after.get(e.id), e.id).toEqual(before.get(e.id));
    for (const e of s.edges) expect(pasted.edges.find(x => x.id === e.id), e.id).toEqual(e);
  });

  it('keeps every line that ends on nothing a drag moves as it was, on every tick of the drag', () => {
    // The valve at the end of the lowest header dragged up and to the right,
    // its header's riser sweeping across the middle of the stand. A branch
    // whose tee and far end stand still was chosen again on every tick
    // against the lines sweeping past it, took other faces and hooked back
    // over its own pipe for a few ticks, and was put back when the drag was
    // let go of.
    const g0 = settle(stand());
    const moving = new Set(['b3']);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of pipesOf(g0.nodes, g0.edges)) {
        if (![p.a.nodeId, p.b.nodeId, ...p.tees].some(id => moving.has(id))) continue;
        for (const id of p.tees) if (!moving.has(id)) { moving.add(id); grew = true; }
      }
    }
    const still = g0.edges.filter(e => !moving.has(e.source) && !moving.has(e.target) && !pipesOf(g0.nodes, g0.edges).some(p => p.lines.includes(e.id)));
    expect(still.length).toBeGreaterThan(5);
    const drag = dragging(g0.nodes, ['b3'], g0.edges);
    let g = g0;
    const from = g0.nodes.find(n => n.id === 'b3')!.position;
    for (let k = 1; k <= 20; k++) {
      const change: NodeChange<Node> = { id: 'b3', type: 'position', position: { x: from.x + 9.5 * k, y: from.y - 4.5 * k }, dragging: true };
      g = settle({ nodes: applyMoves(g.nodes, [change], g.edges, unmeasuredEnd, obstaclesByPage(g.nodes)).nodes, edges: g.edges }, drag);
      for (const e of still) expect(g.edges.find(x => x.id === e.id), `tick ${k}: ${e.id}`).toEqual(e);
    }
  });
});
