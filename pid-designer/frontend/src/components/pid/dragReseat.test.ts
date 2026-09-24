// A drag as the canvas runs it: every tick React Flow's position change goes
// through `applyMoves`, and the reseat effect settles what that leaves --
// told of the drag (`dragging`: where the tees were when it began, and what
// it picks up) -- and letting go settles the drawing once more without it.
//
// What a drag leaves must not depend on the way it went: the same move made
// slowly and made at once gives one drawing, and whatever a drag only passes
// over is as it was.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import { J_END, centreOfJunction, dragging, isJunction, junctionEnd, reseatJunctions } from './junctions';
import type { Dragging, EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { applyMoves, followCorners } from './canvasEdits';
import { obstacleGrid, obstaclesByPage } from './routeGrid';
import { drawnRoute, inTheWay, routeOfLine } from './lineRoute';
import type { LineData } from './lineRoute';
import { pathPoints, routeOrthogonal } from './route';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });
const part = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id },
});
/** Ports at the middle of each edge of a 60 px symbol; a tee's faces with J_END, as the designer's endOfClear. */
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
const E = (id: string, source: string, sh: string, target: string, th: string): Edge =>
  ({ id, source, sourceHandle: sh, target, targetHandle: th, type: 'smoothstep', data: {} });

interface G { nodes: Node[]; edges: Edge[] }

/** The reseat effect run to where it stops, as the canvas runs it: round each page's symbols. */
function settle(g: G, drag: Dragging | null = null): G {
  let { nodes, edges } = g;
  for (let i = 0; i < 20; i++) {
    const re = reseatJunctions(nodes, edges, endOf, obstaclesByPage(nodes), drag);
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}

/** Drag `id` through `path` (where its top-left goes), `ticks` steps a leg, then let go. */
function drag(g0: G, id: string, path: Pt[], ticks: number, watch?: (g: G) => void): G {
  const moving = dragging(g0.nodes, [id]);
  let g = g0;
  let from = g0.nodes.find(n => n.id === id)!.position;
  for (const to of path) {
    for (let k = 1; k <= ticks; k++) {
      const at = P(from.x + ((to.x - from.x) * k) / ticks, from.y + ((to.y - from.y) * k) / ticks);
      const change: NodeChange<Node> = { id, type: 'position', position: at, dragging: true };
      const moved = applyMoves(g.nodes, [change], g.edges, endOf, obstaclesByPage(g.nodes));
      g = settle({ nodes: moved.nodes, edges: g.edges }, moving);
      watch?.(g);
    }
    from = to;
  }
  return settle(g);
}

const teeAt = (g: G, id: string) => centreOfJunction(g.nodes.find(n => n.id === id)!);
const drawn = (g: G, id: string) => drawnRoute(g.edges.find(e => e.id === id)!, new Map(g.nodes.map(n => [n.id, n])), endOf)!;

/** A tee put into line `id` at `at`, as a pull out of the line as drawn puts it. */
function teeInto(g: G, id: string, at: Pt) {
  const split = splitEdgeAt(g.nodes, g.edges, id, at, undefined, { points: drawn(g, id), endOf, obstacles: obstaclesByPage(g.nodes) })!;
  return { nodes: split.nodes, edges: split.edges, tee: split.junctionId };
}

/** M1.r -> M2.l, a Z bending at x = 450, with a tee on its first leg at x = 390 and a branch straight up to TK. */
function teedZ(tk = 50): G & { tee: string } {
  const M1 = part('M1', 270, 270), M2 = part('M2', 570, 420), TK = part('TK', 360, tk);
  const split = teeInto(settle({ nodes: [M1, M2, TK], edges: [E('run', 'M1', 'r', 'M2', 'l')] }), 'run', P(390, 300));
  const g = settle({ nodes: split.nodes, edges: [...split.edges, E('branch', split.tee, 't', 'TK', 'b')] });
  return { ...g, tee: split.tee };
}

describe('a tee a drag sweeps a bend past', () => {
  it('is where the end of the drag puts it, however slowly the drag went', () => {
    const g0 = teedZ();
    expect(teeAt(g0, g0.tee)).toEqual(P(390, 300));
    // M2 drawn up and left until its port is level with M1's: the Z's bend,
    // half-way between the ports, crosses the tee on the way.
    const slow = drag(g0, 'M2', [P(420, 270)], 30);
    const once = drag(g0, 'M2', [P(420, 270)], 1);
    expect(teeAt(once, g0.tee)).toEqual(P(390, 300));
    expect(teeAt(slow, g0.tee)).toEqual(teeAt(once, g0.tee));
    // The branch straight up, not jogged by how far the bend pushed the tee.
    expect(drawn(slow, 'branch')).toHaveLength(2);
  });

  it('is back where it was when the drawing is', () => {
    const g0 = teedZ();
    const there = drag(g0, 'M2', [P(420, 270)], 30);
    const back = drag(there, 'M2', [P(570, 420)], 30);
    expect(teeAt(back, g0.tee)).toEqual(P(390, 300));
  });
});

describe('a symbol dragged across a pipe it has nothing to do with', () => {
  /** A.r -> B.l straight at y = 330, a tee at x = 250 with a branch up to T, and a loose valve V off to one side. */
  function bay(): G & { tee: string } {
    const A = part('A', 0, 300), B = part('B', 500, 300), T = part('T', 220, 50), V = part('V', 700, 50);
    const split = teeInto(settle({ nodes: [A, B, T, V], edges: [E('run', 'A', 'r', 'B', 'l')] }), 'run', P(250, 330));
    const g = settle({ nodes: split.nodes, edges: [...split.edges, E('branch', split.tee, 't', 'T', 'b')] });
    return { ...g, tee: split.tee };
  }

  it('leaves the pipe and its tee as they were, on the way over and once it has gone', () => {
    const g0 = bay();
    const pipe = (g: G) => g.edges.filter(e => e.id !== 'branch').map(e => drawn(g, e.id));
    const pipe0 = pipe(g0);
    // Over the tee, along the pipe, and away.
    const seen: Pt[] = [];
    const after = drag(g0, 'V', [P(230, 300), P(400, 300), P(700, 600)], 8, g => seen.push(teeAt(g, g0.tee)));
    expect(seen.every(p => p.x === 250 && p.y === 330)).toBe(true);
    expect(teeAt(after, g0.tee)).toEqual(P(250, 330));
    expect(pipe(after)).toEqual(pipe0);
  });

  it('is in the way of the pipe once it is let go of there', () => {
    // Dropped on the pipe, the valve is a symbol like any other, and the pipe
    // goes round it -- but only the stretch of it the valve lies across. This
    // used to send the whole pipe round the valve, and the detour, up over it
    // and along the top all the way to B's stub, took the tee forty-five
    // pixels up with it. A tee never moves because of something put in
    // its pipe's way, and the pipe's ends have not moved: so the half the
    // valve is on goes round it between A and the tee, and the tee and the
    // other half stay exactly as they were.
    const g0 = bay();
    const half = (g: G, end: string) => g.edges.find(e => e.id !== 'branch' && (e.source === end || e.target === end))!;
    const before = drawn(g0, half(g0, 'B').id);
    const after = drag(g0, 'V', [P(150, 300)], 8);
    expect(teeAt(after, g0.tee)).toEqual(P(250, 330));
    expect(drawn(after, half(after, 'B').id)).toEqual(before);
    const round = drawn(after, half(after, 'A').id);
    expect(round.length).toBeGreaterThan(2);
    expect(round[0]).toEqual(P(60, 330));
    expect(round[round.length - 1]).toEqual(P(242, 330));
    const V = { x: 150, y: 300, w: 60, h: 60 };
    expect(round.some((p, i) => i + 1 < round.length && Math.max(p.x, round[i + 1].x) > V.x && Math.min(p.x, round[i + 1].x) < V.x + V.w
      && Math.max(p.y, round[i + 1].y) > V.y && Math.min(p.y, round[i + 1].y) < V.y + V.h)).toBe(false);
    expect(drawn(after, 'branch')).toHaveLength(2);
  });

  it('keeps the pipe on the face of the open end it ends on, and goes round the valve into it', () => {
    // A pipe from A to an open end O, the valve put down on it short of O.
    // Priced afresh, the whole pipe went into O's top face over the valve
    // more cheaply than round it into the face it had: the line was turned
    // onto another face, and the pipe was a different pipe. A pipe whose
    // shape is still its own keeps the faces it ends on as it keeps its tees,
    // and only the stretch the valve lies across goes round it.
    const A = part('A', 0, 300), T = part('T', 220, 50), V = part('V', 700, 50);
    const O: Node = { id: 'O', type: 'JUNCTION', position: { x: 495, y: 325 }, measured: { width: 10, height: 10 }, data: { componentType: 'JUNCTION', label: 'O' } };
    const split = teeInto(settle({ nodes: [A, O, T, V], edges: [E('run', 'A', 'r', 'O', 'l')] }), 'run', P(250, 330));
    const g0 = settle({ nodes: split.nodes, edges: [...split.edges, E('branch', split.tee, 't', 'T', 'b')] });
    const toO = (g: G) => g.edges.find(e => e.target === 'O')!;
    const toTee = (g: G) => g.edges.find(e => e.source === 'A')!;
    expect(toO(g0).targetHandle).toBe('l');
    const after = drag(g0, 'V', [P(400, 300)], 4);
    expect(toO(after).targetHandle).toBe('l');
    expect(teeAt(after, split.tee)).toEqual(P(250, 330));
    expect(drawn(after, toTee(after).id)).toEqual(drawn(g0, toTee(g0).id));
    const round = drawn(after, toO(after).id);
    const box = { x: 400, y: 300, w: 60, h: 60 };
    expect(round.length).toBeGreaterThan(2);
    expect(round.some((p, i) => i + 1 < round.length && Math.max(p.x, round[i + 1].x) > box.x && Math.min(p.x, round[i + 1].x) < box.x + box.w
      && Math.max(p.y, round[i + 1].y) > box.y && Math.min(p.y, round[i + 1].y) < box.y + box.h)).toBe(false);
  });

  it('leaves the tee where it is when the only way round would turn inside its reach', () => {
    // A tee off the grid, at x = 243.6, and the valve set down just short of
    // it: the router's way round comes back to the pipe less than a stub out
    // of the tee's face, where the tee cannot stay -- no tee sits by a bend --
    // and taken, it pushed the tee along the pipe to clear the bend it had
    // brought. The half keeps its stretch instead, and the tee its place.
    const A = part('A', 0, 300), B = part('B', 500, 300), T = part('T', 220, 50);
    const at = P(243.6, 330);
    const tee: Node = {
      id: 'J', type: 'JUNCTION', position: { x: at.x - 5, y: at.y - 5 },
      data: {
        componentType: 'JUNCTION', label: 'J',
        along: { t: (at.x - 60) / 440, in: 'l', out: 'r', from: 'A', to: 'B', ends: { a: P(60, 330), b: P(500, 330) } },
      },
    };
    const g0 = settle({
      nodes: [A, B, T, part('V', 700, 50), tee],
      edges: [E('a', 'A', 'r', 'J', 'l'), E('b', 'J', 'r', 'B', 'l'), E('branch', 'J', 't', 'T', 'b')],
    });
    expect(teeAt(g0, 'J')).toEqual(at);
    const after = drag(g0, 'V', [P(160, 300)], 4);
    expect(teeAt(after, 'J')).toEqual(at);
    expect(drawn(after, 'b')).toEqual(drawn(g0, 'b'));
  });

  it('is in the way of only the stretch it lies across after an end of the pipe has moved along it', () => {
    // B dragged further off along its own axis first: the pipe grows under
    // the tee, which stays, and its shape -- a straight run -- still fits its
    // ends. It is still the pipe's own to keep, so the valve put down on it
    // afterwards sends round only the half it lies across, not the pipe and
    // the tee with it.
    const g0 = bay();
    const moved = drag(g0, 'B', [P(560, 300)], 4);
    expect(teeAt(moved, g0.tee)).toEqual(P(250, 330));
    const after = drag(moved, 'V', [P(150, 300)], 8);
    expect(teeAt(after, g0.tee)).toEqual(P(250, 330));
    expect(drawn(after, 'branch')).toHaveLength(2);
  });
});

describe('a branch whose tee is slid onto another leg of its pipe', () => {
  /** Perpendicular crossings of two drawn paths, away from their ends. */
  const crossings = (p: Pt[], q: Pt[]) => {
    let n = 0;
    for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
      const [h1, h2, v1, v2] = Math.abs(p[i].y - p[i + 1].y) < 1e-6 ? [p[i], p[i + 1], q[j], q[j + 1]] : [q[j], q[j + 1], p[i], p[i + 1]];
      if (Math.abs(h1.y - h2.y) > 1e-6 || Math.abs(v1.x - v2.x) > 1e-6) continue;
      if (v1.x > Math.min(h1.x, h2.x) + 1e-6 && v1.x < Math.max(h1.x, h2.x) - 1e-6
        && h1.y > Math.min(v1.y, v2.y) + 1e-6 && h1.y < Math.max(v1.y, v2.y) - 1e-6) n++;
    }
    return n;
  };

  it('does not cross its own pipe or wrap round it to reach the symbol it goes to', () => {
    // The tee dragged from the first leg of the Z onto its last, beside M2,
    // with TK where the middle of the branch's rise is the height of the
    // first leg. Its branch up to TK went out of the bottom, back under the
    // pipe and up across it: with its crossbar in the middle, the top face
    // lay along the first leg. At the height of TK's stub it crosses nothing.
    const g0 = teedZ(98);
    for (const to of [P(540, 440), P(500, 440), P(470, 440)]) {
      const g = drag(g0, g0.tee, [to], 6);
      const tee = teeAt(g, g0.tee);
      expect(tee.y).toBe(450);
      const branch = drawn(g, 'branch');
      const pipe = g.edges.filter(e => e.id !== 'branch').map(e => drawn(g, e.id));
      expect(pipe.reduce((n, p) => n + crossings(branch, p), 0), `tee at ${tee.x}`).toBe(0);
      expect(branch[0].y, `tee at ${tee.x}`).toBeLessThan(450);
    }
  });
});

describe('a branch whose pipe bends at the branch\'s own height', () => {
  const crosses = (branch: Pt[], p: Pt[]) => p.some((q, i) => i + 1 < p.length && branch.some((r, j) => j + 1 < branch.length
    && Math.abs(q.y - p[i + 1].y) < 1e-6 && Math.abs(r.x - branch[j + 1].x) < 1e-6
    && r.x > Math.min(q.x, p[i + 1].x) + 1e-6 && r.x < Math.max(q.x, p[i + 1].x) - 1e-6
    && q.y > Math.min(r.y, branch[j + 1].y) + 1e-6 && q.y < Math.max(r.y, branch[j + 1].y) - 1e-6));

  it('neither crosses the pipe nor loops round it', () => {
    // A over B, a tee on the pipe between them, and a branch from the tee
    // straight across to C. B then moved sideways: the pipe's crossbar,
    // half-way down, comes near the branch's height, the tee goes up off
    // the bend, and the branch in the middle of its run lay along the
    // crossbar; turned round to the other face, it looped back over the
    // pipe to reach C.
    for (const ty of [290, 300, 310, 320, 330]) {
      const A = part('A', 650, 140), B = part('B', 650, 420), C = part('C', 780, ty - 30);
      const split = teeInto(settle({ nodes: [A, B, C], edges: [E('run', 'A', 'b', 'B', 't')] }), 'run', P(680, ty));
      const g0 = settle({ nodes: split.nodes, edges: [...split.edges, E('branch', 'C', 'l', split.tee, 'r')] });
      for (const dx of [-80, -60, -40, -20, 20, 40, 60, 80]) {
        const g = drag(g0, 'B', [P(650 + dx, 420)], 4);
        const branch = drawn(g, 'branch');
        const pipe = g.edges.filter(e => e.id !== 'branch').map(e => drawn(g, e.id));
        const at = `tee at ${ty}, B moved ${dx}: ${JSON.stringify(branch)}`;
        expect(pipe.some(p => crosses(branch, p)), at).toBe(false);
        // Out of the tee toward C, never back past it.
        expect(Math.min(...branch.map(p => p.x)), at).toBeGreaterThanOrEqual(teeAt(g, split.tee).x);
      }
    }
  });
});

describe('a bay picked up whole', () => {
  const junction = (id: string, c: Pt): Node =>
    ({ id, type: 'JUNCTION', position: { x: c.x - 5, y: c.y - 5 }, data: { componentType: 'JUNCTION', label: id } });

  /**
   * M1.r -> tee -> tee -> M2.l, a Z bending at x = 450; a branch up from the
   * first tee to TK, one down from the second to an open end, and M2.r out to
   * another. A valve V stands off to the right, on nothing.
   */
  function bay(): G & { tees: string[]; opens: string[] } {
    const M1 = part('M1', 270, 270), M2 = part('M2', 570, 420), TK = part('TK', 360, 50), V = part('V', 870, 120);
    const O1 = junction('O1', P(510, 560)), O2 = junction('O2', P(800, 450));
    const g0 = settle({ nodes: [M1, M2, TK, V, O1, O2], edges: [E('run', 'M1', 'r', 'M2', 'l'), E('out', 'M2', 'r', 'O2', 'l')] });
    const first = teeInto(g0, 'run', P(390, 300));
    const g1 = settle({ nodes: first.nodes, edges: [...first.edges, E('up', first.tee, 't', 'TK', 'b')] });
    const lower = g1.edges.find(e => e.target === 'M2' && e.targetHandle === 'l')!.id;
    const second = teeInto(g1, lower, P(510, 450));
    const g = settle({ nodes: second.nodes, edges: [...second.edges, E('down', second.tee, 'b', 'O1', 't')] });
    return { ...g, tees: [first.tee, second.tee], opens: ['O1', 'O2'] };
  }

  /**
   * Drag the nodes `ids` together, as a box-selected group is dragged: every
   * tick React Flow proposes each of them from where the drag began, by the
   * one delta, the lines' corners follow what moved (`followCorners`), and the
   * reseat settles what that leaves, told of the drag. Then let go.
   */
  function dragGroup(
    g0: G, ids: string[], path: Pt[], ticks: number, watch?: (g: G, d: Pt) => void, lose?: (tick: number) => boolean,
  ): G {
    const moving = dragging(g0.nodes, ids, g0.edges);
    const start = new Map(g0.nodes.map(n => [n.id, n.position]));
    let g = g0;
    let from = P(0, 0);
    let tick = 0;
    for (const to of path) {
      for (let k = 1; k <= ticks; k++) {
        const d = P(from.x + ((to.x - from.x) * k) / ticks, from.y + ((to.y - from.y) * k) / ticks);
        const changes: NodeChange<Node>[] = ids.map(id => {
          const s = start.get(id)!;
          return { id, type: 'position', position: P(s.x + d.x, s.y + d.y), dragging: true };
        });
        const moved = applyMoves(g.nodes, changes, g.edges, endOf, obstaclesByPage(g.nodes));
        // A tick whose update to the lines is lost -- overwritten by a write
        // of the drawing before it -- leaves the corners where they were.
        const edges = lose?.(++tick) ? g.edges : followCorners(g.edges, moved.shifts);
        g = settle({ nodes: moved.nodes, edges }, moving);
        watch?.(g, d);
      }
      from = to;
    }
    return settle(g);
  }

  /** Every node of `ids` where it was, moved by `d`; and every stored corner and face of every line between them. */
  function expectMovedWhole(g0: G, g: G, ids: Set<string>, d: Pt, at: string) {
    const by = (p: Pt) => P(p.x + d.x, p.y + d.y);
    for (const n of g0.nodes) {
      if (!ids.has(n.id)) continue;
      const now = g.nodes.find(x => x.id === n.id)!.position;
      expect(Math.hypot(now.x - by(n.position).x, now.y - by(n.position).y), `${n.id} ${at}`).toBeLessThan(1e-6);
    }
    for (const e of g0.edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      const now = g.edges.find(x => x.id === e.id)!;
      expect([now.sourceHandle, now.targetHandle], `${e.id} faces ${at}`).toEqual([e.sourceHandle, e.targetHandle]);
      const was = ((e.data as { waypoints?: Pt[] }).waypoints ?? []).map(by);
      const is = (now.data as { waypoints?: Pt[] }).waypoints ?? [];
      expect(is.length, `${e.id} corners ${at}`).toBe(was.length);
      is.forEach((p, i) => expect(Math.hypot(p.x - was[i].x, p.y - was[i].y), `${e.id} corner ${i} ${at}`).toBeLessThan(1e-6));
    }
  }

  it('moves as one piece across a symbol it passes over, tees, corners and all', () => {
    // Everything but V, dragged up over V -- the pipe's first leg and its
    // bend run straight through it; then V across the branch up to TK, and
    // over the top of the open end the other branch comes down to -- and on
    // to where nothing is. The pipe was routed round V on the way, its tees
    // put on the detour, and the detour kept once V was left behind: the bay
    // arrived bent out of shape. The branch to the open end, priced round V,
    // went into another face of it.
    const g0 = bay();
    const ids = g0.nodes.filter(n => n.id !== 'V').map(n => n.id);
    const group = new Set(ids);
    const pipe0 = g0.edges.filter(e => e.id !== 'up' && e.id !== 'down' && e.id !== 'out').map(e => drawn(g0, e.id));
    for (const ticks of [1, 12, 40]) {
      const after = dragGroup(g0, ids, [P(450, -150), P(510, -50), P(390, -367), P(700, 0)], ticks,
        (g, d) => expectMovedWhole(g0, g, group, d, `at ${d.x},${d.y}`));
      expectMovedWhole(g0, after, group, P(700, 0), `let go, ${ticks} ticks a leg`);
      // Drawn where it was, moved: to the float noise of the ticks' fractional steps.
      const pipe = after.edges.filter(e => e.id !== 'up' && e.id !== 'down' && e.id !== 'out').map(e => drawn(after, e.id));
      expect(pipe.map(r => r.length)).toEqual(pipe0.map(r => r.length));
      pipe.forEach((r, i) => r.forEach((p, j) => {
        expect(Math.hypot(p.x - pipe0[i][j].x - 700, p.y - pipe0[i][j].y), `line ${i} point ${j}`).toBeLessThan(1e-6);
      }));
    }
  });

  it('carries the tees of a pipe whose two ends are picked up without them', () => {
    // Only the symbols and open ends selected: the tees ride the pipe, and
    // go with it as they would if they had been selected too.
    const g0 = bay();
    const ids = g0.nodes.filter(n => n.id !== 'V' && !g0.tees.includes(n.id)).map(n => n.id);
    const all = new Set(g0.nodes.filter(n => n.id !== 'V').map(n => n.id));
    const after = dragGroup(g0, ids, [P(450, -150), P(700, 0)], 12, (g, d) => expectMovedWhole(g0, g, all, d, `at ${d.x},${d.y}`));
    expectMovedWhole(g0, after, all, P(700, 0), 'let go');
  });

  it('arrives whole even when a tick\'s move of its corners is lost', () => {
    // The pipe is put where the drag has taken it from where it was when the
    // drag began, not from where the last tick left it: a tick whose lines
    // were not moved with the symbols bent the pipe for good. Its bend is at
    // x = 420 here, where the router left it, not half-way, where the router
    // would put it again.
    const bent = bay();
    const middle = bent.edges.find(e => ((e.data as { waypoints?: Pt[] }).waypoints ?? []).length)!;
    const g0 = settle({
      nodes: bent.nodes,
      edges: bent.edges.map(e => (e === middle ? { ...e, data: { ...e.data, waypoints: [P(420, 300), P(420, 450)] } } : e)),
    });
    expect((g0.edges.find(e => e.id === middle.id)!.data as { waypoints?: Pt[] }).waypoints).toEqual([P(420, 300), P(420, 450)]);
    const ids = g0.nodes.filter(n => n.id !== 'V').map(n => n.id);
    const group = new Set(ids);
    const after = dragGroup(g0, ids, [P(200, 100)], 10, (g, d) => expectMovedWhole(g0, g, group, d, `at ${d.x},${d.y}`),
      tick => tick === 4);
    expectMovedWhole(g0, after, group, P(200, 100), 'let go');
  });

  /** M1.r -> M2.l on the router's corners, bent at x = 400 rather than half-way, a line of no pipe; V off to the right. */
  function bentLine(): G {
    const M1 = part('M1', 270, 270), M2 = part('M2', 570, 420), V = part('V', 820, 200);
    const bend = { waypoints: [P(400, 300), P(400, 450)], viaRun: true };
    return settle({ nodes: [M1, M2, V], edges: [{ ...E('run', 'M1', 'r', 'M2', 'l'), data: bend }] });
  }

  it('keeps the router\'s bend on a line of no pipe it carries over a symbol', () => {
    // The bend is kept while it fits the two ends, which a rigid move never
    // stops it doing; judged against V as it passed, it was dropped, and the
    // line was drawn with the router's own bend, half-way, from then on.
    const g0 = bentLine();
    expect((g0.edges[0].data as { waypoints?: Pt[] }).waypoints).toEqual([P(400, 300), P(400, 450)]);
    const group = new Set(['M1', 'M2']);
    const after = dragGroup(g0, ['M1', 'M2'], [P(450, -150), P(700, 0)], 6,
      (g, d) => expectMovedWhole(g0, g, group, d, `at ${d.x},${d.y}`));
    expectMovedWhole(g0, after, group, P(700, 0), 'let go');
  });

  it('keeps the corners of a line of no pipe it carries when a tick\'s move of them is lost', () => {
    const g0 = bentLine();
    const group = new Set(['M1', 'M2']);
    const after = dragGroup(g0, ['M1', 'M2'], [P(200, 100)], 10, (g, d) => expectMovedWhole(g0, g, group, d, `at ${d.x},${d.y}`),
      tick => tick === 4);
    expectMovedWhole(g0, after, group, P(200, 100), 'let go');
  });

  it('keeps the face a branch pipe it carries ends on, against a line it does not carry', () => {
    // A.r -> B.l with a tee T; from T's bottom a branch pipe down to C, with
    // a tee of its own branching to D; and a second branch from T to Y, far
    // below. The branch pipe holds T's bottom face, so Y's line goes out of
    // the top. Everything but Y dragged: the branch pipe is carried whole
    // and not chosen again, and Y's line, which is, must still find the
    // bottom face held -- not free, and the two drawn out of it together.
    const A = part('A', 0, 300), B = part('B', 500, 300), C = part('C', 220, 600), D = part('D', 400, 420), Y = part('Y', 220, 760);
    const first = teeInto(settle({ nodes: [A, B, C, D, Y], edges: [E('run', 'A', 'r', 'B', 'l')] }), 'run', P(250, 330));
    const g1 = settle({ nodes: first.nodes, edges: [...first.edges, E('branch', first.tee, 'b', 'C', 't')] });
    const second = teeInto(g1, 'branch', P(250, 450));
    const g0 = settle({
      nodes: second.nodes,
      edges: [...second.edges, E('toD', second.tee, 'r', 'D', 'l'), E('toY', first.tee, 't', 'Y', 't')],
    });
    const faceAtT = (g: G) => g.edges.find(e => e.id === 'toY')!.sourceHandle;
    expect(faceAtT(g0)).toBe('t');
    const ids = g0.nodes.filter(n => n.id !== 'Y').map(n => n.id);
    const seen: (string | null | undefined)[] = [];
    dragGroup(g0, ids, [P(0, -40)], 4, g => seen.push(faceAtT(g)));
    expect(seen.every(f => f === 't'), JSON.stringify(seen)).toBe(true);
  });

  it('let go with its pipe across a symbol, keeps every tee where it put it and sends round only the line that crosses', () => {
    // Everything but V dragged until the Z's crossbar lies across V, and let
    // go there. The drag carries the pipe whole, straight through V; letting
    // go settles it round V. It was routed round V again whole, and its tees
    // put on the detour: the crossbar went out past V to the end of the
    // bottom leg, the second tee was put on it, turned, sixteen pixels from
    // M2's port on a six-pixel stub, and the branch down from it jogged back
    // to where it had been. The pipe's two ends have not moved relative to
    // each other, so its shape is still its own: only the crossbar's line
    // goes round V, between the two tees, and they stay where they were put.
    const g0 = bay();
    const ids = g0.nodes.filter(n => n.id !== 'V').map(n => n.id);
    const d = P(460, -200);
    const by = (p: Pt) => P(p.x + d.x, p.y + d.y);
    const after = dragGroup(g0, ids, [d], 6);
    for (const t of g0.tees) {
      const was = by(teeAt(g0, t)), is = teeAt(after, t);
      expect(Math.hypot(is.x - was.x, is.y - was.y), t).toBeLessThan(1e-6);
    }
    const V = { x: 870, y: 120, w: 60, h: 60 };
    const hitsV = (r: Pt[]) => r.some((p, i) => i + 1 < r.length && Math.max(p.x, r[i + 1].x) > V.x && Math.min(p.x, r[i + 1].x) < V.x + V.w
      && Math.max(p.y, r[i + 1].y) > V.y && Math.min(p.y, r[i + 1].y) < V.y + V.h);
    const pipe = g0.edges.filter(e => !['up', 'down', 'out'].includes(e.id)).map(e => e.id);
    const crossing = pipe.filter(id => hitsV(drawn(g0, id).map(by)));
    expect(crossing).toHaveLength(1);
    for (const id of pipe) {
      const was = drawn(g0, id).map(by), is = drawn(after, id);
      if (id === crossing[0]) {
        // Round V, from the same face of the one tee to the same face of the other.
        expect(hitsV(is), id).toBe(false);
        expect(Math.hypot(is[0].x - was[0].x, is[0].y - was[0].y), id).toBeLessThan(1e-6);
        const [a, b] = [is[is.length - 1], was[was.length - 1]];
        expect(Math.hypot(a.x - b.x, a.y - b.y), id).toBeLessThan(1e-6);
        continue;
      }
      expect(is.length, id).toBe(was.length);
      is.forEach((p, i) => expect(Math.hypot(p.x - was[i].x, p.y - was[i].y), `${id} point ${i}`).toBeLessThan(1e-6));
    }
    expect(drawn(after, 'up')).toHaveLength(2);
    expect(drawn(after, 'down')).toHaveLength(2);
  });

  it('let go across a symbol, sends the line round it two grid steps clear of its sides, not down one of them', () => {
    // Let go of 20 px lower than the case above, the first tee lies level
    // with V's top edge, twenty pixels short of it. The router's way round
    // turned down out of the tee's stub and ran the whole height of V six
    // pixels off its side, past its free port: at any zoom it read as run
    // into that port. It goes over the top and down the far side instead,
    // two grid steps off V all the way, and the tees stay where they were
    // put.
    const g0 = bay();
    const ids = g0.nodes.filter(n => n.id !== 'V').map(n => n.id);
    const V = { x: 870, y: 120, w: 60, h: 60 };
    /** How far a route runs beside one of V's sides nearer than two grid steps. */
    const besideV = (r: Pt[]) => {
      let n = 0;
      for (let i = 0; i + 1 < r.length; i++) {
        const [p, q] = [r[i], r[i + 1]];
        if (p.x === q.x && Math.min(Math.abs(p.x - V.x), Math.abs(p.x - V.x - V.w)) < 20) {
          n += Math.max(0, Math.min(Math.max(p.y, q.y), V.y + V.h) - Math.max(Math.min(p.y, q.y), V.y));
        }
        if (p.y === q.y && Math.min(Math.abs(p.y - V.y), Math.abs(p.y - V.y - V.h)) < 20) {
          n += Math.max(0, Math.min(Math.max(p.x, q.x), V.x + V.w) - Math.max(Math.min(p.x, q.x), V.x));
        }
      }
      return n;
    };
    const hitsV = (r: Pt[]) => r.some((p, i) => i + 1 < r.length && Math.max(p.x, r[i + 1].x) > V.x && Math.min(p.x, r[i + 1].x) < V.x + V.w
      && Math.max(p.y, r[i + 1].y) > V.y && Math.min(p.y, r[i + 1].y) < V.y + V.h);
    for (const d of [P(460, -180), P(460, -200)]) {
      const after = dragGroup(g0, ids, [d], 6);
      for (const t of g0.tees) {
        const was = teeAt(g0, t), is = teeAt(after, t);
        expect(Math.hypot(is.x - was.x - d.x, is.y - was.y - d.y), `${t} let go at ${d.y}`).toBeLessThan(1e-6);
      }
      const middle = after.edges.filter(e => !['up', 'down', 'out'].includes(e.id)).map(e => drawn(after, e.id));
      for (const r of middle) {
        expect(hitsV(r), `${JSON.stringify(r)} let go at ${d.y}`).toBe(false);
        expect(besideV(r), `${JSON.stringify(r)} let go at ${d.y}`).toBe(0);
      }
      // Two grid steps off, not further: along the top at y = 100 and down
      // the far side at x = 950.
      const pts = middle.flat();
      expect(Math.min(...pts.map(p => p.y)), `let go at ${d.y}`).toBeCloseTo(100, 6);
      expect(middle.some(r => r.some((p, i) => i + 1 < r.length && p.x === 950 && r[i + 1].x === 950)), `let go at ${d.y}`).toBe(true);
    }
  });

  /**
   * A header M11.r -> M12.l along y = 130 with a tee at x = 330 and a branch
   * up to TK; and S's line to an open end O at (520, 160), thirty pixels
   * under the header -- up into O from S below it, or down into it from S
   * above.
   */
  function header(from: 'below' | 'above' = 'below'): G & { tee: string } {
    const M11 = part('M11', 100, 100), M12 = part('M12', 700, 100), TK = part('TK', 300, -100);
    const S = part('S', 490, from === 'below' ? 300 : -40);
    const O = junction('O', P(520, 160));
    const so = from === 'below' ? E('so', 'S', 't', 'O', 'b') : E('so', 'S', 'b', 'O', 't');
    const g0 = settle({ nodes: [M11, M12, TK, S, O], edges: [E('h1', 'M11', 'r', 'M12', 'l'), so] });
    const split = teeInto(g0, 'h1', P(330, 130));
    const g = settle({ nodes: split.nodes, edges: [...split.edges, E('br', split.tee, 't', 'TK', 'b')] });
    return { ...g, tee: split.tee };
  }

  it('let go with its pipe through another line\'s open end, sends the pipe round the dot and moves nothing else', () => {
    // The header picked up with its tee and branch and let go thirty pixels
    // lower, level with O: carried whole, it ran straight through O's dot,
    // O's own line coming into it from one side, and at any zoom the header
    // read as teed into S. The stretch through the dot goes round it, on the
    // side away from O's line; the tee, its branch, the other line of the
    // header and O stay exactly where they were.
    for (const from of ['below', 'above'] as const) {
      const g0 = header(from);
      const ids = ['M11', 'M12', g0.tee, 'TK'];
      const after = dragGroup(g0, ids, [P(0, 30)], 3);
      const O = teeAt(after, 'O');
      expect(O, from).toEqual(P(520, 160));
      expect(teeAt(after, g0.tee), from).toEqual(P(330, 160));
      const toM12 = after.edges.find(e => e.target === 'M12')!.id;
      const round = drawn(after, toM12);
      const near = (r: Pt[], c: Pt, within: number) => r.some((p, i) => {
        if (i + 1 >= r.length) return false;
        const q = r[i + 1];
        const x = Math.max(Math.min(p.x, q.x), Math.min(Math.max(p.x, q.x), c.x));
        const y = Math.max(Math.min(p.y, q.y), Math.min(Math.max(p.y, q.y), c.y));
        return Math.hypot(c.x - x, c.y - y) < within;
      });
      expect(near(round, O, 10), `${from}: ${JSON.stringify(round)}`).toBe(false);
      expect(round[0], from).toEqual(P(338, 160));
      expect(round[round.length - 1], from).toEqual(P(700, 160));
      // Round the side O's line does not come from, so as not to cross it.
      const ys = round.map(p => p.y);
      if (from === 'below') expect(Math.max(...ys), JSON.stringify(round)).toBe(160);
      else expect(Math.min(...ys), JSON.stringify(round)).toBe(160);
      const other = after.edges.find(e => e.source === 'M11')!.id;
      expect(drawn(after, other), from).toEqual([P(160, 160), P(322, 160)]);
      expect(drawn(after, 'br'), from).toEqual([P(330, 152), P(330, -10)]);
      expect(drawn(after, 'so'), from).toEqual(drawn(g0, 'so'));
    }
  });

  it('does not send a pipe round the open end of its own tee\'s branch', () => {
    // The tee's branch taken to an open end put down against the header,
    // three pixels under it: the branch's end is the branch's business, and
    // the header is not bent round it.
    const g0 = header();
    const own = junction('own', P(420, 133));
    const g = settle({ nodes: [...g0.nodes, own], edges: [...g0.edges, E('toOwn', g0.tee, 'b', 'own', 't')] });
    const toM12 = g.edges.find(e => e.target === 'M12')!.id;
    expect(drawn(g, toM12)).toEqual([P(338, 130), P(700, 130)]);
  });

  it('still re-routes a pipe whose ends moved apart', () => {
    // M2 and its open ends picked up without M1: the pipe's two ends move
    // relative to each other, and the pipe is the router's to draw again.
    // The second tee is left thirty pixels off the new path, further than a
    // tee is put on the nearest point of it: it keeps its distance along the
    // pipe from M1, which did not move -- 330 pixels, 30 of them along the
    // bottom leg past the bend -- where it was once put on the point of the
    // new path nearest where it had been, (510, 480).
    const g0 = bay();
    const after = dragGroup(g0, ['M2', 'O1', 'O2'], [P(0, 30)], 6);
    expect(teeAt(after, g0.tees[1])).toEqual(P(480, 480));
    // And put back where it was when M2 is.
    const back = dragGroup(after, ['M2', 'O1', 'O2'], [P(0, -30)], 6);
    expect(teeAt(back, g0.tees[1])).toEqual(P(510, 450));
  });

  it('keeps a tee where it is on the drawing when the re-routed pipe passes within two grid steps of it', () => {
    // Twenty pixels down, the bottom leg passes two grid steps under the
    // second tee: the nearest point of the new path is where it was, and it
    // goes straight down onto it -- not along the pipe from M1, which would
    // have put it at x = 490.
    const g0 = bay();
    const after = dragGroup(g0, ['M2', 'O1', 'O2'], [P(0, 20)], 6);
    expect(teeAt(after, g0.tees[1])).toEqual(P(510, 470));
  });
});

describe('a branch a drag carries past a symbol it does not end on', () => {
  it('keeps its faces while the symbol goes over it, and is drawn as it was priced', () => {
    // A pipe from F to V with a tee on it, and a branch from the tee's
    // bottom face down and across into an open end's left side. V and W
    // are picked up together and dragged up the sheet: the pipe bends up to
    // V, the tee stays where it is, and W passes over the branch's corner.
    // The page draws the branch through W while W is being dragged -- it
    // ends on nothing W is -- and the reseat, which priced it round W, took
    // the open end's top instead, a face that only made sense round a symbol
    // the branch was not drawn round. Priced as it is drawn, it keeps the
    // faces it has until W is let go of.
    const F = part('F', 100, 100), V = part('V', 700, 100);
    const W: Node = { ...part('W', 260, 520), measured: { width: 60, height: 130 } };
    const O: Node = {
      id: 'O', type: 'JUNCTION', position: { x: 395, y: 295 }, measured: { width: 10, height: 10 },
      data: { componentType: 'JUNCTION', label: 'O' },
    };
    const t = teeInto(settle({ nodes: [F, V, W, O], edges: [E('run', 'F', 'r', 'V', 'l')] }), 'run', P(300, 130));
    let g = settle({ nodes: t.nodes, edges: [...t.edges, E('branch', t.tee, 'b', 'O', 'l')] });
    expect(drawn(g, 'branch')).toEqual([P(300, 138), P(300, 300), P(392, 300)]);
    const moving = dragging(g.nodes, ['V', 'W'], g.edges);
    for (let k = 1; k <= 10; k++) {
      const changes: NodeChange<Node>[] = [
        { id: 'V', type: 'position', position: P(700, 100 - 23 * k), dragging: true },
        { id: 'W', type: 'position', position: P(260, 520 - 30 * k), dragging: true },
      ];
      g = settle({ nodes: applyMoves(g.nodes, changes, g.edges, endOf, obstaclesByPage(g.nodes)).nodes, edges: g.edges }, moving);
      const branch = g.edges.find(e => e.id === 'branch')!;
      expect(teeAt(g, t.tee)).toEqual(P(300, 130));
      expect([branch.sourceHandle, branch.targetHandle], `tick ${k}`).toEqual(['b', 'l']);
      // As BranchableEdge draws it: round the symbols in its way, the ones
      // being dragged left out.
      const byId = new Map(g.nodes.map(n => [n.id, n]));
      const a = { ...endOf(byId.get(branch.source)!, branch.sourceHandle)! }, b = { ...endOf(byId.get(branch.target)!, branch.targetHandle)! };
      const plain = pathPoints(routeOrthogonal(a, b).d);
      expect(routeOfLine(a, b, branch.data as LineData, inTheWay(plain, obstacleGrid(g.nodes), a, b)), `tick ${k}`).toEqual(plain);
    }
  });
});
