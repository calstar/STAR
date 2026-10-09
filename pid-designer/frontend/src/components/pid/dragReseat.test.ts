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
import { J_END, centreOfJunction, dragging, isJunction, junctionData, junctionEnd, reseatJunctions } from './junctions';
import type { Dragging, EndLookup, Face } from './junctions';
import { splitEdgeAt } from './splitEdge';
import { applyMoves, followCorners } from './canvasEdits';
import { DOT_CLEAR, LIFT, VENT_REACH, lineGrid, obstacleGrid, obstaclesByPage } from './routeGrid';
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

/** How far two drawn lines run side by side nearer than `within` px. */
function runBeside(p: Pt[], q: Pt[], within: number): number {
  let t = 0;
  const over = (u0: number, u1: number, v0: number, v1: number) =>
    Math.max(0, Math.min(Math.max(u0, u1), Math.max(v0, v1)) - Math.max(Math.min(u0, u1), Math.min(v0, v1)));
  for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
    const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
    if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < within) t += over(a.x, b.x, c.x, d.x);
    else if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < within) t += over(a.y, b.y, c.y, d.y);
  }
  return t;
}

/** How near a drawn line comes to a point. */
const nearest = (run: Pt[], c: Pt) => Math.min(...run.slice(0, -1).map((p, i) => {
  const q = run[i + 1];
  return Math.hypot(c.x - Math.max(Math.min(p.x, q.x), Math.min(Math.max(p.x, q.x), c.x)), c.y - Math.max(Math.min(p.y, q.y), Math.min(Math.max(p.y, q.y), c.y)));
}));

/** Does a drawn line pass through the inside of a box (its edge, and a pixel in, excepted)? */
const through = (run: Pt[], b: { x: number; y: number; w: number; h: number }) => run.slice(0, -1).some((p, i) => {
  const q = run[i + 1];
  if (p.y === q.y) return p.y > b.y + 1 && p.y < b.y + b.h - 1 && Math.max(p.x, q.x) > b.x + 1 && Math.min(p.x, q.x) < b.x + b.w - 1;
  return p.x > b.x + 1 && p.x < b.x + b.w - 1 && Math.max(p.y, q.y) > b.y + 1 && Math.min(p.y, q.y) < b.y + b.h - 1;
});

/** The drawing with the drag let go of: React Flow's `dragging` taken off what it picked up, and settled. */
const letGo = (g: G): G => settle({ nodes: g.nodes.map(n => (n.dragging ? { ...n, dragging: false } : n)), edges: g.edges });

/** A line that routes itself as the canvas draws it (BranchableEdge): round the symbols, vent marks and dots in its way. */
function onCanvas(g: G, id: string): Pt[] {
  const e = g.edges.find(x => x.id === id)!;
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const a = endOf(byId.get(e.source)!, e.sourceHandle)!, b = endOf(byId.get(e.target)!, e.targetHandle)!;
  const plain = pathPoints(routeOrthogonal(a, b).d);
  return routeOfLine(a, b, e.data as LineData, inTheWay(plain, lineGrid(g.nodes, g.edges), a, b));
}
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

describe('a pipe end dragged far out and exactly back', () => {
  // M2 dragged 250 left and 200 down, past M1's port, and then back by as
  // much. Out there the pipe is routed down past M1 and the tee is carried
  // onto the leg the drag bent it into, off the grid. Every tick of the way
  // back kept the tee where that drag had left it -- the crossbar out at
  // M1's stub keeps it exactly there -- and let go at home the pipe still
  // dropped sixteen pixels out of M1 and the branch jogged over to the tee.
  // The tee's home (`Along.home`) is where it was put with the pipe's ends
  // as they are again, and it goes back there, and the pipe with it.
  const lines = (g: G) => g.edges.map(e => drawn(g, e.id));
  const record = (g: G, id: string) => {
    const n = g.nodes.find(x => x.id === id)!;
    return { position: n.position, along: junctionData(n).along };
  };

  it('puts the tee, its pipe and its branch back as they were, however the end came back', () => {
    const g0 = teedZ();
    for (const ticks of [1, 15]) {
      const far = drag(g0, 'M2', [P(320, 620)], ticks);
      expect(teeAt(far, g0.tee), `${ticks} ticks, far`).not.toEqual(P(390, 300));
      // Straight back; and back up first and then along M2's own axis, which
      // leaves the far drag's shape still fitting the ends when it arrives.
      for (const way of [[P(570, 420)], [P(470, 420), P(570, 420)], [P(320, 420), P(570, 420)]]) {
        const back = letGo(drag(far, 'M2', way, ticks));
        const at = `${ticks} ticks, back by ${JSON.stringify(way)}`;
        expect(teeAt(back, g0.tee), at).toEqual(P(390, 300));
        expect(lines(back), at).toEqual(lines(g0));
        expect(drawn(back, 'branch'), at).toHaveLength(2);
        expect(record(back, g0.tee), at).toEqual(record(g0, g0.tee));
      }
    }
  });

  it('puts back a tee saved before it had a home, from where its record says it was put', () => {
    // A drawing saved without `home`: the tee's place, and where its pipe's
    // ends were when it was put there (`ends`), are its home until the first
    // seat that moves it away writes that down.
    const g0 = teedZ();
    const bare = {
      ...g0,
      nodes: g0.nodes.map(n => {
        if (n.id !== g0.tee) return n;
        const { home: _home, ...rest } = junctionData(n).along!;
        void _home;
        return { ...n, data: { ...n.data, along: rest } };
      }),
    };
    const far = drag(bare, 'M2', [P(320, 620)], 15);
    const back = letGo(drag(far, 'M2', [P(570, 420)], 15));
    expect(teeAt(back, g0.tee)).toEqual(P(390, 300));
    expect(lines(back)).toEqual(lines(g0));
  });

  it('leaves a tee the drag never moved, and a pipe it never bent, exactly as they were', () => {
    // M2 nudged down and back: the pipe's crossbar moves under the tee's
    // leg, not the tee, whose record is not written at all.
    const g0 = teedZ();
    const back = letGo(drag(drag(g0, 'M2', [P(570, 460)], 4), 'M2', [P(570, 420)], 4));
    expect(back.nodes.find(n => n.id === g0.tee)).toBe(g0.nodes.find(n => n.id === g0.tee));
    expect(lines(back)).toEqual(lines(g0));
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

  it('takes its tees\' homes with it: an end dragged far out and back where the bay was put finds its tee there', () => {
    // A tee's home is where it was put with its pipe's ends where they were
    // (`Along.home`). Carried whole, the bay is put down with the tee at home
    // where it lands; were the home left where the bay was picked up, the
    // ends would never be back at it, and the tee would stay where a far
    // drag of M2 left it.
    const g0 = teedZ();
    const ids = g0.nodes.map(n => n.id);
    for (const d of [P(-100, 100), P(300, 50)]) {
      const carried = dragGroup(g0, ids, [d], 6);
      expect(teeAt(carried, g0.tee)).toEqual(P(390 + d.x, 300 + d.y));
      const far = drag(carried, 'M2', [P(570 + d.x - 250, 420 + d.y + 200)], 6);
      expect(teeAt(far, g0.tee)).not.toEqual(teeAt(carried, g0.tee));
      const back = letGo(drag(far, 'M2', [P(570 + d.x, 420 + d.y)], 6));
      expect(teeAt(back, g0.tee), `carried by ${d.x},${d.y}`).toEqual(P(390 + d.x, 300 + d.y));
      expect(back.edges.map(e => drawn(back, e.id)), `carried by ${d.x},${d.y}`).toEqual(carried.edges.map(e => drawn(carried, e.id)));
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
  function header(from: 'below' | 'above' = 'below', teeX = 330): G & { tee: string } {
    const M11 = part('M11', 100, 100), M12 = part('M12', 700, 100), TK = part('TK', teeX - 30, -100);
    const S = part('S', 490, from === 'below' ? 300 : -40);
    const O = junction('O', P(520, 160));
    const so = from === 'below' ? E('so', 'S', 't', 'O', 'b') : E('so', 'S', 'b', 'O', 't');
    const g0 = settle({ nodes: [M11, M12, TK, S, O], edges: [E('h1', 'M11', 'r', 'M12', 'l'), so] });
    const split = teeInto(g0, 'h1', P(teeX, 130));
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

  it('lifts the pipe round the open end two grid steps off its centre, a grid step clear of its ring', () => {
    // Lifted one grid step, ten pixels off the open end's centre, the header
    // ran four pixels over the dot's ring, and at most zooms the open end
    // read as hung off it.
    for (const from of ['below', 'above'] as const) {
      const g0 = header(from);
      const after = dragGroup(g0, ['M11', 'M12', g0.tee, 'TK'], [P(0, 30)], 3);
      const round = drawn(after, after.edges.find(e => e.target === 'M12')!.id);
      const lift = from === 'below' ? 160 - LIFT : 160 + LIFT;
      expect(round, from).toEqual([P(338, 160), P(520 - LIFT, 160), P(520 - LIFT, lift), P(520 + LIFT, lift), P(520 + LIFT, 160), P(700, 160)]);
      expect(nearest(round, teeAt(after, 'O')), from).toBeGreaterThanOrEqual(DOT_CLEAR);
    }
  });

  it('sends the pipe round an open end too near its tee for a lift a grid step clear of the ring, clear of the dot itself', () => {
    // The tee twenty-five pixels past the open end: a way round the dot a
    // grid step clear of its ring would turn inside the tee's reach, and
    // push the tee off the bend it brought. Offered only that, the pipe
    // kept its stretch straight through the dot. It goes round as near as
    // it may, clear of the dot and its shadow, and the tee stays put.
    for (const teeX of [545, 495]) {
      const g0 = header('below', teeX);
      const after = dragGroup(g0, ['M11', 'M12', g0.tee, 'TK'], [P(0, 30)], 3);
      expect(teeAt(after, g0.tee), `${teeX}`).toEqual(P(teeX, 160));
      const O = teeAt(after, 'O');
      for (const e of after.edges.filter(x => x.id !== 'so' && x.id !== 'br')) {
        const run = drawn(after, e.id);
        expect(nearest(run, O), `${teeX} ${e.id}: ${JSON.stringify(run)}`).toBeGreaterThan(7);
      }
    }
  });

  it('keeps the lift round the open end where the open end is when the bay is carried on along the header', () => {
    // The tee on the header's far side of the open end, and a valve just
    // under the header's near end. Carried down onto the open end, the
    // header is lifted round it; carried a hundred pixels on along itself,
    // it was lifted again over its whole first line, from the valve's stub
    // to the tee -- as short a way round the dot as any, and further off
    // the valve under it -- and ran ten pixels over its valves' port level
    // for four hundred and fifty pixels. It is lifted where the open end is
    // and nowhere else.
    const g0 = header('below', 680);
    const g1 = settle({ nodes: [...g0.nodes, part('M13', 100, 170)], edges: g0.edges });
    const ids = ['M11', 'M12', g0.tee, 'TK'];
    const first = dragGroup(g1, ids, [P(0, 30)], 3);
    const second = dragGroup(first, ids, [P(-100, 0)], 3);
    const line = second.edges.find(e => e.source === 'M11')!.id;
    const round = drawn(second, line).map(p => P(Math.round(p.x * 1e6) / 1e6, p.y));
    expect(round).toEqual([P(60, 160), P(520 - LIFT, 160), P(520 - LIFT, 160 - LIFT), P(520 + LIFT, 160 - LIFT), P(520 + LIFT, 160), P(572, 160)]);
  });

  it('let go with its tee on a line between two symbols, sends that line round the dot and carries what it picked up whole', () => {
    // A line straight down from TT to TU crosses the header. The bay is
    // picked up and let go with its tee exactly on that line: drawn from its
    // two ends, the line ran straight through the tee's dot, and at any zoom
    // TT and TU read as teed into the header. The bay goes where it is put;
    // the line goes round the dot, a grid step clear of its ring, as it
    // would round any small symbol it does not end on.
    const M11 = part('M11', 100, 100), M12 = part('M12', 700, 100), TK = part('TK', 430, -100);
    const TT = part('TT', 540, -300), TU = part('TU', 540, 400);
    const g0 = settle({ nodes: [M11, M12, TK, TT, TU], edges: [E('h1', 'M11', 'r', 'M12', 'l'), E('tt-tu', 'TT', 'b', 'TU', 't')] });
    const split = teeInto(g0, 'h1', P(330, 130));
    const g = settle({ nodes: split.nodes, edges: [...split.edges, E('br', split.tee, 't', 'TK', 'b')] });
    expect(drawn(g, 'tt-tu')).toEqual([P(570, -240), P(570, 400)]);
    const ids = ['M11', 'M12', split.tee, 'TK'];
    const d = P(240, 0);
    const after = letGo(dragGroup(g, ids, [d], 4));
    for (const n of g.nodes) {
      if (!ids.includes(n.id)) continue;
      const now = after.nodes.find(x => x.id === n.id)!.position;
      expect(now, n.id).toEqual(P(n.position.x + d.x, n.position.y + d.y));
    }
    const tee = teeAt(after, split.tee);
    expect(tee).toEqual(P(570, 130));
    for (const run of [onCanvas(after, 'tt-tu'), drawn(after, 'tt-tu')]) {
      expect(nearest(run, tee), JSON.stringify(run)).toBeGreaterThanOrEqual(DOT_CLEAR);
      expect(run[0], JSON.stringify(run)).toEqual(P(570, -240));
      expect(run[run.length - 1], JSON.stringify(run)).toEqual(P(570, 400));
    }
    // The branch out of the tee's top is not drawn along the line either.
    expect(runBeside(drawn(after, 'br'), drawn(after, 'tt-tu'), 5)).toBe(0);
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
    // tee is put on the nearest point of it; but M2 went straight across the
    // leg the tee is on, which went thirty pixels down with it, and the tee
    // goes straight down onto it, its branch to O1 still straight. (It kept
    // its distance along the pipe from M1, and slid thirty pixels along the
    // bottom leg, to x = 480.)
    const g0 = bay();
    const after = dragGroup(g0, ['M2', 'O1', 'O2'], [P(0, 30)], 6);
    expect(teeAt(after, g0.tees[1])).toEqual(P(510, 480));
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

  it('settles every step of an end dragged far from it in one reseat, with the lines as the drag found them or without', () => {
    // M2 taken 250 left and 200 down in six steps. Told only where the tees
    // were when the drag began, not how the pipe then ran, each tick reads
    // the pipe as the tick before left it (`pipeWas`). On the fourth step the
    // first tee went round the bend onto the upright leg. Run again on that
    // answer, the reseat found the pipe leaving both its ends as it did --
    // neither end had moved -- and took the leg under the tee to have moved
    // only sideways, since no end had gone further along it than across:
    // true of no end at all. So the tee was taken straight across, onto the
    // bend and off it back onto the level leg; from there straight across
    // onto the bottom leg and round the bend up the upright one; and back.
    // Two answers, each the other's reseat: run on its own answer, as the
    // canvas runs it, the reseat flickered the tee between them until the
    // guard on the effect gave up. The same reading had the first step take a
    // second run to settle the other tee. A drag told how the lines ran when
    // it began reads the pipe as it was then, and is held to the same.
    const g0 = bay();
    for (const lines of [false, true]) {
      const moving = dragging(g0.nodes, ['M2'], lines ? g0.edges : undefined);
      let g: G = g0;
      for (let k = 1; k <= 6; k++) {
        const at = `step ${k}, ${lines ? 'with' : 'without'} the lines`;
        const change: NodeChange<Node> = { id: 'M2', type: 'position', position: P(570 - (250 * k) / 6, 420 + (200 * k) / 6), dragging: true };
        const moved = applyMoves(g.nodes, [change], g.edges, endOf, obstaclesByPage(g.nodes));
        const once = reseatJunctions(moved.nodes, g.edges, endOf, obstaclesByPage(moved.nodes), moving);
        const twice = reseatJunctions(once.nodes, once.edges, endOf, obstaclesByPage(once.nodes), moving);
        expect(twice.nodes, at).toBe(once.nodes);
        expect(twice.edges, at).toBe(once.edges);
        g = once;
      }
      const let0 = { nodes: g.nodes.map(n => (n.dragging ? { ...n, dragging: false } : n)), edges: g.edges };
      const once = reseatJunctions(let0.nodes, let0.edges, endOf, obstaclesByPage(let0.nodes));
      const twice = reseatJunctions(once.nodes, once.edges, endOf, obstaclesByPage(once.nodes));
      expect(twice.nodes).toBe(once.nodes);
      expect(twice.edges).toBe(once.edges);
    }
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

describe('a pipe whose end is dragged away from the rest of it', () => {
  it('is drawn clear of the other lines, not along another line\'s leg into a valve', () => {
    // S1 feeds TK through a tee; P0's line comes down and across into V's
    // inlet at y = 160. TK dragged under V: the pipe, routed again whole by
    // its two ends and the symbols alone, ran along y = 160 into V's margin
    // and down, on top of P0's leg into V for a hundred and thirty pixels --
    // both of them legs out of an end, which nothing that moves lines apart
    // may part -- and read as TK fed from V. Looked for among the other
    // lines, it turns down a grid step or two before P0's line comes down.
    const S1 = part('S1', 100, 130), TK = part('TK', 400, 300), P0 = part('P0', 460, 20), V = part('V', 640, 130);
    const g0 = settle({ nodes: [S1, TK, P0, V], edges: [E('run', 'S1', 'r', 'TK', 't'), E('pv', 'P0', 'b', 'V', 'l')] });
    const t = teeInto(g0, 'run', P(250, 160));
    const g = settle({ nodes: t.nodes, edges: t.edges });
    const pipe = (x: G) => x.edges.filter(e => e.id !== 'pv').map(e => drawn(x, e.id));
    const clear = (x: G, at: string) => {
      for (const run of pipe(x)) {
        expect(runBeside(run, drawn(x, 'pv'), 20), `${at}: ${JSON.stringify(run)}`).toBe(0);
      }
    };
    let ticks = 0;
    const after = drag(g, 'TK', [P(660, 250)], 8, x => clear(x, `tick ${++ticks}`));
    clear(after, 'let go');
    expect(teeAt(after, t.tee)).toEqual(P(250, 160));
    expect(drawn(after, 'pv')).toEqual([P(490, 80), P(490, 160), P(640, 160)]);
    // It stays as it is let go: the next reseat keeps it.
    const again = reseatJunctions(after.nodes, after.edges, endOf, obstaclesByPage(after.nodes));
    expect(again.edges).toBe(after.edges);
    expect(again.nodes).toBe(after.nodes);
  });
});

describe('a valve dropped on a pipe, venting out of its free port', () => {
  it('has the pipe sent round the mark on its open port as well as round its body', () => {
    // A pipe straight up from B0 to T0 with a tee on it, and V, fed from W
    // on its left port and venting out of its right. V dragged over until
    // its right edge is on the pipe: the pipe's stretch below the tee went
    // round V fifteen pixels off its body -- straight up through the
    // triangle drawn on V's open port -- and at any zoom read as plumbed
    // into V's outlet.
    const B0 = part('B0', 650, 450), T0 = part('T0', 650, 0), C = part('C', 800, 170), W = part('W', 300, 330), V = part('V', 450, 330);
    const g0 = settle({ nodes: [B0, T0, C, W, V], edges: [E('up', 'B0', 't', 'T0', 'b'), E('wv', 'W', 'r', 'V', 'l')] });
    const t = teeInto(g0, 'up', P(680, 200));
    const g = settle({ nodes: t.nodes, edges: [...t.edges, E('br', t.tee, 'r', 'C', 'l')] });
    const after = letGo(drag(g, 'V', [P(620, 330)], 6));
    const vented = { x: 620, y: 330, w: 60 + VENT_REACH, h: 60 };
    const below = after.edges.find(e => e.source === 'B0')!.id;
    const round = drawn(after, below);
    expect(through(round, vented), JSON.stringify(round)).toBe(false);
    expect(round[0]).toEqual(P(680, 450));
    expect(teeAt(after, t.tee)).toEqual(P(680, 200));
  });
});

describe('the reseat, run on its own answer', () => {
  // The canvas runs the reseat after every change and again on whatever it
  // hands back, and stops when it hands back the very arrays it was given.
  // So what it hands back has to be what it would hand back again: a
  // drawing it would change on a second run is a tee or a crossbar that
  // moves a second time after the pointer has stopped, and two answers that
  // are each the other's reseat flicker between them until the guard on the
  // effect gives up (`reseat.RUNAWAY`).
  const junction = (id: string, c: Pt): Node =>
    ({ id, type: 'JUNCTION', position: { x: c.x - 5, y: c.y - 5 }, data: { componentType: 'JUNCTION', label: id } });
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  }
  const grid = (v: number) => Math.round(v / 10) * 10;

  /** A tee put into line `id` of `g` a fraction `f` of the way along it as drawn, or null when it has no room for one. */
  function teeAtFraction(g: G, id: string, f: number) {
    const pts = drawn(g, id);
    let s = f * pts.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - pts[i].x, q.y - pts[i].y), 0);
    for (let i = 0; i + 1 < pts.length; i++) {
      const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (s <= len) {
        const at = P(pts[i].x + ((pts[i + 1].x - pts[i].x) * s) / len, pts[i].y + ((pts[i + 1].y - pts[i].y) * s) / len);
        const split = splitEdgeAt(g.nodes, g.edges, id, at, undefined, { points: pts, endOf, obstacles: obstaclesByPage(g.nodes) });
        return split && { nodes: split.nodes, edges: split.edges, tee: split.junctionId };
      }
      s -= len;
    }
    return null;
  }

  /**
   * M1.r -> M2.l with one to three tees on it at random, each with a branch
   * up or down to a symbol or an open end, and up to two symbols standing
   * about on nothing.
   */
  function randomBay(r: () => number): G {
    const M2 = part('M2', 270 + grid(200 + r() * 300), 270 + grid(r() * 300 - 150));
    let g = settle({ nodes: [part('M1', 270, 270), M2], edges: [E('run', 'M1', 'r', 'M2', 'l')] });
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const runs = g.edges.filter(e => !e.id.startsWith('b'));
      const t = teeAtFraction(g, runs[Math.floor(r() * runs.length)].id, r());
      if (!t) continue;
      const c = teeAt(t, t.tee);
      const up = r() < 0.5;
      const far = r() < 0.5
        ? part(`T${k}`, grid(c.x - 30 + r() * 200 - 100), grid(up ? c.y - 200 - r() * 100 : c.y + 100 + r() * 100))
        : junction(`O${k}`, P(grid(c.x + r() * 200 - 100), grid(up ? c.y - 150 : c.y + 150)));
      const run = (t.nodes.find(x => x.id === t.tee)!.data as { along: { in: string } }).along.in;
      const face = run === 'l' || run === 'r' ? (up ? 't' : 'b') : (r() < 0.5 ? 'l' : 'r');
      g = settle({ nodes: [...t.nodes, far], edges: [...t.edges, E(`b${k}`, t.tee, face, far.id, up ? 'b' : 't')] });
    }
    const strays = Math.floor(r() * 3);
    for (let k = 0; k < strays; k++) g = settle({ nodes: [...g.nodes, part(`V${k}`, grid(250 + r() * 400), grid(150 + r() * 400))], edges: g.edges });
    return g;
  }

  /**
   * Two or three headers, one above another, with two to five tees put into
   * them at random and branches from each: to a tee on another header (a
   * pipe of its own between the two), to a symbol, or to an open end; and
   * three symbols standing about among them.
   */
  function randomSheet(r: () => number): G {
    const nodes: Node[] = [], edges: Edge[] = [];
    const H = 2 + Math.floor(r() * 2);
    for (let h = 0; h < H; h++) {
      const y = 200 + h * grid(80 + r() * 80);
      nodes.push(part(`A${h}`, grid(100 + r() * 60), y), part(`B${h}`, grid(500 + r() * 200), grid(y + r() * 120 - 60)));
      edges.push(E(`run${h}`, `A${h}`, 'r', `B${h}`, 'l'));
    }
    for (let k = 0; k < 3; k++) nodes.push(part(`V${k}`, grid(200 + r() * 400), grid(100 + r() * 400)));
    let g = settle({ nodes, edges });
    const tees: string[] = [];
    const T = 2 + Math.floor(r() * 4);
    for (let k = 0; k < T; k++) {
      const runs = g.edges.filter(e => !e.id.startsWith('br'));
      const t = teeAtFraction(g, runs[Math.floor(r() * runs.length)].id, r());
      if (!t) continue;
      tees.push(t.tee);
      g = settle({ nodes: t.nodes, edges: t.edges });
    }
    const runOf = (id: string) => (g.nodes.find(n => n.id === id)!.data as { along?: { in: string } }).along;
    const taken = (id: string, face: string) => g.edges.some(e => (e.source === id && e.sourceHandle === face) || (e.target === id && e.targetHandle === face));
    let b = 0;
    for (const t of tees) {
      const run = runOf(t);
      if (!run) continue;
      const faces = run.in === 'l' || run.in === 'r' ? ['t', 'b'] : ['l', 'r'];
      const face = faces[Math.floor(r() * 2)];
      const c = teeAt(g, t);
      const kind = r();
      const others = tees.filter(o => o !== t);
      if (kind < 0.35 && others.length) {
        const o = others[Math.floor(r() * others.length)];
        const orun = runOf(o);
        if (!orun) continue;
        const of = orun.in === 'l' || orun.in === 'r' ? (r() < 0.5 ? 't' : 'b') : (r() < 0.5 ? 'l' : 'r');
        if (taken(o, of)) continue;
        g = { nodes: g.nodes, edges: [...g.edges, E(`br${b++}`, t, face, o, of)] };
      } else if (kind < 0.7) {
        const k = part(`K${b}`, grid(c.x - 30 + r() * 160 - 80), grid(face === 't' ? c.y - 200 : c.y + 140));
        g = { nodes: [...g.nodes, k], edges: [...g.edges, E(`br${b++}`, t, face, k.id, face === 't' ? 'b' : 't')] };
      } else {
        const o = junction(`O${b}`, P(grid(c.x + r() * 160 - 80), grid(c.y + (face === 't' ? -120 : 120))));
        g = { nodes: [...g.nodes, o], edges: [...g.edges, E(`br${b++}`, t, face, o.id, face === 't' ? 'b' : 't')] };
      }
      g = settle(g);
    }
    return g;
  }

  /** The reseat run once on `g` and once on its answer, which has to come back as the same arrays. */
  function settlesInOne(g: G, drag: Dragging | null, at: string): G {
    const once = reseatJunctions(g.nodes, g.edges, endOf, obstaclesByPage(g.nodes), drag);
    const twice = reseatJunctions(once.nodes, once.edges, endOf, obstaclesByPage(once.nodes), drag);
    expect(twice.nodes, at).toBe(once.nodes);
    expect(twice.edges, at).toBe(once.edges);
    return once;
  }

  /**
   * `id` moved `steps` times by `by`, a tick each, as the canvas moves it: in
   * a drag that keeps the lines as it found them, in one that keeps only
   * where the tees were (`drag` above), or a nudge at a time with no drag.
   * Every tick, and letting go, settles in one reseat.
   */
  function stepThrough(g0: G, id: string, by: Pt, steps: number, how: 'lines' | 'tees' | 'nudges', at: string) {
    const moving = how === 'nudges' ? null : dragging(g0.nodes, [id], how === 'lines' ? g0.edges : undefined);
    const p0 = g0.nodes.find(n => n.id === id)!.position;
    let g = g0;
    for (let k = 1; k <= steps; k++) {
      const change: NodeChange<Node> = { id, type: 'position', position: P(p0.x + by.x * k, p0.y + by.y * k), dragging: how !== 'nudges' };
      const moved = applyMoves(g.nodes, [change], g.edges, endOf, obstaclesByPage(g.nodes));
      g = settlesInOne({ nodes: moved.nodes, edges: g.edges }, moving, `${at}, step ${k}`);
    }
    settlesInOne({ nodes: g.nodes.map(n => (n.dragging ? { ...n, dragging: false } : n)), edges: g.edges }, null, `${at}, let go`);
  }

  it('settles every tick of a drag of a bay with one to three tees in one reseat (randomised)', { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= 16; seed++) {
      const r = rng(seed);
      const g0 = randomBay(r);
      const movers = g0.nodes.filter(n => !isJunction(n)).map(n => n.id);
      const id = movers[Math.floor(r() * movers.length)];
      const by = P(grid(r() * 40 - 20), grid(r() * 40 - 20));
      const steps = 5 + Math.floor(r() * 25);
      for (const how of ['tees', 'lines', 'nudges'] as const) stepThrough(g0, id, by, steps, how, `seed ${seed}, ${id} by ${by.x},${by.y}, ${how}`);
    }
  });

  it('settles a sheet of headers teed into one another, nudged a step at a time, in one reseat', { timeout: 30_000 }, () => {
    // Sheets on which one of these took two runs to settle: a pipe the
    // router could only draw through a symbol, straight past an end boxed in
    // by its neighbours, and which the next run sent round the symbol on the
    // one stretch the symbol lay across (`seatPipe`); a pipe sent round a
    // symbol that came out straight along the symbol's edge, which the next
    // run routed afresh off the edge, tee and all (`keptPipe`); and a branch
    // looked for among fewer lines than it was then priced against, whose
    // crossbar the next run moved a grid step over (`amongOf`).
    for (const seed of [22, 472, 573, 576, 1118, 1177]) {
      const r = rng(seed * 31 + 7);
      const g0 = randomSheet(r);
      const movers = g0.nodes.filter(n => !isJunction(n) || (!junctionData(n).along && r() < 0.3)).map(n => n.id);
      const id = movers[Math.floor(r() * movers.length)];
      const by = P(grid(r() * 40 - 20), grid(r() * 40 - 20));
      stepThrough(g0, id, by, 5 + Math.floor(r() * 20), 'nudges', `seed ${seed}, ${id} by ${by.x},${by.y}`);
    }
  });
});
