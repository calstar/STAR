// What a drag previews (preview.ts): the line letting go will draw, drawn as
// the canvas draws it once the reseat has settled the drop and the page has
// moved it off the lines around it -- and nothing, faded, where letting go
// makes nothing. Symbols are 60 px boxes with their ports on the middle of
// their sides; tees go in with splitEdgeAt and are settled by the reseat, as
// the designer does.
import { afterEach, describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { J_HALF, isJunction, junctionEnd, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { nearestOnPolyline, pathPoints, routeOrthogonal, segmentEntersBox } from './route';
import type { Pt } from './route';
import { commitDrop, lineUnder, resolveDrop } from './drop';
import type { DropPlan, DropScene, DropSource, Under } from './drop';
import { drawnRoute } from './lineRoute';
import { boxGrid, obstaclesByPage } from './routeGrid';
import { nextJunctionId } from './ids';
import { planKey, previewOf, previewer, pullOf } from './preview';
import { drawnScene, trackLineOf } from './tracks';
import { publishEdge, unpublishEdge } from './edgeGeometry';

/**
 * A sweep runs hundreds of drops: well inside a test's usual five seconds
 * alone, but not always on a machine busy with other work.
 */
const SWEEP_MS = 30_000;

const P = (x: number, y: number): Pt => ({ x, y });
const PORTS: Record<string, string[]> = {};
function sym(id: string, x: number, y: number, ports: string[] = ['l', 'r', 't', 'b'], page?: string): Node {
  PORTS[id] = ports;
  return {
    id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 },
    data: { componentType: 'MAN', label: id, ...(page ? { page } : {}) },
  };
}
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? junctionEnd(node.position, handle as Face) : null;
  if (!handle || !(PORTS[node.id] ?? []).includes(handle)) return null;
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

interface G { nodes: Node[]; edges: Edge[] }
const byId = (g: G) => new Map(g.nodes.map(n => [n.id, n]));
/** Every line as the canvas draws it: routed round the symbols in its way, then moved off the lines around it. */
const page = (g: G) => drawnScene(g.nodes, g.edges, endOf, obstaclesByPage(g.nodes));
const drawn = (e: Edge, g: G) => page(g).get(e.id)!;
const scene = (g: G): DropScene => {
  const all = page(g);
  return { nodes: g.nodes, edges: g.edges, endOf, portsOf: n => PORTS[n.id], lines: g.edges.map(e => ({ id: e.id, points: all.get(e.id)! })) };
};
/**
 * The page as the canvas publishes it: each line's own route, its ends and
 * whether it may move, and the page's symbols -- what BranchableEdge hands
 * the store of drawn routes. Every line published before is taken away.
 */
let onPage: string[] = [];
function publish(g: G) {
  for (const id of onPage) unpublishEdge(id);
  const ids = byId(g), boxes = boxGrid(obstaclesByPage(g.nodes)('Main'));
  onPage = [];
  for (const e of g.edges) {
    const l = trackLineOf(e, ids, endOf, obstaclesByPage(g.nodes))!;
    publishEdge(e.id, l.pts, { a: l.a!, b: l.b!, free: !!l.free, sheet: () => boxes });
    onPage.push(e.id);
  }
}
afterEach(() => { for (const id of onPage) unpublishEdge(id); onPage = []; });
/** The reseat, to its fixed point, round the page's symbols, as the designer runs it. */
function settle(g: G): G {
  let n = g.nodes, e = g.edges;
  for (let i = 0; i < 10; i++) {
    const re = reseatJunctions(n, e, endOf, obstaclesByPage(n));
    if (re.nodes === n && re.edges === e) break;
    n = re.nodes; e = re.edges;
  }
  return { nodes: n, edges: e };
}
const connect = (plan: DropPlan) => {
  if (plan.kind !== 'connect') throw new Error(`expected a drop that makes something, got ${plan.why}`);
  return plan;
};
const corners = (pts: Pt[]) => Math.max(0, pts.length - 2);
const sameShape = (p: Pt[], q: Pt[]) => p.length === q.length && p.every((a, i) => a.x === q[i].x && a.y === q[i].y);
const leg = (a: Pt, b: Pt) => (Math.abs(a.x - b.x) < 1e-6 ? 'vertical' : 'horizontal');

describe('a preview is the line letting go draws', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }

  /**
   * Sixty drawings, eight drops each, from wherever to wherever: the preview
   * against the drawing once the drop has settled, drawn as the canvas draws
   * it. `published`: the page's lines are where the canvas publishes them,
   * which is where a preview reads the lines the drop did not touch from.
   */
  function sweep(published: boolean) {
    const rand = rng(7);
    let checked = 0, cancelled = 0, moved = 0;
    const landings = new Set<string>();
    for (let trial = 0; trial < 60; trial++) {
      const nodes: Node[] = [];
      for (let i = 0; i < 5; i++) nodes.push(sym(`S${trial}_${i}`, 140 * (i % 3) + (rand() < 0.3 ? 10 : 0), 160 * Math.floor(i / 3)));
      let g: G = { nodes, edges: [] };
      for (const [a, ha, b, hb] of [[0, 'r', 1, 'l'], [1, 'r', 2, 'l'], [3, 'r', 4, 'l'], [0, 'b', 3, 't']] as const) {
        if (rand() < 0.8) g.edges.push(E(nodes[a].id, ha, nodes[b].id, hb));
      }
      for (const e of [...g.edges]) {
        if (rand() < 0.5) continue;
        const pts = drawn(e, g);
        const mid = nearestOnPolyline(pts, P((pts[0].x + pts[pts.length - 1].x) / 2, (pts[0].y + pts[pts.length - 1].y) / 2))!.point;
        const split = splitEdgeAt(g.nodes, g.edges, e.id, mid, undefined, { points: pts, endOf, obstacles: obstaclesByPage(g.nodes) });
        if (split) g = settle(split);
      }
      g = settle(g);
      for (let k = 0; k < 8; k++) {
        const now = page(g);
        const sources: DropSource[] = [
          ...g.nodes.filter(n => !isJunction(n)).flatMap(n => PORTS[n.id].map(h => ({ kind: 'port', nodeId: n.id, handle: h }) as DropSource)),
          ...g.nodes.filter(isJunction).map(n => ({ kind: 'node', nodeId: n.id, at: P(n.position.x + J_HALF, n.position.y + J_HALF) }) as DropSource),
          ...g.edges.map(e => {
            const pts = now.get(e.id)!;
            const near = nearestOnPolyline(pts, pts[Math.floor(rand() * pts.length)])!;
            return { kind: 'line', edgeId: e.id, at: near.point, dir: near.dir, points: pts } as DropSource;
          }),
        ];
        const source = sources[Math.floor(rand() * sources.length)];
        const at = P(-60 + rand() * 440, -60 + rand() * 360);
        // What the page would say is under the pointer there.
        const sc = scene(g);
        const under: Under = { line: lineUnder(sc.lines!, at, 1) };
        for (const n of g.nodes) {
          if (isJunction(n)) { if (Math.hypot(at.x - n.position.x - J_HALF, at.y - n.position.y - J_HALF) <= 8) under.node = n.id; continue; }
          for (const h of PORTS[n.id]) { const p = endOf(n, h)!; if (Math.abs(p.x - at.x) <= 3 && Math.abs(p.y - at.y) <= 3) under.handle = { nodeId: n.id, handleId: h }; }
          if (!under.node && at.x >= n.position.x && at.x <= n.position.x + 60 && at.y >= n.position.y && at.y <= n.position.y + 60) under.node = n.id;
        }
        const plan = resolveDrop(source, at, under, sc);
        if (published) publish(g);
        const shape = previewOf(plan, sc, { from: P(0, 0), to: at });
        const made = commitDrop(plan, sc);
        const label = `trial ${trial} drop ${k}: ${planKey(plan)}`;
        expect(shape.cancel, label).toBe(!made);
        if (!made) { cancelled++; continue; }
        checked++;
        if (plan.kind === 'connect') landings.add(`${plan.from.kind}->${plan.to.kind}`);
        const after = settle(made);
        const line = after.edges.find(e => e.id === made.lineId)!;
        expect(shape.points, label).toEqual(drawn(line, after));
        if (!sameShape(drawnRoute(line, byId(after), endOf, obstaclesByPage(after.nodes))!, shape.points)) moved++;
        const put = after.nodes.filter(n => isJunction(n) && !g.nodes.some(o => o.id === n.id))
          .map(n => P(n.position.x + J_HALF, n.position.y + J_HALF));
        expect(shape.tees.map(t => t.at), label).toEqual(put);
        g = after;
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(cancelled).toBeGreaterThan(20);
    // Every kind of end a drop can make, at both ends.
    for (const kind of ['port->port', 'port->open', 'port->split', 'split->open', 'split->split', 'split->port', 'tee->open', 'tee->port']) {
      expect(landings.has(kind), kind).toBe(true);
    }
    // And among them, lines the page draws somewhere else than they route
    // themselves: what a preview of the route alone got wrong.
    expect(moved).toBeGreaterThan(10);
  }

  it('whatever is let go wherever: the route, and every tee, exactly where the drawing has them after the drop has settled', () => {
    sweep(false);
  }, SWEEP_MS);

  it('the same, reading the lines the drop did not touch as the page published them, and routing afresh every one it did', () => {
    sweep(true);
  }, SWEEP_MS);

  it('shows a line let go beside another where the page will draw it, a grid step off, not where it routes itself', () => {
    // Two columns: HV1 already feeds SV1; a line from HV2 to SV2 routes its
    // crossbar at the same midpoint, and the page moves it over.
    const g: G = {
      nodes: [sym('HV1', 0, 0), sym('HV2', 0, 100), sym('SV1', 300, 120), sym('SV2', 300, 220)],
      edges: [E('HV1', 'r', 'SV1', 'l')],
    };
    publish(g);
    const plan = connect(resolveDrop({ kind: 'port', nodeId: 'HV2', handle: 'r' }, P(300, 250), { handle: { nodeId: 'SV2', handleId: 'l' }, node: 'SV2' }, scene(g)));
    const shape = previewOf(plan, scene(g), { from: P(60, 130), to: P(300, 250) });
    const made = commitDrop(plan, scene(g))!;
    const line = made.edges.find(e => e.id === made.lineId)!;
    const own = drawnRoute(line, byId(made), endOf, obstaclesByPage(made.nodes))!;
    expect(own.map(p => p.x)).toContain(180);
    expect(shape.points).toEqual(drawn(line, made));
    expect(shape.points).not.toEqual(own);
    expect(shape.points.map(p => p.x)).not.toContain(180);
  });

  it('reads the lines the drop does not touch as the page has them, and routes none of them again', () => {
    const g: G = {
      nodes: [sym('HV1', 0, 0), sym('HV2', 0, 100), sym('SV1', 300, 120), sym('SV2', 300, 220), sym('F1', 1000, 0), sym('F2', 1300, 100)],
      edges: [E('HV1', 'r', 'SV1', 'l'), E('F1', 'r', 'F2', 'l')],
    };
    publish(g);
    const asked = new Set<string>();
    const sc: DropScene = { ...scene(g), endOf: (n, h) => { asked.add(n.id); return endOf(n, h); } };
    const plan = connect(resolveDrop({ kind: 'port', nodeId: 'HV2', handle: 'r' }, P(300, 250), { handle: { nodeId: 'SV2', handleId: 'l' }, node: 'SV2' }, sc));
    asked.clear();
    const shape = previewOf(plan, sc, { from: P(60, 130), to: P(300, 250) });
    const made = commitDrop(plan, scene(g))!;
    expect(shape.points).toEqual(drawn(made.edges.find(e => e.id === made.lineId)!, made));
    expect([...asked].sort()).toEqual(['HV2', 'SV2']);
  });

  it('shows a carried end at the port it is carried to, not where the line was', () => {
    // X-B's end is carried from B to C's free port, beside the line D-E
    // already there: the line keeps its name, and is drawn off D-E.
    const g: G = {
      nodes: [sym('X', 0, 0, ['r']), sym('B', 300, 100, ['l']), sym('C', 300, 250, ['l']), sym('D', 0, 130, ['r']), sym('E', 300, 350, ['l'])],
      edges: [E('X', 'r', 'B', 'l'), E('D', 'r', 'E', 'l')],
    };
    publish(g);
    const plan = connect(resolveDrop({ kind: 'reconnect', edgeId: 'X-B', moving: 'target' }, P(300, 280), { handle: { nodeId: 'C', handleId: 'l' }, node: 'C' }, scene(g)));
    expect(plan.to.kind).toBe('port');
    const shape = previewOf(plan, scene(g), { from: P(300, 130), to: P(300, 280) });
    const made = commitDrop(plan, scene(g))!;
    const line = made.edges.find(e => e.id === 'X-B')!;
    expect(line.target).toBe('C');
    expect(shape.points).toEqual(drawn(line, made));
    expect(shape.points[shape.points.length - 1]).toEqual(P(300, 280));
    expect(shape.points).not.toEqual(drawnRoute(line, byId(made), endOf, obstaclesByPage(made.nodes)));
  });

  it('shows the hook a drop on an unrotated valve above a header draws, not an L', () => {
    const A = sym('A', 0, 0, ['l', 'r']), B = sym('B', 700, 0, ['l', 'r']), V = sym('V1', 300, -260, ['l', 'r']);
    const g: G = { nodes: [A, B, V], edges: [E('A', 'r', 'B', 'l')] };
    const run = drawn(g.edges[0], g);
    const press = P(350, 30), at = P(330, -230);
    const plan = connect(resolveDrop({ kind: 'line', edgeId: 'A-B', at: press, dir: P(1, 0), points: run }, at, { node: 'V1' }, scene(g)));
    const shape = previewOf(plan, scene(g), { from: press, to: at });
    const made = settle(commitDrop(plan, scene(g))!);
    const line = made.edges.find(e => e.target === 'V1' || e.source === 'V1')!;
    expect(shape.points).toEqual(drawn(line, made));
    // A straight L into a port facing sideways is not what is drawn.
    expect(corners(shape.points)).toBeGreaterThan(1);
    expect(shape.ring).toEqual(plan.to.centre);
    expect(shape.tees).toHaveLength(1);
  });

  it('leaves a tee across its run, not along it', () => {
    const A = sym('A', 0, 0, ['l', 'r']), B = sym('B', 400, 0, ['l', 'r']), C = sym('C', 300, 200, ['t']);
    const g0: G = { nodes: [A, B, C], edges: [E('A', 'r', 'B', 'l')] };
    const split = splitEdgeAt(g0.nodes, g0.edges, 'A-B', P(200, 30), undefined, { points: drawn(g0.edges[0], g0) })!;
    const g = settle(split);
    const tee = g.nodes.find(n => n.id === split.junctionId)!;
    const at = P(330, 200);
    const plan = connect(resolveDrop({ kind: 'node', nodeId: tee.id }, at, { handle: { nodeId: 'C', handleId: 't' }, node: 'C' }, scene(g)));
    const shape = previewOf(plan, scene(g), { from: P(tee.position.x + J_HALF, tee.position.y + J_HALF), to: at });
    expect(leg(shape.points[0], shape.points[1])).toBe('vertical');
    expect(shape.points[shape.points.length - 1]).toEqual(P(330, 200));
  });

  it('draws a drop that makes nothing as the bare pull, to the pointer, and says so', () => {
    const g: G = { nodes: [sym('A', 0, 0, ['l', 'r']), sym('B', 400, 0, ['l', 'r'])], edges: [E('A', 'r', 'B', 'l')] };
    const run = drawn(g.edges[0], g);
    const from = P(200, 30), to = P(210, 45);
    const plan = resolveDrop({ kind: 'line', edgeId: 'A-B', at: from, dir: P(1, 0), points: run }, to, {}, scene(g));
    expect(plan).toEqual({ kind: 'cancel', why: 'short' });
    expect(previewOf(plan, scene(g), { from, to })).toEqual({ points: [from, to], tees: [], ring: null, cancel: true });
    // Back on its own line.
    const own = resolveDrop({ kind: 'line', edgeId: 'A-B', at: from, dir: P(1, 0), points: run }, P(320, 31), { line: { id: 'A-B', at: P(320, 30), points: run } }, scene(g));
    expect(previewOf(own, scene(g), { from, to: P(320, 31) }).cancel).toBe(true);
  });

  it('draws a plan the drawing will no longer take as nothing', () => {
    const g: G = { nodes: [sym('A', 0, 0, ['l', 'r']), sym('B', 400, 0, ['l', 'r'])], edges: [] };
    const plan = connect(resolveDrop({ kind: 'port', nodeId: 'A', handle: 'r' }, P(400, 30), { handle: { nodeId: 'B', handleId: 'l' }, node: 'B' }, scene(g)));
    // B.l has taken a line since.
    const taken: G = { ...g, edges: [E('B', 'l', 'A', 'l')] };
    expect(previewOf(plan, scene(taken), { from: P(60, 30), to: P(400, 30) }).cancel).toBe(true);
  });

  it('marks an open end hollow and a tee put into a line solid', () => {
    const g: G = { nodes: [sym('A', 0, 0, ['l', 'r']), sym('B', 400, 0, ['l', 'r'])], edges: [E('A', 'r', 'B', 'l')] };
    const run = drawn(g.edges[0], g);
    const plan = connect(resolveDrop({ kind: 'line', edgeId: 'A-B', at: P(200, 30), dir: P(1, 0), points: run }, P(200, 200), {}, scene(g)));
    const shape = previewOf(plan, scene(g), { from: P(200, 30), to: P(200, 200) });
    expect([...shape.tees].sort((a, b) => a.at.y - b.at.y)).toEqual([{ at: P(200, 30), open: false }, { at: P(200, 200), open: true }]);
    expect(shape.ring).toBeNull();
    expect(shape.points).toEqual([P(200, 38), P(200, 192)]);
  });

  it('shows a pull out of an open end as the line it ends, going on: no dot where the open end was, and no ring on one it joins', () => {
    // A.r out to an open end at (200,30), and B.l out to one at (300,30).
    let g: G = { nodes: [sym('A', 0, 0, ['l', 'r']), sym('B', 400, 0, ['l', 'r'])], edges: [] };
    for (const [id, at] of [['A', P(200, 30)], ['B', P(300, 30)]] as const) {
      g = settle(commitDrop(connect(resolveDrop({ kind: 'port', nodeId: id, handle: id === 'A' ? 'r' : 'l' }, at, {}, scene(g))), scene(g))!);
    }
    const open = (x: number) => g.nodes.find(n => isJunction(n) && n.position.x + J_HALF === x)!.id;
    const fromA = g.edges.find(e => e.source === 'A')!;
    // Pulled on round a corner: the line from A, to an open end below where the old one was.
    const down = connect(resolveDrop({ kind: 'node', nodeId: open(200), at: P(200, 30) }, P(200, 130), {}, scene(g)));
    const shape = previewOf(down, scene(g), { from: P(200, 30), to: P(200, 130) });
    const after = settle(commitDrop(down, scene(g))!);
    expect(shape.points).toEqual(drawn(after.edges.find(e => e.id === fromA.id)!, after));
    expect(shape.points).toEqual([P(60, 30), P(200, 30), P(200, 122)]);
    expect(shape.tees).toEqual([{ at: P(200, 130), open: true }]);
    // Let go on the other open end: the two lines are one, from A to B, and
    // there is nothing left there to ring.
    const join = connect(resolveDrop({ kind: 'node', nodeId: open(200), at: P(200, 30) }, P(300, 30), { node: open(300) }, scene(g)));
    const joined = previewOf(join, scene(g), { from: P(200, 30), to: P(300, 30) });
    expect(joined).toEqual({ points: [P(60, 30), P(400, 30)], tees: [], ring: null, cancel: false });
  });

  it('routes round what the scene says is in the way, and round the page\'s symbols when it does not say', () => {
    // A valve standing on the plain route between the two ports.
    const g: G = { nodes: [sym('A', 0, 0, ['r']), sym('B', 300, 100, ['l']), sym('X', 150, 40)], edges: [] };
    const plan = connect(resolveDrop({ kind: 'port', nodeId: 'A', handle: 'r' }, P(300, 130), { handle: { nodeId: 'B', handleId: 'l' }, node: 'B' }, scene(g)));
    const pull = { from: P(60, 30), to: P(300, 130) };
    const plain = pathPoints(routeOrthogonal(endOf(g.nodes[0], 'r')!, endOf(g.nodes[1], 'l')!).d);
    const x = { x: 150, y: 40, w: 60, h: 60 };
    const round = previewOf(plan, scene(g), pull).points;
    expect(round.some((p, i) => i + 1 < round.length && segmentEntersBox(p, round[i + 1], x, 1))).toBe(false);
    // The ends' own symbols among them, as a page's symbols have them.
    const all = obstaclesByPage(g.nodes)('Main');
    expect(all).toContainEqual(x);
    expect(previewOf(plan, { ...scene(g), obstacles: all }, pull).points).toEqual(round);
    expect(previewOf(plan, { ...scene(g), obstacles: () => all }, pull).points).toEqual(round);
    expect(previewOf(plan, { ...scene(g), obstacles: [] }, pull).points).toEqual(plain);
  });

  it('makes its drop without using up a tee id the real drop will want', () => {
    const g: G = { nodes: [sym('A', 0, 0, ['l', 'r']), sym('B', 400, 0, ['l', 'r'])], edges: [E('A', 'r', 'B', 'l')] };
    const run = drawn(g.edges[0], g);
    const before = nextJunctionId();
    const n = Number(before.slice('junc_'.length));
    for (let i = 0; i < 5; i++) {
      const plan = resolveDrop({ kind: 'line', edgeId: 'A-B', at: P(200, 30), dir: P(1, 0), points: run }, P(200, 150 + 10 * i), {}, scene(g));
      expect(previewOf(plan, scene(g), { from: P(200, 30), to: P(200, 150) }).tees).toHaveLength(2);
    }
    expect(nextJunctionId()).toBe(`junc_${n + 1}`);
  });
});

describe('previewer', () => {
  const g: G = { nodes: [sym('A', 0, 0, ['l', 'r']), sym('B', 400, 0, ['l', 'r'])], edges: [E('A', 'r', 'B', 'l')] };
  const run = drawn(g.edges[0], g);
  const source: DropSource = { kind: 'line', edgeId: 'A-B', at: P(200, 30), dir: P(1, 0), points: run };

  it('draws a plan it drew on the frame before as it was, without making it again', () => {
    const sc = scene(g);
    const preview = previewer(sc);
    // The open end is on the grid: a pointer moving within one grid square resolves to one plan.
    const a = preview(resolveDrop(source, P(201, 199), {}, sc), { from: P(200, 30), to: P(201, 199) });
    const b = preview(resolveDrop(source, P(203, 202), {}, sc), { from: P(200, 30), to: P(203, 202) });
    expect(b).toBe(a);
    const c = preview(resolveDrop(source, P(203, 250), {}, sc), { from: P(200, 30), to: P(203, 250) });
    expect(c).not.toBe(a);
    expect(c.points[c.points.length - 1].y).toBeGreaterThan(a.points[a.points.length - 1].y);
  });

  it('draws a drop that makes nothing to wherever the pointer is now', () => {
    const sc = scene(g);
    const preview = previewer(sc);
    const a = preview(resolveDrop(source, P(205, 40), {}, sc), { from: P(200, 30), to: P(205, 40) });
    const b = preview(resolveDrop(source, P(210, 44), {}, sc), { from: P(200, 30), to: P(210, 44) });
    expect(a.cancel && b.cancel).toBe(true);
    expect(b.points).toEqual([P(200, 30), P(210, 44)]);
  });

  it('tells plans apart by where each end is and what it is on', () => {
    const sc = scene(g);
    const one = resolveDrop(source, P(200, 200), {}, sc), two = resolveDrop(source, P(200, 250), {}, sc);
    expect(planKey(one)).not.toBe(planKey(two));
    expect(planKey(one)).toBe(planKey(resolveDrop(source, P(202, 201), {}, sc)));
    expect(planKey({ kind: 'cancel', why: 'short' })).not.toBe(planKey({ kind: 'cancel', why: 'own' }));
  });
});

describe('pullOf', () => {
  it('leaves the line it was pulled from across it, and otherwise the way the pointer went furthest', () => {
    expect(pullOf(P(0, 0), P(50, 80), P(1, 0))).toEqual([P(0, 0), P(0, 80), P(50, 80)]);
    expect(pullOf(P(0, 0), P(50, 80), P(0, 1))).toEqual([P(0, 0), P(50, 0), P(50, 80)]);
    expect(pullOf(P(0, 0), P(50, 80))).toEqual([P(0, 0), P(0, 80), P(50, 80)]);
    expect(pullOf(P(0, 0), P(90, 80))).toEqual([P(0, 0), P(90, 0), P(90, 80)]);
  });
});
