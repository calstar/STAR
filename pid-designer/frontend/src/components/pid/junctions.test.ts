import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { branchFace, junctionEnd, reseatJunctions, runFaces, slideAlong } from './junctions';
import type { Along, EndLookup } from './junctions';
import { insertInline, splitEdgeAt } from './splitEdge';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });

const part = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 },
  data: { componentType: 'MAN', label: id },
});

/** Ports where the symbols keep them: sides at the middle of each edge. */
const endOf: EndLookup = (node, handle) => {
  if ((node.data as { componentType?: string }).componentType === 'JUNCTION') {
    return handle ? junctionEnd(node.position, handle as 'l' | 'r' | 't' | 'b') : null;
  }
  const { x, y } = node.position;
  switch (handle) {
    case 'l': return { x, y: y + 30, side: Position.Left };
    case 'r': return { x: x + 60, y: y + 30, side: Position.Right };
    case 't': return { x: x + 30, y, side: Position.Top };
    case 'b': return { x: x + 30, y: y + 60, side: Position.Bottom };
    default: return null;
  }
};

function run() {
  const nodes = [part('A', 0, 0), part('B', 400, 0)];
  const edges: Edge[] = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', type: 'smoothstep', data: {} }];
  return { nodes, edges };
}
const drawn = (nodes: Node[]) => ({ a: endOf(nodes[0], 'r')!, b: endOf(nodes[1], 'l')! });
const alongOf = (n: Node) => (n.data as { along: Along }).along;
const centre = (n: Node) => P(n.position.x + 5, n.position.y + 5);

describe('which face a line takes', () => {
  it('runs enter and leave by the faces along the run', () => {
    expect(runFaces(P(1, 0))).toEqual({ in: 'l', out: 'r' });
    expect(runFaces(P(0, -1))).toEqual({ in: 'b', out: 't' });
  });

  it('a branch comes in across the run, on its own side', () => {
    expect(branchFace(P(1, 0), P(200, -100), P(200, 30))).toBe('t');
    expect(branchFace(P(1, 0), P(200, 300), P(200, 30))).toBe('b');
    expect(branchFace(P(0, 1), P(0, 100), P(200, 100))).toBe('l');
    expect(branchFace(P(0, 1), P(400, 100), P(200, 100))).toBe('r');
  });
});

describe('a tee that rides its run', () => {
  it('remembers how far along it went in, and which faces the run uses', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(160, 30), undefined, drawn(nodes))!;
    const j = split.nodes.find(n => n.id === split.junctionId)!;
    expect(alongOf(j).t).toBeCloseTo((160 - 60) / (400 - 60));
    expect(alongOf(j).in).toBe('l');
    expect(alongOf(j).out).toBe('r');
    expect(j.position).toEqual(P(155, 25));
  });

  it('is put back at the same fraction when an end of the run moves', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const moved = split.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 740, y: 0 } } : n));
    const re = reseatJunctions(moved, split.edges, endOf);
    const j = re.nodes.find(n => n.id === split.junctionId)!;
    expect(centre(j).x).toBeCloseTo(400);          // halfway along 60..740
    expect(centre(j).y).toBeCloseTo(30);
  });

  it('hands each half the run\'s corners on its side, so the halves draw the run', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const moved = split.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 400, y: 600 } } : n));
    const re = reseatJunctions(moved, split.edges, endOf);
    const into = re.edges.find(e => e.target === split.junctionId)!.data as { waypoints?: Pt[]; viaRun?: boolean };
    const outOf = re.edges.find(e => e.source === split.junctionId)!.data as { waypoints?: Pt[]; viaRun?: boolean };
    // The run goes right along y=30, down x=230, right along y=630: the tee
    // is on the vertical leg, so the upstream half owns the first corner and
    // the downstream half the second.
    expect(into.viaRun).toBe(true);
    expect(into.waypoints).toEqual([P(230, 30)]);
    expect(outOf.viaRun).toBe(true);
    expect(outOf.waypoints).toEqual([P(230, 630)]);
  });

  it('turns its lines when the run turns under it', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const moved = split.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 400, y: 600 } } : n));
    const re = reseatJunctions(moved, split.edges, endOf);
    const j = re.nodes.find(n => n.id === split.junctionId)!;
    expect(alongOf(j).in).toBe('t');
    expect(alongOf(j).out).toBe('b');
    expect(re.edges.find(e => e.target === j.id)!.targetHandle).toBe('t');
    expect(re.edges.find(e => e.source === j.id)!.sourceHandle).toBe('b');
  });

  it('follows a half somebody has routed by hand', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const detour = [P(100, 30), P(100, -50), P(180, -50), P(180, 30)];
    const byHand = split.edges.map(e => (e.source === 'A'
      ? { ...e, data: { ...e.data, waypoints: detour, viaRun: undefined } }
      : e));
    const seated = reseatJunctions(split.nodes, split.edges, endOf);
    const re = reseatJunctions(seated.nodes, byHand, endOf);
    // The corners stay a person's, and the tee stays exactly where it was:
    // the run's ends did not move, so re-routing one half is not a reason
    // to move the tee -- it takes a fresh fraction of the longer run instead.
    expect((re.edges.find(e => e.source === 'A')!.data as { waypoints?: Pt[] }).waypoints).toEqual(detour);
    const j = re.nodes.find(n => n.id === split.junctionId)!;
    expect(centre(j)).toEqual(P(230, 30));
    expect(alongOf(j).t).toBeCloseTo((40 + 80 + 80 + 80 + 50) / 500);
    // And now that it rides the detoured run, moving B carries it along it.
    const movedB = re.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 900, y: 0 } } : n));
    const again = reseatJunctions(movedB, re.edges, endOf);
    expect(centre(again.nodes.find(n => n.id === split.junctionId)!).x).toBeGreaterThan(230);
  });

  it('hands back the same arrays when nothing needs doing', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const once = reseatJunctions(split.nodes, split.edges, endOf);
    const twice = reseatJunctions(once.nodes, once.edges, endOf);
    expect(twice.nodes).toBe(once.nodes);
    expect(twice.edges).toBe(once.edges);
  });

  it('keeps its place when a valve goes into one of its halves, and rides the shorter run', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(160, 30), undefined, drawn(nodes))!;
    const down = split.edges.find(e => e.source === split.junctionId)!;
    const ins = insertInline(split.nodes, split.edges, down.id, P(300, 30), part('V', 0, 0))!;
    const re = reseatJunctions(ins.nodes, ins.edges, endOf);
    const j = re.nodes.find(n => n.id === split.junctionId)!;
    expect(centre(j)).toEqual(P(160, 30));                    // did not move
    expect(alongOf(j).to).toBe('V');                          // rides A..V now
    expect(alongOf(j).t).toBeCloseTo((160 - 60) / (270 - 60)); // V's inlet is at x=270
    // And moving B no longer moves it: B is not on its run.
    const movedB = re.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 900, y: 0 } } : n));
    const again = reseatJunctions(movedB, re.edges, endOf);
    expect(centre(again.nodes.find(n => n.id === split.junctionId)!)).toEqual(P(160, 30));
  });

  it('settles a chain of tees along one pipe', () => {
    const { nodes, edges } = run();
    const first = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const half = first.edges.find(e => e.source === 'A')!;
    const j1 = first.nodes.find(n => n.id === first.junctionId)!;
    const second = splitEdgeAt(first.nodes, first.edges, half.id, P(120, 30), undefined, { a: endOf(nodes[0], 'r')!, b: endOf(j1, 'l')! })!;
    // As the app does: a seat after the split, before anything moves. The
    // outer tee's run is now inner..B, and it keeps its place on it.
    const settled = reseatJunctions(second.nodes, second.edges, endOf);
    expect(centre(settled.nodes.find(n => n.id === first.junctionId)!)).toEqual(P(230, 30));
    const moved = settled.nodes.map(n => (n.id === 'B' ? { ...n, position: { x: 740, y: 0 } } : n));
    const re = reseatJunctions(moved, settled.edges, endOf);
    const outer = re.nodes.find(n => n.id === first.junctionId)!;
    const inner = re.nodes.find(n => n.id === second.junctionId)!;
    // The two ride each other's runs -- inner rides A..outer, outer rides
    // inner..B -- so the answer is the fixed point where both fractions hold
    // at once, not a number either could give alone. What must be true: both
    // stretched right with the pipe, in order, on the line.
    expect(centre(outer).x).toBeGreaterThan(300);
    expect(centre(outer).x).toBeLessThan(740);
    expect(centre(inner).x).toBeGreaterThan(120);
    expect(centre(inner).x).toBeLessThan(centre(outer).x);
    expect(centre(inner).y).toBeCloseTo(30);
    expect(centre(outer).y).toBeCloseTo(30);
    // Stable: a second pass changes nothing.
    const again = reseatJunctions(re.nodes, re.edges, endOf);
    expect(again.nodes).toBe(re.nodes);
  });

  it('stops riding when a run line is gone, and stays put', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const j = split.nodes.find(n => n.id === split.junctionId)!;
    const re = reseatJunctions(split.nodes, split.edges.filter(e => e.target !== 'B'), endOf);
    const after = re.nodes.find(n => n.id === split.junctionId)!;
    expect((after.data as { along?: Along }).along).toBeUndefined();
    expect(after.position).toEqual(j.position);
  });

  it('slides along the run when dragged, rather than off it', () => {
    const { nodes, edges } = run();
    const split = splitEdgeAt(nodes, edges, 'A-B', P(230, 30), undefined, drawn(nodes))!;
    const j = split.nodes.find(n => n.id === split.junctionId)!;
    const slid = slideAlong(j, alongOf(j), { x: 295, y: 120 }, split.edges, new Map(split.nodes.map(n => [n.id, n])), endOf)!;
    expect(slid.position).toEqual(P(295, 25));      // back on the pipe
    expect(slid.along.t).toBeCloseTo((300 - 60) / 340);
  });
});
