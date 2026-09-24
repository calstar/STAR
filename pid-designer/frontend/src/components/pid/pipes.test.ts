import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import {
  CORNER_GAP, END_GAP, J_END, TEE_END_GAP, TEE_GAP, adoptTee, dragging, freezePipe, isJunction, junctionData, junctionEnd, keptShape,
  latestSpots, legalSpot, pipeGeometry, pipeOf, pipesOf, pointLines, reseatJunctions, setHandCorners, slideAlong, splitSpot,
  thawPipe,
} from './junctions';
import type { Along, Dragging, EndLookup, Face } from './junctions';
import { dissolveAfterDelete, insertInline, rejoinChains, splitEdgeAt } from './splitEdge';
import { migrate } from './migrate';
import { dragSegment, pathPoints, polylineLength, routeOrthogonal, routeThrough, simplifyPoints, sliceByArc, waypointsOf } from './route';
import { boxOfNode, obstacleBoxes, routeAuto } from './routeGrid';
import { drawnScene } from './tracks';
import type { End, Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });

const part = (id: string, x: number, y: number, type = 'MAN'): Node => ({
  id, type, position: { x, y }, measured: { width: 60, height: 60 },
  data: { componentType: type, label: id },
});
const openEnd = (id: string, cx: number, cy: number): Node => ({
  id, type: 'JUNCTION', position: { x: cx - 5, y: cy - 5 }, measured: { width: 10, height: 10 },
  data: { componentType: 'JUNCTION', label: id },
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

const E = (source: string, sh: string, target: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${source}-${target}`, source, sourceHandle: sh, target, targetHandle: th, type: 'smoothstep', data });

const byIdOf = (nodes: Node[]) => new Map(nodes.map(n => [n.id, n]));
const centre = (n: Node) => P(n.position.x + 5, n.position.y + 5);
const alongOf = (n: Node) => junctionData(n).along!;
const dataOf = (e: Edge) => (e.data ?? {}) as { waypoints?: Pt[]; viaRun?: boolean; offset?: number };

/** A line as BranchableEdge draws it. */
function draw(e: Edge, nodes: Node[]): { pts: Pt[]; a: End; b: End } {
  const m = byIdOf(nodes);
  const a = endOf(m.get(e.source)!, e.sourceHandle)!, b = endOf(m.get(e.target)!, e.targetHandle)!;
  const w = dataOf(e).waypoints;
  return { pts: pathPoints((w?.length ? routeThrough(a, b, w) : routeOrthogonal(a, b, dataOf(e).offset ?? 0)).d), a, b };
}

/** The reseat, as the effect runs it: until it hands back the same arrays. */
function settle(nodes: Node[], edges: Edge[], drag?: Dragging) {
  for (let i = 0; i < 10; i++) {
    const re = reseatJunctions(nodes, edges, endOf, undefined, drag);
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges, runs: i };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}

/** Put a tee into a line where it is drawn, as alt-click does, and settle. */
function tee(nodes: Node[], edges: Edge[], edgeId: string, at: Pt) {
  const e = edges.find(x => x.id === edgeId)!;
  const d = draw(e, nodes);
  const s = splitEdgeAt(nodes, edges, edgeId, at, undefined, { a: d.a, b: d.b, points: d.pts })!;
  return { ...settle(s.nodes, s.edges), id: s.junctionId };
}

/** A.r(60,30) to B.l(400,330): a Z whose vertical leg is at x=230. */
const zPipe = () => ({ nodes: [part('A', 0, 0), part('B', 400, 300)], edges: [E('A', 'r', 'B', 'l')] });

/** The reseat as the canvas runs it, round the page's symbols, until it hands back the same arrays. */
function settleOnPage(nodes: Node[], edges: Edge[], drag?: Dragging) {
  for (let i = 0; i < 10; i++) {
    const re = reseatJunctions(nodes, edges, endOf, obstacleBoxes(nodes), drag);
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}

/** How far two drawn lines run along each other, nearer than `w` px: drawn as one line. */
function along(p: Pt[], q: Pt[], w = 5): number {
  let t = 0;
  for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
    const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
    if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < w) t += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    else if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < w) t += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
  }
  return t;
}

/** Does a drawn line pass nearer than `r` to `c`: through the dot of a junction there? */
const passes = (pts: Pt[], c: Pt, r: number) => pts.slice(0, -1).some((p, i) => {
  const q = pts[i + 1];
  if (p.y === q.y) return Math.abs(p.y - c.y) < r && c.x > Math.min(p.x, q.x) && c.x < Math.max(p.x, q.x);
  return Math.abs(p.x - c.x) < r && c.y > Math.min(p.y, q.y) && c.y < Math.max(p.y, q.y);
});

// ── Where a tee may sit ──────────────────────────────────────────────────────

describe('legalSpot', () => {
  // A Z: 170 along, a bend at s=170, 300 down, a bend at s=470, 170 along.
  const Z = [P(60, 30), P(230, 30), P(230, 330), P(400, 330)];

  it('leaves a legal spot where it is', () => {
    expect(legalSpot(Z, 100)).toBe(100);
    expect(legalSpot(Z, 300)).toBe(300);
  });

  it('keeps a tee a tee\'s reach off every bend, on the leg it was on', () => {
    expect(legalSpot(Z, 165)).toBe(170 - CORNER_GAP);
    expect(legalSpot(Z, 175)).toBe(170 + CORNER_GAP);
    // Exactly on the bend: equally far either way, so the leg before it.
    expect(legalSpot(Z, 170)).toBe(170 - CORNER_GAP);
  });

  it('goes the way the gesture heads when told', () => {
    expect(legalSpot(Z, 170, { prefer: 1 })).toBe(170 + CORNER_GAP);
    expect(legalSpot(Z, 165, { prefer: 1 })).toBe(170 + CORNER_GAP);
    expect(legalSpot(Z, 175, { prefer: -1 })).toBe(170 - CORNER_GAP);
  });

  it('keeps clear of the ends', () => {
    expect(legalSpot(Z, 3)).toBe(END_GAP);
    expect(legalSpot(Z, 638, { endGapB: 20 })).toBe(640 - 20);
  });

  it('never comes within a tee\'s spacing of a neighbour, and never passes it', () => {
    expect(legalSpot(Z, 110, { neighbours: { after: 120 } })).toBe(120 - TEE_GAP);
    expect(legalSpot(Z, 400, { neighbours: { after: 120 } })).toBe(120 - TEE_GAP);
    expect(legalSpot(Z, 50, { neighbours: { before: 60 } })).toBe(60 + TEE_GAP);
  });

  it('skips a leg too short to hold a tee', () => {
    // A 20 px jog: no spot on it is 14 from both of its bends.
    const jog = [P(0, 0), P(100, 0), P(100, 20), P(200, 20)];
    expect(legalSpot(jog, 112)).toBe(100 + 20 + CORNER_GAP);
    expect(legalSpot(jog, 108)).toBe(100 - CORNER_GAP);
    // Halfway along it, neither way is nearer: the leg before.
    expect(legalSpot(jog, 110)).toBe(100 - CORNER_GAP);
  });

  it('puts a tee in the middle of a pipe too short to hold it anywhere', () => {
    expect(legalSpot([P(0, 0), P(20, 0)], 3)).toBe(10);
    expect(legalSpot([P(0, 0), P(20, 0)], 17)).toBe(10);
  });

  it('on a pipe too bent to hold one clear of its bends, keeps at least the bends out from under the tee', () => {
    // Legs of 24: nowhere is 14 from both bends, but a spot 9 from them
    // keeps each bend on one line either side of the tee.
    const bent = [P(0, 0), P(24, 0), P(24, 24), P(48, 24)];
    expect(legalSpot(bent, 24)).toBe(24 - 9);
    expect(legalSpot(bent, 30)).toBe(24 + 9);
    expect(legalSpot(bent, 40)).toBe(48 - 9);
  });

  it('and where not even that can be had, the middle of the longest straight piece', () => {
    const tight = [P(0, 0), P(20, 0), P(20, 10), P(40, 10)];
    expect(legalSpot(tight, 15)).toBe(25);
    expect(legalSpot(tight, 35)).toBe(25);
  });

  it('and that is the longest straight piece\'s middle, not the middle of what the ends allow', () => {
    // A jog of 6 after 18: bends at 18 and 24, and the ends allow 14 to 32.
    // No spot is 14 from both bends, nor 9. Of the straight pieces left --
    // 14..18, 18..24 and 24..32 -- the last is longest, and its middle, 28,
    // is 4 from the nearest bend. The middle of 14..32 is 23, a pixel from
    // the bend at 24: a tee on the corner, whatever it was asked for.
    const jog = [P(0, 0), P(18, 0), P(18, 6), P(40, 6)];
    for (const ask of [0, 15, 20, 23, 28, 40]) expect(legalSpot(jog, ask), `asked for ${ask}`).toBe(28);
  });

  it('is a projection: asking twice changes nothing (randomised)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 400; k++) {
      const pts: Pt[] = [P(0, 0)];
      const legs = 1 + Math.floor(rnd() * 5);
      for (let i = 0; i < legs; i++) {
        const q = pts[pts.length - 1], len = 5 + Math.floor(rnd() * 80);
        pts.push(i % 2 ? P(q.x, q.y + (rnd() < 0.5 ? len : -len)) : P(q.x + len, q.y));
      }
      const L = polylineLength(pts);
      const rules = rnd() < 0.5 ? {} : { neighbours: { before: rnd() * L * 0.5 }, prefer: rnd() < 0.5 ? 1 : -1 };
      const once = legalSpot(pts, rnd() * L, rules);
      expect(legalSpot(pts, once, rules)).toBe(once);
    }
  });
});

// ── Pipes ────────────────────────────────────────────────────────────────────

describe('a pipe', () => {
  it('runs through its riding tees in order, between two ends that are not', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, half.id, P(230, 200));
    const [pipe] = pipesOf(t2.nodes, t2.edges);
    expect(pipe.a.nodeId).toBe('A');
    expect(pipe.b.nodeId).toBe('B');
    expect(pipe.tees).toEqual([t1.id, t2.id]);
    expect(pipe.lines).toHaveLength(3);
    expect(pipeOf(t2.nodes, t2.edges, t2.nodes.find(n => n.id === t1.id)!)).toEqual(pipe);
    expect(pipeOf(t2.nodes, t2.edges, t2.edges.find(e => e.id === pipe.lines[1])!)).toEqual(pipe);
  });

  it('reads a line stored against it', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    // The upstream half redrawn from the tee to A, as a person might.
    const flipped = t1.edges.map(e => (e.target === t1.id
      ? { ...e, source: t1.id, sourceHandle: e.targetHandle, target: 'A', targetHandle: e.sourceHandle } : e));
    const [pipe] = pipesOf(t1.nodes, flipped);
    expect(pipe.a.nodeId).toBe('A');
    expect(pipe.forward).toEqual([false, true]);
  });

  it('ends at a tee it reaches on a branch face', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const nodes = [...t1.nodes, part('C', 120, 200)];
    const branch = E(t1.id, 'b', 'C', 't');
    const t2 = tee(nodes, [...t1.edges, branch], branch.id, P(150, 120));
    const pipe = pipeOf(t2.nodes, t2.edges, t2.nodes.find(n => n.id === t2.id)!)!;
    expect(pipe.a.nodeId).toBe(t1.id);
    expect(pipe.b.nodeId).toBe('C');
  });

  it('is nothing for a ring of tees, which have no ends to route between', () => {
    const along = (inF: Face, outF: Face): Along => ({ t: 0.5, in: inF, out: outF });
    const j = (id: string, x: number, y: number, a: Along): Node => ({ ...openEnd(id, x, y), data: { componentType: 'JUNCTION', label: id, along: a } });
    const nodes = [j('j1', 100, 100, along('l', 'r')), j('j2', 200, 100, along('l', 'r'))];
    const edges = [E('j1', 'r', 'j2', 'l'), { ...E('j2', 'r', 'j1', 'l'), id: 'back' }];
    expect(pipesOf(nodes, edges)).toEqual([]);
    // The reseat stops them riding rather than routing a pipe with no ends.
    const re = reseatJunctions(nodes, edges, endOf);
    expect(re.nodes.every(n => !junctionData(n).along)).toBe(true);
    expect(reseatJunctions(re.nodes, re.edges, endOf).nodes).toBe(re.nodes);
  });
});

describe('where a pipe runs', () => {
  it('is the router\'s route between its ends when nothing is stored', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const pipe = pipesOf(t1.nodes, t1.edges)[0];
    const geo = pipeGeometry(pipe, byIdOf(t1.nodes), new Map(t1.edges.map(e => [e.id, e])), endOf)!;
    expect(geo.pts).toEqual([P(60, 30), P(230, 30), P(230, 330), P(400, 330)]);
    expect(geo.hand).toBe(false);
  });

  it('keeps the shape it was drawn with while that still fits its ends', () => {
    // A valve's downstream half keeps the bend it was cut from...
    const a: End = { x: 160, y: 30, side: Position.Right }, b: End = { x: 400, y: 330, side: Position.Left };
    expect(keptShape(a, b, [P(230, 30), P(230, 330)])).toEqual([P(160, 30), P(230, 30), P(230, 330), P(400, 330)]);
    // ...until an end moves off the corner that belongs to it,
    expect(keptShape(a, { ...b, y: 300 }, [P(230, 30), P(230, 330)])).toBeNull();
    // or past it, so the shape would have to double back,
    expect(keptShape(a, { ...b, x: 200 }, [P(230, 30), P(230, 330)])).toBeNull();
    // or a symbol now sits on it.
    expect(keptShape(a, b, [P(230, 30), P(230, 330)], [{ x: 200, y: 150, w: 60, h: 60 }])).toBeNull();
  });

  it('keeps a shape only if it is drawn exactly as stored', () => {
    // The router snaps a corner within half a pixel of a stub onto the stub.
    // Kept, that would rewrite the corners on every reseat.
    const a: End = { x: 100, y: 0, side: Position.Right }, b: End = { x: 140, y: -50, side: Position.Left };
    expect(keptShape(a, b, [P(115.6, 0), P(115.6, -50)])).toBeNull();
    expect(keptShape(a, b, [P(120, 0), P(120, -50)])).toEqual([P(100, 0), P(120, 0), P(120, -50), P(140, -50)]);
  });

  it('keeps a shape that doubles back only for a pipe', () => {
    // Out right, down, and back left into a port facing right.
    const a: End = { x: 160, y: 30, side: Position.Right }, b: End = { x: 200, y: 330, side: Position.Right };
    const w = [P(230, 30), P(230, 330)];
    expect(keptShape(a, b, w)).toBeNull();
    expect(keptShape(a, b, w, [], true)).toEqual([P(160, 30), P(230, 30), P(230, 330), P(200, 330)]);
  });

  it('goes round the symbols in its way as the router does, asking only about those near it (randomised)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const grid = (v: number) => Math.round(v / 10) * 10;
    for (let k = 0; k < 60; k++) {
      const A = part('A', 0, 0), B = part('B', grid(-500 + rnd() * 1500), grid(-500 + rnd() * 1000));
      const others = Array.from({ length: 40 }, (_, i) => part(`X${i}`, grid(-600 + rnd() * 2200), grid(-900 + rnd() * 1800)))
        .filter(x => Math.hypot(x.position.x, x.position.y) > 90 && Math.hypot(x.position.x - B.position.x, x.position.y - B.position.y) > 90);
      const nodes = [A, B, ...others];
      const t = splitEdgeAt(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(110, 30), undefined, { points: [P(60, 30), P(160, 30)] })!;
      // A pipe with nothing stored on it: the router's route, exactly.
      const bare = t.edges.map(e => ({ ...e, data: {} }));
      const pipe = pipesOf(t.nodes, bare)[0];
      const obstacles = obstacleBoxes(nodes);
      // Ends that carry their own symbol's box, which the router holds
      // against a route as well, and ends that do not.
      const withBody: EndLookup = (n, h) => { const e = endOf(n, h); return e && !isJunction(n) ? { ...e, body: boxOfNode(n) } : e; };
      for (const ends of [endOf, withBody]) {
        for (const boxes of [obstacles, obstacleBoxes(others)]) {
          const geo = pipeGeometry(pipe, byIdOf(t.nodes), new Map(bare.map(e => [e.id, e])), ends, boxes)!;
          const whole = simplifyPoints(pathPoints(routeAuto(ends(A, 'r')!, ends(B, 'l')!, boxes).d));
          expect(geo.pts).toEqual(whole);
        }
      }
    }
  });

  it('is drawn through a person\'s corners wherever the ends go', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 300)];
    const edges = [E('A', 'r', 'B', 'l', { waypoints: [P(300, 30), P(300, 330)], offset: 0 })];
    const t1 = tee(nodes, edges, 'A-B', P(150, 30));
    const moved = t1.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 500, y: 300 } } : n));
    const pipe = pipesOf(moved, t1.edges)[0];
    const geo = pipeGeometry(pipe, byIdOf(moved), new Map(t1.edges.map(e => [e.id, e])), endOf)!;
    expect(geo.hand).toBe(true);
    expect(geo.pts).toEqual([P(60, 30), P(300, 30), P(300, 330), P(500, 330)]);
  });
});

describe('a pipe routed afresh under its tees', () => {
  // A down to B, a tee on the way at y = 310 with a branch in from C's port
  // level with it. B is moved sideways, so the pipe becomes a Z whose
  // crossbar in the middle, (200 + 420) / 2, is right at the tee.
  function tanks() {
    const nodes = [part('A', 650, 140), part('B', 650, 420), part('C', 780, 280)];
    const t = tee(nodes, [E('A', 'b', 'B', 't')], 'A-B', P(680, 310));
    return { ...settle(t.nodes, [...t.edges, { ...E('C', 'l', t.id, 'r'), id: 'branch' }]), id: t.id };
  }

  it('is drawn with the crossbar that leaves its tee where it is, and the branch into it straight', () => {
    const g = tanks();
    for (const drag of [false, true]) {
      let s = { nodes: g.nodes, edges: g.edges };
      const d = drag ? dragging(s.nodes, ['B'], s.edges) : undefined;
      for (let dx = drag ? 5 : 60; dx <= 60; dx += 5) s = settle(s.nodes.map(n => (n.id === 'B' ? { ...n, position: P(650 + dx, 420) } : n)), s.edges, d);
      s = settle(s.nodes, s.edges);
      expect(centre(s.nodes.find(n => n.id === g.id)!), `drag ${drag}`).toEqual(P(680, 310));
      expect(draw(s.edges.find(e => e.id === 'branch')!, s.nodes).pts, `drag ${drag}`).toEqual([P(780, 310), P(688, 310)]);
      const down = s.edges.find(e => e.source === g.id)!;
      expect(draw(down, s.nodes).pts, `drag ${drag}`).toEqual([P(680, 318), P(680, 404), P(740, 404), P(740, 420)]);
    }
  });

  it('puts its tee back where it was when a drag that pushed it off ends where a crossbar leaves it there', () => {
    // B dragged up and across first: no crossbar keeps the tee where it was,
    // and it is pushed along. Then down and further across, to where B's stub
    // does keep it: chosen from where the tee was when the drag began, the
    // pipe is drawn so that it goes back there, as the same move made at once
    // puts it.
    const g = tanks();
    const drag = dragging(g.nodes, ['B'], g.edges);
    let s = settle(g.nodes.map(n => (n.id === 'B' ? { ...n, position: P(710, 330) } : n)), g.edges, drag);
    expect(centre(s.nodes.find(n => n.id === g.id)!)).not.toEqual(P(680, 310));
    s = settle(s.nodes.map(n => (n.id === 'B' ? { ...n, position: P(720, 420) } : n)), s.edges, drag);
    s = settle(s.nodes, s.edges);
    expect(centre(s.nodes.find(n => n.id === g.id)!)).toEqual(P(680, 310));
    expect(draw(s.edges.find(e => e.id === 'branch')!, s.nodes).pts).toEqual([P(780, 310), P(688, 310)]);
  });

  it('is drawn the router\'s own way when no other crossbar leaves every tee where it is', () => {
    // A tee near each end: out at A's stub the crossbar is on the upper tee,
    // out at B's it is beside the lower one, and in the middle only the lower
    // one moves -- to the other leg, sixty pixels off. Out at B's stub moves
    // it less, ten pixels up the leg, but it still moves, and a pipe that is
    // not the router's own is only drawn to leave its tees where they are.
    const nodes = [part('A', 650, 140), part('B', 650, 420)];
    const t1 = tee(nodes, [E('A', 'b', 'B', 't')], 'A-B', P(680, 220));
    const t2 = tee(t1.nodes, t1.edges, t1.edges.find(e => e.source === t1.id)!.id, P(680, 400));
    const s = settle(t2.nodes.map(n => (n.id === 'B' ? { ...n, position: P(710, 420) } : n)), t2.edges);
    const pipe = pipesOf(s.nodes, s.edges)[0];
    const geo = pipeGeometry(pipe, byIdOf(s.nodes), new Map(s.edges.map(e => [e.id, e])), endOf)!;
    expect(geo.pts).toEqual([P(680, 200), P(680, 310), P(740, 310), P(740, 420)]);
    expect(centre(s.nodes.find(n => n.id === t1.id)!)).toEqual(P(680, 220));
  });
});

// ── The reseat ───────────────────────────────────────────────────────────────

describe('the reseat', () => {
  it('seats every tee of a pipe on one route, so a new tee never moves the bend or the other tees', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, half.id, P(230, 100));
    expect(centre(t2.nodes.find(n => n.id === t1.id)!)).toEqual(P(150, 30));
    expect(centre(t2.nodes.find(n => n.id === t2.id)!)).toEqual(P(230, 100));
    const drawnXs = t2.edges.flatMap(e => draw(e, t2.nodes).pts).filter((p, i, a) => i > 0 && a[i - 1].x === p.x).map(p => p.x);
    expect([...new Set(drawnXs)]).toEqual([230]);
  });

  it('hands each line exactly its slice of the pipe, so the lines draw the pipe', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, half.id, P(230, 200));
    const pipe = pipesOf(t2.nodes, t2.edges)[0];
    const geo = pipeGeometry(pipe, byIdOf(t2.nodes), new Map(t2.edges.map(e => [e.id, e])), endOf)!;
    const spots = pipe.tees.map(id => centre(t2.nodes.find(n => n.id === id)!));
    // The first tee at s=90 and the second at s=170+170=340.
    expect(spots).toEqual([P(150, 30), P(230, 200)]);
    const cuts = [0, 90 - 8, 90 + 8, 340 - 8, 340 + 8, geo.length];
    pipe.lines.forEach((id, k) => {
      const e = t2.edges.find(x => x.id === id)!;
      expect(simplifyPoints(draw(e, t2.nodes).pts)).toEqual(simplifyPoints(sliceByArc(geo.pts, cuts[2 * k], cuts[2 * k + 1])));
    });
  });

  it('keeps a tee off a bend the pipe brings to it, and it rides on when that end keeps moving', () => {
    // A tee at x=190 on a straight run; B dragged down, so the pipe's bend
    // comes to x=(60+B.l)/2 -- through the tee at one point of the drag.
    const nodes = [part('A', 0, 0), part('B', 320, 0)];
    let s = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(190, 30));
    for (let by = 10; by <= 200; by += 10) {
      s = { ...settle(s.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 320, y: by } } : n)), s.edges), id: s.id };
      const pipe = pipesOf(s.nodes, s.edges)[0];
      const geo = pipeGeometry(pipe, byIdOf(s.nodes), new Map(s.edges.map(e => [e.id, e])), endOf)!;
      const c = centre(s.nodes.find(n => n.id === s.id)!);
      // On the pipe, and at least a tee's reach from each of its bends.
      const bends = geo.pts.slice(1, -1);
      for (const k of bends) expect(Math.abs(c.x - k.x) + Math.abs(c.y - k.y)).toBeGreaterThanOrEqual(CORNER_GAP - 1e-6);
    }
  });

  it('leaves room for every tee after it, so none is crowded onto a bend', () => {
    // Three tees on a long L; then its far end is pulled in, so the pipe is
    // a 100 px leg and a 40 px one. Two of the tees end up near the bend.
    const nodes = [part('A', 0, 0), part('B', 270, 200)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 't')], 'A-B', P(140, 30));
    const h1 = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, h1.id, P(160, 30));
    const h2 = t2.edges.find(e => e.source === t2.id)!;
    const t3 = tee(t2.nodes, t2.edges, h2.id, P(300, 100));
    const moved = t3.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 130, y: 70 } } : n));
    const s = settle(moved, t3.edges);
    const bend = P(160, 30);
    for (const id of [t1.id, t2.id, t3.id]) {
      const c = centre(s.nodes.find(n => n.id === id)!);
      expect(Math.abs(c.x - bend.x) + Math.abs(c.y - bend.y)).toBeGreaterThanOrEqual(CORNER_GAP - 1e-6);
    }
  });

  it('loses no corner of a hand-routed pipe that tightens round its tee past holding it clear of its bends', () => {
    // A tee put in with room, on the last leg; then B brought in until the
    // legs are 20, 10 and 20. No tee is put into a pipe that tight, but one
    // it already has stays on it: the middle of the short leg, 5 px from
    // each bend, and each bend with the line on its side, still a person's.
    const nodes = [part('A', 0, 0), part('B', 200, 10)];
    const e = E('A', 'r', 'B', 'l', { waypoints: [P(80, 30), P(80, 40)], offset: 0 });
    const t0 = tee(nodes, [e], 'A-B', P(140, 40));
    const t1 = settle(t0.nodes.map(n => (n.id === 'B' ? { ...n, position: P(100, 10) } : n)), t0.edges);
    expect(centre(t1.nodes.find(n => n.id === t0.id)!)).toEqual(P(80, 35));
    expect(dataOf(t1.edges.find(x => x.target === t0.id)!)).toEqual({ offset: 0, waypoints: [P(80, 30)] });
    expect(dataOf(t1.edges.find(x => x.source === t0.id)!)).toEqual({ offset: 0, waypoints: [P(80, 40)] });
    const again = reseatJunctions(t1.nodes, t1.edges, endOf);
    expect(again.edges).toBe(t1.edges);
  });

  it('keeps tees in order and apart', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 0)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, half.id, P(300, 30));
    // Knock the second tee onto the first, as a stale drag might leave it.
    const knocked = t2.nodes.map(n => (n.id === t2.id ? { ...n, position: { x: 200, y: 25 } } : n));
    const s = settle(knocked, t2.edges);
    expect(centre(s.nodes.find(n => n.id === t2.id)!)).toEqual(P(200 + TEE_GAP, 30));
  });

  it('is idempotent by identity on every drawing it makes (randomised)', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const grid = (v: number) => Math.round(v / 10) * 10;
    for (let k = 0; k < 60; k++) {
      let nodes: Node[] = [part('A', 0, 0), part('B', grid(200 + rnd() * 300), grid(-200 + rnd() * 400))];
      let edges: Edge[] = [E('A', 'r', 'B', pick(['l', 't', 'b']))];
      if (rnd() < 0.3) {
        const d = draw(edges[0], nodes).pts;
        const middle = Math.floor((d.length - 1) / 2);
        edges = [{ ...edges[0], data: { waypoints: waypointsOf(dragSegment(d, middle, P(grid(rnd() * 60 - 30), grid(rnd() * 60 - 30)))), offset: 0 } }];
      }
      // Up to three tees at random points along whatever is drawn, some with branches.
      for (let t = 0; t < 1 + Math.floor(rnd() * 3); t++) {
        const line = pick(edges.filter(e => !nodes.find(n => n.id === e.target)?.id.startsWith('o')));
        const d = draw(line, nodes).pts;
        const L = polylineLength(d);
        const at = sliceByArc(d, 0, rnd() * L).pop()!;
        const s = splitEdgeAt(nodes, edges, line.id, at, undefined, { points: d });
        if (!s) continue;
        nodes = s.nodes; edges = s.edges;
        if (rnd() < 0.5) {
          const o = openEnd(`o${k}_${t}`, grid(at.x + rnd() * 200 - 100), grid(at.y + rnd() * 200 - 100));
          nodes = [...nodes, o];
          edges = [...edges, E(s.junctionId, 't', o.id, 'b')];
        }
      }
      const once = reseatJunctions(nodes, edges, endOf);
      const twice = reseatJunctions(once.nodes, once.edges, endOf);
      expect(twice.nodes).toBe(once.nodes);
      expect(twice.edges).toBe(once.edges);
      // Every line of a pipe with room for its tees draws its slice of the
      // pipe and nothing else. (One too short for them -- two tees in 26 px
      // -- puts them in the least bad place, which is not a clean drawing.)
      for (const pipe of pipesOf(once.nodes, once.edges)) {
        const geo = pipeGeometry(pipe, byIdOf(once.nodes), new Map(once.edges.map(e => [e.id, e])), endOf)!;
        const degree = (id: string) => once.edges.filter(e => e.source === id || e.target === id).length;
        const gap = (id: string) => (isJunction(once.nodes.find(n => n.id === id)) && degree(id) > 1 ? 20 : END_GAP);
        if (!latestSpots(geo.pts, pipe.tees.length, { endGapA: gap(pipe.a.nodeId), endGapB: gap(pipe.b.nodeId) })) continue;
        const drawnLength = pipe.lines.reduce((sum, id) => sum + polylineLength(draw(once.edges.find(e => e.id === id)!, once.nodes).pts), 0);
        expect(Math.abs(drawnLength + 2 * 8 * pipe.tees.length - geo.length)).toBeLessThan(0.5 * pipe.lines.length);
      }
      // And after an end moves.
      const moved = once.nodes.map(n => (n.id === pick(['A', 'B']) ? { ...n, position: { x: grid(n.position.x + rnd() * 200 - 100), y: grid(n.position.y + rnd() * 200 - 100) } } : n));
      const m1 = reseatJunctions(moved, once.edges, endOf);
      const m2 = reseatJunctions(m1.nodes, m1.edges, endOf);
      expect(m2.nodes).toBe(m1.nodes);
      expect(m2.edges).toBe(m1.edges);
    }
  });

  it('stays idempotent through slides, parts dropped in, and hand edits (randomised)', () => {
    let seed = 5;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const grid = (v: number) => Math.round(v / 10) * 10;
    for (let k = 0; k < 40; k++) {
      let s = { nodes: [part('A', 0, 0), part('B', grid(250 + rnd() * 250), grid(-200 + rnd() * 400))] as Node[], edges: [E('A', 'r', 'B', 'l')] };
      for (let step = 0; step < 6; step++) {
        const lines = s.edges;
        const line = pick(lines);
        const d = draw(line, s.nodes).pts;
        const at = sliceByArc(d, 0, rnd() * polylineLength(d)).pop()!;
        const r = rnd();
        if (r < 0.35) {
          const sp = splitEdgeAt(s.nodes, s.edges, line.id, at, undefined, { points: d });
          if (sp) s = { nodes: sp.nodes, edges: sp.edges };
        } else if (r < 0.5) {
          const ins = insertInline(s.nodes, s.edges, line.id, at, part(`V${k}_${step}`, 0, 0), { points: d });
          if (ins) s = { nodes: ins.nodes, edges: ins.edges };
        } else if (r < 0.7) {
          const tees = s.nodes.filter(n => isJunction(n) && junctionData(n).along);
          if (tees.length) {
            const t = pick(tees);
            const slid = slideAlong(t, alongOf(t), { x: grid(t.position.x + rnd() * 160 - 80), y: grid(t.position.y + rnd() * 160 - 80) }, s.edges, byIdOf(s.nodes), endOf);
            if (slid) s = { ...s, nodes: s.nodes.map(n => (n.id === t.id ? { ...n, position: slid.position, data: { ...n.data, along: slid.along } } : n)) };
          }
        } else if (r < 0.85 && d.length > 2) {
          const seg = Math.floor(rnd() * (d.length - 1));
          s = { ...s, edges: setHandCorners(s.nodes, s.edges, line.id, waypointsOf(dragSegment(d, seg, P(grid(rnd() * 60 - 30), grid(rnd() * 60 - 30))))) };
        } else {
          const who = pick(s.nodes.filter(n => !isJunction(n)));
          s = { ...s, nodes: s.nodes.map(n => (n.id === who.id ? { ...n, position: { x: grid(n.position.x + rnd() * 160 - 80), y: grid(n.position.y + rnd() * 160 - 80) } } : n)) };
        }
        const once = reseatJunctions(s.nodes, s.edges, endOf);
        const twice = reseatJunctions(once.nodes, once.edges, endOf);
        expect(twice.nodes).toBe(once.nodes);
        expect(twice.edges).toBe(once.edges);
        s = once;
      }
    }
  });

  it('does not rewrite a tee that has not moved when its pipe is re-routed under it', () => {
    // What it recorded about where the pipe's ends were goes stale, and
    // that is all: rewriting it on every re-route made opening a drawing an
    // edit the autosave then saved.
    const nodes = [part('A', 0, 0), part('B', 400, 0)];
    const s = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const moved = s.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 500, y: 0 } } : n));
    const re = reseatJunctions(moved, s.edges, endOf);
    expect(re.nodes.find(n => n.id === s.id)).toBe(s.nodes.find(n => n.id === s.id));
  });

  it('stops a tee riding when a run line is gone, and takes the pipe\'s corners off what is left', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(230, 180));
    const up = t1.edges.find(e => e.target === t1.id)!;
    expect(dataOf(up).viaRun).toBe(true);
    const re = reseatJunctions(t1.nodes, t1.edges.filter(e => e.source !== t1.id), endOf);
    expect(junctionData(re.nodes.find(n => n.id === t1.id)!).along).toBeUndefined();
    const left = re.edges.find(e => e.id === up.id)!;
    expect(dataOf(left).waypoints).toBeUndefined();
    expect(dataOf(left).viaRun).toBeUndefined();
  });

  it('keeps the bend on a valve\'s halves until an end moves off it', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 300)];
    const d = draw(E('A', 'r', 'B', 'l'), nodes);
    const ins = insertInline(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(130, 30), part('V', 0, 0), { points: d.pts })!;
    const kept = reseatJunctions(ins.nodes, ins.edges, endOf);
    expect(kept.edges).toBe(ins.edges);
    const vb = ins.edges.find(e => e.source === 'V')!;
    expect(dataOf(vb).waypoints).toEqual([P(230, 30), P(230, 330)]);
    // B moved level with the valve: the old bend no longer fits.
    const moved = ins.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 400, y: 0 } } : n));
    const re = reseatJunctions(moved, ins.edges, endOf);
    expect(dataOf(re.edges.find(e => e.id === vb.id)!).waypoints).toBeUndefined();
    expect(dataOf(re.edges.find(e => e.id === vb.id)!).viaRun).toBeUndefined();
  });

  it('keeps a pipe\'s own shape that doubles back, while it fits', () => {
    // A jog put into a teed pipe (as a drawing saved before a jog froze the
    // pipe has it: the router's corners, jog and all). Drawn exactly through
    // its corners, it is still the pipe; routed afresh, the jog would go.
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const down = t1.edges.find(e => e.source === t1.id)!;
    const jog = [P(230, 30), P(230, 164), P(280, 164), P(280, 196), P(230, 196), P(230, 330)];
    const edges = t1.edges.map(e => (e.id === down.id ? { ...e, data: { ...e.data, waypoints: jog, viaRun: true, offset: 0 } } : e));
    const re = reseatJunctions(t1.nodes, edges, endOf);
    expect(dataOf(re.edges.find(e => e.id === down.id)!).waypoints).toEqual(jog);
  });

  it('drops a valve\'s bend that a symbol has come to sit on', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 300)];
    const d = draw(E('A', 'r', 'B', 'l'), nodes);
    const ins = insertInline(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(130, 30), part('V', 0, 0), { points: d.pts })!;
    const withC = [...ins.nodes, part('C', 200, 150)];
    const re = reseatJunctions(withC, ins.edges, endOf);
    expect(dataOf(re.edges.find(e => e.source === 'V')!).waypoints).toBeUndefined();
  });

  it('does not hold a symbol on another page against a bend', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 300)];
    const d = draw(E('A', 'r', 'B', 'l'), nodes);
    const ins = insertInline(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(130, 30), part('V', 0, 0), { points: d.pts })!;
    const elsewhere = { ...part('C', 200, 150), data: { componentType: 'MAN', label: 'C', page: 'GSE' } };
    const re = reseatJunctions([...ins.nodes, elsewhere], ins.edges, endOf);
    expect(re.edges).toBe(ins.edges);
  });

  it('moves a branch off a face the tee has turned to run through, even one it cannot price yet', () => {
    // T rides A to B, on a pipe a person has bent down at x=270; a branch
    // leaves T's top face for C, whose port has not been measured, and comes
    // first on the tee. B is moved down, the bend follows it, and T, kept
    // where it is, lands on the pipe's vertical leg: its run now comes in by
    // its top face. A branch left there was taken for the run by the next
    // reseat, and the pipe went through C. (A pipe the router draws no
    // longer brings a bend onto a tee when another of its crossbars leaves
    // the tee where it is, so the bend here is a person's.)
    const nodes = [part('A', 80, -300), part('B', 400, 0), part('C', 100, 100)];
    const bent = E('A', 'r', 'B', 'l', { waypoints: [P(270, -270), P(270, 30)], offset: 0 });
    const t = tee(nodes, [bent], 'A-B', P(330, 30));
    expect([alongOf(t.nodes.find(n => n.id === t.id)!).in]).toEqual(['l']);
    const edges = [E(t.id, 't', 'C', 'unmeasured'), ...t.edges];
    const moved = t.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 400, y: 100 } } : n));
    const once = reseatJunctions(moved, edges, endOf);
    const T = once.nodes.find(n => n.id === t.id)!;
    expect([alongOf(T).in, alongOf(T).out]).toEqual(['t', 'b']);
    expect(['l', 'r']).toContain(once.edges.find(e => e.target === 'C')!.sourceHandle);
    expect(pipesOf(once.nodes, once.edges)[0]).toMatchObject({ a: { nodeId: 'A' }, b: { nodeId: 'B' } });
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
  });

  it('draws the branch to an open end its tee has come to touch as the short line it is, not a loop', () => {
    // The tee on A-B at (200,30), its branch down to an open end whose dot
    // now touches the tee's: centres ten apart. The branch went out of the
    // bottom, round and back up into the open end's bottom, a square hung
    // off the two dots.
    const t1 = tee([part('A', 0, 0), part('B', 400, 0), openEnd('O', 200, 40)], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const s = settle(t1.nodes, [...t1.edges, E(t1.id, 'b', 'O', 't')]);
    const branch = s.edges.find(e => e.target === 'O')!;
    expect(draw(branch, s.nodes).pts).toHaveLength(2);
    expect([branch.sourceHandle, branch.targetHandle]).toEqual(['b', 't']);
  });

  it('puts an open end its tee has come to sit on beside it, so the branch to it is not a loop', () => {
    // The open end nearer than the two dots are wide: its face and the tee's
    // across from it overlap by more than their stubs, and every other pair
    // of faces went out and round, a square loop hung off two dots drawn on
    // top of each other. It goes where the dots touch, on the side it is on
    // -- or, right on the tee's centre, out of the face its line leaves by.
    for (const [at, face, to] of [[36, 'b', 40], [38, 'b', 40], [24, 'b', 20], [30, 'b', 40], [30, 't', 20]] as const) {
      const t1 = tee([part('A', 0, 0), part('B', 400, 0), openEnd('O', 200, at)], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
      const s = settle(t1.nodes, [...t1.edges, E(t1.id, face, 'O', 't')]);
      expect(centre(s.nodes.find(n => n.id === 'O')!), `open end at ${at}`).toEqual(P(200, to));
      const branch = s.edges.find(e => e.target === 'O')!;
      expect(draw(branch, s.nodes).pts, `open end at ${at}`).toHaveLength(2);
    }
    // One the tee does not sit on is where it was put: touching, and clear.
    for (const at of [40, 44, 60]) {
      const t1 = tee([part('A', 0, 0), part('B', 400, 0), openEnd('O', 200, at)], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
      const s = settle(t1.nodes, [...t1.edges, E(t1.id, 'b', 'O', 't')]);
      expect(centre(s.nodes.find(n => n.id === 'O')!)).toEqual(P(200, at));
    }
  });

  it('leaves an open end a dragged tee only passes over where it was', () => {
    // A bay picked up without the open end of its tee's branch, and carried
    // down past it. While the tee sits on it the open end is beside it, and
    // once the tee has gone by it is back where it was put: shoved along
    // from wherever the last tick left it, it went down the page with the
    // tee.
    const t1 = tee([part('A', 0, 0), part('B', 400, 0), openEnd('O', 200, 60)], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    let s = settle(t1.nodes, [...t1.edges, E(t1.id, 'b', 'O', 't')]);
    const bay = new Set(['A', 'B', t1.id]);
    const moving = dragging(s.nodes, bay);
    const start = new Map(s.nodes.map(n => [n.id, n.position]));
    for (let dy = 4; dy <= 60; dy += 4) {
      const moved = s.nodes.map(n => (bay.has(n.id) ? { ...n, position: { x: start.get(n.id)!.x, y: start.get(n.id)!.y + dy } } : n));
      s = settle(moved, s.edges, moving);
      const c = centre(s.nodes.find(n => n.id === t1.id)!), o = centre(s.nodes.find(n => n.id === 'O')!);
      expect(Math.hypot(c.x - o.x, c.y - o.y), `down ${dy}`).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(draw(s.edges.find(e => e.target === 'O')!, s.nodes).pts.length, `down ${dy}`).toBeLessThanOrEqual(2);
    }
    s = settle(s.nodes, s.edges);
    expect(centre(s.nodes.find(n => n.id === 'O')!)).toEqual(P(200, 60));
  });

  it('keeps a pipe\'s shape, and every tee on it, when its ports are measured again a hair off', () => {
    // A Z with a tee on its first leg, settled; then its ports measured at
    // another zoom, a hundred-thousandth of a pixel off. The corners it was
    // given still fit, and nothing is written.
    const t1 = tee([part('A', 0, 0), part('B', 400, 300)], [E('A', 'r', 'B', 'l')], 'A-B', P(150, 30));
    const noisy: EndLookup = (n, h) => {
      const e = endOf(n, h);
      return e && !isJunction(n) ? { ...e, x: e.x + 1.4e-5, y: e.y - 1.1e-5 } : e;
    };
    const again = reseatJunctions(t1.nodes, t1.edges, noisy);
    expect(again.nodes).toBe(t1.nodes);
    expect(again.edges).toBe(t1.edges);
  });

  it('never gives a junction a run by itself, however near a straight line it is put', () => {
    // An open end put down 40 px below the level line from A to B and then
    // carried on to B is a corner somebody chose; one 3 px off, where the
    // grid snap leaves it, is still a junction until a gesture or opening an
    // old drawing makes it ride (`adoptTee`, `migrate`). The reseat used to
    // pull anything within 44 px onto the line, and from then on every drag
    // of it slid along the line: it could never be pulled off again.
    for (const off of [40, 3]) {
      const nodes = [part('A', 0, 0), part('B', 400, 0), openEnd('O', 230, 30 + off)];
      const edges = [E('A', 'r', 'O', 'l'), E('O', 'r', 'B', 'l')];
      const s = settle(nodes, edges);
      const o = s.nodes.find(n => n.id === 'O')!;
      expect(centre(o)).toEqual(P(230, 30 + off));
      expect(junctionData(o).along).toBeUndefined();
    }
  });

  it('leaves such a tee alone when it is on its run already, so opening an old drawing is not an edit', () => {
    const nodes = [part('A', 100, 100), part('B', 400, 100), openEnd('T', 280, 130)];
    const edges = [E('A', 'r', 'T', 'l'), E('T', 'r', 'B', 'l')];
    const re = reseatJunctions(nodes, edges, endOf);
    expect(re.nodes).toBe(nodes);
    expect(re.edges).toBe(edges);
  });

  it('adopts on request only a tee on its straight run, within the router\'s in-line tolerance', () => {
    // Within it the router draws the two lines through the tee as one
    // straight run; further off, the tee is at a bend in them.
    const at = (off: number) => ({
      nodes: [part('A', 100, 100), part('B', 400, 100), openEnd('T', 280, 130 + off)],
      edges: [E('A', 'r', 'T', 'l'), E('T', 'r', 'B', 'l')],
    });
    const near = at(3);
    expect(alongOf(adoptTee(near.nodes, near.edges, 'T', endOf).nodes.find(n => n.id === 'T')!)).toMatchObject({ in: 'l', out: 'r' });
    const far = at(10);
    const r = adoptTee(far.nodes, far.edges, 'T', endOf);
    expect(r.nodes).toBe(far.nodes);
    expect(r.edges).toBe(far.edges);
  });

  it('is idempotent after a run line is deleted from under a branched tee', () => {
    // A.r (60,30) to B.l (400,36): a Z. Two tees on its last leg, the first
    // branched to an open end level with A's port. The run line between the
    // tees goes: the first stops riding, and its lines, free now, turn to
    // make a straight line from A to the open end through it. That must not
    // make it ride on the next reseat.
    const nodes = [part('A', 0, 0), part('B', 400, 6), openEnd('O', 330, 30)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(280, 36));
    const down = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, down.id, P(360, 36));
    // The branch is a hose, so what is left through the first tee is two
    // kinds of line and the delete leaves it be (a tee left as a dot between
    // two lines of one kind is healed away: canvasEdits.test.ts).
    const s = settle(t2.nodes, [...t2.edges, E(t1.id, 't', 'O', 'l', { lineType: 'flex_hose' })]);
    const run = s.edges.find(e => e.source === t1.id && e.target === t2.id)!;
    const d = dissolveAfterDelete([], [run], s.nodes, s.edges.filter(e => e !== run));
    const once = reseatJunctions(d.nodes, d.edges, endOf);
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
    expect(junctionData(once.nodes.find(n => n.id === t1.id)!).along).toBeUndefined();
  });

  it('does not let a pipe that loops back into one of its own tees ride round it', () => {
    // S into T1, on through T2, and back into T1's bottom face: the pipe
    // ends on a tee whose place depends on where the pipe runs. Seated, it
    // moved the tee, which moved its own end, and the reseat never settled.
    // T1 stops riding and stays where it is; T2 rides the loop from T1 to T1.
    const nodes = [part('S', 0, 0)];
    const t1 = tee([...nodes, part('B', 400, 0)], [E('S', 'r', 'B', 'l')], 'S-B', P(150, 30));
    const onward = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, onward.id, P(300, 30));
    // Take B away and bring T2's out line back into T1 from below.
    const edges = t2.edges.map(e => (e.target === 'B' ? { ...e, target: t1.id, targetHandle: 'b' } : e));
    const loop = { nodes: t2.nodes.filter(n => n.id !== 'B'), edges };
    const once = reseatJunctions(loop.nodes, loop.edges, endOf);
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
    expect(junctionData(once.nodes.find(n => n.id === t1.id)!).along).toBeUndefined();
    expect(centre(once.nodes.find(n => n.id === t1.id)!)).toEqual(P(150, 30));
    expect(junctionData(once.nodes.find(n => n.id === t2.id)!).along).toBeDefined();
  });

  it('does not let a ring of pipes, each ending on a tee of the next, ride round it', () => {
    // P runs from X through TP into TQ's top face; Q from Y through TQ into
    // TP's bottom face. Where each pipe runs depends on where the other's tee
    // is, round and round. The tee that closes the ring stops riding.
    const nodes = [part('X', 0, 0), part('PB', 400, 0), part('Y', 0, 200), part('QB', 400, 200)];
    const p = tee(nodes, [E('X', 'r', 'PB', 'l'), E('Y', 'r', 'QB', 'l')], 'X-PB', P(200, 30));
    const q = tee(p.nodes, p.edges, 'Y-QB', P(250, 230));
    // PB and QB go; P's out line goes down into TQ's top, Q's up into TP's bottom.
    const edges = q.edges.map(e => {
      if (e.target === 'PB') return { ...e, target: q.id, targetHandle: 't' };
      if (e.target === 'QB') return { ...e, target: p.id, targetHandle: 'b' };
      return e;
    });
    const ring = { nodes: q.nodes.filter(n => n.id !== 'PB' && n.id !== 'QB'), edges };
    const once = reseatJunctions(ring.nodes, ring.edges, endOf);
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
    const riding = [p.id, q.id].filter(id => junctionData(once.nodes.find(n => n.id === id)!).along);
    expect(riding).toHaveLength(1);
  });

  it('adopts a tee on request, as a split would have made it', () => {
    const nodes = [part('A', 100, 100), part('B', 400, 100), openEnd('T', 280, 130)];
    const edges = [E('A', 'r', 'T', 'b'), E('T', 't', 'B', 'l')];
    const a = adoptTee(nodes, edges, 'T', endOf);
    expect(alongOf(a.nodes.find(n => n.id === 'T')!)).toMatchObject({ in: 'l', out: 'r', from: 'A', to: 'B' });
    expect(a.edges.map(e => (e.source === 'T' ? e.sourceHandle : e.targetHandle))).toEqual(['l', 'r']);
    expect(adoptTee(a.nodes, a.edges, 'T', endOf).nodes).toBe(a.nodes);
  });

  it('does not adopt a tee whose lines make two straight runs through it', () => {
    // A cross: A to B level through T, C to D plumb through it. Either could
    // be the run, and whichever came first in the drawing would make the
    // other two lines branches of it -- a choice the drawing does not make.
    const nodes = [part('A', 100, 100), part('B', 400, 100), part('C', 250, -100), part('D', 250, 300), openEnd('T', 280, 130)];
    const edges = [E('A', 'r', 'T', 'l'), E('T', 'r', 'B', 'l'), E('C', 'b', 'T', 't'), E('T', 'b', 'D', 't')];
    const a = adoptTee(nodes, edges, 'T', endOf);
    expect(a.nodes).toBe(nodes);
    expect(a.edges).toBe(edges);
    expect(junctionData(migrate({ nodes, edges }).nodes.find(n => n.id === 'T')!).along).toBeUndefined();
    // One straight run and a branch is adopted, the branch left a branch.
    const one = adoptTee(nodes.filter(n => n.id !== 'D'), edges.filter(e => e.target !== 'D'), 'T', endOf);
    expect(alongOf(one.nodes.find(n => n.id === 'T')!)).toMatchObject({ in: 'l', out: 'r', from: 'A', to: 'B' });
  });

  it('does not adopt a tee whose run would close a ring of tees', () => {
    // R2 and R1 ride one pipe that leaves the free junction T by its right
    // face and comes back into its left, T on the straight run between them.
    // Riding it, T would have no pipe with two ends to be on: the next reseat
    // would find a ring of tees and stop all three riding.
    const rider = (id: string, cx: number, a: Along): Node => ({ ...openEnd(id, cx, 30), data: { componentType: 'JUNCTION', label: id, along: a } });
    const nodes = [
      rider('R2', 100, { t: 0.5, in: 'l', out: 'r', from: 'T', to: 'T' }),
      openEnd('T', 200, 30),
      rider('R1', 300, { t: 0.5, in: 'l', out: 'r', from: 'T', to: 'T' }),
    ];
    const edges = [E('R2', 'r', 'T', 'l'), E('T', 'r', 'R1', 'l'), E('R1', 'r', 'R2', 'l')];
    const riding = (ns: Node[]) => ns.filter(n => junctionData(n).along).map(n => n.id).sort();
    const a = adoptTee(nodes, edges, 'T', endOf);
    expect(a.nodes).toBe(nodes);
    expect(a.edges).toBe(edges);
    expect(riding(settle(a.nodes, a.edges).nodes)).toEqual(['R1', 'R2']);
    // Opening a drawing adopts through the same door.
    const opened = migrate({ nodes, edges });
    expect(riding(opened.nodes)).toEqual(['R1', 'R2']);
    expect(riding(settle(opened.nodes, opened.edges).nodes)).toEqual(['R1', 'R2']);
  });
});

// ── Faces ────────────────────────────────────────────────────────────────────

describe('the faces lines take at a tee', () => {
  const branchFaces = (edges: Edge[], teeId: string) =>
    edges.filter(e => (e.source === teeId || e.target === teeId)).map(e => (e.source === teeId ? e.sourceHandle : e.targetHandle));

  it('are shared out: two branches on a tee take its two faces, even when both would rather have one', () => {
    const nodes = [part('A', 0, 170), part('B', 600, 170), part('D', 300, 320), part('E', 420, 320)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(330, 200));
    const s = settle(t.nodes, [...t.edges, E(t.id, 'b', 'D', 't'), E('E', 't', t.id, 'b')]);
    expect(branchFaces(s.edges, t.id).sort()).toEqual(['b', 'l', 'r', 't']);
  });

  it('are shared out even where sharing one face would cost less than the way round', () => {
    // Two symbols below the run, just either side of the tee: out of the
    // bottom face, each branch is a short L, and the two lie on each other
    // down the stub. The top face takes one of them over the run and back
    // down, a long way round -- and still it goes, since two lines drawn on
    // top of each other out of one face read as one.
    const nodes = [part('A', 0, 0), part('B', 340, 0), part('C', 100, 40), part('D', 240, 40)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const s = settle(t.nodes, [...t.edges, E(t.id, 'b', 'C', 'r'), E(t.id, 'b', 'D', 'l')]);
    expect(branchFaces(s.edges, t.id).sort()).toEqual(['b', 'l', 'r', 't']);
  });

  it('are shared out on an open end, whose arriving line keeps its face', () => {
    const nodes = [part('A', 0, 0), part('C', 40, 150), openEnd('O', 200, 30)];
    const s = settle(nodes, [E('A', 'r', 'O', 'l'), E('O', 'l', 'C', 't')]);
    const faces = branchFaces(s.edges, 'O');
    expect(faces[0]).toBe('l');
    expect(faces[1]).not.toBe('l');
  });

  it('never send a branch across its own pipe when the other face goes clear', () => {
    // An L pipe, a tee on its first leg, a valve below and right of the bend.
    const nodes = [part('A', 0, 0), part('B', 300, 400), part('C', 300, 500)];
    const t = tee(nodes, [E('A', 'r', 'B', 't')], 'A-B', P(120, 30));
    const s = settle(t.nodes, [...t.edges, E(t.id, 'b', 'C', 'r')]);
    expect(s.edges.find(e => e.target === 'C')!.sourceHandle).toBe('t');
  });

  it('prefer a crossbar in a narrow gap beside the pipe to crossing the pipe', () => {
    // A tank 17 px under a header: the branch down to its lid is a Z whose
    // crossbar runs 12.5 px under the header. Going over the top would cross it.
    const nodes = [part('A', 100, 170), part('B', 500, 170), { ...part('T', 230, 217, 'TANK'), measured: { width: 60, height: 100 } }];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(300, 200));
    const s = settle(t.nodes, [...t.edges, E(t.id, 't', 'T', 't')]);
    expect(s.edges.find(e => e.target === 'T')!.sourceHandle).toBe('b');
  });

  it('keep a branch out of the gap beside its own pipe when a way round is clear', () => {
    // Two pipes side by side 14 px apart, the second between two open ends
    // and shorter; a tee on each, and a branch between the tees. Straight
    // across into the second tee's near face, the branch runs down the gap
    // seven pixels from both pipes, and the three read as one fat pipe. Over
    // the top of the shorter pipe into its far face is longer, and clear.
    const nodes = [part('A', 70, 0), part('B', 70, 600), openEnd('O1', 114, 250), openEnd('O2', 114, 420)];
    const t1 = tee(nodes, [E('A', 'b', 'B', 't'), E('O1', 'b', 'O2', 't')], 'A-B', P(100, 200));
    const t2 = tee(t1.nodes, t1.edges, 'O1-O2', P(114, 330));
    for (const face of ['l', 'r']) {
      const s = settle(t2.nodes, [...t2.edges, { ...E(t1.id, 'r', t2.id, face), id: 'branch' }]);
      const branch = s.edges.find(e => e.id === 'branch')!;
      expect([branch.sourceHandle, branch.targetHandle], `starting on ${face}`).toEqual(['r', 'r']);
      expect(draw(branch, s.nodes).pts).toEqual([P(108, 200), P(128, 200), P(128, 330), P(122, 330)]);
    }
  });

  it('never lay a branch along its own pipe, even to save a crossing', () => {
    // An L pipe; a tee on its vertical leg; the target up and to the left,
    // beyond the horizontal leg. Leaving to the right runs back along that
    // leg 2 px from it; leaving to the left crosses it once.
    const nodes = [part('A', 0, 0), part('B', 300, 400), part('C', 100, -100)];
    const t = tee(nodes, [E('A', 'r', 'B', 't')], 'A-B', P(330, 100));
    const s = settle(t.nodes, [...t.edges, E(t.id, 'r', 'C', 'l')]);
    expect(s.edges.find(e => e.target === 'C')!.sourceHandle).toBe('l');
  });

  it('keep two lines on an open end off each other, even with a face each', () => {
    // Up from A below into the open end; on to C, whose top port is on the
    // way up. Straight up into the bottom face, the other line has to come
    // down onto C's port along it; so it comes in by a side face instead.
    // Ports measured as the designer measures them, 3 px out.
    const measured: EndLookup = (node, handle) => {
      const e = endOf(node, handle);
      if (!e || isJunction(node)) return e;
      const out = { l: P(-3, 0), r: P(3, 0), t: P(0, -3), b: P(0, 3) }[handle as Face];
      return { ...e, x: e.x + out.x, y: e.y + out.y };
    };
    let ns: Node[] = [part('A', 270, 440), part('C', 270, 363), openEnd('O', 300, 300)];
    let es: Edge[] = [E('A', 't', 'O', 'b'), E('O', 'l', 'C', 't')];
    for (let i = 0; i < 5; i++) {
      const re = reseatJunctions(ns, es, measured);
      if (re.nodes === ns && re.edges === es) break;
      ns = re.nodes; es = re.edges;
    }
    const drawn = (e: Edge) => {
      const m = byIdOf(ns);
      return pathPoints(routeOrthogonal(measured(m.get(e.source)!, e.sourceHandle)!, measured(m.get(e.target)!, e.targetHandle)!).d);
    };
    const [p, q] = es.map(drawn);
    let shared = 0;
    for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
      const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
      if (a.x === b.x && c.x === d.x && a.x === c.x) shared += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
      if (a.y === b.y && c.y === d.y && a.y === c.y) shared += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    }
    expect(shared).toBe(0);
  });

  it('keep the face a line has when another is exactly as good', () => {
    // A target level with the run beyond its end: up and over, or down and
    // under, are mirror images.
    const nodes = [part('A', 0, 170), part('B', 300, 170), part('C', 400, 170)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(180, 200));
    for (const face of ['t', 'b']) {
      const s = settle(t.nodes, [...t.edges, E(t.id, face, 'C', 'l')]);
      expect(s.edges.find(e => e.target === 'C')!.sourceHandle).toBe(face);
    }
  });

  it('keep the face a pipe has when another is exactly as good, and its tees where they are', () => {
    // The same mirror-image branch, with a tee put on its crossbar: it is a
    // pipe now, priced as a whole, and over or under are still exactly as
    // good. Taking the first of two equal answers flipped it over the run,
    // and the tee on it with it, on a reseat nothing had asked for.
    const nodes = [part('A', 0, 170), part('B', 300, 170), part('C', 400, 170)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(180, 200));
    for (const face of ['t', 'b']) {
      const s = settle(t.nodes, [...t.edges, E(t.id, face, 'C', 'l')]);
      const branch = s.edges.find(e => e.target === 'C')!;
      const crossbar = draw(branch, s.nodes).pts.slice(1, 3);
      expect(crossbar[0].y, face).toBe(crossbar[1].y);
      const t2 = tee(s.nodes, s.edges, branch.id, P((crossbar[0].x + crossbar[1].x) / 2, crossbar[0].y));
      expect(t2.edges.find(e => e.source === t.id && e.target === t2.id)!.sourceHandle, face).toBe(face);
      const c = centre(t2.nodes.find(n => n.id === t2.id)!);
      expect(Math.sign(c.y - 200), face).toBe(face === 't' ? -1 : 1);
    }
  });

  it('keep a line out of a symbol in its way', () => {
    // An open end below and right of A's bottom port. Straight in by its
    // left face is shortest, but runs through S; by its top face is clear.
    const nodes = [part('A', 100, 100), part('S', 170, 270), openEnd('O', 300, 300)];
    const s = settle(nodes, [E('A', 'b', 'O', 'l')]);
    expect(s.edges[0].targetHandle).toBe('t');
    const clear = settle(nodes.filter(n => n.id !== 'S'), [E('A', 'b', 'O', 't')]);
    expect(clear.edges[0].targetHandle).toBe('l');
  });

  it('re-route, in the same reseat, a pipe whose end on another tee\'s branch face moved', () => {
    // A branch off T1 down to C, with a tee of its own; its face on T1 is
    // left pointing away from C.
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const nodes = [...t1.nodes, part('C', 120, 250)];
    const branch = E(t1.id, 'b', 'C', 't');
    const t2 = tee(nodes, [...t1.edges, branch], branch.id, P(150, 150));
    const wrong = t2.edges.map(e => (e.source === t1.id && e.target === t2.id ? { ...e, sourceHandle: 't' } : e));
    const once = reseatJunctions(t2.nodes, wrong, endOf);
    expect(once.edges.find(e => e.source === t1.id && e.target === t2.id)!.sourceHandle).toBe('b');
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
  });

  it('route a pipe to where the tee it ends on is put, in the same reseat', () => {
    // T1 on A-B, 20 px from A; a branch pipe from T1 down to C, with a tee of
    // its own that comes first in the drawing. A moves right onto T1, which
    // is pushed along the run, and the branch pipe has to follow it.
    const nodes = [part('A', 0, 0), part('B', 400, 0), part('C', 250, 300)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(80, 30));
    const branch = E(t1.id, 'b', 'C', 't');
    const t2 = tee(t1.nodes, [...t1.edges, branch], branch.id, P(80, 100));
    const order = [...t2.nodes].sort((x, y) => (x.id === t2.id ? -1 : y.id === t2.id ? 1 : 0));
    const moved = order.map(n => (n.id === 'A' ? { ...n, position: { x: 20, y: 0 } } : n));
    const once = reseatJunctions(moved, t2.edges, endOf);
    expect(centre(once.nodes.find(n => n.id === t1.id)!)).toEqual(P(80 + END_GAP, 30));
    expect(centre(once.nodes.find(n => n.id === t2.id)!).x).toBe(80 + END_GAP);
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
  });

  it('leave a pipe a person has routed on the faces it has', () => {
    // A branch pipe off the tee's bottom face, with a tee of its own, down to
    // C. C is then moved up above the run, where the top face draws a route
    // afresh better. The router's pipe turns to it; a person's keeps the face
    // its corners were drawn from -- priced through corners the router
    // refits to whichever face it is on, it went back and forth between the
    // two from one reseat to the next.
    const nodes = [part('A', 0, 170), part('B', 600, 170), part('C', 380, 400)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 200));
    const branch = E(t.id, 'b', 'C', 'l');
    const t2 = tee(t.nodes, [...t.edges, branch], branch.id, P(200, 300));
    const face = (edges: Edge[]) => edges.find(e => e.source === t.id && e.target === t2.id)!.sourceHandle;
    expect(face(t2.edges)).toBe('b');
    const up = t2.nodes.map(n => (n.id === 'C' ? { ...n, position: { x: 380, y: 0 } } : n));
    expect(face(pointLines(t2.edges, byIdOf(up), endOf))).toBe('t');
    const last = t2.edges.find(e => e.source === t2.id)!;
    const byHand = setHandCorners(t2.nodes, t2.edges, last.id, waypointsOf(draw(last, t2.nodes).pts));
    expect(face(pointLines(byHand, byIdOf(up), endOf))).toBe('b');
  });

  it('are chosen once, where a line\'s far end is a choice made later in the same reseat', () => {
    // J stopped riding when its in line went; its lines are free to take any
    // face. The open end O comes first in the drawing, so the line from J to
    // O is chosen there, with J's face at the far end only guessed at, and
    // settled later at J. A guess that leaned on the face J had then leaned
    // the other way on the next reseat, once J's face had changed.
    const J: Node = { ...openEnd('J', 388.32, 338), data: { componentType: 'JUNCTION', label: 'J', along: { t: 0.17, in: 't', out: 'b', from: 'gone', to: 'O' } } };
    const nodes = [part('S0', 160, 330), part('S2', 200, 280), part('S3', 670, 390), openEnd('O', 430, 400), J, part('X', 260, 470)];
    const edges: Edge[] = [
      E('J', 'b', 'O', 'l', { offset: 0, waypoints: [P(388.32, 400)], viaRun: true }),
      E('J', 'l', 'X', 'l'),
      E('S2', 'r', 'S3', 't', { offset: 0, waypoints: [P(700, 310)], viaRun: true }),
    ];
    const once = reseatJunctions(nodes, edges, endOf);
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.edges).toBe(once.edges);
    expect(twice.nodes).toBe(once.nodes);
  });

  it('keep what they have when nothing has changed', () => {
    const nodes = [part('A', 0, 170), part('B', 600, 170), part('D', 300, 320)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(330, 200));
    const edges = [...t.edges, E(t.id, 'b', 'D', 't')];
    const once = pointLines(edges, byIdOf(t.nodes), endOf);
    expect(pointLines(once, byIdOf(t.nodes), endOf)).toBe(once);
  });

  it('send a branch straight into an open end its pipe has come to run just above, not round the pipe\'s corner', () => {
    // A person's pipe from A right to x = 490, down, and on to B, a tee on
    // its lower leg with a branch straight down to an open end. B dragged
    // 100 px down takes the lower leg with it to just above the open end,
    // and the tee, kept where it was, lands on the pipe's vertical leg.
    const nodes = [part('A', 270, 270), part('B', 570, 420), openEnd('O', 510, 560)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l', { waypoints: [P(490, 300), P(490, 450)], offset: 0 })], 'A-B', P(510, 450));
    let s = settle(t.nodes, [...t.edges, { ...E(t.id, 'b', 'O', 't'), id: 'branch' }]);
    expect(draw(s.edges.find(e => e.id === 'branch')!, s.nodes).pts).toEqual([P(510, 458), P(510, 552)]);
    const drag = dragging(s.nodes, ['B'], s.edges);
    for (let dy = 10; dy <= 100; dy += 10) s = settle(s.nodes.map(n => (n.id === 'B' ? { ...n, position: P(570, 420 + dy) } : n)), s.edges, drag);
    s = settle(s.nodes, s.edges);
    expect(centre(s.nodes.find(n => n.id === t.id)!)).toEqual(P(490, 450));
    const branch = s.edges.find(e => e.id === 'branch')!;
    expect([branch.sourceHandle, branch.targetHandle]).toEqual(['r', 't']);
    expect(draw(branch, s.nodes).pts).toEqual([P(498, 450), P(510, 450), P(510, 552)]);
  });

  it('keep a branch between two runs a tee\'s clearance apart inside the gap, not round the far run', () => {
    // Runs 20 px apart, a tee on each, the lower one 20 px further along; a
    // branch from the upper tee to the lower. Its far end is within a tee's
    // clearance of the upper run, but the lower tee has a face on that side:
    // crossing its run to come in from below is a choice, and a bad one.
    const nodes = [part('A', 100, 70), part('B', 500, 70), part('C', 30, 90), part('D', 570, 90)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l'), E('C', 'r', 'D', 'l')], 'A-B', P(330, 100));
    const t2 = tee(t1.nodes, t1.edges, 'C-D', P(350, 120));
    const s = settle(t2.nodes, [...t2.edges, { ...E(t1.id, 'b', t2.id, 'b'), id: 'branch' }]);
    const pts = draw(s.edges.find(e => e.id === 'branch')!, s.nodes).pts;
    expect(pts.every(p => p.y >= 100 && p.y <= 120)).toBe(true);
    expect(pts).toEqual([P(330, 108), P(330, 110), P(350, 110), P(350, 112)]);
  });
});

describe('the faces lines take, against the rest of the page', () => {
  /**
   * A pipe along y = 680 with a tee T; above it an unrelated line between two
   * open ends, straight down x = 850 to V2 at (850, 560); a pipe along
   * y = 450 with a tee U; a symbol M7 standing on its own between them; and a
   * branch from T up to U. Straight up out of T into U's bottom face, the
   * branch runs up x = 850 along the open ends' line and through V2's dot.
   */
  function page(other: { nodes: Node[]; edge: Edge } = { nodes: [openEnd('V1', 850, 300), openEnd('V2', 850, 560)], edge: E('V1', 'b', 'V2', 't') }) {
    const nodes = [part('M5', 700, 650), part('M6', 1000, 650), part('MA', 570, 420), openEnd('J1', 900, 450), part('M7', 750, 470), ...other.nodes];
    const t = tee(nodes, [E('M5', 'r', 'M6', 'l'), other.edge, E('MA', 'r', 'J1', 'l')], 'M5-M6', P(850, 680));
    const u = tee(t.nodes, t.edges, 'MA-J1', P(760, 450));
    return { nodes: u.nodes, edges: [...u.edges, { ...E(t.id, 't', u.id, 'b'), id: 'branch' }] };
  }

  it('keep a branch off an unrelated line, and out of the dot at its end', () => {
    const g = page();
    const s = settleOnPage(g.nodes, g.edges);
    const drawn = drawnScene(s.nodes, s.edges, endOf, obstacleBoxes(s.nodes));
    const branch = drawn.get('branch')!;
    expect(along(branch, drawn.get('V1-V2')!)).toBe(0);
    expect(passes(branch, P(850, 560), 7)).toBe(false);
  });

  it('leave two branches whose crossbars meet in one gap to the pass that draws them a step apart', () => {
    // Tees at x = 200 and 240 on a header, branches down to valves side by
    // side: each crossbar in the middle of the gap, one on the other. The
    // pass that moves lines apart draws the second a grid step off the first.
    // Priced as lying on the first, the second's crossbar was sent out to its
    // tee's stub instead, and ran under the header the whole way across.
    const nodes = [part('A', 0, 70), part('B', 600, 70), part('S1', 270, 300), part('S2', 330, 300)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 100));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, half.id, P(240, 100));
    const s = settleOnPage(t2.nodes, [...t2.edges, E(t1.id, 'b', 'S1', 't'), E(t2.id, 'b', 'S2', 't')]);
    for (const id of [`${t1.id}-S1`, `${t2.id}-S2`]) expect(dataOf(s.edges.find(e => e.id === id)!).offset ?? 0, id).toBe(0);
    const drawn = drawnScene(s.nodes, s.edges, endOf, obstacleBoxes(s.nodes));
    expect(along(drawn.get(`${t1.id}-S1`)!, drawn.get(`${t2.id}-S2`)!)).toBe(0);
  });

  it('keep a branch straight up to its tank past another tee ten pixels off it', () => {
    // A header along y = 400 with a tee at x = 300, its branch straight up to
    // a tank; a second header along y = 330 ends in a tee ten pixels to the
    // right of that branch. The branch passes clear of the second tee's dot.
    const nodes = [part('A', 100, 370), part('B', 500, 370), part('K', 270, 100), part('C', 400, 300), openEnd('O', 250, 330)];
    const t = tee(nodes, [E('A', 'r', 'B', 'l'), E('O', 'r', 'C', 'l')], 'A-B', P(300, 400));
    const t2 = tee(t.nodes, t.edges, 'O-C', P(310, 330));
    const s = settleOnPage(t2.nodes, [...t2.edges, { ...E(t.id, 't', 'K', 'b'), id: 'up' }]);
    const drawn = drawnScene(s.nodes, s.edges, endOf, obstacleBoxes(s.nodes));
    expect(drawn.get('up')).toEqual([P(300, 392), P(300, 160)]);
  });

  it('keep a branch off a line between two symbols it would otherwise run up', () => {
    // The same, with the line up x = 850 an L from P down and across to Q:
    // no dot on it, and nothing of it the pass that moves lines apart may move.
    const g = page({ nodes: [part('P', 820, 240), part('Q', 950, 570)], edge: E('P', 'b', 'Q', 'l') });
    const s = settleOnPage(g.nodes, g.edges);
    const drawn = drawnScene(s.nodes, s.edges, endOf, obstacleBoxes(s.nodes));
    expect(drawn.get('P-Q')!.slice(0, 2)).toEqual([P(850, 300), P(850, 600)]);
    expect(along(drawn.get('branch')!, drawn.get('P-Q')!)).toBe(0);
  });

  it('keep a branch out of an open end\'s dot whose line leaves it sideways', () => {
    // The same, with the open end at (850, 560) on a line off to the right:
    // straight up out of T, the branch would pass through its dot and cross
    // nothing, which reads as a tee.
    const g = page({ nodes: [openEnd('V2', 850, 560), part('W', 950, 530)], edge: E('V2', 'r', 'W', 'l') });
    const s = settleOnPage(g.nodes, g.edges);
    const drawn = drawnScene(s.nodes, s.edges, endOf, obstacleBoxes(s.nodes));
    expect(along(drawn.get('branch')!, drawn.get('V2-W')!)).toBe(0);
    expect(passes(drawn.get('branch')!, P(850, 560), 7)).toBe(false);
  });
});

// ── Under a person's hand ────────────────────────────────────────────────────

describe('a tee dragged along its pipe', () => {
  function manifold() {
    const nodes = [part('A', 0, 0), part('B', 600, 0)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const t2 = tee(t1.nodes, t1.edges, half.id, P(400, 30));
    return { nodes: t2.nodes, edges: t2.edges, t1: t1.id, t2: t2.id };
  }
  const slide = (m: ReturnType<typeof manifold>, id: string, to: Pt) => {
    const n = m.nodes.find(x => x.id === id)!;
    return slideAlong(n, alongOf(n), { x: to.x - 5, y: to.y - 5 }, m.edges, byIdOf(m.nodes), endOf)!;
  };

  it('stays on the pipe under the pointer', () => {
    const m = manifold();
    const s = slide(m, m.t1, P(300, 90));
    expect(s.position).toEqual(P(295, 25));
  });

  it('cannot pass the next tee, nor come within a tee\'s spacing of it', () => {
    const m = manifold();
    expect(slide(m, m.t1, P(500, 30)).position).toEqual(P(400 - TEE_GAP - 5, 25));
    expect(slide(m, m.t2, P(100, 30)).position).toEqual(P(200 + TEE_GAP - 5, 25));
  });

  it('keeps the faces its lines are on, for the reseat to turn', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const n = t1.nodes.find(x => x.id === t1.id)!;
    const s = slideAlong(n, alongOf(n), { x: 225, y: 195 }, t1.edges, byIdOf(t1.nodes), endOf)!;
    expect(s.position).toEqual(P(225, 195));
    expect([s.along.in, s.along.out]).toEqual(['l', 'r']);
    expect(s.dir).toEqual(P(0, 1));
  });

  it('is kept off a bend', () => {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    const n = t1.nodes.find(x => x.id === t1.id)!;
    // Pointer 3 px short of the bend on the first leg, then 3 px past it on the second.
    const before = slideAlong(n, alongOf(n), { x: 222, y: 24 }, t1.edges, byIdOf(t1.nodes), endOf)!;
    expect(before.position).toEqual(P(230 - CORNER_GAP - 5, 25));
    const past = slideAlong(n, alongOf(n), { x: 225, y: 28 }, t1.edges, byIdOf(t1.nodes), endOf)!;
    expect(past.position).toEqual(P(225, 30 + CORNER_GAP - 5));
  });

  it('stays on the leg it was on when the pointer is as near another', () => {
    // A hand-routed pipe that doubles back: legs at y=30 and y=70. A pointer
    // at y=50 is as near both; the tee was on the lower one.
    const nodes = [part('A', 0, 0), part('B', 40, 120)];
    const e = E('A', 'r', 'B', 't', { waypoints: [P(200, 30), P(200, 70), P(70, 70)], offset: 0 });
    const t1 = tee(nodes, [e], 'A-B', P(150, 70));
    const n = t1.nodes.find(x => x.id === t1.id)!;
    expect(centre(n)).toEqual(P(150, 70));
    const s = slideAlong(n, alongOf(n), { x: 145, y: 45 }, t1.edges, byIdOf(t1.nodes), endOf)!;
    expect(s.position).toEqual(P(145, 65));
  });

  it('keeps further from a tee its pipe ends on than from a port, sliding and reseated', () => {
    // A branch pipe from T1's bottom face down to C, with a tee T2 of its
    // own. T1's face is not a port: T1 keeps a stub of its own there, and
    // its dot is half a dot beyond. So T2 keeps TEE_END_GAP from that face,
    // where from C's port it keeps END_GAP -- slid there, or left there by a
    // drag and put back by the reseat.
    const t1 = tee([part('A', 0, 0), part('B', 400, 0), part('C', 170, 200)], [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const s1 = settle(t1.nodes, [...t1.edges, E(t1.id, 'b', 'C', 't')]);
    const t2 = tee(s1.nodes, s1.edges, `${t1.id}-C`, P(200, 120));
    const face = 30 + 8;
    const T2 = t2.nodes.find(n => n.id === t2.id)!;
    const slid = slideAlong(T2, alongOf(T2), P(195, 20), t2.edges, byIdOf(t2.nodes), endOf)!;
    expect(slid.position).toEqual(P(195, face + TEE_END_GAP - 5));
    expect(slideAlong(T2, alongOf(T2), P(195, 300), t2.edges, byIdOf(t2.nodes), endOf)!.position).toEqual(P(195, 200 - END_GAP - 5));
    // Left 2 px off T1's face, recorded as there, and reseated.
    const knocked = t2.nodes.map(n => (n.id === t2.id
      ? { ...n, position: P(195, face + 2 - 5), data: { ...n.data, along: { ...alongOf(n), t: alongOf(n).from === t1.id ? 0.01 : 0.99 } } }
      : n));
    expect(centre(settle(knocked, t2.edges).nodes.find(n => n.id === t2.id)!)).toEqual(P(200, face + TEE_END_GAP));
  });

  it('is null for a tee that rides nothing', () => {
    const o = openEnd('O', 100, 100);
    expect(slideAlong(o, { t: 0, in: 'l', out: 'r' }, { x: 0, y: 0 }, [], byIdOf([o]), endOf)).toBeNull();
  });

});

describe('a hand edit on a pipe', () => {
  function teedZ() {
    const z = zPipe();
    const t1 = tee(z.nodes, z.edges, 'A-B', P(150, 30));
    return { ...t1, up: t1.edges.find(e => e.target === t1.id)!.id, down: t1.edges.find(e => e.source === t1.id)!.id };
  }

  it('freezes every line of the pipe: each keeps the slice it draws, as its own corners', () => {
    const s = teedZ();
    expect(dataOf(s.edges.find(e => e.id === s.down)!).viaRun).toBe(true);
    const frozen = freezePipe(s.nodes, s.edges, s.up);
    const down = frozen.find(e => e.id === s.down)!;
    expect(dataOf(down).viaRun).toBeUndefined();
    expect(dataOf(down).waypoints).toEqual([P(230, 30), P(230, 330)]);
    expect(freezePipe(s.nodes, frozen, s.up)).toBe(frozen);
  });

  it('writes a drag as a person\'s corners, which the reseat keeps', () => {
    const s = teedZ();
    const before = draw(s.edges.find(e => e.id === s.down)!, s.nodes).pts;
    const moved = waypointsOf(dragSegment(before, 1, P(60, 0)));
    const edges = setHandCorners(s.nodes, s.edges, s.down, moved);
    const down = edges.find(e => e.id === s.down)!;
    expect(dataOf(down)).toMatchObject({ waypoints: moved, offset: 0 });
    expect(dataOf(down).viaRun).toBeUndefined();
    const re = reseatJunctions(s.nodes, edges, endOf);
    expect(dataOf(re.edges.find(e => e.id === s.down)!).waypoints).toEqual(moved);
    expect(centre(re.nodes.find(n => n.id === s.id)!)).toEqual(P(150, 30));
  });

  it('gives a hand-routed pipe\'s corners to whichever line a tee leaves them on', () => {
    // A tee slid past a person's corner hands that corner to the other line.
    const s = teedZ();
    const edges = setHandCorners(s.nodes, s.edges, s.down, [P(290, 30), P(290, 330)]);
    const n = s.nodes.find(x => x.id === s.id)!;
    const slid = slideAlong(n, alongOf(n), { x: 285, y: 195 }, edges, byIdOf(s.nodes), endOf)!;
    const nodes = s.nodes.map(x => (x.id === s.id ? { ...x, position: slid.position, data: { ...x.data, along: slid.along } } : x));
    const re = settle(nodes, edges);
    expect(dataOf(re.edges.find(e => e.id === s.up)!)).toMatchObject({ waypoints: [P(290, 30)] });
    expect(dataOf(re.edges.find(e => e.id === s.down)!)).toMatchObject({ waypoints: [P(290, 330)] });
    expect(dataOf(re.edges.find(e => e.id === s.up)!).viaRun).toBeUndefined();
  });

  it('is undone by a reset of any line of the pipe: the whole pipe routes itself again', () => {
    const s = teedZ();
    const edges = setHandCorners(s.nodes, s.edges, s.down, [P(290, 30), P(290, 330)]);
    const thawed = thawPipe(s.nodes, edges, s.up);
    for (const e of thawed) expect(dataOf(e).waypoints).toBeUndefined();
    const re = settle(s.nodes, thawed);
    expect(dataOf(re.edges.find(e => e.id === s.down)!)).toMatchObject({ waypoints: [P(230, 30), P(230, 330)], viaRun: true });
  });
});

describe('a line a person has routed', () => {
  // A's bottom port at (330, 480); an open end at (530, 450). The line out
  // of A's bottom into the open end's bottom face goes down, across and up.
  const start = () => ({ nodes: [part('A', 300, 420), openEnd('O', 530, 450)], edges: [E('A', 'b', 'O', 'b')] });

  it('keeps the face its corners arrive by, all the way down a drag of its middle away from the open end', () => {
    const s = start();
    const line = s.edges[0];
    const base = draw(line, s.nodes);
    expect(base.pts).toEqual([P(330, 480), P(330, 496), P(530, 496), P(530, 458)]);
    for (let dy = 5; dy <= 80; dy += 5) {
      const edges = setHandCorners(s.nodes, s.edges, line.id, waypointsOf(dragSegment(base.pts, 1, P(0, dy), { ends: { a: base.a, b: base.b } })));
      const re = settle(s.nodes, edges);
      const e = re.edges[0];
      expect(e.targetHandle, `down ${dy}`).toBe('b');
      expect(draw(e, re.nodes).pts, `down ${dy}`).toEqual([P(330, 480), P(330, 496 + dy), P(530, 496 + dy), P(530, 458)]);
    }
  });

  it('arrives by the face its corners come in from, wherever its open end is taken', () => {
    const s = start();
    const line = s.edges[0];
    const base = draw(line, s.nodes);
    const edges = setHandCorners(s.nodes, s.edges, line.id, waypointsOf(dragSegment(base.pts, 1, P(0, 40), { ends: { a: base.a, b: base.b } })));
    // The open end taken down below the person's crossbar at y = 536.
    const nodes = s.nodes.map(n => (n.id === 'O' ? { ...n, position: P(525, 595) } : n));
    const re = settle(nodes, edges);
    expect(re.edges[0].targetHandle).toBe('t');
    expect(draw(re.edges[0], re.nodes).pts).toEqual([P(330, 480), P(330, 536), P(530, 536), P(530, 592)]);
  });

  it('holds its face against a pipe that ends at the same junction', () => {
    // A pipe from A through a tee ends on the free junction J; a person's
    // line leaves J to the left and turns down to S. Into J's left face the
    // pipe would run along the person's line; it takes another face.
    const nodes = [part('A', 0, 0), openEnd('J', 300, 30), part('S', 240, 200)];
    const t = tee(nodes, [E('A', 'r', 'J', 'l')], 'A-J', P(150, 30));
    expect(t.edges.find(e => e.target === 'J')!.targetHandle).toBe('l');
    const hand = E('J', 'r', 'S', 't', { waypoints: [P(270, 30)], offset: 0 });
    const s = settle(t.nodes, [...t.edges, hand]);
    expect(s.edges.find(e => e.id === hand.id)!.sourceHandle).toBe('l');
    expect(s.edges.find(e => e.target === 'J')!.targetHandle).not.toBe('l');
  });
});

describe('where a tee put into a line goes', () => {
  it('is where the hover dot says: the legal spot nearest the pointer', () => {
    const z = zPipe();
    const pts = draw(z.edges[0], z.nodes).pts;
    const spot = splitSpot(z.nodes, z.edges, 'A-B', pts, P(229, 31))!;
    expect(spot.point).toEqual(P(230 - CORNER_GAP, 30));
    const s = splitEdgeAt(z.nodes, z.edges, 'A-B', P(229, 31), undefined, { points: pts })!;
    expect(centre(s.nodes.find(n => n.id === s.junctionId)!)).toEqual(spot.point);
  });

  it('goes onto the leg a pull at a bend heads for', () => {
    const z = zPipe();
    const pts = draw(z.edges[0], z.nodes).pts;
    expect(splitSpot(z.nodes, z.edges, 'A-B', pts, P(230, 30), P(500, 230))!.point).toEqual(P(230, 30 + CORNER_GAP));
    expect(splitSpot(z.nodes, z.edges, 'A-B', pts, P(230, 30), P(100, -100))!.point).toEqual(P(230 - CORNER_GAP, 30));
  });

  it('is told the pipe it lands on, not just the line', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 0)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const s = splitEdgeAt(t1.nodes, t1.edges, half.id, P(300, 30), undefined, { points: draw(half, t1.nodes).pts })!;
    expect(alongOf(s.nodes.find(n => n.id === s.junctionId)!)).toMatchObject({ from: 'A', to: 'B', in: 'l', out: 'r' });
    expect(alongOf(s.nodes.find(n => n.id === s.junctionId)!).t).toBeCloseTo((300 - 60) / 340, 1);
  });

  it('keeps clear of a tee already on the line', () => {
    const nodes = [part('A', 0, 0), part('B', 400, 0)];
    const t1 = tee(nodes, [E('A', 'r', 'B', 'l')], 'A-B', P(200, 30));
    const half = t1.edges.find(e => e.source === t1.id)!;
    const pts = draw(half, t1.nodes).pts;
    expect(splitSpot(t1.nodes, t1.edges, half.id, pts, P(205, 30))!.point).toEqual(P(200 + TEE_GAP, 30));
  });

  it('is, told the drawing\'s ports, where the reseat puts it on its pipe, on a short bent line too', () => {
    // A pipe routed by hand with a jog at x=76, and a tee just past the jog:
    // the line from A to it is 57 px with two bends in it, and no spot on it
    // a tee's reach clear of both. On the line alone the least bad spot is
    // between the bends; placed on its pipe, as the reseat places it, the new
    // tee goes past the second bend and the tee beyond is made room. The dot
    // has to say where it lands.
    const nodes = [part('A', 0, 0), part('B', 400, 26)];
    const e = E('A', 'r', 'B', 'l', { waypoints: [P(76, 30), P(76, 56)], offset: 0 });
    const t1 = tee(nodes, [e], 'A-B', P(98.6, 56));
    const up = t1.edges.find(x => x.target === t1.id)!;
    const pts = draw(up, t1.nodes).pts;
    expect(pts).toEqual([P(60, 30), P(76, 30), P(76, 56), P(90.6, 56)]);
    const dot = splitSpot(t1.nodes, t1.edges, up.id, pts, P(76, 40), undefined, { endOf })!;
    expect(dot.point).toEqual(P(90, 56));
    expect(splitSpot(t1.nodes, t1.edges, up.id, pts, P(76, 40))!.point).not.toEqual(dot.point);
    const s = splitEdgeAt(t1.nodes, t1.edges, up.id, P(76, 40), undefined, { points: pts, endOf })!;
    expect(centre(s.nodes.find(n => n.id === s.junctionId)!)).toEqual(dot.point);
    const after = settle(s.nodes, s.edges);
    expect(centre(after.nodes.find(n => n.id === s.junctionId)!)).toEqual(dot.point);
    expect(centre(after.nodes.find(n => n.id === t1.id)!)).toEqual(P(90 + TEE_GAP, 56));
  });

  it('lands where the dot said, whatever line it goes into (randomised)', () => {
    let seed = 21;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const grid = (v: number) => Math.round(v / 10) * 10;
    for (let k = 0; k < 120; k++) {
      let st = settle([part('A', 0, 0), part('B', grid(150 + rnd() * 400), grid(-250 + rnd() * 500))], [E('A', 'r', 'B', (['l', 't', 'b'] as const)[Math.floor(rnd() * 3)])]);
      for (let t = 0; t < 4; t++) {
        const line = st.edges[Math.floor(rnd() * st.edges.length)];
        const d = draw(line, st.nodes).pts;
        const at = sliceByArc(d, 0, rnd() * polylineLength(d)).pop()!;
        const dot = splitSpot(st.nodes, st.edges, line.id, d, at, undefined, { endOf });
        const sp = splitEdgeAt(st.nodes, st.edges, line.id, at, undefined, { points: d, endOf });
        if (!sp || !dot) continue;
        const after = settle(sp.nodes, sp.edges);
        const c = centre(after.nodes.find(x => x.id === sp.junctionId)!);
        expect(Math.hypot(c.x - dot.point.x, c.y - dot.point.y)).toBeLessThan(1e-6);
        st = after;
      }
    }
  });

  it('never changes the shape of the pipe it goes into (randomised)', () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const grid = (v: number) => Math.round(v / 10) * 10;
    for (let k = 0; k < 80; k++) {
      const nodes = [part('A', 0, 0), part('B', grid(150 + rnd() * 300), grid(-250 + rnd() * 500))];
      let e = E('A', 'r', 'B', rnd() < 0.5 ? 'l' : 't');
      const d0 = draw(e, nodes).pts;
      if (rnd() < 0.4 && d0.length > 2) {
        e = { ...e, data: { waypoints: waypointsOf(dragSegment(d0, 1, P(grid(rnd() * 40 - 20), grid(rnd() * 40 - 20)))), offset: 0 } };
      }
      const before = simplifyPoints(draw(e, nodes).pts);
      const L = polylineLength(before);
      const at = sliceByArc(before, 0, rnd() * L).pop()!;
      const s = splitEdgeAt(nodes, [e], 'A-B', at, undefined, { points: before })!;
      const pipe = pipesOf(s.nodes, s.edges)[0];
      const geo = pipeGeometry(pipe, byIdOf(s.nodes), new Map(s.edges.map(x => [x.id, x])), endOf)!;
      expect(geo.pts).toEqual(before);
      // And the reseat that follows leaves it too.
      const re = reseatJunctions(s.nodes, s.edges, endOf);
      const pipe2 = pipesOf(re.nodes, re.edges)[0];
      expect(pipeGeometry(pipe2, byIdOf(re.nodes), new Map(re.edges.map(x => [x.id, x])), endOf)!.pts).toEqual(before);
    }
  });
});

describe('where a tee put into a line goes, with others about', () => {
  // A vertical line down x = 410, and what may crowd it: a pipe along
  // y = 650 crossing it, or a tee at (400, 650), ten pixels to its side.
  const K = () => ({ nodes: [part('K1', 380, 380), part('K2', 380, 880)], edges: [E('K1', 'b', 'K2', 't')] });
  const pts = [P(410, 440), P(410, 880)];

  it('is a tee\'s spacing from a line that crosses it, where there is room', () => {
    const k = K();
    const crowd = { lines: [{ id: 'across', points: [P(250, 650), P(560, 650)] }], tees: [] };
    for (const at of [P(410, 655), P(410, 645), P(410, 660)]) {
      const spot = splitSpot(k.nodes, k.edges, 'K1-K2', pts, at, undefined, { endOf, crowd })!;
      expect(Math.abs(spot.point.y - 650), JSON.stringify(at)).toBeGreaterThanOrEqual(TEE_GAP - 1e-6);
    }
  });

  it('is a tee\'s spacing from another tee\'s dot beside the line, measured on the page', () => {
    const k = K();
    const crowd = { lines: [], tees: [{ id: 'X', at: P(400, 650) }] };
    for (const at of [P(410, 655), P(410, 645), P(410, 665)]) {
      const spot = splitSpot(k.nodes, k.edges, 'K1-K2', pts, at, undefined, { endOf, crowd })!;
      expect(Math.hypot(spot.point.x - 400, spot.point.y - 650), JSON.stringify(at)).toBeGreaterThanOrEqual(TEE_GAP - 1e-6);
    }
  });

  it('is a tee\'s reach from a crossing where there is no room for its spacing', () => {
    // A line 64 px long between two ports, crossed in the middle: a tee's
    // spacing either side leaves nowhere, a tee's reach does not.
    const nodes = [part('P', 380, 380), part('Q', 380, 504)];
    const edges = [E('P', 'b', 'Q', 't')];
    const short = [P(410, 440), P(410, 504)];
    const crowd = { lines: [{ id: 'across', points: [P(300, 472), P(500, 472)] }], tees: [] };
    const spot = splitSpot(nodes, edges, 'P-Q', short, P(410, 475), undefined, { endOf, crowd })!;
    expect(Math.abs(spot.point.y - 472)).toBeGreaterThanOrEqual(CORNER_GAP - 1e-6);
  });
});

// ── Whatever a person does ───────────────────────────────────────────────────

describe('the reseat, whatever a person does to a drawing', () => {
  /**
   * Edits of every kind a person can make, at random, each followed by the
   * reseat as the designer runs it: tees put in and branched to symbols, to
   * open ends and to other tees; valves dropped in; tees slid; lines dragged
   * by hand; symbols moved; tees and lines deleted. Pipes that end on other
   * pipes' tees, on open ends and on their own tees all turn up. `after` is
   * shown each drawing before the reseat that follows the edit.
   */
  function randomEdits(seed: number, drawings: number, after: (nodes: Node[], edges: Edge[], log: string) => void) {
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const grid = (v: number) => Math.round(v / 10) * 10;
    let n = 0;
    const line = (source: string, sh: string, target: string, th: string): Edge =>
      ({ id: `${source}-${target}-${n++}`, source, sourceHandle: sh, target, targetHandle: th, type: 'smoothstep', data: {} });
    const faces = ['t', 'b', 'l', 'r'];
    for (let k = 0; k < drawings; k++) {
      let nodes: Node[] = [0, 1, 2, 3].map(i => part(`S${i}`, grid(rnd() * 700), grid(rnd() * 700)));
      let edges: Edge[] = [line('S0', 'r', 'S1', pick(['l', 't', 'b'])), line('S2', pick(['r', 'b']), 'S3', pick(['l', 't']))];
      ({ nodes, edges } = reseatJunctions(nodes, edges, endOf));
      const log: string[] = [];
      for (let step = 0; step < 10 && edges.length; step++) {
        const r = rnd() * 0.97;
        if (r < 0.3) {
          const e = pick(edges);
          const d = draw(e, nodes).pts;
          const at = sliceByArc(d, 0, rnd() * polylineLength(d)).pop()!;
          const sp = splitEdgeAt(nodes, edges, e.id, at, undefined, { points: d });
          if (!sp) continue;
          nodes = sp.nodes; edges = sp.edges;
          log.push(`tee in ${e.id}`);
          const q = rnd();
          if (q < 0.4 && edges.length > 2) {
            const other = pick(edges.filter(x => x.source !== sp.junctionId && x.target !== sp.junctionId));
            const d2 = draw(other, nodes).pts;
            const sp2 = splitEdgeAt(nodes, edges, other.id, sliceByArc(d2, 0, rnd() * polylineLength(d2)).pop()!, undefined, { points: d2 });
            if (sp2) {
              nodes = sp2.nodes;
              edges = [...sp2.edges, line(sp.junctionId, pick(faces), sp2.junctionId, pick(faces))];
              log.push(`tee to tee ${sp.junctionId}-${sp2.junctionId}`);
            }
          } else if (q < 0.7) {
            const o = openEnd(`o${k}_${step}`, grid(at.x + rnd() * 200 - 100), grid(at.y + rnd() * 200 - 100));
            nodes = [...nodes, o];
            edges = [...edges, line(sp.junctionId, pick(faces), o.id, pick(faces))];
            log.push(`open end ${o.id}`);
          } else {
            const x = part(`X${k}_${step}`, grid(at.x + rnd() * 300 - 150), grid(at.y + rnd() * 300 - 150));
            nodes = [...nodes, x];
            edges = [...edges, line(sp.junctionId, pick(['t', 'b']), x.id, pick(faces))];
            log.push(`branch to ${x.id}`);
          }
        } else if (r < 0.4) {
          const e = pick(edges);
          const d = draw(e, nodes).pts;
          const at = sliceByArc(d, 0, rnd() * polylineLength(d)).pop()!;
          const ins = insertInline(nodes, edges, e.id, at, part(`V${k}_${step}`, 0, 0), { points: d });
          if (ins) { nodes = ins.nodes; edges = ins.edges; log.push(`valve in ${e.id}`); }
        } else if (r < 0.55) {
          const tees = nodes.filter(x => isJunction(x) && junctionData(x).along);
          if (!tees.length) continue;
          const t = pick(tees);
          const to = { x: grid(t.position.x + rnd() * 160 - 80), y: grid(t.position.y + rnd() * 160 - 80) };
          const slid = slideAlong(t, alongOf(t), to, edges, byIdOf(nodes), endOf);
          if (slid) nodes = nodes.map(x => (x.id === t.id ? { ...x, position: slid.position, data: { ...x.data, along: slid.along } } : x));
          log.push(`slide ${t.id}`);
        } else if (r < 0.65) {
          const e = pick(edges);
          const d = draw(e, nodes).pts;
          if (d.length < 3) continue;
          const seg = 1 + Math.floor(rnd() * (d.length - 3));
          edges = setHandCorners(nodes, edges, e.id, waypointsOf(dragSegment(d, seg, P(grid(rnd() * 60 - 30), grid(rnd() * 60 - 30)))));
          log.push(`drag ${e.id}`);
        } else if (r < 0.8) {
          const who = pick(nodes.filter(x => !isJunction(x)));
          nodes = nodes.map(x => (x.id === who.id ? { ...x, position: { x: grid(x.position.x + rnd() * 200 - 100), y: grid(x.position.y + rnd() * 200 - 100) } } : x));
          log.push(`move ${who.id}`);
        } else if (r < 0.9) {
          // A tee deleted as React Flow deletes it: with every line on it.
          const tees = nodes.filter(isJunction);
          if (!tees.length) continue;
          const t = pick(tees);
          const gone = edges.filter(e => e.source === t.id || e.target === t.id);
          const left = edges.filter(e => !gone.includes(e));
          const healed = rejoinChains([t], gone, new Set(left.map(e => e.id))).map(x => x.edge);
          ({ nodes, edges } = dissolveAfterDelete([t], gone, nodes.filter(x => x.id !== t.id), [...left, ...healed]));
          log.push(`delete ${t.id}`);
        } else {
          const e = pick(edges);
          ({ nodes, edges } = dissolveAfterDelete([], [e], nodes, edges.filter(x => x !== e)));
          log.push(`delete ${e.id}`);
        }
        after(nodes, edges, log.join(', '));
        ({ nodes, edges } = reseatJunctions(nodes, edges, endOf));
      }
    }
  }

  it('is idempotent by identity after every edit, and every line id stays unique (randomised)', () => {
    // Seeds whose walks reach what used to leave the reseat something to do
    // on its own output: two pipes trading faces at a free junction; a tee
    // its lines made straight after it had stopped riding; and a pipe whose
    // faces were priced on the crossbar that would leave its tees where they
    // were, which the tees, once seated, answered differently.
    for (const seed of [4242, 17, 197 * 7919]) {
      randomEdits(seed, 170, (nodes, edges, log) => {
        const ids = new Set(nodes.map(x => x.id));
        expect(new Set(edges.map(e => e.id)).size, log).toBe(edges.length);
        expect(edges.every(e => ids.has(e.source) && ids.has(e.target)), log).toBe(true);
        const once = reseatJunctions(nodes, edges, endOf);
        const twice = reseatJunctions(once.nodes, once.edges, endOf);
        expect(twice.nodes, log).toBe(once.nodes);
        expect(twice.edges, log).toBe(once.edges);
      });
    }
    // A few hundred random edits: slower than a unit test under a full parallel run.
  }, 30_000);

});
