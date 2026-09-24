// What a drag let go somewhere means (drop.ts): each rule on its own, the
// plan made into a drawing, a carried end, and the drawing React Flow is
// handed. Symbols are 60 px boxes with their ports on the middle of their
// sides; tees are put in with splitEdgeAt and settled with the reseat, as the
// designer does.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { J_END, J_HALF, TEE_GAP, isJunction, junctionData, junctionEnd, pipeOf, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { dragSegment, nearestOnPolyline, pathPoints, pointsToPath, routeOrthogonal, routeThrough, waypointsOf } from './route';
import { nodeSize } from './attach';
import { obstaclesByPage } from './routeGrid';
import { drawnScene } from './tracks';
import { previewOf } from './preview';
import type { Pt } from './route';
import {
  ALIGN_REACH, LINE_REACH, MIN_PULL, MIN_PULL_FLOW, TEE_OUT, canJoin, clientOf, commitDrop, connectLine, lineUnder, minPull,
  partOnLine, plainLine,
  reconnectLine, reconnectMoving, reconnectableEnds, resolveDrop,
} from './drop';
import type { DropPlan, DropScene, DropSource, PlanEnd, Under } from './drop';

/**
 * A sweep runs hundreds of drops: well inside a test's usual five seconds
 * alone, but not always on a machine busy with other work.
 */
const SWEEP_MS = 30_000;

const P = (x: number, y: number): Pt => ({ x, y });

// ── The drawing ──────────────────────────────────────────────────────────────

const PORTS: Record<string, string[]> = {};
function sym(id: string, x: number, y: number, ports: string[] = ['l', 'r'], w = 60, h = 60, page?: string): Node {
  PORTS[id] = ports;
  return {
    id, type: 'MAN', position: { x, y }, measured: { width: w, height: h },
    data: { componentType: 'MAN', label: id, ...(page ? { page } : {}) },
  };
}
/** Ports off the middle of a side, from the symbol's corner: a manifold's outlets, a tank's lid. */
const AT: Record<string, Record<string, { x: number; y: number; side: Position }>> = {};
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? junctionEnd(node.position, handle as Face) : null;
  if (!handle || !(PORTS[node.id] ?? []).includes(handle)) return null;
  const { x, y } = node.position;
  const off = AT[node.id]?.[handle];
  if (off) return { x: x + off.x, y: y + off.y, side: off.side };
  const w = node.measured?.width ?? 60, h = node.measured?.height ?? 60;
  switch (handle) {
    case 'l': return { x, y: y + h / 2, side: Position.Left };
    case 'r': return { x: x + w, y: y + h / 2, side: Position.Right };
    case 't': return { x: x + w / 2, y, side: Position.Top };
    case 'b': return { x: x + w / 2, y: y + h, side: Position.Bottom };
    default: return null;
  }
};
const E = (s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${s}-${t}`, source: s, sourceHandle: sh, target: t, targetHandle: th, type: 'smoothstep', data });

/** A line as the canvas draws it: J_END on a tee end, through its corners when it has them. */
function drawn(e: Edge, nodes: Node[]): Pt[] {
  const s = nodes.find(n => n.id === e.source)!, t = nodes.find(n => n.id === e.target)!;
  const a = { ...endOf(s, e.sourceHandle)!, ...(isJunction(s) ? J_END : {}) };
  const b = { ...endOf(t, e.targetHandle)!, ...(isJunction(t) ? J_END : {}) };
  const d = (e.data ?? {}) as { waypoints?: Pt[] };
  return pathPoints((d.waypoints?.length ? routeThrough(a, b, d.waypoints) : routeOrthogonal(a, b)).d);
}

interface G { nodes: Node[]; edges: Edge[] }
const scene = (g: G, extra: Partial<DropScene> = {}): DropScene => ({
  nodes: g.nodes, edges: g.edges, endOf, portsOf: n => PORTS[n.id],
  lines: g.edges.map(e => ({ id: e.id, points: drawn(e, g.nodes) })), ...extra,
});
function settle(g: G): G {
  let n = g.nodes, e = g.edges;
  for (let i = 0; i < 10; i++) {
    const re = reseatJunctions(n, e, endOf);
    if (re.nodes === n && re.edges === e) break;
    n = re.nodes; e = re.edges;
  }
  return { nodes: n, edges: e };
}
/** Valve A (0,0) to valve B (400,0): A.r (60,30) -> B.l (400,30). */
const run = (): G => ({ nodes: [sym('A', 0, 0), sym('B', 400, 0)], edges: [E('A', 'r', 'B', 'l')] });
/** The run with a tee put in it at x, settled. */
function teed(x: number, g: G = run()): G & { tee: string } {
  const e = g.edges.find(l => l.source === 'A')!;
  const split = splitEdgeAt(g.nodes, g.edges, e.id, P(x, 30), undefined, { points: drawn(e, g.nodes) })!;
  return { ...settle(split), tee: split.junctionId };
}
const centre = (g: G, id: string) => { const n = g.nodes.find(x => x.id === id)!; return P(n.position.x + J_HALF, n.position.y + J_HALF); };

/** A press on a drawn line, as BranchableEdge hands it to BranchDrag. */
function press(g: G, edgeId: string, at: Pt): DropSource {
  const points = drawn(g.edges.find(e => e.id === edgeId)!, g.nodes);
  const near = nearestOnPolyline(points, at)!;
  return { kind: 'line', edgeId, at: near.point, dir: near.dir, points };
}
const ring = (g: G, id: string): DropSource => ({ kind: 'node', nodeId: id, at: centre(g, id) });
const port = (nodeId: string, handle: string): DropSource => ({ kind: 'port', nodeId, handle });

/** Resolve a drop, with the nearest drawn line found as the designer finds it. */
function drop(g: G, source: DropSource, at: Pt, under: Under = {}, extra: Partial<DropScene> = {}): DropPlan {
  const sc = scene(g, extra);
  return resolveDrop(source, at, { line: lineUnder(sc.lines!, at, sc.zoom), ...under }, sc);
}
function connected(plan: DropPlan) {
  expect(plan.kind, JSON.stringify(plan.kind === 'cancel' ? plan : plan.landed)).toBe('connect');
  return plan as Extract<DropPlan, { kind: 'connect' }>;
}
const on = (nodeId: string, handleId: string): Under => ({ handle: { nodeId, handleId }, node: nodeId });

// ── a. What draws nothing ────────────────────────────────────────────────────

describe('a pull that ends where it began, or on its own pipe, draws nothing', () => {
  it('measures the shortest pull in screen pixels, never less than a floor on the drawing', () => {
    expect(minPull(1)).toBe(MIN_PULL);
    expect(minPull(0.5)).toBe(MIN_PULL * 2);
    expect(minPull(2)).toBe(MIN_PULL_FLOW);
    // 25 px on the drawing: short at zoom 1 (25 screen px), a line at zoom 2
    // (50 screen px), short again at zoom 0.5 even at 50 px on the drawing.
    expect(drop(run(), port('A', 'l'), P(-25, 30))).toEqual({ kind: 'cancel', why: 'short' });
    expect(drop(run(), port('A', 'l'), P(-25, 30), {}, { zoom: 2 }).kind).toBe('connect');
    expect(drop(run(), port('A', 'l'), P(-50, 30), {}, { zoom: 0.5 })).toEqual({ kind: 'cancel', why: 'short' });
  });

  it('never joins a symbol to itself: not its body, not its other port', () => {
    const g = { nodes: [sym('A', 0, 0), sym('C', 200, 0)], edges: [] };
    expect(drop(g, port('A', 'r'), P(20, 45), { node: 'A' })).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, port('A', 'r'), P(0, 30), on('A', 'l'))).toEqual({ kind: 'cancel', why: 'own' });
  });

  it('never joins a symbol to itself through a tee: not in a pipe out of another of its ports, nor where one ends', () => {
    // S.r -> B.l. A tee in that line joined to S.t or S.b would put two of
    // S's ports on one node, its outlet on its own inlet.
    const S = () => sym('S', 0, 0, ['l', 'r', 't', 'b']);
    const g: G = { nodes: [S(), sym('B', 400, 0, ['l', 'b'])], edges: [E('S', 'r', 'B', 'l')] };
    expect(drop(g, port('S', 't'), P(120, 31))).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, port('S', 'b'), P(300, 31))).toEqual({ kind: 'cancel', why: 'own' });
    // Drawn the other way round -- a pull out of the line let go on S.t -- it always was.
    expect(drop(g, press(g, 'S-B', P(120, 31)), P(30, 0), on('S', 't'))).toEqual({ kind: 'cancel', why: 'own' });
    // B's port, which has the line on it, would be teed 30 px out in the same line.
    expect(drop(g, port('S', 'b'), P(400, 30), on('B', 'l'))).toEqual({ kind: 'cancel', why: 'own' });
    // A second line to B, the symbol at the far end, is two lines between two
    // symbols, which a drawing may have.
    expect(connected(drop(g, port('S', 'b'), P(430, 60), on('B', 'b'))).to).toMatchObject({ kind: 'port', nodeId: 'B', handle: 'b' });
    // A tee riding the pipe, and the open end a pipe out of S stops at.
    const t = teed(200, { nodes: [sym('A', 0, 0, ['l', 'r', 't', 'b']), sym('B', 400, 0)], edges: [E('A', 'r', 'B', 'l')] });
    const c = centre(t, t.tee);
    expect(drop(t, port('A', 'b'), P(c.x + 1, c.y + 2), { node: t.tee })).toEqual({ kind: 'cancel', why: 'own' });
    const lone: G = { nodes: [S()], edges: [] };
    const open = settle(commitDrop(connected(drop(lone, port('S', 'r'), P(200, 30))), scene(lone))!);
    const end = open.nodes.find(isJunction)!;
    expect(drop(open, port('S', 't'), P(201, 31), { node: end.id })).toEqual({ kind: 'cancel', why: 'own' });
  });

  it('a short pull let go right on a free port joins it; let go anywhere else near, it is a change of mind', () => {
    // C.t at (115,55): 29 px from a press on the run at (100,30).
    const g: G = { nodes: [...run().nodes, sym('C', 85, 55, ['t']), sym('Z', 0, 300)], edges: run().edges };
    expect(connected(drop(g, press(g, 'A-B', P(100, 31)), P(115, 55), on('C', 't'))).to).toMatchObject({ kind: 'port', nodeId: 'C', handle: 't' });
    expect(drop(g, press(g, 'A-B', P(100, 31)), P(112, 57), { node: 'C' })).toEqual({ kind: 'cancel', why: 'short' });
    // With a line on it, joining it is teeing a line, which a short pull does not.
    const busy = { ...g, edges: [...g.edges, E('Z', 'r', 'C', 't')] };
    expect(drop(busy, press(busy, 'A-B', P(100, 31)), P(115, 55), on('C', 't'))).toEqual({ kind: 'cancel', why: 'short' });
  });

  it('a pull let go further along its own line draws nothing, where a pull let go off it leaves an open end', () => {
    const g = run();
    expect(drop(g, press(g, 'A-B', P(150, 31)), P(260, 33))).toEqual({ kind: 'cancel', why: 'own' });
    // The same pull, let go clear of the line: an open end.
    expect(connected(drop(g, press(g, 'A-B', P(150, 31)), P(260, 30 + 2 * LINE_REACH))).landed).toBe('open');
  });

  it('a pull out of one half of a run let go on the other half, or on a tee of the run, draws nothing', () => {
    const g = teed(200);
    const up = g.edges.find(e => e.source === 'A')!;
    expect(drop(g, press(g, up.id, P(120, 31)), P(320, 32))).toEqual({ kind: 'cancel', why: 'own' });
    const c = centre(g, g.tee);
    expect(drop(g, press(g, up.id, P(100, 31)), P(c.x + 2, c.y + 2), { node: g.tee })).toEqual({ kind: 'cancel', why: 'own' });
  });

  it('a pull let go on the symbol at either end of its pipe, or on the port there, draws nothing', () => {
    const g = teed(250);
    const up = g.edges.find(e => e.source === 'A')!;
    expect(drop(g, press(g, up.id, P(150, 31)), P(430, 40), { node: 'B' })).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, press(g, up.id, P(150, 31)), P(60, 30), on('A', 'r'))).toEqual({ kind: 'cancel', why: 'own' });
  });

  it("a tee's ring let go on its own run, on its own branch, or on another tee of its run draws nothing", () => {
    const g0 = teed(150);
    const down = g0.edges.find(e => e.source === g0.tee)!;
    const split = splitEdgeAt(g0.nodes, g0.edges, down.id, P(300, 30), undefined, { points: drawn(down, g0.nodes) })!;
    const g = { ...settle({ nodes: [...split.nodes, sym('C', 120, 200, ['t'])], edges: [...split.edges, E(g0.tee, 'b', 'C', 't')] }), tee: g0.tee };
    expect(drop(g, ring(g, g.tee), P(80, 31))).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, ring(g, g.tee), P(302, 32), { node: split.junctionId })).toEqual({ kind: 'cancel', why: 'own' });
    // Its own branch, and the symbol that branch goes to.
    expect(drop(g, ring(g, g.tee), P(151, 120))).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, ring(g, g.tee), P(150, 230), { node: 'C' })).toEqual({ kind: 'cancel', why: 'own' });
  });
});

// ── b and c. What is under the pointer ───────────────────────────────────────

describe('a port under the pointer, and the nearer of a line and a node', () => {
  it('a free port under the pointer is joined as it is', () => {
    const g = { nodes: [sym('A', 0, 0), sym('C', 200, 100)], edges: [] };
    const plan = connected(drop(g, port('A', 'r'), P(200, 130), on('C', 'l')));
    expect(plan.landed).toBe('port');
    expect(plan.to).toMatchObject({ kind: 'port', nodeId: 'C', handle: 'l' });
    expect(plan.from).toMatchObject({ kind: 'port', nodeId: 'A', handle: 'r' });
  });

  it("a tee's face under the pointer is the tee, joined on its face across the run", () => {
    const t = teed(200);
    const g = { ...t, nodes: [...t.nodes, sym('S', 170, 150, ['t'])] };
    const c = centre(g, g.tee);
    // The face on the run itself, which React Flow's radius can land a drop
    // nearest: never used.
    const plan = connected(drop(g, port('S', 't'), P(c.x + 2, c.y + 3), on(g.tee, 'r')));
    expect(plan.landed).toBe('tee');
    expect(plan.to).toMatchObject({ kind: 'tee', nodeId: g.tee, face: 'b' });
  });

  it('a line nearer the pointer than the node under it wins, and the node wins a tie', () => {
    // X.r (60,95) -> Y.l (400,95) passes over the top of C (200..260, 100..160).
    const g = { nodes: [sym('X', 0, 65), sym('Y', 400, 65), sym('C', 200, 100), sym('S', 500, 300)], edges: [E('X', 'r', 'Y', 'l')] };
    expect(connected(drop(g, port('S', 'l'), P(230, 97), { node: null })).landed).toBe('line');
    expect(connected(drop(g, port('S', 'l'), P(230, 97), { node: 'C' })).landed).toBe('line');
    // 2.5 from the line and 2.5 from the box: a tie, which the node takes.
    expect(connected(drop(g, port('S', 'l'), P(230, 97.5), { node: 'C' })).landed).toBe('body');
    expect(connected(drop(g, port('S', 'l'), P(230, 98.5), { node: 'C' })).landed).toBe('body');
    expect(connected(drop(g, port('S', 'l'), P(230, 110), { node: 'C' })).landed).toBe('body');
  });

  it("a tee's halo loses to a line running nearer the pointer than the tee's centre", () => {
    const t = teed(200);
    const g = { nodes: [...t.nodes, sym('C', 40, 10), sym('D', 360, 10), sym('S', 170, 200, ['t'])], edges: [...t.edges, E('C', 'r', 'D', 'l')] };
    // C.r (100,40) -> D.l (360,40), ten below the tee at (200,30).
    const plan = connected(drop(g, port('S', 't'), P(205, 39), { node: t.tee }));
    expect(plan.landed).toBe('line');
    expect(plan.to).toMatchObject({ kind: 'split', edgeId: 'C-D' });
  });

  it("a tee's own run is the tee on its halo, however much nearer the pointer the run is than the tee's centre", () => {
    // S.l faces away from the run, so nothing lines a line from it up with
    // the tee: let go on the tee's halo just beside its dot, over one of the
    // two lines leaving it, it is the tee that was aimed at -- not a second
    // tee split into its run beside it, nor a pull refused for want of room.
    const t = teed(200);
    const g = { nodes: [...t.nodes, sym('S', 300, 150, ['l'])], edges: t.edges };
    for (const at of [P(209, 33), P(191, 33)]) {
      const under: Under = { node: t.tee, line: lineUnder(scene(g).lines!, at) };
      // The line under the pointer is the tee's own, and nearer than its centre.
      const own = g.edges.find(e => e.id === under.line?.id)!;
      expect([own.source, own.target], JSON.stringify(at)).toContain(t.tee);
      expect(Math.hypot(under.line!.at.x - at.x, under.line!.at.y - at.y)).toBeLessThan(Math.hypot(200 - at.x, 30 - at.y));
      expect(connected(drop(g, port('S', 'l'), at, under)).to, JSON.stringify(at)).toMatchObject({ kind: 'tee', nodeId: t.tee, face: 'b' });
    }
  });

  it('section boxes and text are not things to join: a drop over one is a drop on the canvas', () => {
    const region: Node = { id: 'R', type: 'REGION', position: { x: 100, y: 100 }, measured: { width: 300, height: 200 }, data: { componentType: 'REGION' } };
    const g = { nodes: [sym('A', 0, 0), region], edges: [] };
    expect(connected(drop(g, port('A', 'r'), P(200, 200), { node: 'R' })).landed).toBe('open');
  });
});

// ── d. Bodies and tees ───────────────────────────────────────────────────────

describe("a symbol's body means its best free port; a tee its free face across its run", () => {
  it('picks the port the line reaches best, and never one that already has a line', () => {
    const g: G = { nodes: [sym('A', 0, 0), sym('C', 300, 100), sym('Z', 150, 300)], edges: [] };
    expect(connected(drop(g, port('A', 'r'), P(330, 130), { node: 'C' })).to).toMatchObject({ kind: 'port', nodeId: 'C', handle: 'l' });
    const taken = { ...g, edges: [E('Z', 'r', 'C', 'l')] };
    const plan = connected(drop(taken, port('A', 'r'), P(330, 130), { node: 'C' }));
    expect(plan.landed).toBe('body');
    expect(plan.to).toMatchObject({ kind: 'port', nodeId: 'C', handle: 'r' });
  });

  it('with every port taken, tees the line on the port it reaches best', () => {
    const g: G = { nodes: [sym('A', 0, 0), sym('C', 300, 100), sym('Z', 150, 300), sym('W', 500, 300)], edges: [E('Z', 'r', 'C', 'l'), E('C', 'r', 'W', 'l')] };
    const plan = connected(drop(g, port('A', 'r'), P(330, 130), { node: 'C' }));
    expect(plan.landed).toBe('occupied');
    expect(plan.to).toMatchObject({ kind: 'split', edgeId: 'Z-C' });
  });

  it('refuses a body whose ports are all on the pull\'s own pipe, or that has no port at all', () => {
    const g: G = { nodes: [sym('A', 0, 0, ['r']), sym('B', 400, 0, ['l']), sym('N', 150, 200, [])], edges: [E('A', 'r', 'B', 'l')] };
    expect(drop(g, port('N', 'x'), P(30, 30), { node: 'A' })).toEqual({ kind: 'cancel', why: 'nothing' });
    const up = { nodes: [...g.nodes, sym('S', 150, 200, ['t'])], edges: g.edges };
    expect(drop(up, port('S', 't'), P(180, 100), { node: 'N' })).toEqual({ kind: 'cancel', why: 'full' });
  });

  it('a tee riding a run gives the face on the side the line comes from', () => {
    const t = teed(200);
    const g = { nodes: [...t.nodes, sym('S', 170, 150, ['t']), sym('U', 170, -150, ['b'])], edges: t.edges };
    const c = centre(g, t.tee);
    expect(connected(drop(g, port('S', 't'), P(c.x + 1, c.y + 2), { node: t.tee })).to).toMatchObject({ kind: 'tee', face: 'b' });
    expect(connected(drop(g, port('U', 'b'), P(c.x + 1, c.y - 2), { node: t.tee })).to).toMatchObject({ kind: 'tee', face: 't' });
  });

  it('with that face taken, puts a new tee on the run TEE_GAP along it, toward the other end', () => {
    const t = teed(200);
    const g0 = { nodes: [...t.nodes, sym('D', 170, 150, ['t']), sym('S', 300, 250, ['t']), sym('Q', 40, 250, ['t'])], edges: [...t.edges, E(t.tee, 'b', 'D', 't')] };
    const g = settle(g0);
    const c = centre(g, t.tee);
    const right = connected(drop(g, port('S', 't'), P(c.x + 2, c.y + 2), { node: t.tee }));
    expect(right.to.kind).toBe('split');
    expect(right.to.centre).toEqual(P(c.x + TEE_GAP, c.y));
    expect((right.to as Extract<PlanEnd, { kind: 'split' }>).face).toBe('b');
    const left = connected(drop(g, port('Q', 't'), P(c.x - 2, c.y + 2), { node: t.tee }));
    expect(left.to.centre).toEqual(P(c.x - TEE_GAP, c.y));
  });

  it("a tee's ring with its face taken branches from a new tee beside it, and the two branches never share a face", () => {
    const t = teed(300);
    const first = connected(drop(t, ring(t, t.tee), P(300, 150)));
    const made = commitDrop(first, scene(t))!;
    const g = settle(made);
    const second = connected(drop(g, ring(g, t.tee), P(420, 150)));
    expect(second.from.kind).toBe('split');
    expect(second.from.centre).toEqual(P(300 + TEE_GAP, 30));
    const after = settle(commitDrop(second, scene(g))!);
    const faces = after.edges.filter(e => e.source === t.tee || e.target === t.tee).map(e => (e.source === t.tee ? e.sourceHandle : e.targetHandle));
    expect(new Set(faces).size).toBe(faces.length);
  });

  it('judges where it lands from the new tee, not the full one, so the branch beside it is still straight', () => {
    const t = teed(300);
    // The tee's lower face already has a branch, down and away to C.t.
    const g = settle({ nodes: [...t.nodes, sym('C', 100, 200, ['t'])], edges: [...t.edges, E(t.tee, 'b', 'C', 't')] });
    // Let go just right of straight below the full tee: the new tee goes
    // TEE_GAP right of it, and the open end is put level with the new tee,
    // not with the full one.
    const plan = connected(drop(g, ring(g, t.tee), P(312, 150)));
    expect(plan.from.centre).toEqual(P(300 + TEE_GAP, 30));
    expect(plan.to.centre).toEqual(P(300 + TEE_GAP, 150));
  });


  it('never puts an open end level with where it leaves when that is on a line', () => {
    // C.r (100,40) -> D.l (300,40) runs on along A.r's level, (-40,40).
    const g: G = { nodes: [sym('A', -100, 10), sym('C', 40, 10), sym('D', 300, 10)], edges: [E('C', 'r', 'D', 'l')] };
    expect(connected(drop(g, port('A', 'r'), P(200, 59))).to.centre).toEqual(P(200, 60));
  });

  it('a free junction gives the face pointing at the line, or the free face pointing nearest, and refuses when full', () => {
    const j: Node = { id: 'J', type: 'JUNCTION', position: { x: 195, y: 195 }, data: { componentType: 'JUNCTION' } };
    const others = ['n1', 'n2', 'n3', 'n4'].map((id, i) => sym(id, 500 + 100 * i, 500));
    // S.r at (60,280): left of the junction and below it.
    const g: G = { nodes: [sym('S', 0, 250), j, ...others], edges: [] };
    expect(connected(drop(g, port('S', 'r'), P(200, 201), { node: 'J' })).to).toMatchObject({ kind: 'tee', face: 'l' });
    const lTaken = { ...g, edges: [E('n1', 'l', 'J', 'l')] };
    expect(connected(drop(lTaken, port('S', 'r'), P(200, 201), { node: 'J' })).to).toMatchObject({ kind: 'tee', face: 'b' });
    const full = { ...g, edges: (['l', 't', 'b', 'r'] as const).map((f, i) => ({ ...E(`n${i + 1}`, 'l', 'J', f), id: `k${i}` })) };
    expect(drop(full, port('S', 'r'), P(200, 201), { node: 'J' })).toEqual({ kind: 'cancel', why: 'full' });
  });
});

// ── e. Ports that already have a line ────────────────────────────────────────

describe('a port that already has a line is teed, never stacked', () => {
  it('a drop on it tees its line TEE_OUT out from the port', () => {
    const g = { ...run(), nodes: [...run().nodes, sym('S', 170, 200)] };
    const atA = connected(drop(g, port('S', 'l'), P(60, 30), on('A', 'r')));
    expect(atA.landed).toBe('occupied');
    expect(atA.to).toMatchObject({ kind: 'split', edgeId: 'A-B' });
    // Thirty out: the port's stub, the tee's anchor and its own stub.
    expect(TEE_OUT).toBe(30);
    expect(atA.to.centre).toEqual(P(90, 30));
    const atB = connected(drop(g, port('S', 'l'), P(400, 30), on('B', 'l')));
    expect(atB.to.centre).toEqual(P(370, 30));
  });

  it('a drag out of it is a pull out of its line from the same place', () => {
    const g = { ...run(), nodes: [...run().nodes, sym('S', 60, 200, ['t'])] };
    const plan = connected(drop(g, port('A', 'r'), P(95, 197), on('S', 't')));
    expect(plan.from).toMatchObject({ kind: 'split', edgeId: 'A-B' });
    expect(plan.from.centre).toEqual(P(90, 30));
    const made = commitDrop(plan, scene(g))!;
    const onA = made.edges.filter(e => (e.source === 'A' && e.sourceHandle === 'r') || (e.target === 'A' && e.targetHandle === 'r'));
    expect(onA).toHaveLength(1);
    const line = made.edges.find(e => e.id === made.lineId)!;
    expect(line.target).toBe('S');
    expect(isJunction(made.nodes.find(n => n.id === line.source))).toBe(true);
  });

  it('keeps the line it tees in more than two grid steps off the pipe it joins, and previews it where it is drawn', () => {
    // M's right port has its line to K, along y = 600 and up. A line from
    // S, down and to the right, let go on that port tees in thirty out and
    // comes into the tee from below. Every level for its crossbar between
    // the tee's stub and S is as short as every other, and the router's own
    // is at the stub: fourteen pixels under the pipe, all the way along it
    // to where it turns up, which reads as the pipe drawn twice. The
    // crossbar goes where it is clear, and no further; and the preview is
    // the line the drop leaves.
    const onPage = (g: G): G => {
      let n = g.nodes, e = g.edges;
      for (let i = 0; i < 10; i++) {
        const re = reseatJunctions(n, e, endOf, obstaclesByPage(n));
        if (re.nodes === n && re.edges === e) break;
        n = re.nodes; e = re.edges;
      }
      return { nodes: n, edges: e };
    };
    const g = onPage({ nodes: [sym('M', 1000, 570), sym('K', 1200, 340, ['b']), sym('S', 1580, 820, ['r'])], edges: [E('M', 'r', 'K', 'b')] });
    const plan = connected(drop(g, port('S', 'r'), P(1060, 600), on('M', 'r')));
    expect(plan.landed).toBe('occupied');
    const s = onPage(commitDrop(plan, scene(g))!);
    const line = s.edges.find(e => e.target === 'S' || e.source === 'S')!;
    const pts = drawnScene(s.nodes, s.edges, endOf, obstaclesByPage(s.nodes)).get(line.id)!;
    const bar = pts.find((p, i) => i > 0 && pts[i - 1].y === p.y && Math.abs(p.x - pts[i - 1].x) > 100)!;
    expect(bar.y - 600).toBeGreaterThan(20);
    expect(bar.y).toBe(630);
    expect(previewOf(plan, scene(g), { from: P(1640, 850), to: P(1060, 600) }).points).toEqual(pts);
  });
});

// ── f. Lines ─────────────────────────────────────────────────────────────────

describe('a line let go on is teed where it was hit, or level with the other end', () => {
  const withS = (ports: string[], x = 300, y = 200): G => ({ nodes: [...run().nodes, sym('S', x, y, ports)], edges: run().edges });

  it('puts the tee at the foot of a port that faces the line, within ALIGN_REACH of the hit', () => {
    const g = withS(['t']);  // S.t at (330,200), facing up at the run
    expect(connected(drop(g, port('S', 't'), P(345, 31))).to.centre).toEqual(P(330, 30));
    expect(connected(drop(g, port('S', 't'), P(330 - ALIGN_REACH + 1, 29))).to.centre).toEqual(P(330, 30));
    // Further off, where it was hit -- on the grid, the pointer's own place
    // being a fraction of a pixel at any zoom but one.
    expect(connected(drop(g, port('S', 't'), P(330 + ALIGN_REACH + 5, 31))).to.centre).toEqual(P(360, 30));
    expect(connected(drop(g, port('S', 't'), P(362.57, 31))).to.centre).toEqual(P(360, 30));
  });

  it('leaves the tee where it was hit when the other end cannot leave straight toward the line', () => {
    // S.l faces along the run; S.b faces away from it.
    expect(connected(drop(withS(['l']), port('S', 'l'), P(310, 31))).to.centre).toEqual(P(310, 30));
    expect(connected(drop(withS(['b']), port('S', 'b'), P(340, 31))).to.centre).toEqual(P(340, 30));
  });

  it('leaves it where it was hit when the foot is on another leg, or not a place a tee may sit', () => {
    // A bent run: A.r (60,30) -> K.t (260,200), turning down at x=260.
    const g: G = { nodes: [sym('A', 0, 0), sym('K', 230, 200, ['t']), sym('S', 290, 60, ['l'])], edges: [E('A', 'r', 'K', 't')] };
    // S.l (290,90) faces the down leg; its foot (260,90) is on that leg.
    expect(connected(drop(g, port('S', 'l'), P(261, 80))).to.centre).toEqual(P(260, 90));
    // Hit on the down leg with S level with the top leg: the foot is not on
    // the leg that was hit.
    const high = { ...g, nodes: [...g.nodes.slice(0, 2), sym('S', 290, 10, ['l'])] };
    expect(connected(drop(high, port('S', 'l'), P(261, 60))).to.centre).toEqual(P(260, 60));
    // A foot within a corner's reach of the bend is not a legal spot: the tee
    // goes to the legal spot nearest the hit instead.
    const nearBend = { ...g, nodes: [...g.nodes.slice(0, 2), sym('S', 290, 12, ['l'])] };
    const at = connected(drop(nearBend, port('S', 'l'), P(261, 60))).to.centre;
    expect(at).toEqual(P(260, 60));
  });

  it("puts the pulled line's own tee level with the port it is let go on, so a pull aimed straight is straight", () => {
    const g = withS(['t']);
    for (const off of [-15, -7, 0, 3, 12]) {
      const plan = connected(drop(g, press(g, 'A-B', P(330 + off, 31)), P(330, 200), on('S', 't')));
      expect(plan.from.centre, `pressed ${off} off`).toEqual(P(330, 30));
    }
    // Pressed further off than ALIGN_REACH: where it was pressed.
    const far = connected(drop(g, press(g, 'A-B', P(360, 31)), P(330, 200), on('S', 't')));
    expect(far.from.centre).toEqual(P(360, 30));
  });

  it('a pull from one line to another lines both tees up', () => {
    const g: G = { nodes: [...run().nodes, sym('C', 0, 170), sym('D', 400, 170)], edges: [...run().edges, E('C', 'r', 'D', 'l')] };
    const plan = connected(drop(g, press(g, 'A-B', P(200, 31)), P(212, 199)));
    expect(plan.to).toMatchObject({ kind: 'split', edgeId: 'C-D' });
    expect(plan.to.centre).toEqual(P(200, 200));
    expect(plan.from.centre).toEqual(P(200, 30));
  });
});

describe('a pull let go beside a tee on a parallel run joins that tee', () => {
  /** Two runs `gap` apart, a tee at x = 200 on each: the upper branched up to U, the lower down to W. */
  function parallel(gap: number) {
    const lowerY = 30 + gap;
    let g: G = {
      nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('C', 0, lowerY - 30), sym('D', 400, lowerY - 30), sym('U', 170, -200, ['b']), sym('W', 170, lowerY + 120, ['t'])],
      edges: [E('A', 'r', 'B', 'l'), E('C', 'r', 'D', 'l')],
    };
    const upper = splitEdgeAt(g.nodes, g.edges, 'A-B', P(200, 30), undefined, { points: drawn(g.edges[0], g.nodes) })!;
    g = settle({ nodes: upper.nodes, edges: [...upper.edges, E(upper.junctionId, 't', 'U', 'b')] });
    const run = g.edges.find(e => e.id === 'C-D')!;
    const lower = splitEdgeAt(g.nodes, g.edges, 'C-D', P(200, lowerY), undefined, { points: drawn(run, g.nodes) })!;
    g = settle({ nodes: lower.nodes, edges: [...lower.edges, E(lower.junctionId, 'b', 'W', 't')] });
    return { ...g, top: upper.junctionId, bottom: lower.junctionId, lowerY };
  }

  it('let go on the run just beside it, or on the edge of its dot', () => {
    // Ring-pulled down from the upper tee and let go 15 px along the lower
    // run from the lower tee: the tee straight below, whose top face is free,
    // is what was meant. It used to get a third tee 20 px along, a jog into
    // it, and two dots touching.
    const g = parallel(60);
    for (const [at, under] of [[P(215, 90), {}], [P(185, 90), {}], [P(206, 90), { node: g.bottom }]] as const) {
      const plan = connected(drop(g, ring(g, g.top), at, under));
      expect(plan.to, JSON.stringify(at)).toMatchObject({ kind: 'tee', nodeId: g.bottom, face: 't' });
      const after = settle(commitDrop(plan, scene(g))!);
      expect(after.nodes.filter(isJunction)).toHaveLength(2);
      const line = after.edges.find(e => e.source === g.top && e.target === g.bottom)!;
      expect(drawn(line, after.nodes), JSON.stringify(at)).toEqual([P(200, 38), P(200, 82)]);
    }
    // Let go well along, the jog is what was aimed at.
    expect(connected(drop(g, ring(g, g.top), P(260, 90))).to).toMatchObject({ kind: 'split' });
  });

  it('however short the pull, the lower tee on runs a grid step or two apart', () => {
    // Twenty apart, the tees are closer than a pull counts; let go on the
    // lower tee's dot, it is aimed at.
    const g = parallel(20);
    const plan = connected(drop(g, ring(g, g.top), P(200, 52), { node: g.bottom }));
    expect(plan.to).toMatchObject({ kind: 'tee', nodeId: g.bottom, face: 't' });
    // Let go on the line beside it, short, it is still nothing.
    expect(drop(g, ring(g, g.top), P(212, 50))).toEqual({ kind: 'cancel', why: 'short' });
  });
});

describe('a tee pulled out of a line keeps off crossings', () => {
  it('goes in clear of where another pipe crosses, and of that pipe\'s tee beside it', () => {
    // M1 -> M2 along y = 650, a tee on it at x = 400 branched up to O; and
    // K1 -> K2 straight down x = 410, crossing it. A pull out of K1-K2 just
    // beside the crossing put its tee on the crossing, hid the crossing under
    // its dot, and ran its branch along the pipe five pixels off it.
    let g: G = {
      nodes: [sym('M1', 190, 620), sym('M2', 560, 620), sym('K1', 380, 380, ['b']), sym('K2', 380, 880, ['t']),
        { id: 'O', type: 'JUNCTION', position: P(395, 555), data: { componentType: 'JUNCTION', label: 'O' } }],
      edges: [E('M1', 'r', 'M2', 'l'), E('K1', 'b', 'K2', 't')],
    };
    const split = splitEdgeAt(g.nodes, g.edges, 'M1-M2', P(400, 650), undefined, { points: drawn(g.edges[0], g.nodes) })!;
    g = settle({ nodes: split.nodes, edges: [...split.edges, E(split.junctionId, 't', 'O', 'b')] });
    for (const at of [P(408, 655), P(410, 645), P(407, 647)]) {
      const plan = connected(drop(g, press(g, 'K1-K2', at), P(488, 615)));
      expect(plan.from.kind, JSON.stringify(at)).toBe('split');
      expect(Math.abs(plan.from.centre.y - 650), JSON.stringify(plan.from.centre)).toBeGreaterThanOrEqual(14);
      const after = settle(commitDrop(plan, scene(g))!);
      const made = after.nodes.find(n => isJunction(n) && n.id !== split.junctionId && !!junctionData(n).along)!;
      expect(centre(after, made.id)).toEqual(plan.from.centre);
    }
  });
});

describe('a line with no room for a tee is not split, and no tee already there moves', () => {
  /** The run with a tee at 200, its branch to C, and one `gap` further on, its branch to D. */
  function twoTees(gap: number) {
    const t = teed(200, { nodes: [...run().nodes, sym('C', 150, 200, ['t']), sym('D', 300, 200, ['t'])], edges: run().edges });
    const g1 = settle({ nodes: t.nodes, edges: [...t.edges, { ...E(t.tee, 'b', 'C', 't'), id: 'x1' }] });
    const down = g1.edges.find(e => e.source === t.tee && e.target === 'B')!;
    const split = splitEdgeAt(g1.nodes, g1.edges, down.id, P(200 + gap, 30), undefined, { points: drawn(down, g1.nodes) })!;
    const g = settle({ nodes: split.nodes, edges: [...split.edges, { ...E(split.junctionId, 'b', 'D', 't'), id: 'x2' }] });
    return { ...g, t1: t.tee, t2: split.junctionId, mid: g.edges.find(e => e.source === t.tee && e.target === split.junctionId)! };
  }

  it('refuses a pull out of the piece between two tees nearer than twice TEE_GAP', () => {
    for (const gap of [24, 30, 36]) {
      const g = twoTees(gap);
      expect(centre(g, g.t2), `gap ${gap}`).toEqual(P(200 + gap, 30));
      expect(drop(g, press(g, g.mid.id, P(200 + gap / 2, 31)), P(200 + gap / 2, -80)), `gap ${gap}`).toEqual({ kind: 'cancel', why: 'full' });
      // ...or a line let go on it.
      const withS = { ...g, nodes: [...g.nodes, sym('S', 170 + gap / 2, -150, ['b'])] };
      expect(drop(withS, port('S', 'b'), P(200 + gap / 2, 31)), `gap ${gap}`).toEqual({ kind: 'cancel', why: 'full' });
    }
  });

  it('with room, puts the tee where it showed and leaves both neighbours where they were', () => {
    for (const gap of [40, 44, 60]) {
      const g = twoTees(gap);
      const plan = connected(drop(g, press(g, g.mid.id, P(200 + gap / 2, 31)), P(200 + gap / 2, -80)));
      const after = settle(commitDrop(plan, scene(g))!);
      expect(centre(after, g.t1), `gap ${gap}`).toEqual(centre(g, g.t1));
      expect(centre(after, g.t2), `gap ${gap}`).toEqual(centre(g, g.t2));
      const made = after.nodes.find(n => isJunction(n) && junctionData(n).along && n.id !== g.t1 && n.id !== g.t2)!;
      expect(centre(after, made.id), `gap ${gap}`).toEqual(plan.from.centre);
    }
  });

  it('refuses a port that has a line with no room left on it beside a tee', () => {
    // A tee rides A-B at 370; B.l is at 400. A tee 30 px out from B.l would
    // sit on it, and nowhere on the 22 px left between them is 20 from it
    // and 14 from the port.
    const t = teed(370, { nodes: [...run().nodes, sym('S', 300, 200, ['t'])], edges: run().edges });
    expect(drop(t, port('S', 't'), P(400, 30), on('B', 'l'))).toEqual({ kind: 'cancel', why: 'full' });
    // With the tee further along, there is.
    const room = teed(330, { nodes: [...run().nodes, sym('S', 300, 200, ['t'])], edges: run().edges });
    expect(connected(drop(room, port('S', 't'), P(400, 30), on('B', 'l'))).to.centre).toEqual(P(370, 30));
  });

  it('puts no tee into a branch too short for one: there is nowhere on it a tee can sit', () => {
    // A 16 px branch from the tee at 200 down to V.t: shorter than the tee's
    // own clearance and the port's together. A tee put in anyway sat at its
    // middle, on top of both, and its halves hooked round it. (This used to
    // be the case that showed the tee it leaves staying put: nothing goes in
    // now for it to be put beside.)
    const t = teed(200, { nodes: [...run().nodes, sym('V', 170, 54, ['t']), sym('S', 300, 200)], edges: run().edges });
    const g = settle({ nodes: t.nodes, edges: [...t.edges, { ...E(t.tee, 'b', 'V', 't'), id: 'br' }] });
    expect(drawn(g.edges.find(e => e.id === 'br')!, g.nodes)).toEqual([P(200, 38), P(200, 54)]);
    expect(drop(g, port('S', 'l'), P(201, 46))).toEqual({ kind: 'cancel', why: 'full' });
  });

  it('puts no tee into a short line bent where a tee would sit, pulled from or tee\'d by the Junction tool alike', () => {
    // A tank's lid port with an open end let go 30 px up and to the left:
    // legs of 20 and 22, and no spot on it clear of the ends and the bend.
    // A tee put in went 4 px from the bend, and its halves hooked round it.
    const J: Node = { id: 'J', type: 'JUNCTION', position: P(480 - J_HALF, 300 - J_HALF), data: { componentType: 'JUNCTION', label: 'J' } };
    const g: G = { nodes: [sym('S', 480, 320, ['t']), J, sym('X', 700, 400, ['l'])], edges: [E('S', 't', 'J', 'r')] };
    expect(drawn(g.edges[0], g.nodes)).toEqual([P(510, 320), P(510, 300), P(488, 300)]);
    for (const at of [P(510, 312), P(510, 306), P(500, 300)]) {
      expect(drop(g, port('X', 'l'), at)).toEqual({ kind: 'cancel', why: 'full' });
      expect(splitEdgeAt(g.nodes, g.edges, 'S-J', at, undefined, { points: drawn(g.edges[0], g.nodes) })).toBeNull();
    }
  });

  it('refuses the piece between the tee a branch leaves and the first tee riding the branch, when there is no room', () => {
    // A branch up from a tee at (200,30) to X, with a tee riding it `gap` up.
    const bay = (gap: number) => {
      const t = teed(200, { nodes: [...run().nodes, sym('X', 170, -300, ['b']), sym('D', 300, -150, ['l'])], edges: run().edges });
      const g1 = settle({ nodes: t.nodes, edges: [...t.edges, { ...E(t.tee, 't', 'X', 'b'), id: 'br' }] });
      const br = g1.edges.find(e => e.id === 'br')!;
      const split = splitEdgeAt(g1.nodes, g1.edges, 'br', P(200, 30 - gap), undefined, { points: drawn(br, g1.nodes) })!;
      const g = settle({ nodes: split.nodes, edges: [...split.edges, { ...E(split.junctionId, 'r', 'D', 'l'), id: 'x2' }] });
      return { ...g, t0: t.tee, t1: split.junctionId, mid: g.edges.find(e => e.source === t.tee && e.target === split.junctionId)! };
    };
    // The branch keeps TEE_END_GAP from its tee's face, and TEE_GAP from the
    // riding tee: 48 between centres holds a third, 44 does not.
    const tight = bay(44);
    const at = P(200, (centre(tight, tight.t0).y + centre(tight, tight.t1).y) / 2);
    expect(drop(tight, press(tight, tight.mid.id, at), P(60, at.y))).toEqual({ kind: 'cancel', why: 'full' });
    const room = bay(50);
    const at2 = P(200, (centre(room, room.t0).y + centre(room, room.t1).y) / 2);
    const plan = connected(drop(room, press(room, room.mid.id, at2), P(60, at2.y)));
    const after = settle(commitDrop(plan, scene(room))!);
    expect(centre(after, room.t1)).toEqual(centre(room, room.t1));
  });
});

// ── g. Empty canvas ──────────────────────────────────────────────────────────

describe('empty canvas leaves an open end, straight when it nearly is', () => {
  it('puts the open end on the grid, facing back at the line', () => {
    const plan = connected(drop(run(), port('A', 'l'), P(-97, 107)));
    expect(plan.to).toMatchObject({ kind: 'open', face: 'r' });
    expect(plan.to.centre).toEqual(P(-100, 110));
  });

  it('puts it level with the port when that is within ALIGN_REACH and ahead of it', () => {
    expect(connected(drop(run(), port('A', 'l'), P(-97, 44))).to.centre).toEqual(P(-100, 30));
    expect(connected(drop(run(), port('A', 'l'), P(-97, 30 + ALIGN_REACH + 8))).to.centre).toEqual(P(-100, 60));
    // Behind the port -- through its own symbol -- it is left where it was let go.
    const g = { nodes: [sym('A', 0, 0)], edges: [] };
    expect(connected(drop(g, port('A', 'l'), P(103, 44))).to.centre).toEqual(P(100, 40));
  });

  it('a pull out of a line leaves its open end square across the line from its tee', () => {
    const g = run();
    const plan = connected(drop(g, press(g, 'A-B', P(154.6, 31)), P(157, 200)));
    expect(plan.to.centre).toEqual(P(154.6, 200));
    expect(plan.from.centre.x).toBeCloseTo(154.6, 9);
  });
});

// ── Making it ────────────────────────────────────────────────────────────────

describe('commitDrop', () => {
  it('draws one new line, with a fresh id, from where the drag began to where it landed', () => {
    const g: G = { nodes: [sym('A', 0, 0), sym('C', 200, 0)], edges: [{ ...E('A', 'l', 'C', 'r'), id: 'A-C' }] };
    const plan = connected(drop(g, port('A', 'r'), P(200, 30), on('C', 'l')));
    const made = commitDrop(plan, scene(g))!;
    expect(made.lineId).toBe('A-C-2');
    expect(made.edges.find(e => e.id === made.lineId)).toMatchObject({ source: 'A', sourceHandle: 'r', target: 'C', targetHandle: 'l', data: {} });
    expect(commitDrop({ kind: 'cancel', why: 'own' }, scene(g))).toBeNull();
  });

  it('refuses a plan the drawing no longer allows: a port that has since been given a line', () => {
    const g: G = { nodes: [sym('A', 0, 0), sym('C', 200, 0), sym('Z', 200, 200)], edges: [] };
    const plan = connected(drop(g, port('A', 'r'), P(200, 30), on('C', 'l')));
    expect(commitDrop(plan, scene({ ...g, edges: [E('Z', 'r', 'C', 'l')] }))).toBeNull();
  });

  // resolveDrop never hands over these two -- its own-pipe rules cancel them
  // first -- so the plans are made by hand. commitDrop is the last thing
  // between a plan and the drawing, and a symbol joined to itself must not
  // get through it whatever made the plan.
  const at = (nodes: Node[], nodeId: string, handle: string): PlanEnd => {
    const end = endOf(nodes.find(n => n.id === nodeId)!, handle)!;
    return { kind: 'port', nodeId, handle, centre: P(end.x, end.y), end };
  };

  it('refuses a plan whose two ends are on one symbol, however it was made', () => {
    const nodes = [sym('C', 200, 0, ['l', 'r', 't', 'b']), sym('D', 400, 0)];
    const g: G = { nodes, edges: [] };
    const plan: DropPlan = { kind: 'connect', landed: 'port', from: at(nodes, 'C', 'r'), to: at(nodes, 'C', 'l') };
    expect(commitDrop(plan, scene(g))).toBeNull();
    // A plan to another symbol is made, so the refusal is the self-join's.
    expect(commitDrop({ ...plan, to: at(nodes, 'D', 'l') }, scene(g))).not.toBeNull();
  });

  it('refuses to carry an end onto the symbol at the end that stays, from either end', () => {
    const nodes = [sym('A', 0, 0, ['l', 'r', 't', 'b']), sym('B', 400, 0, ['l', 'r', 't', 'b']), sym('C', 300, 200)];
    const g: G = { nodes, edges: [E('A', 'r', 'B', 'l')] };
    const target: DropPlan = {
      kind: 'connect', landed: 'port', from: at(nodes, 'A', 'r'), to: at(nodes, 'A', 'b'),
      reconnect: { edgeId: 'A-B', moving: 'target' },
    };
    expect(commitDrop(target, scene(g))).toBeNull();
    const source: DropPlan = {
      kind: 'connect', landed: 'port', from: at(nodes, 'B', 'l'), to: at(nodes, 'B', 't'),
      reconnect: { edgeId: 'A-B', moving: 'source' },
    };
    expect(commitDrop(source, scene(g))).toBeNull();
    // Carried to a third symbol, the same plan is made.
    expect(commitDrop({ ...target, to: at(nodes, 'C', 'l') }, scene(g))!.edges[0])
      .toMatchObject({ source: 'A', target: 'C', targetHandle: 'l' });
  });

  it('puts every new tee in with its run, where the plan said it would land', () => {
    const g: G = { nodes: [...run().nodes, sym('C', 0, 170), sym('D', 400, 170)], edges: [...run().edges, E('C', 'r', 'D', 'l')] };
    const plan = connected(drop(g, press(g, 'A-B', P(200, 31)), P(212, 199)));
    const made = commitDrop(plan, scene(g))!;
    const line = made.edges.find(e => e.id === made.lineId)!;
    for (const [id, end] of [[line.source, plan.from], [line.target, plan.to]] as const) {
      const tee = made.nodes.find(n => n.id === id)!;
      expect(junctionData(tee).along).toBeTruthy();
      expect(centre(made, id)).toEqual(end.centre);
    }
    expect(line.sourceHandle).toBe('b');
    expect(line.targetHandle).toBe('t');
    expect(pipeOf(made.nodes, made.edges, line)).toBeNull();
  });

  it('puts an open end on the page it is drawn from', () => {
    const g: G = { nodes: [sym('A', 0, 0, ['l', 'r'], 60, 60, 'GSE')], edges: [] };
    const made = commitDrop(connected(drop(g, port('A', 'r'), P(200, 30))), scene(g))!;
    expect(made.nodes.find(n => isJunction(n))!.data).toMatchObject({ page: 'GSE' });
    const here = commitDrop(connected(drop(g, port('A', 'r'), P(200, 30))), scene(g, { page: 'Main' }))!;
    expect(here.nodes.find(n => isJunction(n))!.data).toMatchObject({ page: 'Main' });
  });

  it('an open end carried on to a port is the line it ends, joined there: one line, and no dot', () => {
    // It used to stay, riding the run the two lines made through it: a
    // filled dot in the middle of a straight line with nothing branching.
    const g0: G = { nodes: [sym('A', 0, 0), sym('B', 400, 0)], edges: [] };
    const open = commitDrop(connected(drop(g0, port('A', 'r'), P(200, 30))), scene(g0))!;
    const g = settle(open);
    const j = g.nodes.find(n => isJunction(n))!;
    expect(junctionData(j).along).toBeUndefined();
    const on2 = commitDrop(connected(drop(g, ring(g, j.id), P(400, 30), on('B', 'l'))), scene(g))!;
    expect(on2.nodes.filter(isJunction)).toEqual([]);
    expect(on2.edges).toEqual([expect.objectContaining({ id: open.lineId, source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l' })]);
    expect(on2.lineId).toBe(open.lineId);
  });
});

// ── Open ends ────────────────────────────────────────────────────────────────

describe('a line drawn on out of an open end, or let go on one, is that line going on', () => {
  const pipe = (bore: number) => ({ lineType: 'pipe', params: { bore: { value: bore, unit: 'in', source: 'verified' } } });
  /** A.r (60,30) out to an open end at (200,30), the line given `data`. */
  function loose(data: Record<string, unknown> = pipe(0.5), g0: G = { nodes: [sym('A', 0, 0)], edges: [] }) {
    const made = commitDrop(connected(drop(g0, port('A', 'r'), P(200, 30))), scene(g0))!;
    const g = settle(made);
    const open = g.nodes.find(n => isJunction(n) && !g0.nodes.includes(n))!.id;
    return { nodes: g.nodes, edges: g.edges.map(e => (e.id === made.lineId ? { ...e, data } : e)), open, line: made.lineId };
  }
  const junctions = (g: G) => g.nodes.filter(isJunction);
  const linesOn = (g: G, id: string) => g.edges.filter(e => e.source === id || e.target === id);
  /** A dot with two lines and nothing branching from it: what a line going on must never leave. */
  const dots = (g: G) => junctions(g).filter(n => linesOn(g, n.id).length === 2).map(n => n.id);

  it('pulled on straight ahead, the line is longer: its id and its data, and an open end where the pull let go', () => {
    const g = loose();
    const after = settle(commitDrop(connected(drop(g, ring(g, g.open), P(260, 32))), scene(g))!);
    expect(after.edges).toEqual([expect.objectContaining({ id: g.line, source: 'A', sourceHandle: 'r', data: pipe(0.5) })]);
    expect(junctions(after)).toHaveLength(1);
    expect(after.nodes.some(n => n.id === g.open)).toBe(false);
    expect(centre(after, after.edges[0].target)).toEqual(P(260, 30));
    expect(drawn(after.edges[0], after.nodes)).toEqual([P(60, 30), P(252, 30)]);
  });

  it('pulled round a corner, the line turns where the open end was', () => {
    const g = loose();
    const after = settle(commitDrop(connected(drop(g, ring(g, g.open), P(203, 120))), scene(g))!);
    expect(after.edges).toHaveLength(1);
    expect(dots(after)).toEqual([]);
    expect(drawn(after.edges[0], after.nodes)).toEqual([P(60, 30), P(200, 30), P(200, 112)]);
  });

  it('drawn by hand, keeps its corners, and bends where the open end was', () => {
    // Round a dip on its way to the open end, then pulled on down from it.
    const dip = [P(100, 30), P(100, 80), P(150, 80), P(150, 30)];
    const g = loose({ ...pipe(0.5), waypoints: dip });
    const down = commitDrop(connected(drop(g, ring(g, g.open), P(200, 150))), scene(g))!;
    expect((down.edges[0].data as { waypoints?: Pt[] }).waypoints).toEqual([...dip, P(200, 30)]);
    expect(drawn(down.edges[0], down.nodes)).toEqual([P(60, 30), ...dip, P(200, 30), P(200, 142)]);
    // Straight on, the open end is no corner: the line runs on through it.
    const on2 = commitDrop(connected(drop(g, ring(g, g.open), P(300, 30))), scene(g))!;
    expect((on2.edges[0].data as { waypoints?: Pt[] }).waypoints).toEqual(dip);
    expect(drawn(on2.edges[0], on2.nodes)).toEqual([P(60, 30), ...dip, P(292, 30)]);
    // The same line stored the other way, out of the open end back to A: the
    // bend goes on at its start.
    const pid = [...dip].reverse();
    const back: G = {
      nodes: g.nodes,
      edges: g.edges.map(e => ({ ...e, source: e.target, sourceHandle: e.targetHandle, target: e.source, targetHandle: e.sourceHandle, data: { ...pipe(0.5), waypoints: pid } })),
    };
    const up = commitDrop(connected(drop(back, ring(back, g.open), P(200, 150))), scene(back))!;
    expect(up.edges[0]).toMatchObject({ target: 'A', targetHandle: 'r', data: { waypoints: [P(200, 30), ...pid] } });
    expect(drawn(up.edges[0], up.nodes)).toEqual([P(200, 142), P(200, 30), ...pid, P(60, 30)]);
  });

  it('let go on a line, the line it ends is a branch of the tee put in there', () => {
    const g0 = loose();
    const g = { ...g0, nodes: [...g0.nodes, sym('C', 0, 200), sym('D', 400, 200)], edges: [...g0.edges, E('C', 'r', 'D', 'l')] };
    const after = settle(commitDrop(connected(drop(g, ring(g, g.open), P(200, 229))), scene(g))!);
    expect(after.nodes.some(n => n.id === g.open)).toBe(false);
    const branch = after.edges.find(e => e.id === g.line)!;
    expect(branch).toMatchObject({ source: 'A', sourceHandle: 'r', targetHandle: 't' });
    expect(linesOn(after, branch.target)).toHaveLength(3);
    expect(dots(after)).toEqual([]);
  });

  it('a port dragged onto an open end takes the line it ends', () => {
    const g0 = loose();
    const g = { ...g0, nodes: [...g0.nodes, sym('C', 300, 150, ['t'])] };
    const plan = connected(drop(g, port('C', 't'), centre(g, g.open), { node: g.open }));
    expect(plan.to).toMatchObject({ kind: 'tee', nodeId: g.open });
    const made = commitDrop(plan, scene(g))!;
    expect(made.lineId).toBe(g.line);
    expect(junctions(made)).toEqual([]);
    expect(made.edges).toEqual([expect.objectContaining({ id: g.line, source: 'A', target: 'C', targetHandle: 't', data: pipe(0.5) })]);
  });

  it('two open ends joined are one line, unless the two are different pipe, when the junction between them stays', () => {
    const both = (boreB: number) => {
      const a = loose(pipe(0.5), { nodes: [sym('A', 0, 0), sym('B', 400, 0)], edges: [] });
      const b = commitDrop(connected(drop(a, port('B', 'l'), P(260, 30))), scene(a))!;
      const g = settle({ nodes: b.nodes, edges: b.edges.map(e => (e.id === b.lineId ? { ...e, data: pipe(boreB) } : e)) });
      const other = junctions(g).find(n => n.id !== a.open)!.id;
      return { ...g, one: a.open, other, plan: connected(drop(g, ring(g, a.open), centre(g, other), { node: other })) };
    };
    const same = both(0.5);
    const joined = settle(commitDrop(same.plan, scene(same))!);
    expect(junctions(joined)).toEqual([]);
    expect(joined.edges).toEqual([expect.objectContaining({ source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: pipe(0.5) })]);
    // A half inch line and a quarter inch one: a reducer, kept.
    const reducer = both(0.25);
    const kept = settle(commitDrop(reducer.plan, scene(reducer))!);
    expect(junctions(kept).map(n => n.id)).toEqual([reducer.other]);
    expect(linesOn(kept, reducer.other).map(e => (e.source === reducer.other ? e.target : e.source)).sort()).toEqual(['A', 'B']);
  });

  it("a line's end carried onto an open end, and the line the open end ends, are one line", () => {
    const g0 = loose();
    const g = { ...g0, nodes: [...g0.nodes, sym('X', 0, 200), sym('Y', 400, 200)], edges: [...g0.edges, E('X', 'r', 'Y', 'l', pipe(0.5))] };
    const plan = connected(drop(g, { kind: 'reconnect', edgeId: 'X-Y', moving: 'target' }, centre(g, g.open), { node: g.open }));
    const made = settle(commitDrop(plan, scene(g))!);
    expect(junctions(made)).toEqual([]);
    expect(made.edges).toHaveLength(1);
    expect([made.edges[0].source, made.edges[0].target].sort()).toEqual(['A', 'X']);
  });

  it('never joins two open ends whose lines leave one symbol: that is the symbol joined to itself', () => {
    const g0 = loose(pipe(0.5), { nodes: [sym('A', 0, 0, ['r', 'b'])], edges: [] });
    const down = commitDrop(connected(drop(g0, port('A', 'b'), P(30, 200))), scene(g0))!;
    const g = settle(down);
    const other = junctions(g).find(n => n.id !== g0.open)!.id;
    const plan = connected(drop(g, ring(g, g0.open), centre(g, other), { node: other }));
    expect(commitDrop(plan, scene(g))).toBeNull();
  });
});

// ── A part from the palette ──────────────────────────────────────────────────

describe('a part from the palette let go on a line', () => {
  /** The lines as the page draws them: what `lineAt` hit-tests. */
  const page = (g: G) => g.edges.map(e => ({ id: e.id, d: pointsToPath(drawn(e, g.nodes)) }));
  const part = (id: string, type: string): Node => ({ id, type, position: P(0, 0), data: { componentType: type, label: id } });

  it('goes into the line on the grid, not where the pointer happened to be', () => {
    // At zoom 0.7 a pointer's place on the drawing is never a whole pixel.
    const g = run();
    for (const x of [183.7, 206.4, 241.43]) {
      const made = partOnLine(g, page(g), P(x, 31.6), part('V', 'SOL'), { endOf })!;
      const v = made.nodes.find(n => n.id === 'V')!;
      const { w, h } = nodeSize(v);
      expect(P(v.position.x + w / 2, v.position.y + h / 2), String(x)).toEqual(P(Math.round(x / 10) * 10, 30));
      expect(made.edges.map(e => [e.source, e.target])).toEqual([['A', 'V'], ['V', 'B']]);
    }
  });

  it('taps the line with a tee on the grid, the instrument on its third face', () => {
    const g = run();
    for (const x of [183.7, 206.4, 241.43]) {
      const made = partOnLine(g, page(g), P(x, 42.2), part('P1', 'PT'), { endOf })!;
      const tee = made.nodes.find(n => isJunction(n))!;
      expect(centre(made, tee.id), String(x)).toEqual(P(Math.round(x / 10) * 10, 30));
      expect(made.edges.find(e => e.source === 'P1')).toMatchObject({ sourceHandle: 'b', target: tee.id, targetHandle: 'b' });
    }
  });

  it('is nothing to do with a line when it is let go clear of every line, or is not a part that goes on one', () => {
    const g = run();
    expect(partOnLine(g, page(g), P(200, 80), part('V', 'SOL'), { endOf })).toBeNull();
    expect(partOnLine(g, page(g), P(200, 31), part('T1', 'TANK'), { endOf })).toBeNull();
  });
});

// ── Carrying an end ──────────────────────────────────────────────────────────

describe('what React Flow may join by itself, and the line it makes', () => {
  it('joins two free ports of two different symbols, and nothing else', () => {
    const g = run();
    const c = (s: string, sh: string, t: string, th: string) => ({ source: s, sourceHandle: sh, target: t, targetHandle: th });
    const nodes = [...g.nodes, sym('C', 0, 200), { id: 'J', type: 'JUNCTION', position: P(0, 0), data: {} } as Node,
      { id: 'K', type: 'MAN', position: P(0, 0), data: { componentType: 'JUNCTION' } } as Node];
    expect(canJoin(c('C', 'r', 'B', 'r'), nodes, g.edges)).toBe(true);
    expect(canJoin(c('C', 'l', 'C', 'r'), nodes, g.edges)).toBe(false);          // itself
    expect(canJoin(c('C', 'r', 'B', 'l'), nodes, g.edges)).toBe(false);          // B.l has A-B on it
    expect(canJoin(c('C', 'r', 'J', 'l'), nodes, g.edges)).toBe(false);          // a tee by its node type
    expect(canJoin(c('C', 'r', 'K', 'l'), nodes, g.edges)).toBe(false);          // a tee by its component type
    expect(canJoin(c('C', 'r', 'X', 'l'), nodes, g.edges)).toBe(false);          // nothing there
  });

  it('names the line it makes as every other line is named, never one already taken', () => {
    const joined = connectLine([E('C', 'r', 'B', 'r'), { ...E('C', 'r', 'B', 'r'), id: 'C-B-2' }],
      { source: 'C', sourceHandle: 'l', target: 'B', targetHandle: 't' });
    expect(joined.map(e => e.id)).toEqual(['C-B', 'C-B-2', 'C-B-3']);
    expect(joined[2]).toMatchObject({ type: 'smoothstep', data: {}, sourceHandle: 'l', targetHandle: 't' });
  });
});

describe("carrying a line's end", () => {
  const bay = (): G => ({
    nodes: [sym('A', 0, 0), sym('B', 400, 0), sym('C', 300, 200), sym('Z', 0, 300), sym('W', 500, 300)],
    edges: [
      E('A', 'r', 'B', 'l', {
        params: { length: { value: 1.2, unit: 'm', source: 'measured' } }, segments: [{ id: 's1' }], sketch: { legs: [] },
        waypoints: [P(230, 30)], viaRun: true, offset: 6,
      }),
      E('Z', 'r', 'W', 'l'),
    ],
  });
  const carry = (moving: 'source' | 'target' = 'target'): DropSource => ({ kind: 'reconnect', edgeId: 'A-B', moving });

  it('re-points the same line to a free port, keeping its id and data and dropping its corners', () => {
    const g = bay();
    const plan = connected(drop(g, carry(), P(300, 230), on('C', 'l')));
    expect(plan.reconnect).toEqual({ edgeId: 'A-B', moving: 'target' });
    const made = commitDrop(plan, scene(g))!;
    expect(made.lineId).toBe('A-B');
    expect(made.edges).toHaveLength(2);
    const e = made.edges.find(x => x.id === 'A-B')!;
    expect(e).toMatchObject({ source: 'A', sourceHandle: 'r', target: 'C', targetHandle: 'l' });
    expect(e.data).toEqual({ params: { length: { value: 1.2, unit: 'm', source: 'measured' } }, segments: [{ id: 's1' }], sketch: { legs: [] } });
  });

  it('carries the source end as readily, and may take another port of the symbol it leaves', () => {
    const b = bay();
    const g = { ...b, nodes: [sym('A', 0, 0, ['r', 'b']), ...b.nodes.slice(1)] };
    const made = commitDrop(connected(drop(g, carry('source'), P(30, 60), on('A', 'b'))), scene(g))!;
    const e = made.edges.find(x => x.id === 'A-B')!;
    expect(e).toMatchObject({ source: 'A', sourceHandle: 'b', target: 'B', targetHandle: 'l' });
    // The corners were drawn out of A.r; kept, they would carry the line
    // back round to where its source end used to be.
    expect(e.data).toEqual({ params: { length: { value: 1.2, unit: 'm', source: 'measured' } }, segments: [{ id: 's1' }], sketch: { legs: [] } });
  });

  it('let go on a port that has a line, tees that line and ends there', () => {
    const g = bay();
    const plan = connected(drop(g, carry(), P(500, 330), on('W', 'l')));
    expect(plan.landed).toBe('occupied');
    const made = commitDrop(plan, scene(g))!;
    const e = made.edges.find(x => x.id === 'A-B')!;
    expect(isJunction(made.nodes.find(n => n.id === e.target))).toBe(true);
    expect(made.edges.filter(x => x.source === 'W' || x.target === 'W')).toHaveLength(1);
  });

  it('carries an end to the next port along, however near: a manifold outlet 26 px on, a tank lid port 20', () => {
    AT.M = { o1: { x: 0, y: 17, side: Position.Left }, o2: { x: 0, y: 43, side: Position.Left } };
    AT.K = { t1: { x: 20, y: 0, side: Position.Top }, t2: { x: 40, y: 0, side: Position.Top } };
    const g: G = {
      nodes: [sym('A', 0, 0), sym('M', 300, 0, ['o1', 'o2']), sym('K', 480, 200, ['t1', 't2']), sym('Q', 490, 0, ['b']), sym('Z', 0, 300)],
      edges: [E('A', 'r', 'M', 'o1', { params: { bore: 6 } }), E('Q', 'b', 'K', 't1')],
    };
    const outlet = connected(drop(g, { kind: 'reconnect', edgeId: 'A-M', moving: 'target' }, P(300, 43), on('M', 'o2')));
    expect(outlet.to).toMatchObject({ kind: 'port', nodeId: 'M', handle: 'o2' });
    expect(commitDrop(outlet, scene(g))!.edges.find(e => e.id === 'A-M'))
      .toMatchObject({ source: 'A', target: 'M', targetHandle: 'o2', data: { params: { bore: 6 } } });
    const lid = connected(drop(g, { kind: 'reconnect', edgeId: 'Q-K', moving: 'target' }, P(520, 200), on('K', 't2')));
    expect(lid.to).toMatchObject({ kind: 'port', nodeId: 'K', handle: 't2' });
    // Only onto a free port: the same carry let go on the body, or on an
    // outlet that has a line, is still a change of mind.
    expect(drop(g, { kind: 'reconnect', edgeId: 'A-M', moving: 'target' }, P(310, 43), { node: 'M' })).toEqual({ kind: 'cancel', why: 'short' });
    const busy = { ...g, edges: [...g.edges, E('Z', 'r', 'M', 'o2')] };
    expect(drop(busy, { kind: 'reconnect', edgeId: 'A-M', moving: 'target' }, P(300, 43), on('M', 'o2'))).toEqual({ kind: 'cancel', why: 'short' });
  });

  it("never carries a branch's end onto its own tee's run, nor an end onto a pipe out of the symbol that stays", () => {
    // A branch br from a tee on A-B at x=200 down to V.
    const t = teed(200);
    const g = settle({ nodes: [...t.nodes, sym('V', 170, 200, ['t'])], edges: [...t.edges, { ...E(t.tee, 'b', 'V', 't'), id: 'br' }] });
    const br = (): DropSource => ({ kind: 'reconnect', edgeId: 'br', moving: 'target' });
    // Two lines straight between the same two tees: a loop with nothing in it.
    expect(drop(g, br(), P(100, 32))).toEqual({ kind: 'cancel', why: 'own' });
    // As a pull out of the tee's ring let go there is.
    expect(drop(g, ring(g, t.tee), P(100, 32))).toEqual({ kind: 'cancel', why: 'own' });
    // Nor to A's free port: A would be joined to itself through the tee.
    const A2 = { ...g, nodes: g.nodes.map(n => (n.id === 'A' ? sym('A', 0, 0, ['r', 'b']) : n)) };
    expect(drop(A2, br(), P(30, 60), on('A', 'b'))).toEqual({ kind: 'cancel', why: 'own' });
    // V, the symbol the branch's end is leaving, may still take it on another port.
    const V2 = { ...g, nodes: g.nodes.map(n => (n.id === 'V' ? sym('V', 170, 200, ['t', 'r']) : n)) };
    expect(connected(drop(V2, br(), P(230, 230), on('V', 'r'))).to).toMatchObject({ kind: 'port', nodeId: 'V', handle: 'r' });

    // A.r -> B.l and A.b -> W.l: B's end carried into the line to W would
    // tee A's two ports together.
    const h: G = {
      nodes: [sym('A', 0, 0, ['r', 'b']), sym('B', 400, 0), sym('W', 300, 200, ['l', 'r'])],
      edges: [E('A', 'r', 'B', 'l'), E('A', 'b', 'W', 'l')],
    };
    const onAW = nearestOnPolyline(drawn(h.edges[1], h.nodes), P(200, 230))!.point;
    expect(drop(h, carry(), P(onAW.x, onAW.y + 1))).toEqual({ kind: 'cancel', why: 'own' });
    // W's other port is a second line between A and W, which is allowed.
    expect(connected(drop(h, carry(), P(360, 230), on('W', 'r'))).to).toMatchObject({ kind: 'port', nodeId: 'W', handle: 'r' });
  });

  it('let go on nothing, on the fixed end, back on its own port or on its own pipe, leaves the line as it was', () => {
    const g = bay();
    expect(drop(g, carry(), P(250, 150))).toEqual({ kind: 'cancel', why: 'nothing' });
    expect(drop(g, carry(), P(30, 40), { node: 'A' })).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, carry(), P(400, 50), on('B', 'l'))).toEqual({ kind: 'cancel', why: 'short' });
    expect(drop(g, carry(), P(430, 30), on('B', 'l'))).toEqual({ kind: 'cancel', why: 'own' });
    expect(drop(g, carry(), P(150, 31))).toEqual({ kind: 'cancel', why: 'own' });
  });

  it("the end being carried is found from the end React Flow drags from, or else from the handle type it reports", () => {
    const e = E('A', 'r', 'B', 'l');
    expect(reconnectMoving(e, 'target', { nodeId: 'A', handle: 'r' })).toBe('target');
    expect(reconnectMoving(e, 'source', { nodeId: 'B', handle: 'l' })).toBe('source');
    expect(reconnectMoving(e, 'source')).toBe('target');
    expect(reconnectMoving(e, 'target')).toBe('source');
  });

  it('reconnectLine re-points one line and keeps everything else about it', () => {
    const g = bay();
    const out = reconnectLine(g.edges, 'A-B', { source: 'A', sourceHandle: 'r', target: 'C', targetHandle: 'l' });
    expect(out[1]).toBe(g.edges[1]);
    expect(out[0]).toMatchObject({ id: 'A-B', target: 'C', targetHandle: 'l' });
    expect((out[0].data as Record<string, unknown>).waypoints).toBeUndefined();
  });
});

// ── What React Flow is handed ────────────────────────────────────────────────

describe('reconnectableEnds', () => {
  it("offers only a line's ends at a symbol's port, and hands back the same objects when nothing changes", () => {
    const t = teed(200);
    const g = { nodes: [...t.nodes, sym('C', 170, 200, ['t'])], edges: [...t.edges, E(t.tee, 'b', 'C', 't'), E('A', 'l', 'B', 'r')] };
    const plain = { nodes: run().nodes, edges: run().edges };
    expect(reconnectableEnds(plain.nodes, plain.edges)).toBe(plain.edges);
    const out = reconnectableEnds(g.nodes, g.edges);
    const by = (s: string, t2: string) => out.find(e => e.source === s && e.target === t2)!;
    expect(by('A', t.tee).reconnectable).toBe('source');
    expect(by(t.tee, 'B').reconnectable).toBe('target');
    expect(by(t.tee, 'C').reconnectable).toBe('target');
    expect(by('A', 'B')).toBe(g.edges[g.edges.length - 1]);
    // Asked again with the same lines, the same objects.
    const again = reconnectableEnds(g.nodes, g.edges);
    out.forEach((e, i) => expect(again[i]).toBe(e));
    // Between two tees, neither end.
    const j: Node = { id: 'J2', type: 'JUNCTION', position: { x: 0, y: 300 }, data: { componentType: 'JUNCTION' } };
    expect(reconnectableEnds([...g.nodes, j], [E(t.tee, 't', 'J2', 'b')])[0].reconnectable).toBe(false);
  });

  it('takes a mark off a line between two symbols that brought one with it, which would hold one end fast', () => {
    // A tee deleted through React Flow's own lines heals a line from the half
    // that was marked 'source'.
    const stray = { ...E('A', 'r', 'B', 'l'), reconnectable: 'source' as const };
    const [out] = reconnectableEnds(run().nodes, [stray]);
    expect('reconnectable' in out).toBe(false);
    expect(out).toEqual(E('A', 'r', 'B', 'l'));
    expect(reconnectableEnds(run().nodes, [stray])[0]).toBe(out);
  });

  it('plainLine takes the mark off, and hands back a line without one as it is', () => {
    const e = E('A', 'r', 'B', 'l');
    expect(plainLine(e)).toBe(e);
    expect(plainLine({ ...e, reconnectable: 'target' })).toEqual(e);
  });
});

describe('the lines and the pointer, as the designer hands them over', () => {
  it('finds the drawn line within LINE_REACH on screen, at any zoom', () => {
    const lines = [{ id: 'L', points: [P(0, 0), P(100, 0)] }];
    expect(lineUnder(lines, P(50, 13))?.id).toBe('L');
    expect(lineUnder(lines, P(50, 15))).toBeNull();
    expect(lineUnder(lines, P(50, 25), 0.5)?.at).toEqual(P(50, 0));
    expect(lineUnder(lines, P(50, 8), 2)).toBeNull();
  });

  it('reads where a mouse or a touch let go', () => {
    expect(clientOf({ clientX: 3, clientY: 4 })).toEqual(P(3, 4));
    expect(clientOf({ changedTouches: [{ clientX: 5, clientY: 6 }] } as unknown as TouchEvent)).toEqual(P(5, 6));
  });
});

// ── Whatever is let go wherever ──────────────────────────────────────────────

describe('whatever is let go wherever, the drawing stays a drawing', () => {
  /** A deterministic generator, so a failure names its case. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }

  it('never joins a symbol to itself, stacks two lines on a port, repeats a line id, or loops a pipe back on itself', () => {
    const rand = rng(20260923);
    let made = 0, cancelled = 0;
    for (let trial = 0; trial < 60; trial++) {
      // A few symbols on a grid, a few lines, a few tees on them.
      const nodes: Node[] = [];
      for (let i = 0; i < 5; i++) nodes.push(sym(`S${trial}_${i}`, 140 * (i % 3), 160 * Math.floor(i / 3), ['l', 'r', 't', 'b']));
      let g: G = { nodes, edges: [] };
      const pairs: [number, string, number, string][] = [[0, 'r', 1, 'l'], [1, 'r', 2, 'l'], [3, 'r', 4, 'l'], [0, 'b', 3, 't']];
      for (const [a, ha, b, hb] of pairs) if (rand() < 0.8) g.edges.push(E(nodes[a].id, ha, nodes[b].id, hb));
      for (const e of [...g.edges]) {
        if (rand() < 0.5) continue;
        const pts = drawn(e, g.nodes);
        const mid = nearestOnPolyline(pts, P((pts[0].x + pts[pts.length - 1].x) / 2, (pts[0].y + pts[pts.length - 1].y) / 2))!.point;
        const split = splitEdgeAt(g.nodes, g.edges, e.id, mid, undefined, { points: pts });
        if (split) g = settle(split);
      }
      for (let k = 0; k < 8; k++) {
        const sources: DropSource[] = [
          ...g.nodes.filter(n => !isJunction(n)).flatMap(n => PORTS[n.id].map(h => port(n.id, h))),
          ...g.nodes.filter(isJunction).map(n => ring(g, n.id)),
          ...g.edges.map(e => { const pts = drawn(e, g.nodes); return press(g, e.id, pts[Math.floor(rand() * pts.length)]); }),
        ];
        const source = sources[Math.floor(rand() * sources.length)];
        const at = P(-60 + rand() * 440, -60 + rand() * 360);
        // What the page would say is under the pointer there.
        const under: Under = {};
        for (const n of g.nodes) {
          if (isJunction(n)) { if (Math.hypot(at.x - centre(g, n.id).x, at.y - centre(g, n.id).y) <= 12) under.node = n.id; continue; }
          for (const h of PORTS[n.id]) { const p = endOf(n, h)!; if (Math.abs(p.x - at.x) <= 3 && Math.abs(p.y - at.y) <= 3) under.handle = { nodeId: n.id, handleId: h }; }
          const b = { x: n.position.x, y: n.position.y };
          if (!under.node && at.x >= b.x && at.x <= b.x + 60 && at.y >= b.y && at.y <= b.y + 60) under.node = n.id;
        }
        if (under.handle) under.node = under.handle.nodeId;
        const plan = drop(g, source, at, under);
        const result = commitDrop(plan, scene(g));
        if (!result) { cancelled++; continue; }
        made++;
        const next = settle(result);
        const label = `trial ${trial} drop ${k}: ${JSON.stringify(source).slice(0, 80)} at ${at.x.toFixed(1)},${at.y.toFixed(1)}`;
        expect(next.edges.filter(e => e.source === e.target), label).toEqual([]);
        expect(new Set(next.edges.map(e => e.id)).size, label).toBe(next.edges.length);
        const onPort = new Map<string, number>();
        for (const e of next.edges) for (const [id, h] of [[e.source, e.sourceHandle], [e.target, e.targetHandle]] as const) {
          if (isJunction(next.nodes.find(n => n.id === id))) continue;
          onPort.set(`${id}.${h}`, (onPort.get(`${id}.${h}`) ?? 0) + 1);
        }
        expect([...onPort].filter(([, c]) => c > 1), label).toEqual([]);
        // A line drawn on out of an open end, or let go on one, is that line
        // going on: no junction that had one line is left with two, a dot
        // on a line with nothing branching from it.
        const degree = (h: G, id: string) => h.edges.filter(e => e.source === id || e.target === id).length;
        expect(next.nodes.filter(n => isJunction(n) && degree(next, n.id) === 2 && degree(g, n.id) < 2).map(n => n.id), label).toEqual([]);
        // The new line joins two things that were not already one pipe.
        const line = result.edges.find(e => e.id === result.lineId)!;
        const pipe = pipeOf(result.nodes, result.edges, line);
        if (pipe) expect(pipe.a.nodeId === pipe.b.nodeId && pipe.a.handle === pipe.b.handle, label).toBe(false);
        g = next;
      }
    }
    expect(made).toBeGreaterThan(100);
    expect(cancelled).toBeGreaterThan(20);
  }, SWEEP_MS);
});

// The corners a line is drawn with survive a pull out of it (its pipe keeps
// its shape), which a split of a hand-routed line has always promised.
describe('a pull out of a hand-routed line', () => {
  it('keeps the line where it is drawn', () => {
    const g0 = run();
    const plain = drawn(g0.edges[0], g0.nodes);
    const hand = { ...g0.edges[0], data: { waypoints: waypointsOf(dragSegment(plain, 0, P(0, 60))) } };
    const g: G = { nodes: [...g0.nodes, sym('S', 170, 250, ['t'])], edges: [hand] };
    const before = drawn(hand, g.nodes);
    const made = settle(commitDrop(connected(drop(g, press(g, 'A-B', P(200, 91)), P(200, 250), on('S', 't'))), scene(g))!);
    const halves = made.edges.filter(e => e.target !== 'S');
    const flat = halves.flatMap(e => drawn(e, made.nodes));
    for (const p of before.slice(1, -1)) expect(flat.some(q => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6)).toBe(true);
  });
});
