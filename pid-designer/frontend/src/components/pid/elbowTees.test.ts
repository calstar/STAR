// Tees where a pipe turns: an elbow tee sits on the bend, its run faces at
// right angles, and its branches carry the two legs straight on past the
// corner. What a drafter draws when three lines meet at a corner.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import {
  CORNER_GAP, J_END, freeFaces, isJunction, junctionData, junctionEnd, pipeGeometry, pipesOf, reseatJunctions, slideAlong,
} from './junctions';
import type { Along, EndLookup, Face } from './junctions';
import { applyMoves } from './canvasEdits';
import { commitDrop, lineUnder, resolveDrop } from './drop';
import type { DropPlan, DropScene, DropSource, Under } from './drop';
import { dissolveAfterDelete, splitEdgeAt } from './splitEdge';
import { nearestOnPolyline, pathPoints, routeOrthogonal, routeThrough, simplifyPoints } from './route';
import type { Pt } from './route';
import { obstacleBoxes } from './routeGrid';

const P = (x: number, y: number): Pt => ({ x, y });

const part = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id },
});

/** Ports at the middle of each side of a 60 px symbol; a tee's faces with J_END. */
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

const E = (source: string, sh: string, target: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${source}-${target}`, source, sourceHandle: sh, target, targetHandle: th, type: 'smoothstep', data });

interface G { nodes: Node[]; edges: Edge[] }

const byIdOf = (nodes: Node[]) => new Map(nodes.map(n => [n.id, n]));
const centre = (n: Node) => P(n.position.x + 5, n.position.y + 5);
const alongOf = (n: Node) => junctionData(n).along!;
const tees = (g: G) => g.nodes.filter(n => isJunction(n) && junctionData(n).along);
const dataOf = (e: Edge) => (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean; offset?: number };

/** A line as the canvas draws it: through its corners when it has them, J_END on a tee's end. */
function drawn(e: Edge, nodes: Node[]): Pt[] {
  const m = byIdOf(nodes);
  const a = endOf(m.get(e.source)!, e.sourceHandle)!, b = endOf(m.get(e.target)!, e.targetHandle)!;
  const w = dataOf(e).waypoints;
  return simplifyPoints(pathPoints((w?.length ? routeThrough(a, b, w) : routeOrthogonal(a, b, dataOf(e).offset ?? 0)).d));
}

/** The reseat as the canvas runs it, until it hands back the same arrays. */
function settle(g: G, onPage = false): G {
  let { nodes, edges } = g;
  for (let i = 0; i < 10; i++) {
    const re = reseatJunctions(nodes, edges, endOf, onPage ? obstacleBoxes(nodes) : undefined);
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}

const scene = (g: G, zoom = 1): DropScene => ({
  nodes: g.nodes, edges: g.edges, endOf, zoom,
  lines: g.edges.map(e => ({ id: e.id, points: drawn(e, g.nodes) })),
});

/** Resolve a drop as the designer does, the nearest drawn line under the pointer found as it finds it. */
function drop(g: G, source: DropSource, at: Pt, zoom = 1, under: Under = {}): DropPlan {
  const sc = scene(g, zoom);
  return resolveDrop(source, at, { line: lineUnder(sc.lines!, at, zoom), ...under }, sc);
}

/** Resolve and make a drop, and settle what it made. */
function dropped(g: G, source: DropSource, at: Pt, zoom = 1, under: Under = {}): G {
  const plan = drop(g, source, at, zoom, under);
  expect(plan.kind, JSON.stringify(plan)).toBe('connect');
  return settle(commitDrop(plan, scene(g, zoom))!);
}

/** A press on a drawn line, as BranchableEdge hands it to the pull. */
function press(g: G, edgeId: string, at: Pt): DropSource {
  const points = drawn(g.edges.find(e => e.id === edgeId)!, g.nodes);
  const near = nearestOnPolyline(points, at)!;
  return { kind: 'line', edgeId, at: near.point, dir: near.dir, points };
}

const port = (nodeId: string, handle: string): DropSource => ({ kind: 'port', nodeId, handle });

// ── What a clean meeting is ──────────────────────────────────────────────────

/** Does a drawn line turn straight back on itself anywhere: a hook? */
function hooks(pts: Pt[]): boolean {
  for (let i = 0; i + 2 < pts.length; i++) {
    const u = { x: Math.sign(pts[i + 1].x - pts[i].x), y: Math.sign(pts[i + 1].y - pts[i].y) };
    const v = { x: Math.sign(pts[i + 2].x - pts[i + 1].x), y: Math.sign(pts[i + 2].y - pts[i + 1].y) };
    if (u.x === -v.x && u.y === -v.y) return true;
  }
  return false;
}

/** How far two drawn lines lie along each other, nearer than `w`: drawn as one line. */
function lying(p: Pt[], q: Pt[], w = 5): number {
  let t = 0;
  for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
    const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
    if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < w) t += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    else if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < w) t += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
  }
  return t;
}

/** The last leg of a drawn line into `at`: the way it arrives there. */
function arrives(pts: Pt[], at: Pt): Pt {
  const end = Math.hypot(pts[0].x - at.x, pts[0].y - at.y) < Math.hypot(pts[pts.length - 1].x - at.x, pts[pts.length - 1].y - at.y)
    ? [...pts].reverse() : pts;
  const a = end[end.length - 2], b = end[end.length - 1];
  return { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
}

const INTO: Record<Face, Pt> = { t: { x: 0, y: 1 }, b: { x: 0, y: -1 }, l: { x: 1, y: 0 }, r: { x: -1, y: 0 } };

/**
 * Every line on a tee meets it cleanly: each arrives along the axis of the
 * face it is on, into that face, nothing hooks, and no two lie on each other.
 */
function meetsCleanly(g: G, teeId: string) {
  const tee = g.nodes.find(n => n.id === teeId)!;
  const lines = g.edges.filter(e => e.source === teeId || e.target === teeId);
  const faces = lines.map(e => (e.source === teeId ? e.sourceHandle : e.targetHandle) as Face);
  expect(new Set(faces).size, 'one line to a face').toBe(lines.length);
  const pts = lines.map(e => drawn(e, g.nodes));
  lines.forEach((e, i) => {
    const anchor = endOf(tee, faces[i])!;
    expect(hooks(pts[i]), `${e.id} hooks: ${JSON.stringify(pts[i])}`).toBe(false);
    expect(arrives(pts[i], anchor), `${e.id} arrives along its face: ${JSON.stringify(pts[i])}`).toEqual(INTO[faces[i]]);
  });
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    expect(lying(pts[i], pts[j]), `${lines[i].id} lies on ${lines[j].id}`).toBe(0);
  }
}

// ── Three lines meeting at a corner ──────────────────────────────────────────

describe('three lines meeting where a pipe turns', () => {
  // Two valves at different heights joined by the router's jogged pipe:
  // S10.r (60, 30) along to the corner at x = 230, down to y = 230 and along
  // to S11.l (400, 230). A third valve straight above the corner.
  const valves = (): G => ({
    nodes: [part('S10', 0, 0), part('S11', 400, 200), part('S12', 200, -200)],
    edges: [E('S10', 'r', 'S11', 'l')],
  });

  it('the jogged pipe turns where the line from above is let go', () => {
    expect(drawn(valves().edges[0], valves().nodes)).toEqual([P(60, 30), P(230, 30), P(230, 230), P(400, 230)]);
  });

  for (const zoom of [1, 2]) {
    for (const at of [P(230, 31), P(226, 30), P(230, 38)]) {
      it(`puts the tee on the corner, every line meeting it cleanly (let go at ${at.x},${at.y}, zoom ${zoom})`, () => {
        const g = dropped(valves(), port('S12', 'b'), at, zoom);
        const [tee] = tees(g);
        expect(centre(tee)).toEqual(P(230, 30));
        expect([alongOf(tee).in, alongOf(tee).out]).toEqual(['l', 'b']);
        meetsCleanly(g, tee.id);
        // The line from above comes straight down into the corner; the line
        // from S10 runs straight in along its leg; the pipe on to S11 leaves
        // straight down and keeps its bend at the bottom, and nothing else.
        const line = (a: string, b: string) => drawn(g.edges.find(e => (e.source === a && e.target === b) || (e.source === b && e.target === a))!, g.nodes);
        expect(line('S12', tee.id)).toEqual([P(230, -140), P(230, 22)]);
        expect(line('S10', tee.id)).toEqual([P(60, 30), P(222, 30)]);
        expect(line(tee.id, 'S11')).toEqual([P(230, 38), P(230, 230), P(400, 230)]);
        // And the pipe as a whole is the shape it was.
        const geo = pipeGeometry(pipesOf(g.nodes, g.edges)[0], byIdOf(g.nodes), new Map(g.edges.map(e => [e.id, e])), endOf)!;
        expect(geo.pts).toEqual([P(60, 30), P(230, 30), P(230, 230), P(400, 230)]);
      });
    }
  }

  it('is settled: the reseat hands it back as it is, round the page\'s symbols too', () => {
    const g = dropped(valves(), port('S12', 'b'), P(230, 31));
    expect(reseatJunctions(g.nodes, g.edges, endOf)).toEqual({ nodes: g.nodes, edges: g.edges });
    const onPage = settle(g, true);
    const [tee] = tees(onPage);
    expect(centre(tee)).toEqual(P(230, 30));
    meetsCleanly(onPage, tee.id);
  });
});

// ── A pull from a bend ───────────────────────────────────────────────────────

describe('a line pulled out of a pipe at its bend', () => {
  const z = (): G => ({ nodes: [part('A', 0, 0), part('B', 400, 300), part('U', 200, -200), part('R', 500, 0)], edges: [E('A', 'r', 'B', 'l')] });

  it('puts the tee on the bend and leaves it by the face that carries a leg on toward the pull', () => {
    // A.r (60, 30) along to (230, 30), down to (230, 330), along to B.
    // Pressed on the bend (or within a tee's reach of it) and pulled up to
    // U, the branch carries the riser on up; pulled across to R, it carries
    // the first leg on across.
    for (const at of [P(230, 30), P(222, 30), P(230, 40)]) {
      const up = dropped(z(), press(z(), 'A-B', at), P(230, -140), 1, { handle: { nodeId: 'U', handleId: 'b' }, node: 'U' });
      const [t1] = tees(up);
      expect(centre(t1)).toEqual(P(230, 30));
      const toU = up.edges.find(e => e.source === 'U' || e.target === 'U')!;
      expect(toU.source === t1.id ? toU.sourceHandle : toU.targetHandle).toBe('t');
      meetsCleanly(up, t1.id);

      const across = dropped(z(), press(z(), 'A-B', at), P(500, 30), 1, { handle: { nodeId: 'R', handleId: 'l' }, node: 'R' });
      const [t2] = tees(across);
      expect(centre(t2)).toEqual(P(230, 30));
      const toR = across.edges.find(e => e.source === 'R' || e.target === 'R')!;
      expect(toR.source === t2.id ? toR.sourceHandle : toR.targetHandle).toBe('r');
      expect(drawn(toR, across.nodes)).toEqual(toR.source === 'R' ? [P(500, 30), P(238, 30)] : [P(238, 30), P(500, 30)]);
      meetsCleanly(across, t2.id);
    }
  });
});

describe('what a drop at a corner is planned as', () => {
  const z = (): G => ({ nodes: [part('A', 0, 0), part('B', 400, 300), part('R', 500, 0)], edges: [E('A', 'r', 'B', 'l')] });

  it('a line let go on the corner from beside it is planned into the free face on its side', () => {
    // From R, level with the first leg, to the right of the corner: the tee
    // goes on the corner and the line comes in by its right face, carrying
    // the first leg on -- not across a leg, which is all a straight tee has.
    const plan = drop(z(), port('R', 'l'), P(230, 31));
    expect(plan.kind).toBe('connect');
    const to = (plan as Extract<DropPlan, { kind: 'connect' }>).to;
    expect(to).toMatchObject({ kind: 'split', centre: P(230, 30), face: 'r' });
  });

  it('a pull from the corner let go on empty canvas leaves an open end level with the face it leaves by', () => {
    // Let go to the right, five pixels below the first leg's level: the line
    // leaves the elbow by its right face, along the leg, and the open end is
    // put level with it rather than five pixels down, which would jog.
    const g = dropped(z(), press(z(), 'A-B', P(230, 30)), P(400, 35));
    const [tee] = tees(g);
    expect(centre(tee)).toEqual(P(230, 30));
    const open = g.nodes.find(n => isJunction(n) && !junctionData(n).along)!;
    expect(centre(open)).toEqual(P(400, 30));
    meetsCleanly(g, tee.id);
  });
});

// ── Branches from an elbow ───────────────────────────────────────────────────

describe('an elbow tee\'s branches', () => {
  // A.r along to the corner at (230, 30) and down to B.t (230, 300): an L,
  // with an elbow tee on its corner, in from the left and out down.
  const elbow = (): G & { tee: string } => {
    const nodes = [part('A', 0, 0), part('B', 200, 300), part('U', 200, -200), part('R', 500, 0)];
    const edges = [E('A', 'r', 'B', 't')];
    const s = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, { points: drawn(edges[0], nodes) })!;
    return { ...settle(s), tee: s.junctionId };
  };

  it('take the two faces the run leaves free, each carrying a leg straight on past the corner', () => {
    const g = elbow();
    const t = g.nodes.find(n => n.id === g.tee)!;
    expect(freeFaces(alongOf(t))).toEqual(['t', 'r']);
    // One up to U and one across to R, both at once.
    const both = settle({ nodes: g.nodes, edges: [...g.edges, { ...E('U', 'b', g.tee, 'b'), id: 'up' }, { ...E('R', 'l', g.tee, 'l'), id: 'across' }] });
    const up = both.edges.find(e => e.id === 'up')!, across = both.edges.find(e => e.id === 'across')!;
    expect(up.targetHandle).toBe('t');
    expect(across.targetHandle).toBe('r');
    expect(drawn(up, both.nodes)).toEqual([P(230, -140), P(230, 22)]);
    expect(drawn(across, both.nodes)).toEqual([P(500, 30), P(238, 30)]);
    expect(centre(both.nodes.find(n => n.id === g.tee)!)).toEqual(P(230, 30));
    meetsCleanly(both, g.tee);
  });

  it('dropped on the elbow land on the free face on their side', () => {
    for (const [sym, handle, face] of [['U', 'b', 't'], ['R', 'l', 'r']] as const) {
      const g = elbow();
      const after = dropped(g, port(sym, handle), P(230, 30), 1, { node: g.tee });
      const line = after.edges.find(e => e.source === sym || e.target === sym)!;
      expect(line.source === g.tee ? line.sourceHandle : line.targetHandle).toBe(face);
      expect(tees(after)).toHaveLength(1);
      meetsCleanly(after, g.tee);
    }
  });

  it('taken away again, leave the pipe its corner', () => {
    // Deleting the elbow's only branch dissolves it, and the healed line
    // keeps the corner the tee was: neither half carried it.
    const g = elbow();
    const withBranch = settle({ nodes: g.nodes, edges: [...g.edges, { ...E('U', 'b', g.tee, 't'), id: 'up' }] });
    const branch = withBranch.edges.find(e => e.id === 'up')!;
    const left = dissolveAfterDelete([], [branch], withBranch.nodes, withBranch.edges.filter(e => e.id !== 'up'));
    expect(left.nodes.some(n => n.id === g.tee)).toBe(false);
    const healed = left.edges.find(e => e.source === 'A' && e.target === 'B')!;
    expect(dataOf(healed).waypoints).toEqual([P(230, 30)]);
    expect(drawn(healed, left.nodes)).toEqual([P(60, 30), P(230, 30), P(230, 300)]);
  });
});

// ── Sliding a tee onto a bend and past it ────────────────────────────────────

describe('a tee slid along its pipe round a bend', () => {
  // A.r (60, 30) to B.l (400, 330): a Z turning at (230, 30) and (230, 330),
  // a tee on its first leg at x = 150.
  const z = (): G & { tee: string } => {
    const nodes = [part('A', 0, 0), part('B', 400, 300)];
    const edges = [E('A', 'r', 'B', 'l')];
    const s = splitEdgeAt(nodes, edges, 'A-B', P(150, 30), undefined, { points: drawn(edges[0], nodes) })!;
    return { ...settle(s), tee: s.junctionId };
  };
  const shape = (g: G) => pipeGeometry(pipesOf(g.nodes, g.edges)[0], byIdOf(g.nodes), new Map(g.edges.map(e => [e.id, e])), endOf)!.pts;
  const Z = [P(60, 30), P(230, 30), P(230, 330), P(400, 330)];
  /** Drag the tee by React Flow's snapped corner, as the canvas does, and settle. */
  const slide = (g: G & { tee: string }, to: Pt): G & { tee: string } => {
    const moved = applyMoves(g.nodes, [{ type: 'position', id: g.tee, position: { x: to.x - 5, y: to.y - 5 } }], g.edges, endOf).nodes;
    return { ...settle({ nodes: moved, edges: g.edges }), tee: g.tee };
  };

  it('rests on the bend, an elbow, and the pipe keeps its shape', () => {
    const g = z();
    expect(shape(g)).toEqual(Z);
    for (const to of [P(222, 30), P(230, 30), P(230, 38)]) {
      const on = slide(g, to);
      const t = on.nodes.find(n => n.id === g.tee)!;
      expect(centre(t)).toEqual(P(230, 30));
      expect([alongOf(t).in, alongOf(t).out]).toEqual(['l', 'b']);
      expect(shape(on)).toEqual(Z);
      // The bend is the tee's: neither line carries it.
      for (const e of on.edges) expect(dataOf(e).waypoints ?? []).not.toContainEqual(P(230, 30));
      meetsCleanly(on, g.tee);
    }
  });

  it('goes on past it onto the next leg, and the pipe keeps its shape and its corner', () => {
    const g = z();
    const on = slide(g, P(230, 30));
    // From the bend down the riser; then back past it along the first leg.
    for (const [to, at] of [[P(230, 100), P(230, 100)], [P(230, 45), P(230, 50)], [P(150, 30), P(150, 30)], [P(210, 30), P(210, 30)]] as const) {
      const off = slide(on, to);
      const t = off.nodes.find(n => n.id === g.tee)!;
      expect(centre(t), `slid to ${to.x},${to.y}`).toEqual(at);
      expect(shape(off), `slid to ${to.x},${to.y}`).toEqual(Z);
      expect(alongOf(t).corner).toBeUndefined();
      expect(Math.abs(at.x - 230) + Math.abs(at.y - 30)).toBeGreaterThanOrEqual(CORNER_GAP);
      meetsCleanly(off, g.tee);
    }
  });

  it('slid off its corner carries the corner until the reseat hands it to a line', () => {
    const g = slide(z(), P(230, 30));
    const t = g.nodes.find(n => n.id === g.tee)!;
    const slid = slideAlong(t, alongOf(t), P(225, 95), g.edges, byIdOf(g.nodes), endOf)!;
    expect(slid.position).toEqual(P(225, 95));
    expect(slid.along.corner).toEqual(P(0, -70));
    // The faces are still the elbow's: the reseat turns them.
    expect([slid.along.in, slid.along.out]).toEqual(['l', 'b']);
    const nodes = g.nodes.map(n => (n.id === g.tee ? { ...n, position: slid.position, data: { ...n.data, along: slid.along as Along } } : n));
    const after = settle({ nodes, edges: g.edges });
    expect(shape(after)).toEqual(Z);
    const t2 = after.nodes.find(n => n.id === g.tee)!;
    expect([alongOf(t2).in, alongOf(t2).out]).toEqual(['t', 'b']);
    expect(alongOf(t2).corner).toBeUndefined();
    expect(dataOf(after.edges.find(e => e.target === g.tee)!).waypoints).toEqual([P(230, 30)]);
  });
});

// ── A person's pipe ──────────────────────────────────────────────────────────

describe('an elbow on a pipe a person routed', () => {
  // A.r (60, 30) to B.l (400, 330) routed by hand down x = 300, not the
  // router's 230, and an elbow tee put on its upper corner. The pipe is
  // drawn through its corners wherever its ends go, and the corner the tee
  // sits on is one of them, though no line carries it.
  const hand = (): G & { tee: string } => {
    const nodes = [part('A', 0, 0), part('B', 400, 300)];
    const edges = [E('A', 'r', 'B', 'l', { waypoints: [P(300, 30), P(300, 330)], offset: 0 })];
    const s = splitEdgeAt(nodes, edges, 'A-B', P(300, 30), undefined, { points: drawn(edges[0], nodes) })!;
    return { ...settle(s), tee: s.junctionId };
  };
  const shape = (g: G) => pipeGeometry(pipesOf(g.nodes, g.edges)[0], byIdOf(g.nodes), new Map(g.edges.map(e => [e.id, e])), endOf)!.pts;

  it('keeps the corner the tee sits on wherever its ends go', () => {
    const g = hand();
    const t = g.nodes.find(n => n.id === g.tee)!;
    expect(centre(t)).toEqual(P(300, 30));
    expect([alongOf(t).in, alongOf(t).out]).toEqual(['l', 'b']);
    for (const e of g.edges) expect(dataOf(e).viaRun).toBeUndefined();
    const moved = settle({ nodes: g.nodes.map(n => (n.id === 'B' ? { ...n, position: P(500, 300) } : n)), edges: g.edges });
    expect(shape(moved)).toEqual([P(60, 30), P(300, 30), P(300, 330), P(500, 330)]);
    expect(centre(moved.nodes.find(n => n.id === g.tee)!)).toEqual(P(300, 30));
    meetsCleanly(moved, g.tee);
  });

  it('keeps a middle corner of a staircase the tee sits on, which nothing else says where it is', () => {
    // Down from (150, 30) and along from (150, 130): from the corners either
    // side alone the pipe could as well go along first and then down.
    const nodes = [part('A', 0, 0), part('B', 400, 200)];
    const corners = [P(150, 30), P(150, 130), P(250, 130), P(250, 230)];
    const edges = [E('A', 'r', 'B', 'l', { waypoints: corners, offset: 0 })];
    const s = splitEdgeAt(nodes, edges, 'A-B', P(150, 130), undefined, { points: drawn(edges[0], nodes) })!;
    const g = settle(s);
    const t = g.nodes.find(n => n.id === s.junctionId)!;
    expect(centre(t)).toEqual(P(150, 130));
    expect([alongOf(t).in, alongOf(t).out]).toEqual(['t', 'r']);
    const stair = [P(60, 30), ...corners, P(400, 230)];
    expect(shape(g)).toEqual(stair);
    const moved = settle({ nodes: g.nodes.map(n => (n.id === 'B' ? { ...n, position: P(420, 200) } : n)), edges: g.edges });
    expect(shape(moved)).toEqual([P(60, 30), ...corners, P(420, 230)]);
    meetsCleanly(moved, s.junctionId);
  });

  it('keeps a staircase\'s corner when the tee on it is slid off it, either way', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 200)];
    const corners = [P(150, 30), P(150, 130), P(250, 130), P(250, 230)];
    const edges = [E('A', 'r', 'B', 'l', { waypoints: corners, offset: 0 })];
    const s = splitEdgeAt(nodes, edges, 'A-B', P(150, 130), undefined, { points: drawn(edges[0], nodes) })!;
    const g = settle(s);
    const stair = [P(60, 30), ...corners, P(400, 230)];
    for (const to of [P(150, 80), P(200, 130)]) {
      // Dragged by its corner as React Flow reports it, a tick at a time.
      let nodes2 = g.nodes;
      for (const k of [0.5, 1]) {
        const at = P(150 + (to.x - 150) * k, 130 + (to.y - 130) * k);
        nodes2 = applyMoves(nodes2, [{ type: 'position', id: s.junctionId, position: { x: at.x - 5, y: at.y - 5 } }], g.edges, endOf).nodes;
      }
      const after = settle({ nodes: nodes2, edges: g.edges });
      expect(centre(after.nodes.find(n => n.id === s.junctionId)!), `to ${to.x},${to.y}`).toEqual(to);
      expect(shape(after), `to ${to.x},${to.y}`).toEqual(stair);
      meetsCleanly(after, s.junctionId);
    }
  });

  it('keeps its corner when the tee is slid off it, handed to the line on its side', () => {
    const g = hand();
    const moved = applyMoves(g.nodes, [{ type: 'position', id: g.tee, position: { x: 295, y: 95 } }], g.edges, endOf).nodes;
    const after = settle({ nodes: moved, edges: g.edges });
    expect(centre(after.nodes.find(n => n.id === g.tee)!)).toEqual(P(300, 100));
    expect(shape(after)).toEqual([P(60, 30), P(300, 30), P(300, 330), P(400, 330)]);
    const into = after.edges.find(e => e.target === g.tee)!;
    expect(dataOf(into)).toMatchObject({ waypoints: [P(300, 30)] });
    expect(dataOf(into).viaRun).toBeUndefined();
    meetsCleanly(after, g.tee);
  });
});

// ── The reseat leaves its own work alone ─────────────────────────────────────

describe('the reseat with elbow tees', () => {
  it('is idempotent by identity on drawings with tees on bends (randomised)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const grid = (v: number) => Math.round(v / 10) * 10;
    let elbows = 0;
    for (let k = 0; k < 80; k++) {
      let g: G = {
        nodes: [part('A', 0, 0), part('B', grid(200 + rnd() * 300), grid(-250 + rnd() * 500))],
        edges: [E('A', 'r', 'B', (['l', 't', 'b'] as const)[Math.floor(rnd() * 3)])],
      };
      // Up to three tees: on a bend of whatever is drawn, or anywhere along it.
      for (let t = 0; t < 1 + Math.floor(rnd() * 3); t++) {
        const line = g.edges[Math.floor(rnd() * g.edges.length)];
        const pts = drawn(line, g.nodes);
        const at = rnd() < 0.6 && pts.length > 2
          ? pts[1 + Math.floor(rnd() * (pts.length - 2))]
          : P(pts[0].x + (pts[pts.length - 1].x - pts[0].x) * rnd(), pts[0].y);
        const s = splitEdgeAt(g.nodes, g.edges, line.id, at, undefined, { points: pts, endOf });
        if (!s) continue;
        g = settle(s, k % 2 === 0);
        // A branch off it, to a symbol on whichever side.
        if (rnd() < 0.6) {
          const id = `S${t}`;
          const c = centre(g.nodes.find(n => n.id === s.junctionId)!);
          const sym = part(id, grid(c.x - 30 + (rnd() * 300 - 150)), grid(c.y - 30 + (rnd() < 0.5 ? -160 : 160)));
          g = settle({ nodes: [...g.nodes, sym], edges: [...g.edges, { ...E(id, 'b', s.junctionId, 't'), id: `br${t}` }] }, k % 2 === 0);
        }
      }
      for (const n of tees(g)) if (freeFaces(alongOf(n)).length === 2 && alongOf(n).in !== ({ l: 'r', r: 'l', t: 'b', b: 't' } as const)[alongOf(n).out]) elbows++;
      const obstacles = k % 2 === 0 ? obstacleBoxes(g.nodes) : undefined;
      const again = reseatJunctions(g.nodes, g.edges, endOf, obstacles);
      expect(again.nodes, `drawing ${k}`).toBe(g.nodes);
      expect(again.edges, `drawing ${k}`).toBe(g.edges);
      // Every elbow is on a bend of its pipe, and its two lines carry neither it.
      for (const n of tees(g)) {
        const a = alongOf(n);
        if (a.in === ({ l: 'r', r: 'l', t: 'b', b: 't' } as const)[a.out]) continue;
        for (const e of g.edges.filter(x => x.source === n.id || x.target === n.id)) {
          expect(dataOf(e).waypoints ?? [], `drawing ${k}`).not.toContainEqual(centre(n));
        }
      }
    }
    // The sweep is about elbows: enough of them came up to say so.
    expect(elbows).toBeGreaterThan(20);
  });
});
