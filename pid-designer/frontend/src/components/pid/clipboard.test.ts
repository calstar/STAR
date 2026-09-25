import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { PASTE_OFFSET, copySelection, pasteClip, pasteOffset } from './clipboard';
import type { Clip } from './clipboard';
import { J_END, centreOfJunction, isJunction, junctionData, junctionEnd, reseatJunctions } from './junctions';
import type { EndLookup, Face } from './junctions';
import { drawnRoute } from './lineRoute';
import { obstaclesByPage } from './routeGrid';
import type { Pt } from './route';
import { splitEdgeAt } from './splitEdge';

const node = (id: string, componentType: string, label: string, extra: Record<string, unknown> = {}, selected = true): Node =>
  ({ id, type: componentType, position: { x: 100, y: 100 }, selected,
     data: { componentType, label, page: 'Main', ...extra } }) as unknown as Node;
const edge = (source: string, target: string): Edge =>
  ({ id: `${source}-${target}`, source, target, sourceHandle: 'r', targetHandle: 'l', data: {} }) as unknown as Edge;
const labelOf = (n: Node) => (n.data as { label?: string }).label;

describe('copying a selection', () => {
  it('takes the selected symbols and the lines between them only', () => {
    const nodes = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2'), node('c', 'SOL', 'SOL-3', {}, false)];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const clip = copySelection(nodes, edges)!;
    expect(clip.nodes.map(n => n.id)).toEqual(['a', 'b']);
    // b-c has one end outside the selection: half a pipe is worse than none.
    expect(clip.edges.map(e => e.id)).toEqual(['a-b']);
  });

  it('takes only what is selected on the page being looked at', () => {
    // A selection left on another page is not one the reader can see they
    // are copying; Cmd+D used to paste it onto the page in front of them.
    const nodes = [node('a', 'SOL', 'SOL-1'), node('g', 'SOL', 'SOL-2', { page: 'GSE' })];
    expect(copySelection(nodes, [], 'GSE')!.nodes.map(n => n.id)).toEqual(['g']);
    expect(copySelection(nodes.slice(0, 1), [], 'GSE')).toBeNull();
    // Without a page, the whole selection, as before.
    expect(copySelection(nodes, [])!.nodes).toHaveLength(2);
  });

  it('is nothing when nothing is selected', () => {
    expect(copySelection([node('a', 'SOL', 'SOL-1', {}, false)], [])).toBeNull();
  });

  it('does not carry view state', () => {
    const clip = copySelection([node('a', 'SOL', 'SOL-1')], [])!;
    expect('selected' in clip.nodes[0]).toBe(false);
  });
});

describe('pasting', () => {
  it('lands fresh symbols with fresh ids and fresh tags, offset and selected', () => {
    const original = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2')];
    const clip = copySelection(original, [edge('a', 'b')])!;
    const out = pasteClip(clip, original, 'Main');
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes.map(n => n.id)).not.toContain('a');
    // Two valves both called SOL-1 is the duplicate the checks catch.
    expect(out.nodes.map(labelOf)).toEqual(['SOL-3', 'SOL-4']);
    expect(out.nodes[0].position).toEqual({ x: 140, y: 140 });
    expect(out.nodes.every(n => n.selected)).toBe(true);
    // The line between them comes along, rewired to the copies.
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].source).toBe(out.nodes[0].id);
    expect(out.edges[0].target).toBe(out.nodes[1].id);
  });

  it('numbers from the stem, so a renamed valve copies as its type', () => {
    const original = [node('a', 'SOL', 'SV-LOX-VENT')];
    const out = pasteClip(copySelection(original, [])!, original, 'Main');
    // The stem is what was there; the number is what is free.
    expect(labelOf(out.nodes[0])).toBe('SV-LOX-VENT-1');
  });

  it('lands on the page being looked at', () => {
    const original = [node('a', 'SOL', 'SOL-1')];
    const out = pasteClip(copySelection(original, [])!, original, 'GSE');
    expect((out.nodes[0].data as { page?: string }).page).toBe('GSE');
  });

  it('keeps a probe clipped to a copied host, and frees one clipped outside', () => {
    const host = node('t', 'TANK', 'TK-1');
    const probe = node('p', 'RTD', 'RTD-1', { attachedTo: 't' });
    const stray = node('q', 'RTD', 'RTD-2', { attachedTo: 'elsewhere' });
    const out = pasteClip(copySelection([host, probe, stray], [])!, [host, probe, stray], 'Main');
    const [t, p, q] = out.nodes;
    expect((p.data as { attachedTo?: string }).attachedTo).toBe(t.id);
    expect((q.data as { attachedTo?: string }).attachedTo).toBeUndefined();
  });

  it('gives a junction a junction id', () => {
    const j = { id: 'junc_1', type: 'JUNCTION', position: { x: 0, y: 0 }, selected: true, data: { page: 'Main' } } as unknown as Node;
    const out = pasteClip(copySelection([j], [])!, [j], 'Main');
    expect(out.nodes[0].id).toMatch(/^junc_\d+$/);
  });

  it('leaves annotation text and section names as they are', () => {
    const box = node('r', 'REGION', 'GSE bay');
    const out = pasteClip(copySelection([box], [])!, [box], 'Main');
    expect(labelOf(out.nodes[0])).toBe('GSE bay');
  });
});

describe('a paste is the original, moved', () => {
  const P = (x: number, y: number) => ({ x, y });
  const at = (id: string, x: number, y: number, extra: Partial<Node> = {}, data: Record<string, unknown> = {}): Node =>
    ({ id, type: 'MAN', position: P(x, y), selected: true,
       data: { componentType: 'MAN', label: id, page: 'Main', ...data }, ...extra }) as unknown as Node;
  /** A bay: A -> tee -> B along y=30 on hand corners, a branch off the tee to C, and a valve's pipe-given half. */
  const bay = () => {
    const nodes = [
      at('A', 0, 0), at('B', 300, 100), at('C', 100, 200),
      at('junc_7', 145, 25, { type: 'JUNCTION' }, {
        componentType: 'JUNCTION',
        along: { t: 0.4, in: 'l', out: 'r', from: 'A', to: 'B', ends: { a: P(60, 30), b: P(300, 130) }, home: { a: P(60, 30), b: P(300, 130), at: P(150, 30) } },
      }),
    ];
    const edges = [
      { id: 'A-j', source: 'A', sourceHandle: 'r', target: 'junc_7', targetHandle: 'l', data: { waypoints: [P(100, 30)] } },
      { id: 'j-B', source: 'junc_7', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: { waypoints: [P(200, 30), P(200, 130)], viaRun: true } },
      { id: 'j-C', source: 'junc_7', sourceHandle: 'b', target: 'C', targetHandle: 't', data: {} },
    ] as Edge[];
    return { nodes, edges };
  };
  const shifted = (p: { x: number; y: number }, k = 1) => P(p.x + PASTE_OFFSET.x * k, p.y + PASTE_OFFSET.y * k);

  it('moves every symbol, every stored corner and every tee\'s record of its pipe and its home by the offset', () => {
    const { nodes, edges } = bay();
    // A bay lands beside itself (see 'where a paste lands'): whatever the
    // offset, everything goes by it.
    const d = pasteOffset(copySelection(nodes, edges)!, nodes, 'Main');
    const by = (p: { x: number; y: number }) => P(p.x + d.x, p.y + d.y);
    const out = pasteClip(copySelection(nodes, edges)!, nodes, 'Main');
    const copyOf = new Map(nodes.map((n, i) => [n.id, out.nodes[i]]));
    for (const n of nodes) expect(copyOf.get(n.id)!.position).toEqual(by(n.position));
    edges.forEach((e, i) => {
      const was = (e.data as { waypoints?: { x: number; y: number }[] }).waypoints ?? [];
      const now = (out.edges[i].data as { waypoints?: { x: number; y: number }[] }).waypoints ?? [];
      expect(now).toEqual(was.map(by));
    });
    // The pipe-given corners stay pipe-given: the reseat still owns them.
    expect((out.edges[1].data as { viaRun?: boolean }).viaRun).toBe(true);
    const along = (copyOf.get('junc_7')!.data as { along: { ends: unknown; home: unknown; from: string; to: string; t: number } }).along;
    expect(along.ends).toEqual({ a: by(P(60, 30)), b: by(P(300, 130)) });
    // Its home too: the copy's pipe, with its ends where the copies of A and
    // B are, has the copy of the tee at home where it is.
    expect(along.home).toEqual({ a: by(P(60, 30)), b: by(P(300, 130)), at: by(P(150, 30)) });
    // Its pipe ends at the copies of A and B, not at the originals.
    expect(along.from).toBe(copyOf.get('A')!.id);
    expect(along.to).toBe(copyOf.get('B')!.id);
    expect(along.t).toBe(0.4);
    // And the original is untouched.
    expect(bay()).toEqual({ nodes, edges });
  });

  it('lands where an explicit offset says, corners and all', () => {
    const { nodes, edges } = bay();
    const out = pasteClip(copySelection(nodes, edges)!, nodes, 'Main',
      { offset: P(PASTE_OFFSET.x * 2, PASTE_OFFSET.y * 2) });
    expect(out.nodes[0].position).toEqual(shifted(P(0, 0), 2));
    expect((out.edges[0].data as { waypoints: unknown }).waypoints).toEqual([shifted(P(100, 30), 2)]);
  });

  it('names no pipe end on a tee whose end was not copied', () => {
    // The copy's tee is not on the original's pipe, and naming the original
    // would make it compare itself with that pipe. The tee has a second
    // branch here, up to D: with only the one to C it would be left a dot
    // on a bent line, and the copy heals such a tee away (see 'what a copy
    // leaves behind').
    const { nodes: bayNodes, edges: bayEdges } = bay();
    const nodes = [...bayNodes, at('D', 100, -100)];
    const edges = [...bayEdges, { id: 'j-D', source: 'junc_7', sourceHandle: 't', target: 'D', targetHandle: 'b', data: {} } as Edge];
    const picked = nodes.map(n => (n.id === 'B' ? { ...n, selected: false } : n));
    const out = pasteClip(copySelection(picked, edges)!, picked, 'Main');
    const along = (out.nodes.find(n => n.type === 'JUNCTION')!.data as { along: { from?: string; to?: string } }).along;
    expect(along.from).toBe(out.nodes[0].id);
    expect(along.to).toBeUndefined();
  });

  it('gives two lines between the same pair of symbols an id each', () => {
    const nodes = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2')];
    const edges = [edge('a', 'b'), { ...edge('a', 'b'), id: 'a-b-2', sourceHandle: 'b', targetHandle: 'b' }];
    const out = pasteClip(copySelection(nodes, edges)!, nodes, 'Main', { edges });
    const ids = out.edges.map(e => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.some(id => edges.some(e => e.id === id))).toBe(false);
  });

  it('gives two copied lines an id each even when the originals share one', () => {
    // Drawings saved before line ids were checked can hold two lines of one
    // id. Minting by that id gave both copies the same fresh one.
    const nodes = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2'),
      node('tc', 'TC', 'TC-1', { attachedTo: 'a-b' })];
    const edges = [edge('a', 'b'), { ...edge('a', 'b'), sourceHandle: 'b', targetHandle: 'b' }];
    const out = pasteClip(copySelection(nodes, edges)!, nodes, 'Main', { edges });
    const ids = out.edges.map(e => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // The ports still say which copy is which.
    expect(out.edges.map(e => e.sourceHandle)).toEqual(['r', 'b']);
    // A probe on the ambiguous id can do no better than the first of them.
    expect((out.nodes[2].data as { attachedTo?: string }).attachedTo).toBe(ids[0]);
  });

  it('never takes the id of a line already on the drawing', () => {
    const nodes = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2')];
    const clip = copySelection(nodes, [edge('a', 'b')])!;
    const first = pasteClip(clip, nodes, 'Main').edges[0];
    expect(first.id).toBe(`${first.source}-${first.target}`);
    // Node ids come from a counter, so the next paste's copies are the two
    // after these -- and a line of their natural name is already drawn.
    const later = (id: string) => id.replace(/\d+$/, m => String(Number(m) + 2));
    const there = { id: `${later(first.source)}-${later(first.target)}`, source: 'x', target: 'y' } as Edge;
    const second = pasteClip(clip, nodes, 'Main', { edges: [there] }).edges[0];
    expect(second.source).toBe(later(first.source));
    expect(second.id).not.toBe(there.id);
  });

  it('keeps a probe clipped to a copied line clipped to the copy of that line', () => {
    const nodes = [node('a', 'SOL', 'SOL-1'), node('b', 'SOL', 'SOL-2'), node('tc', 'TC', 'TC-1', { attachedTo: 'a-b' })];
    const edges = [edge('a', 'b')];
    const out = pasteClip(copySelection(nodes, edges)!, nodes, 'Main');
    expect((out.nodes[2].data as { attachedTo?: string }).attachedTo).toBe(out.edges[0].id);
  });
});

describe('where a paste lands', () => {
  const at = (id: string, x: number, y: number, page = 'Main'): Node =>
    ({ id, type: 'SOL', position: { x, y }, selected: true,
       data: { componentType: 'SOL', label: `SOL-${id}`, page } }) as unknown as Node;
  const step = (k: number) => ({ x: PASTE_OFFSET.x * k, y: PASTE_OFFSET.y * k });
  /** Paste `clip` onto `drawing` as Cmd+V does, and hand back the drawing with the copy on it. */
  const paste = (clip: Clip, drawing: Node[], page = 'Main') => {
    const added = pasteClip(clip, drawing, page).nodes;
    return { added, drawing: [...drawing, ...added] };
  };

  it('steps down the page one offset per paste, so seven Cmd+V lay out seven copies', () => {
    let drawing = [at('a', 100, 100)];
    const clip = copySelection(drawing, [])!;
    const landed: { x: number; y: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const next = paste(clip, drawing);
      landed.push(next.added[0].position);
      drawing = next.drawing;
    }
    expect(landed).toEqual([1, 2, 3, 4, 5, 6, 7].map(k => ({ x: 100 + step(k).x, y: 100 + step(k).y })));
  });

  it('does not land a paste on a duplicate made in between', () => {
    // Cmd+C, Cmd+D, Cmd+V: the duplicate already stands one offset along,
    // and a count of pastes since the copy never saw it.
    const original = [at('a', 100, 100)];
    const clip = copySelection(original, [])!;
    const duplicated = paste(copySelection(original, [])!, original).drawing;
    expect(pasteOffset(clip, duplicated, 'Main')).toEqual(step(2));
  });

  it('takes a spot back when the copy standing on it has gone', () => {
    // An undone paste, or a copy dragged away: the next paste lands where
    // that one did rather than skipping a step.
    const original = [at('a', 100, 100)];
    const clip = copySelection(original, [])!;
    const moved = paste(clip, original).drawing.map((n, i) =>
      (i === 1 ? { ...n, position: { x: 500, y: 500 } } : n));
    expect(pasteOffset(clip, original, 'Main')).toEqual(step(1));
    expect(pasteOffset(clip, moved, 'Main')).toEqual(step(1));
  });

  it('is kept clear only of what is on the page being pasted onto', () => {
    const original = [at('a', 100, 100)];
    const clip = copySelection(original, [])!;
    const elsewhere = [...original, at('g', 140, 140, 'GSE')];
    expect(pasteOffset(clip, elsewhere, 'Main')).toEqual(step(1));
    expect(pasteOffset(clip, elsewhere, 'GSE')).toEqual(step(2));
  });

  it('counts a spot as taken to the whole pixel, and a symbol nudged off it as somewhere else', () => {
    const original = [at('a', 100, 100)];
    const clip = copySelection(original, [])!;
    expect(pasteOffset(clip, [...original, at('b', 140.3, 139.8)], 'Main')).toEqual(step(2));
    expect(pasteOffset(clip, [...original, at('b', 150, 140)], 'Main')).toEqual(step(1));
  });

  it('lands a copy of a whole bay beside it, clear of it and of what is there already', () => {
    // A bay of five tanks some 500 px across: forty along it lay over the
    // bay, symbols on symbols and lines across lines.
    const bay = [at('t1', 0, 0), at('t2', 220, 0), at('t3', 440, 0), at('t4', 110, 220), at('t5', 330, 440)];
    const clip = copySelection(bay, [])!;
    expect(pasteOffset(clip, bay, 'Main')).toEqual({ x: 540, y: 0 });
    // With a bay already there, past it.
    const next = paste(clip, bay).drawing;
    expect(pasteOffset(clip, next, 'Main')).toEqual({ x: 1080, y: 0 });
    // A copy of one valve still steps down the page as before.
    expect(pasteOffset(copySelection([bay[0]], [])!, bay, 'Main')).toEqual(step(1));
  });

  it('keeps every symbol of a copied group clear, not just the first', () => {
    // A pair small enough to step down the page (a bay steps aside; see
    // above): only the second one's next spot is occupied.
    const original = [at('a', 100, 100), at('b', 100, 120)];
    const clip = copySelection(original, [])!;
    expect(pasteOffset(clip, [...original, at('x', 140, 160)], 'Main')).toEqual(step(2));
  });
});

// ── A bay as the canvas has it ───────────────────────────────────────────────

const Q = (x: number, y: number): Pt => ({ x, y });
const sym = (id: string, x: number, y: number, h = 60): Node => ({
  id, type: 'MAN', position: Q(x, y), measured: { width: 60, height: h }, selected: true,
  data: { componentType: 'MAN', label: id, page: 'Main' },
});
const dot = (id: string, c: Pt): Node =>
  ({ id, type: 'JUNCTION', position: Q(c.x - 5, c.y - 5), selected: true, data: { componentType: 'JUNCTION', label: id, page: 'Main' } });
/** Ports at the middle of each side of a symbol; a tee's faces with J_END, as the designer's endOfClear. */
const endOf: EndLookup = (n, handle) => {
  if (isJunction(n)) return handle ? { ...junctionEnd(n.position, handle as Face), ...J_END } : null;
  const { x, y } = n.position;
  const h = n.measured?.height ?? 60;
  switch (handle) {
    case 'l': return { x, y: y + h / 2, side: Position.Left };
    case 'r': return { x: x + 60, y: y + h / 2, side: Position.Right };
    case 't': return { x: x + 30, y, side: Position.Top };
    case 'b': return { x: x + 30, y: y + h, side: Position.Bottom };
    default: return null;
  }
};
const line = (id: string, source: string, sh: string, target: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id, source, sourceHandle: sh, target, targetHandle: th, type: 'smoothstep', data });
type G = { nodes: Node[]; edges: Edge[] };
/** The reseat run to where it stops, as the canvas runs it. */
function settle(g: G): G {
  let { nodes, edges } = g;
  for (let i = 0; i < 20; i++) {
    const re = reseatJunctions(nodes, edges, endOf, obstaclesByPage(nodes));
    if (re.nodes === nodes && re.edges === edges) return { nodes, edges };
    nodes = re.nodes; edges = re.edges;
  }
  throw new Error('the reseat did not settle');
}
/** Every line as the canvas draws it (`drawnRoute`), by id. */
const drawnLines = (g: G) => {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const obstacles = obstaclesByPage(g.nodes);
  return new Map(g.edges.map(e => [e.id, drawnRoute(e, byId, endOf, obstacles)!]));
};
/** A tee put into line `id` at `at`, as a pull out of the line as drawn puts it. */
function teeInto(g: G, id: string, at: Pt) {
  const split = splitEdgeAt(g.nodes, g.edges, id, at, 'Main', { points: drawnLines(g).get(id)!, endOf, obstacles: obstaclesByPage(g.nodes) })!;
  const nodes = split.nodes.map(n => (n.id === split.junctionId ? { ...n, selected: true } : n));
  return { g: { nodes, edges: split.edges }, tee: split.junctionId };
}

/**
 * The bay: M1.r -> tee -> tee -> M2.l, a Z bending at x = 450; a branch up
 * from the first tee to TK, one down from the second to an open end at
 * (510, 560), and M2.r out to another at (800, 450).
 */
function s3c(): G & { tees: string[] } {
  const M1 = sym('M1', 270, 270), M2 = sym('M2', 570, 420), TK = sym('TK', 360, 50, 100);
  const O1 = dot('O1', Q(510, 560)), O2 = dot('O2', Q(800, 450));
  const g0 = settle({ nodes: [M1, M2, TK, O1, O2], edges: [line('run', 'M1', 'r', 'M2', 'l'), line('out', 'M2', 'r', 'O2', 'l')] });
  const first = teeInto(g0, 'run', Q(390, 300));
  const g1 = settle({ nodes: first.g.nodes, edges: [...first.g.edges, line('up', first.tee, 't', 'TK', 'b')] });
  const lower = g1.edges.find(e => e.target === 'M2' && e.targetHandle === 'l')!.id;
  const second = teeInto(g1, lower, Q(510, 450));
  const g = settle({ nodes: second.g.nodes, edges: [...second.g.edges, line('down', second.tee, 'b', 'O1', 't')] });
  return { ...g, tees: [first.tee, second.tee] };
}

/**
 * Paste `clip` onto `g` as Cmd+V does -- told of the lines as drawn and the
 * ports -- and settle what lands, once React Flow has measured the copies:
 * the reseat waits for that, and they measure as their originals do.
 */
function pasteOnto(g: G, clip: Clip): G & { added: G } {
  const added = pasteClip(clip, g.nodes, 'Main', { edges: g.edges, geometry: { drawn: drawnLines(g), endOf } });
  const measured = added.nodes.map((n, i) => {
    const o = g.nodes.find(x => x.id === clip.nodes[i].id);
    return o?.measured ? { ...n, measured: o.measured } : n;
  });
  return { ...settle({ nodes: [...g.nodes, ...measured], edges: [...g.edges, ...added.edges] }), added };
}

describe('what a copy leaves behind', () => {
  it('heals a tee whose branch was not copied into its run, and the run keeps its shape', () => {
    // TK left out: the first tee has nothing branching off it in the copy.
    // Pasted as it was, it was a filled dot in the middle of a straight run.
    const bay = s3c();
    const picked = bay.nodes.map(n => (n.id === 'TK' ? { ...n, selected: false } : n));
    const clip = copySelection(picked, bay.edges)!;
    expect(clip.nodes.map(n => n.id)).not.toContain(bay.tees[0]);
    expect(clip.nodes.map(n => n.id)).toContain(bay.tees[1]);
    const healed = clip.edges.find(e => e.source === 'M1' || e.target === 'M1')!;
    expect([healed.source, healed.target].sort()).toEqual(['M1', bay.tees[1]].sort());
    // The pasted pipe is drawn as the original was, less the dot.
    const after = pasteOnto({ nodes: picked, edges: bay.edges }, clip);
    const was = drawnLines(bay);
    const d = Q(after.added.nodes[0].position.x - 270, after.added.nodes[0].position.y - 270);
    const copyOf = (id: string) => after.added.nodes[clip.nodes.findIndex(n => n.id === id)].id;
    const now = drawnLines(after);
    const runNow = after.edges.filter(e => [e.source, e.target].includes(copyOf(bay.tees[1]))
      && !(e.source === copyOf('O1') || e.target === copyOf('O1'))).map(e => now.get(e.id)!);
    const runWas = bay.edges.filter(e => e.source === 'M1' || e.target === 'M2' || e.source === bay.tees[0] && e.target !== 'TK')
      .filter(e => e.target !== 'TK' && e.id !== 'out' && e.id !== 'down');
    expect(runWas).toHaveLength(3);
    const pipeWas = runWas.map(e => was.get(e.id)!).flat().map(p => `${p.x + d.x},${p.y + d.y}`);
    for (const r of runNow) for (const p of r) expect(pipeWas, `${p.x},${p.y}`).toContain(`${p.x},${p.y}`);
    const tee = after.nodes.find(n => n.id === copyOf(bay.tees[1]))!;
    expect(centreOfJunction(tee)).toEqual(Q(510 + d.x, 450 + d.y));
  });

  it('keeps a probe on a healed pair where on the pipe it was, given the lines as drawn', () => {
    // Clipped half-way along the pipe's first line, 26 px from M1's port:
    // on the healed line it is still 26 px from the port, not half-way.
    const bay = s3c();
    const first = bay.edges.find(e => e.source === 'M1')!;
    const PT: Node = { id: 'PT', type: 'PT', position: Q(340, 250), selected: true,
      data: { componentType: 'PT', label: 'PT', page: 'Main', attachedTo: first.id, attachedAt: 0.5 } };
    const picked = [...bay.nodes.map(n => (n.id === 'TK' ? { ...n, selected: false } : n)), PT];
    const drawn = drawnLines(bay);
    const clip = copySelection(picked, bay.edges, undefined, { old: id => drawn.get(id) })!;
    const healed = clip.edges.find(e => e.source === 'M1' || e.target === 'M1')!;
    const clipped = clip.nodes.find(n => n.id === 'PT')!.data as { attachedTo?: string; attachedAt?: number };
    expect(clipped.attachedTo).toBe(healed.id);
    const run = [first.id, ...bay.edges.filter(e => e.source === bay.tees[0] && e.target === bay.tees[1]).map(e => e.id)]
      .map(id => drawn.get(id)!);
    const length = (pts: Pt[]) => pts.slice(1).reduce((l, q, i) => l + Math.hypot(q.x - pts[i].x, q.y - pts[i].y), 0);
    const along = length(run[0]) / 2;
    expect(clipped.attachedAt! * length(run.flat())).toBeCloseTo(along, 6);
  });

  it('keeps a tee put on a run and never branched, which lost nothing', () => {
    const bay = s3c();
    const bare = bay.edges.filter(e => e.id !== 'up');
    const clip = copySelection(bay.nodes.map(n => (n.id === 'TK' ? { ...n, selected: false } : n)), bare)!;
    expect(clip.nodes.map(n => n.id)).toContain(bay.tees[0]);
  });

  it('drops a junction all of whose lines were left behind', () => {
    const bay = s3c();
    const clip = copySelection(bay.nodes.map(n => (n.id === 'M2' ? { ...n, selected: false } : n)), bay.edges)!;
    // O2's only line went to M2.
    expect(clip.nodes.map(n => n.id)).not.toContain('O2');
  });

  it('keeps a tee between two kinds of pipe, which is a reducer', () => {
    const bay = s3c();
    const edges = bay.edges.map(e => (e.target === bay.tees[0]
      ? { ...e, data: { ...e.data, lineType: 'pipe', params: { bore: { value: 0.5, unit: 'in' } } } }
      : e.source === bay.tees[0] && e.target !== 'TK'
        ? { ...e, data: { ...e.data, lineType: 'pipe', params: { bore: { value: 0.25, unit: 'in' } } } }
        : e));
    const clip = copySelection(bay.nodes.map(n => (n.id === 'TK' ? { ...n, selected: false } : n)), edges)!;
    expect(clip.nodes.map(n => n.id)).toContain(bay.tees[0]);
  });
});

describe('where a copy of a bay lands, with its lines', () => {
  it('keeps the copy\'s lines clear of a line already there, not only its symbols', () => {
    // A.r -> B.l, and off to the right a line on nothing but two open ends,
    // standing where a copy one bay's width along would put A's line across
    // it. Kept clear of symbols only, it landed there.
    const A = sym('A', 0, 0), B = sym('B', 300, 0);
    const g = settle({ nodes: [A, B, dot('O1', Q(520, -100)), dot('O2', Q(520, 200))].map(n => ({ ...n, selected: n.id === 'A' || n.id === 'B' })),
      edges: [line('ab', 'A', 'r', 'B', 'l'), line('o', 'O1', 'b', 'O2', 't')] });
    const clip = copySelection(g.nodes, g.edges)!;
    expect(pasteOffset(clip, g.nodes, 'Main')).toEqual(Q(400, 0));
    const geometry = { drawn: drawnLines(g), endOf };
    expect(pasteOffset(clip, g.nodes, 'Main', geometry)).toEqual(Q(800, 0));
    // And a paste told of them lands there.
    expect(pasteClip(clip, g.nodes, 'Main', { geometry }).nodes[0].position).toEqual(Q(800, 0));
  });

  it('keeps the copy clear of a junction standing on its own', () => {
    // A junction put down and not yet wired, where the copy's line would run.
    const A = sym('A', 0, 0), B = sym('B', 300, 0);
    const g = settle({ nodes: [A, B, { ...dot('J', Q(580, 40)), selected: false }], edges: [line('ab', 'A', 'r', 'B', 'l')] });
    const clip = copySelection(g.nodes, g.edges)!;
    expect(pasteOffset(clip, g.nodes, 'Main', { drawn: drawnLines(g), endOf })).toEqual(Q(800, 0));
  });

  it('takes a copied symbol at the size it was measured at', () => {
    // A copy is not measured until it is drawn, and a tank taken for a
    // sixty-pixel square missed the valve under where its copy would stand.
    const TK = sym('TK', 0, 0, 200), B = sym('B', 300, 0);
    const V = { ...sym('V', 400, 170), selected: false };
    const clip = copySelection([TK, B, V], [])!;
    expect(pasteOffset(clip, [TK, B, V], 'Main')).toEqual(Q(800, 0));
  });

  it('takes a copy\'s junctions for what it covers, so a line between two open ends lands beside itself', () => {
    // No symbols at all: the copy is its two dots and the line between them,
    // three hundred pixels long, and forty along would lie on the original.
    const g = { nodes: [dot('O1', Q(0, 0)), dot('O2', Q(300, 0))], edges: [line('o', 'O1', 'r', 'O2', 'l')] };
    const clip = copySelection(g.nodes, g.edges)!;
    expect(pasteOffset(clip, g.nodes, 'Main')).toEqual(Q(350, 0));
  });

  it('lands a bay twice beside itself, each copy drawn exactly as the original, tees and all', () => {
    // The bay, and a tank standing to its right. Kept clear of symbols only,
    // the first copy's lines landed round the tank and the second's on the
    // first's open end; both were drawn again round what they landed on,
    // their tees moved onto the new shapes.
    const bay = s3c();
    const g = { nodes: [...bay.nodes, { ...sym('TKB', 1200, 300, 100), selected: false }], edges: bay.edges };
    const clip = copySelection(g.nodes, g.edges)!;
    const was = drawnLines(bay);
    let now: G = g;
    const offsets: Pt[] = [];
    for (let k = 0; k < 2; k++) {
      const after = pasteOnto({ nodes: now.nodes.map(n => ({ ...n, selected: false })), edges: now.edges }, clip);
      const d = Q(after.added.nodes[0].position.x - clip.nodes[0].position.x, after.added.nodes[0].position.y - clip.nodes[0].position.y);
      offsets.push(d);
      const ids = new Map(clip.nodes.map((n, i) => [n.id, after.added.nodes[i].id]));
      const drawnNow = drawnLines(after);
      for (const n of clip.nodes) {
        const c = after.nodes.find(x => x.id === ids.get(n.id))!;
        expect(c.position, `${n.id} copy ${k + 1}`).toEqual(Q(n.position.x + d.x, n.position.y + d.y));
        if (junctionData(n).along) expect(junctionData(c).along!.ends).toEqual({
          a: Q(junctionData(n).along!.ends!.a.x + d.x, junctionData(n).along!.ends!.a.y + d.y),
          b: Q(junctionData(n).along!.ends!.b.x + d.x, junctionData(n).along!.ends!.b.y + d.y),
        });
      }
      clip.edges.forEach((e, i) => {
        const copy = after.added.edges[i];
        const settled = after.edges.find(x => x.id === copy.id)!;
        expect([settled.sourceHandle, settled.targetHandle], `${e.id} copy ${k + 1}`).toEqual([e.sourceHandle, e.targetHandle]);
        expect(drawnNow.get(copy.id), `${e.id} copy ${k + 1}`).toEqual(was.get(e.id)!.map(p => Q(p.x + d.x, p.y + d.y)));
      });
      now = after;
    }
    // Past the tank, then past the first copy.
    expect(offsets[0].y).toBe(0);
    expect(offsets[1].x).toBeGreaterThan(offsets[0].x);
  });
});
