import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import { J_END, centreOfJunction, isJunction, junctionData, junctionEnd, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { insertInline, splitEdgeAt } from './splitEdge';
import { dragSegment, pathPoints, routeOrthogonal, routeThrough, waypointsOf } from './route';
import type { Pt } from './route';
import { afterDelete, applyMoves, carriedWith, followCorners } from './canvasEdits';
import { translateSubgraph } from './graphOps';

const P = (x: number, y: number): Pt => ({ x, y });
const part = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id },
});
const probe = (id: string, host: string, x: number, y: number): Node => ({
  id, type: 'PT', position: { x, y }, data: { componentType: 'PT', label: id, attachedTo: host },
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
const wp = (e: Edge) => (e.data as { waypoints?: Pt[] }).waypoints;
const pos = (nodes: Node[], id: string) => nodes.find(n => n.id === id)!.position;
const move = (id: string, p: Pt): NodeChange<Node> => ({ id, type: 'position', position: p, dragging: true });

function settle(nodes: Node[], edges: Edge[]) {
  for (let i = 0; i < 10; i++) {
    const re = reseatJunctions(nodes, edges, endOf);
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}

/** A.r -> B.l, hand-routed round a U, with a tee on its bottom leg and a branch down to C. */
function handBay() {
  const A = part('A', 0, 0), B = part('B', 300, 0), C = part('C', 120, 200);
  const e0 = E('A', 'r', 'B', 'l');
  const plain = pathPoints(routeOrthogonal(endOf(A, 'r')!, endOf(B, 'l')!).d);
  const hand = { ...e0, data: { waypoints: waypointsOf(dragSegment(plain, 0, P(0, 60))) } };
  const drawn = pathPoints(routeThrough(endOf(A, 'r')!, endOf(B, 'l')!, wp(hand)!).d);
  const split = splitEdgeAt([A, B, C], [hand], 'A-B', P(150, 90), undefined, { points: drawn })!;
  const branch = E(split.junctionId, 'b', 'C', 't');
  return { ...settle(split.nodes, [...split.edges, branch]), tee: split.junctionId };
}

// ── Moving ───────────────────────────────────────────────────────────────────

describe('applyMoves', () => {
  it('carries a tee picked up with both ends of its pipe by exactly their delta', () => {
    const bay = handBay();
    const tee = bay.nodes.find(n => n.id === bay.tee)!;
    const ends0 = junctionData(tee).along!.ends!;
    // React Flow proposes each dragged node from where the drag began, snapped
    // and rounded on its own: the tee a hair off the others' delta.
    const changes = [move('A', P(20, 10)), move('B', P(320, 10)), move(bay.tee, P(tee.position.x + 19.6, tee.position.y + 10.4))];
    const r = applyMoves(bay.nodes, changes, bay.edges, endOf);
    expect(pos(r.nodes, bay.tee)).toEqual(P(tee.position.x + 20, tee.position.y + 10));
    expect(r.shifts.get(bay.tee)).toEqual(P(20, 10));
    const ends = junctionData(r.nodes.find(n => n.id === bay.tee)!).along!.ends!;
    expect(ends).toEqual({ a: P(ends0.a.x + 20, ends0.a.y + 10), b: P(ends0.b.x + 20, ends0.b.y + 10) });
    // Its home goes with it: at home where the bay is put down, as it was
    // where the bay was picked up.
    const home0 = junctionData(tee).along!.home!;
    const by = (p: Pt) => P(p.x + 20, p.y + 10);
    expect(junctionData(r.nodes.find(n => n.id === bay.tee)!).along!.home).toEqual({ a: by(home0.a), b: by(home0.b), at: by(home0.at) });
  });

  it('moves a bay with a tee on a hand-routed pipe as one piece', () => {
    const bay = handBay();
    const drawnBefore = bay.edges.map(e => pathPoints(routeThrough(
      endOf(bay.nodes.find(n => n.id === e.source)!, e.sourceHandle)!,
      endOf(bay.nodes.find(n => n.id === e.target)!, e.targetHandle)!, wp(e) ?? []).d));
    const tee = bay.nodes.find(n => n.id === bay.tee)!;
    let nodes = bay.nodes, edges = bay.edges;
    for (let k = 1; k <= 5; k++) {
      const changes = [move('A', P(20 * k, 10 * k)), move('B', P(300 + 20 * k, 10 * k)), move('C', P(120 + 20 * k, 200 + 10 * k)),
        move(bay.tee, P(tee.position.x + 20 * k + 0.4, tee.position.y + 10 * k))];
      const r = applyMoves(nodes, changes, edges, endOf);
      ({ nodes, edges } = settle(r.nodes, followCorners(edges, r.shifts)));
    }
    edges.forEach((e, i) => {
      const now = pathPoints(routeThrough(endOf(nodes.find(n => n.id === e.source)!, e.sourceHandle)!,
        endOf(nodes.find(n => n.id === e.target)!, e.targetHandle)!, wp(e) ?? []).d);
      expect(now).toEqual(drawnBefore[i].map(p => P(p.x + 100, p.y + 50)));
    });
  });

  it('carries a bay whose tee sits at a fraction of a pixel, corners and all, across a power of two', () => {
    // Tees sit where they project onto their pipes, almost never on a whole
    // pixel; one whose coordinate crosses 1024 on the way loses its last bit
    // when its move is worked out again as where it is less where it was.
    const bay = handBay();
    const moved = translateSubgraph(bay.nodes, bay.edges, new Set(bay.nodes.map(n => n.id)), P(870, 0));
    const nodes = moved.nodes.map(n => (n.id === bay.tee ? { ...n, position: { ...n.position, x: 1016.76112 } } : n));
    expect(1016.76112 + 10 - 1016.76112).not.toBe(10);
    const at = (id: string) => nodes.find(n => n.id === id)!.position;
    const r = applyMoves(nodes, ['A', 'B', bay.tee].map(id => move(id, P(at(id).x + 10, at(id).y))), moved.edges, endOf);
    expect(r.shifts.get(bay.tee)).toEqual(P(10, 0));
    const followed = followCorners(moved.edges, r.shifts);
    for (const e of followed) {
      const before = moved.edges.find(x => x.id === e.id)!;
      expect(wp(e) ?? []).toEqual((wp(before) ?? []).map(p => P(p.x + 10, p.y)));
    }
  });

  it('carries a tee left out of the selection with the pipe it rides, when both its ends are picked up', () => {
    // React Flow proposes nothing for a tee nobody selected. It rides the
    // pipe, and the pipe is moving whole: it goes too, in the same tick, with
    // its record of where the ends stood -- and so do the corners between it
    // and them.
    const bay = handBay();
    const tee = bay.nodes.find(n => n.id === bay.tee)!;
    const ends0 = junctionData(tee).along!.ends!;
    const r = applyMoves(bay.nodes, [move('A', P(20, 10)), move('B', P(320, 10))], bay.edges, endOf);
    expect(pos(r.nodes, bay.tee)).toEqual(P(tee.position.x + 20, tee.position.y + 10));
    expect(r.shifts.get(bay.tee)).toEqual(P(20, 10));
    const ends = junctionData(r.nodes.find(n => n.id === bay.tee)!).along!.ends!;
    expect(ends).toEqual({ a: P(ends0.a.x + 20, ends0.a.y + 10), b: P(ends0.b.x + 20, ends0.b.y + 10) });
    const home0 = junctionData(tee).along!.home!;
    expect(junctionData(r.nodes.find(n => n.id === bay.tee)!).along!.home!.at).toEqual(P(home0.at.x + 20, home0.at.y + 10));
    for (const e of followCorners(bay.edges, r.shifts)) {
      if (e.source === 'C' || e.target === 'C') continue;
      expect(wp(e) ?? []).toEqual((wp(bay.edges.find(x => x.id === e.id)!) ?? []).map(p => P(p.x + 20, p.y + 10)));
    }
    // Only one end picked up, or the two by different deltas: the pipe is not moving whole.
    expect(pos(applyMoves(bay.nodes, [move('A', P(20, 10)), move('C', P(140, 210))], bay.edges, endOf).nodes, bay.tee))
      .toEqual(tee.position);
    expect(applyMoves(bay.nodes, [move('A', P(20, 10)), move('B', P(320, 0))], bay.edges, endOf).shifts.has(bay.tee))
      .toBe(false);
  });

  it('slides a tee dragged on its own along its pipe', () => {
    const bay = handBay();
    const tee = bay.nodes.find(n => n.id === bay.tee)!;
    // Dragged 30 along and 20 off the pipe: it stays on the bottom leg.
    const r = applyMoves(bay.nodes, [move(bay.tee, P(tee.position.x + 30, tee.position.y + 20))], bay.edges, endOf);
    expect(pos(r.nodes, bay.tee).y).toBe(tee.position.y);
    expect(pos(r.nodes, bay.tee).x).toBeCloseTo(tee.position.x + 30, 6);
  });

  it('slides a tee dragged by hand onto the grid by its centre, tick after tick', () => {
    // React Flow snaps the dragged dot's top-left corner to the grid, so
    // every position it proposes puts the centre five pixels off a grid line
    // -- and the tee landed there, a branch to a symbol on the grid jogging
    // by the five. Each tick lands the centre on a grid line along the pipe:
    // the one the tee is coming from, when the snapped corner leaves it
    // exactly between two.
    const bay = handBay();
    const start = bay.nodes.find(n => n.id === bay.tee)!.position;
    expect(start).toEqual(P(145, 85));
    let nodes = bay.nodes;
    const seen: Pt[] = [];
    // The pointer 3, 13 and 23 px along: React Flow's snapped corners.
    for (const x of [150, 160, 170]) {
      nodes = applyMoves(nodes, [move(bay.tee, P(x, 90))], bay.edges, endOf).nodes;
      const p = pos(nodes, bay.tee);
      seen.push(P(p.x + 5, p.y + 5));
    }
    expect(seen).toEqual([P(150, 90), P(160, 90), P(170, 90)]);
  });

  it('slides a tee stopped short of a bend or a port onto the nearest grid line it may sit on', () => {
    // M1.r -> M2.l, a Z bending at x = 450, a tee on its first leg at 390.
    // Dragged past the bend, the tee is held a tee's reach down the riser, at
    // y = 314, and dragged on at M2 it is held a port's clearance short of
    // it, at x = 556: both on no grid line, and the branch from each jogged
    // by the difference. On the grid line beyond the stop that is still as
    // far off: 320, and 550.
    const M1 = part('M1', 270, 270), M2 = part('M2', 570, 420);
    const split = splitEdgeAt([M1, M2], [E('M1', 'r', 'M2', 'l')], 'M1-M2', P(390, 300), undefined, { a: endOf(M1, 'r')!, b: endOf(M2, 'l')! })!;
    const bay = settle(split.nodes, split.edges);
    const tee = split.junctionId;
    expect(centreOfJunction(bay.nodes.find(n => n.id === tee)!)).toEqual(P(390, 300));
    // React Flow's snapped corners: the pointer just past the bend, and on
    // past M2's port.
    const past = applyMoves(bay.nodes, [move(tee, P(460, 300))], bay.edges, endOf).nodes;
    expect(centreOfJunction(past.find(n => n.id === tee)!)).toEqual(P(450, 320));
    const on = applyMoves(bay.nodes, [move(tee, P(590, 450))], bay.edges, endOf).nodes;
    expect(centreOfJunction(on.find(n => n.id === tee)!)).toEqual(P(550, 450));
  });

  it('slides a tee picked up with only one end of its pipe', () => {
    const bay = handBay();
    const tee = bay.nodes.find(n => n.id === bay.tee)!;
    const r = applyMoves(bay.nodes, [move('A', P(0, 40)), move(bay.tee, P(tee.position.x, tee.position.y + 40))], bay.edges, endOf);
    // Not carried off its pipe with A: B did not move, so the pipe's bottom leg did not.
    expect(pos(r.nodes, bay.tee).y).toBe(tee.position.y);
  });

  it('brings the probes clipped to what moved, and copies a resize into an authored size', () => {
    const box: Node = { id: 'R', type: 'REGION', position: P(0, 0), width: 300, height: 200, data: { componentType: 'REGION' } };
    const nodes = [part('A', 0, 0), probe('PT1', 'A', 70, -40), box];
    const r = applyMoves(nodes, [
      move('A', P(30, 0)),
      { id: 'R', type: 'dimensions', dimensions: { width: 320, height: 210 }, resizing: true, setAttributes: true },
    ], [], endOf);
    expect(pos(r.nodes, 'PT1')).toEqual(P(100, -40));
    expect(r.nodes.find(n => n.id === 'R')).toMatchObject({ width: 320, height: 210 });
  });
});

describe('carriedWith', () => {
  it('adds the tees of every pipe whose two ends are carried, and no others', () => {
    const bay = handBay();
    expect(carriedWith(bay.nodes, bay.edges, ['A', 'B'])).toEqual(new Set(['A', 'B', bay.tee]));
    expect(carriedWith(bay.nodes, bay.edges, ['A', 'C'])).toEqual(new Set(['A', 'C']));
  });
});

describe('followCorners', () => {
  const hand = (s: string, t: string) => E(s, 'r', t, 'l', { waypoints: [P(100, 30), P(100, 90)] });
  it('moves the corners of a line both of whose ends moved by one delta', () => {
    const edges = [hand('A', 'B'), hand('B', 'C')];
    const out = followCorners(edges, new Map([['A', P(10, 5)], ['B', P(10, 5)]]));
    expect(wp(out[0])).toEqual([P(110, 35), P(110, 95)]);
    expect(out[1]).toBe(edges[1]);
  });

  it('leaves them when the two ends moved differently, and hands back the same array when nothing follows', () => {
    const edges = [hand('A', 'B')];
    expect(followCorners(edges, new Map([['A', P(10, 5)], ['B', P(10, 6)]]))).toBe(edges);
    expect(followCorners(edges, new Map([['A', P(10, 5)]]))).toBe(edges);
  });
});

// ── Deleting ─────────────────────────────────────────────────────────────────

const params = (bore: number) => ({ lineType: 'pipe', params: { length: { value: 3, unit: 'ft' }, bore: { value: bore, unit: 'in' } } });

/** A.r -> B.l with a tee at x=200 and a branch from the tee's bottom face to `far`. */
function branched(far: Node, data: Record<string, unknown> = params(0.5)) {
  const nodes = [part('A', 0, 0), part('B', 400, 0)];
  const split = splitEdgeAt(nodes, [E('A', 'r', 'B', 'l', data)], 'A-B', P(200, 30), undefined,
    { a: endOf(nodes[0], 'r')!, b: endOf(nodes[1], 'l')! })!;
  const branch = E(split.junctionId, 'b', far.id, 't');
  return { ...settle([...split.nodes, far], [...split.edges, branch]), tee: split.junctionId, branch: branch.id };
}
const openEnd = (id: string, cx: number, cy: number): Node =>
  ({ id, type: 'JUNCTION', position: P(cx - 5, cy - 5), data: { componentType: 'JUNCTION', label: id } });
/** What React Flow removes for a selection: the nodes, and every line on them. */
function removed(g: { nodes: Node[]; edges: Edge[] }, sel: { nodes?: string[]; edges?: string[] }) {
  const ns = new Set(sel.nodes ?? []);
  return {
    nodes: g.nodes.filter(n => ns.has(n.id)),
    edges: g.edges.filter(e => sel.edges?.includes(e.id) || ns.has(e.source) || ns.has(e.target)),
  };
}
const joins = (edges: Edge[], a: string, b: string) => edges.filter(e => (e.source === a && e.target === b) || (e.source === b && e.target === a));

describe('afterDelete', () => {
  it('gives a pipe back as one line when a tee on it is taken out, branch and all', () => {
    const s = branched(openEnd('O', 200, 200));
    const r = afterDelete(s, removed(s, { nodes: [s.tee] }));
    expect(r.healed).toBe(true);
    expect(joins(r.edges, 'A', 'B')).toHaveLength(1);
    // The open end the branch led to has nothing left on it, and goes.
    expect(r.nodes.map(n => n.id).sort()).toEqual(['A', 'B']);
    expect(r.edges).toHaveLength(1);
  });

  it('dissolves a tee that lost its branch when its halves agree, and keeps a reducer', () => {
    const s = branched(part('C', 170, 200));
    const r = afterDelete(s, removed(s, { edges: [s.branch] }));
    expect(r.nodes.some(n => n.id === s.tee)).toBe(false);
    expect(joins(r.edges, 'A', 'B')).toHaveLength(1);
    // A half inch into a quarter inch is a fitting somebody put there.
    const red = branched(part('C', 170, 200));
    const halves = red.edges.map(e => (e.source === red.tee && e.id !== red.branch ? { ...e, data: params(0.25) } : e));
    const kept = afterDelete({ ...red, edges: halves }, removed({ ...red, edges: halves }, { edges: [red.branch] }));
    expect(kept.nodes.some(n => n.id === red.tee)).toBe(true);
    expect(kept.healed).toBe(false);
  });

  it('leaves a tee put on a run and never branched where it is when the part beside it goes', () => {
    // A -- V -- T -- B: the run is healed onto T's face, so T has lost
    // nothing, and a tee somebody placed stays placed, bore and all.
    const nodes = [part('A', 0, 0), part('B', 400, 0)];
    const valve: Node = { id: 'V', type: 'SOL', position: P(0, 0), measured: { width: 60, height: 60 }, data: { componentType: 'SOL', label: 'V' } };
    const run = E('A', 'r', 'B', 'l', params(0.5));
    const put = insertInline(nodes, [run], 'A-B', P(120, 30), valve, { a: endOf(nodes[0], 'r')!, b: endOf(nodes[1], 'l')! })!;
    const down = put.edges.find(e => e.source === 'V')!;
    const V = put.nodes.find(n => n.id === 'V')!;
    const split = splitEdgeAt(put.nodes, put.edges, down.id, P(320, 30), undefined,
      { a: endOf(V, 'r')!, b: endOf(nodes[1], 'l')! })!;
    const g = settle(split.nodes, split.edges);
    const r = afterDelete(g, removed(g, { nodes: ['V'] }));
    expect(r.nodes.some(n => n.id === split.junctionId)).toBe(true);
    expect(joins(r.edges, 'A', split.junctionId)).toHaveLength(1);
    expect(joins(r.edges, split.junctionId, 'B')).toHaveLength(1);
    // Nor when the tee beside it is the one deleted, branch and all.
    const twice = splitEdgeAt(g.nodes, g.edges, joins(g.edges, split.junctionId, 'B')[0].id, P(360, 30), undefined,
      { a: junctionEnd(g.nodes.find(n => n.id === split.junctionId)!.position, 'r'), b: endOf(nodes[1], 'l')! })!;
    const h = settle([...twice.nodes, part('C', 330, 200)], [...twice.edges, E(twice.junctionId, 'b', 'C', 't')]);
    const r2 = afterDelete(h, removed(h, { nodes: [twice.junctionId] }));
    expect(r2.nodes.some(n => n.id === split.junctionId)).toBe(true);
  });

  it('takes away a tee left as a dot on a line when the end of its pipe is deleted', () => {
    // A -- T -- B with a branch down to C, and B deleted: what is left of the
    // run and the branch meet at T and go nowhere else. One line, A to C,
    // when the two are the same kind of pipe.
    const b = branched(part('C', 170, 200));
    const s = { ...b, edges: b.edges.map(e => (e.id === b.branch ? { ...e, data: params(0.5) } : e)) };
    const r = afterDelete(s, removed(s, { nodes: ['B'] }));
    expect(r.nodes.map(n => n.id).sort()).toEqual(['A', 'C']);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]).toMatchObject({ source: 'A', sourceHandle: 'r', target: 'C', targetHandle: 't' });
  });

  it('heals round a valve at the end of a bent pipe without re-routing the pipe or moving its tees', () => {
    // M1 -- T1 -- T2 -- M2 -- O: a Z bending at x = 450, a tee on each leg,
    // and M2 out to an open end. With M2 gone the pipe ends on the open end,
    // whose other faces would each draw it afresh as some other shape; the
    // Z still fits the face the heal left it on, and is kept, T2 and all.
    const M1 = part('M1', 270, 270), M2 = part('M2', 570, 420), TK = part('TK', 360, 50);
    const O = openEnd('O', 800, 450), D = openEnd('D', 510, 560);
    const pts = (g: { nodes: Node[]; edges: Edge[] }, id: string) => {
      const e = g.edges.find(x => x.id === id)!;
      const at = (n: string) => g.nodes.find(x => x.id === n)!;
      return pathPoints(routeThrough(endOf(at(e.source), e.sourceHandle)!, endOf(at(e.target), e.targetHandle)!, wp(e) ?? []).d);
    };
    let g = settle([M1, M2, TK, O, D], [E('M1', 'r', 'M2', 'l'), E('M2', 'r', 'O', 'l')]);
    const s1 = splitEdgeAt(g.nodes, g.edges, 'M1-M2', P(390, 300), undefined, { points: pathPoints(routeOrthogonal(endOf(M1, 'r')!, endOf(M2, 'l')!).d) })!;
    g = settle(s1.nodes, [...s1.edges, E(s1.junctionId, 't', 'TK', 'b')]);
    const half = g.edges.find(e => e.source === s1.junctionId && e.target === 'M2')!;
    const s2 = splitEdgeAt(g.nodes, g.edges, half.id, P(510, 450), undefined, { points: pts(g, half.id) })!;
    g = settle(s2.nodes, [...s2.edges, E(s2.junctionId, 'b', 'D', 't')]);
    const t2 = centreOfJunction(g.nodes.find(n => n.id === s2.junctionId)!);
    expect(t2).toEqual(P(510, 450));
    const r = afterDelete(g, removed(g, { nodes: ['M2'] }));
    const after = settle(r.nodes, r.edges);
    expect(centreOfJunction(after.nodes.find(n => n.id === s2.junctionId)!)).toEqual(t2);
    const run = after.edges.find(e => e.target === s2.junctionId && e.source === s1.junctionId)!;
    expect(pts(after, run.id)).toEqual([P(398, 300), P(450, 300), P(450, 450), P(502, 450)]);
  });

  it('gives every healed line an id nothing else has', () => {
    const s = branched(openEnd('O', 200, 200));
    // Something else is already called A-B.
    const other = { ...E('A', 't', 'B', 't'), id: 'A-B' };
    const r = afterDelete({ nodes: s.nodes, edges: [...s.edges, other] }, removed({ nodes: s.nodes, edges: [...s.edges, other] }, { nodes: [s.tee] }));
    const ids = r.edges.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('A-B-2');
  });

  it('moves a probe clipped to a healed half onto the healed line', () => {
    const s = branched(openEnd('O', 200, 200));
    const half = s.edges.find(e => e.source === 'A')!;
    const withProbe = { nodes: [...s.nodes, { ...probe('PT1', half.id, 100, -40), data: { componentType: 'PT', attachedTo: half.id, attachedAt: 0.5 } }], edges: s.edges };
    const r = afterDelete(withProbe, removed(withProbe, { nodes: [s.tee] }));
    const healed = joins(r.edges, 'A', 'B')[0];
    expect((r.nodes.find(n => n.id === 'PT1')!.data as { attachedTo?: string }).attachedTo).toBe(healed.id);
  });

  it('leaves a delete with nothing to heal to React Flow', () => {
    const nodes = [part('A', 0, 0), part('V', 200, 0)];
    const edges = [E('A', 'r', 'V', 'l')];
    const r = afterDelete({ nodes, edges }, removed({ nodes, edges }, { nodes: ['V'] }));
    expect(r.healed).toBe(false);
    expect(r.nodes.map(n => n.id)).toEqual(['A']);
    expect(r.edges).toEqual([]);
  });
});
