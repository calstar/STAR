import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { migrate } from './migrate';
import { J_END, isJunction, junctionData, junctionEnd, reseatJunctions, slideAlong } from './junctions';
import type { EndLookup, Face } from './junctions';

describe('an older drawing opens in today\'s vocabulary', () => {
  it('reads a standalone injector as an engine', () => {
    const inj = { id: 'n1', type: 'INJECTOR', position: { x: 0, y: 0 },
      data: { componentType: 'INJECTOR', label: 'INJ-1' } } as unknown as Node;
    const [out] = migrate({ nodes: [inj], edges: [] }).nodes;
    expect(out.type).toBe('ENGINE');
    expect((out.data as { componentType: string }).componentType).toBe('ENGINE');
    expect((out.data as { label: string }).label).toBe('INJ-1');
  });

  it('leaves everything else alone', () => {
    const tank = { id: 'n2', type: 'TANK', position: { x: 0, y: 0 },
      data: { componentType: 'TANK', label: 'TK-1' } } as unknown as Node;
    expect(migrate({ nodes: [tank], edges: [] }).nodes[0]).toBe(tank);
  });

  it('hands back the drawing it was given when there is nothing to change', () => {
    const d = { nodes: [valve('A', 0, 0)], edges: [] as Edge[] };
    const out = migrate(d);
    expect(out.nodes).toBe(d.nodes);
    expect(out.edges).toBe(d.edges);
  });
});

const valve = (id: string, x: number, y: number): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 },
  data: { componentType: 'MAN', label: id },
});

/** What click-to-branch saved, June to September 2026: `data: {}`, in on `t`, out off `b`, no symbol port named. */
function clickBranched() {
  const tee: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 275, y: 125 }, data: {} };
  const edges: Edge[] = [
    { id: 'A-B-to-junc_1', source: 'A', target: 'junc_1', targetHandle: 't', data: {} },
    { id: 'junc_1-to-B', source: 'junc_1', sourceHandle: 'b', target: 'B', data: {} },
  ];
  return { nodes: [valve('A', 100, 100), valve('B', 400, 100), tee], edges };
}

/** Measured ports, 3 px out, as the designer reads them; a tee's faces with J_END. */
const endOf: EndLookup = (node, handle) => {
  if (isJunction(node)) return handle ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
  const { x, y } = node.position;
  switch (handle) {
    case 'l': return { x: x - 3, y: y + 30, side: Position.Left };
    case 'r': return { x: x + 63, y: y + 30, side: Position.Right };
    case 't': return { x: x + 30, y: y - 3, side: Position.Top };
    case 'b': return { x: x + 30, y: y + 63, side: Position.Bottom };
    default: return null;
  }
};

describe('a tee from before tees were marked as tees', () => {
  it('is a tee again', () => {
    const out = migrate(clickBranched());
    const tee = out.nodes.find(n => n.id === 'junc_1')!;
    expect(tee.data).toMatchObject({ componentType: 'JUNCTION', label: 'junc_1' });
  });

  it('has its lines on the ports they were drawn from, not the symbol\'s first port', () => {
    const out = migrate(clickBranched());
    expect(out.edges.find(e => e.source === 'A')!.sourceHandle).toBe('r');
    expect(out.edges.find(e => e.target === 'B')!.targetHandle).toBe('l');
  });

  it('rides the straight run its lines make, on the run\'s faces', () => {
    const out = migrate(clickBranched());
    const tee = out.nodes.find(n => n.id === 'junc_1')!;
    expect(junctionData(tee).along).toMatchObject({ in: 'l', out: 'r', from: 'A', to: 'B' });
    expect(out.edges.find(e => e.source === 'A')!.targetHandle).toBe('l');
    expect(out.edges.find(e => e.target === 'B')!.sourceHandle).toBe('r');
  });
});

describe('a tee from before tees rode their pipes', () => {
  /** What splitEdgeAt saved, September 9 to 19 2026: a marked tee with no `along`, and a branch. */
  function unridden() {
    const tee: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 275, y: 125 }, measured: { width: 10, height: 10 }, data: { componentType: 'JUNCTION', label: 'junc_1' } };
    const edges: Edge[] = [
      { id: 'A-junc_1', source: 'A', sourceHandle: 'r', target: 'junc_1', targetHandle: 'l', data: {} },
      { id: 'junc_1-B', source: 'junc_1', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} },
      { id: 'C-junc_1', source: 'C', sourceHandle: 't', target: 'junc_1', targetHandle: 'b', data: {} },
    ];
    return { nodes: [valve('A', 100, 100), valve('B', 400, 100), valve('C', 170, 250), tee], edges };
  }

  it('is given the record a split gives a tee today', () => {
    const out = migrate(unridden());
    expect(junctionData(out.nodes.find(n => n.id === 'junc_1')!).along).toMatchObject({ in: 'l', out: 'r', from: 'A', to: 'B' });
  });

  it('opens settled: the reseat that follows changes nothing', () => {
    const out = migrate(JSON.parse(JSON.stringify(unridden())));
    const re = reseatJunctions(out.nodes, out.edges, endOf);
    expect(re.nodes).toBe(out.nodes);
    expect(re.edges).toBe(out.edges);
  });

  it('is left free when its lines make no one straight run', () => {
    const tee: Node = { id: 'j', type: 'JUNCTION', position: { x: 275, y: 125 }, data: { componentType: 'JUNCTION', label: 'j' } };
    const edges: Edge[] = [
      { id: 'A-j', source: 'A', sourceHandle: 'r', target: 'j', targetHandle: 'l', data: {} },
      { id: 'j-C', source: 'j', sourceHandle: 'b', target: 'C', targetHandle: 't', data: {} },
    ];
    const d = { nodes: [valve('A', 100, 100), valve('C', 250, 300), tee], edges };
    const out = migrate(d);
    expect(out.nodes).toBe(d.nodes);
    expect(out.edges).toBe(d.edges);
  });
});

describe('an old tee knocked off its pipe, or nowhere near one', () => {
  const tee = (id: string, cx: number, cy: number): Node =>
    ({ id, type: 'JUNCTION', position: { x: cx - 5, y: cy - 5 }, measured: { width: 10, height: 10 }, data: { componentType: 'JUNCTION', label: id } });
  /** A.r (163,130) to B.l (397,130), the tee `off` px below the run, a branch down to C. */
  const drawing = (off: number) => ({
    nodes: [valve('A', 100, 100), valve('B', 400, 100), valve('C', 170, 250), tee('T', 280, 130 + off)],
    edges: [
      { id: 'A-T', source: 'A', sourceHandle: 'r', target: 'T', targetHandle: 'l', data: {} },
      { id: 'T-B', source: 'T', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} },
      { id: 'C-T', source: 'C', sourceHandle: 't', target: 'T', targetHandle: 'b', data: {} },
    ] as Edge[],
  });
  const centre = (n: Node) => ({ x: n.position.x + 5, y: n.position.y + 5 });

  it('is put on its pipe on opening, when the old router drew it there, so the first reseat has nothing to do', () => {
    // Three pixels off, where a drag with the grid on left it: drawn as a
    // tee on a straight pipe. Put back on it by the reseat that follows the
    // load, it was a rewrite after the autosave's baseline, saved unasked.
    const out = migrate(JSON.parse(JSON.stringify(drawing(3))));
    const t = out.nodes.find(n => n.id === 'T')!;
    expect(centre(t)).toEqual({ x: 280, y: 130 });
    expect(junctionData(t).along).toMatchObject({ in: 'l', out: 'r', from: 'A', to: 'B' });
    const re = reseatJunctions(out.nodes, out.edges, endOf);
    expect(re.nodes).toBe(out.nodes);
    expect(re.edges).toBe(out.edges);
  });

  it('is left where it is, free, when it sat at a bend in its lines', () => {
    const d = drawing(40);
    const out = migrate(d);
    expect(out.nodes).toBe(d.nodes);
    expect(out.edges).toBe(d.edges);
  });

  it('rides its pipe once opened: dragged across it, it stays on it', () => {
    const out = migrate(JSON.parse(JSON.stringify(drawing(0))));
    const t = out.nodes.find(n => n.id === 'T')!;
    const slid = slideAlong(t, junctionData(t).along!, { x: 285, y: 155 }, out.edges, new Map(out.nodes.map(n => [n.id, n])), endOf)!;
    expect(centre({ ...t, position: slid.position })).toEqual({ x: 290, y: 130 });
  });
});

describe('a tee that recorded its neighbours', () => {
  /** A.r to B.l straight, two tees on it, each recording the two things either side of it, as tees did before they rode whole pipes. */
  function neighbours() {
    const riding = (id: string, cx: number, from: string, to: string): Node => ({
      id, type: 'JUNCTION', position: { x: cx - 5, y: 125 }, measured: { width: 10, height: 10 },
      data: { componentType: 'JUNCTION', label: id, along: { t: 0.5, in: 'l', out: 'r', from, to, ends: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } } } },
    });
    const line = (id: string, s: string, t: string): Edge => ({ id, source: s, sourceHandle: 'r', target: t, targetHandle: 'l', data: {} });
    return {
      nodes: [valve('A', 100, 100), valve('B', 400, 100), riding('T1', 230, 'A', 'T2'), riding('T2', 330, 'T1', 'B')],
      edges: [line('a', 'A', 'T1'), line('b', 'T1', 'T2'), line('c', 'T2', 'B')],
    };
  }

  it('records the ends of the pipe it rides on opening, and moves nowhere', () => {
    const d = neighbours();
    const out = migrate(d);
    for (const id of ['T1', 'T2']) {
      const n = out.nodes.find(x => x.id === id)!;
      expect(n.position).toEqual(d.nodes.find(x => x.id === id)!.position);
      expect(junctionData(n).along).toMatchObject({ from: 'A', to: 'B', in: 'l', out: 'r' });
    }
    expect(junctionData(out.nodes.find(x => x.id === 'T1')!).along!.t).toBeCloseTo((230 - 163) / (397 - 163), 6);
    expect(out.edges).toBe(d.edges);
  });

  it('opens settled: the reseat that follows rewrites no record', () => {
    const out = migrate(neighbours());
    const re = reseatJunctions(out.nodes, out.edges, endOf);
    expect(re.nodes).toBe(out.nodes);
  });
});

describe('a line an old tee saved with no port on its symbol end', () => {
  it('is put on the lid port the tee is over, of a tank with three', () => {
    const tank: Node = { id: 'TK', type: 'TANK', position: { x: 100, y: 200 }, data: { componentType: 'TANK', label: 'TK', options: { portsTop: 3 } } };
    const above: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 145, y: 95 }, data: {} };
    const out = migrate({ nodes: [tank, above], edges: [{ id: 'j-TK', source: 'junc_1', sourceHandle: 'b', target: 'TK', data: {} }] });
    // The lid ports are at 10, 30 and 50 across; the tee is over the third.
    expect(out.edges[0].targetHandle).toBe('t3');
  });

  it('is put on a manifold\'s nearest outlet, which is named for no side', () => {
    const man: Node = { id: 'M', type: 'MANIFOLD', position: { x: 400, y: 200 }, data: { componentType: 'MANIFOLD', label: 'M', options: { outlets: 4 } } };
    // Outlets down the bottom at 10, 40, 70 and 100 across; the tee is under the third.
    const below: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 461, y: 295 }, data: {} };
    const out = migrate({ nodes: [man, below], edges: [{ id: 'j-M', source: 'junc_1', sourceHandle: 't', target: 'M', data: {} }] });
    expect(out.edges[0].targetHandle).toBe('p3');
  });
});

describe('a line an old tee saved with no port on its symbol end, beside one that has a port', () => {
  it('is not put on a port another line is on', () => {
    // V.r already runs to X. The old tee to V's right was drawn from V's
    // first port, which React Flow showed it on; put on V.r as the port that
    // reaches best, it would have been a second line on one port.
    const V: Node = { id: 'V', type: 'SOL', position: { x: 100, y: 100 }, data: { componentType: 'SOL', label: 'V' } };
    const X = valve('X', 400, 100);
    const tee: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 215, y: 55 }, data: {} };
    const out = migrate({
      nodes: [V, X, tee],
      edges: [
        { id: 'V-X', source: 'V', sourceHandle: 'r', target: 'X', targetHandle: 'l', data: {} },
        { id: 'V-junc_1', source: 'V', target: 'junc_1', targetHandle: 'l', data: {} },
      ],
    });
    expect(out.edges.find(e => e.id === 'V-junc_1')!.sourceHandle).toBe('l');
    // With the port free, the best one is taken, as ever.
    const alone = migrate({ nodes: [V, tee], edges: [{ id: 'V-junc_1', source: 'V', target: 'junc_1', targetHandle: 'l', data: {} }] });
    expect(alone.edges[0].sourceHandle).toBe('r');
  });
});

describe('a drawing that holds two lines of one id', () => {
  it('gives the second an id of its own, so neither is lost to the other', () => {
    const d = {
      nodes: [valve('A', 0, 0), valve('B', 200, 0), valve('C', 0, 200), valve('D', 200, 200)],
      edges: [
        { id: 'dup', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} },
        { id: 'dup', source: 'C', sourceHandle: 'r', target: 'D', targetHandle: 'l', data: {} },
      ] as Edge[],
    };
    const out = migrate(d);
    expect(out.edges.map(e => [e.id, e.source])).toEqual([['dup', 'A'], ['C-D', 'C']]);
    // Opened again, it is as it was.
    expect(migrate(out).edges).toBe(out.edges);
  });
});

describe('a junction today\'s canvas left free', () => {
  it('is not made to ride by opening the drawing again', () => {
    // An open end carried on to C round a corner, and C then brought level
    // with A: two lines straight through a junction the canvas left free.
    // Opening the drawing is not a gesture, and nothing changes.
    const J: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 140, y: 125 }, data: { componentType: 'JUNCTION', label: 'junc_1' } };
    const d = {
      nodes: [valve('A', 0, 100), J, valve('C', 260, 100)],
      edges: [
        { id: 'A-junc_1', source: 'A', sourceHandle: 'r', target: 'junc_1', targetHandle: 'l', data: {} },
        { id: 'junc_1-C', source: 'junc_1', sourceHandle: 'r', target: 'C', targetHandle: 'l', data: {} },
      ] as Edge[],
    };
    const out = migrate(d);
    expect(out.nodes).toBe(d.nodes);
    expect(out.edges).toBe(d.edges);
  });
});

describe('a line an old tee saved with no port on a turned symbol', () => {
  it('is put on the port that faces the tee once the symbol is turned', () => {
    // A valve turned a quarter clockwise has `l` facing up and `r` down; the
    // old tee is below it. Turned three quarters, the other way about.
    const old = (rotation: number) => {
      const tee: Node = { id: 'junc_1', type: 'JUNCTION', position: { x: 125, y: 300 }, data: {} };
      const V: Node = { ...valve('A', 100, 100), data: { componentType: 'MAN', label: 'A', rotation } };
      return migrate({ nodes: [V, tee], edges: [{ id: 'A-junc_1', source: 'A', target: 'junc_1', targetHandle: 't', data: {} }] });
    };
    expect(old(90).edges[0].sourceHandle).toBe('r');
    expect(old(270).edges[0].sourceHandle).toBe('l');
  });
});
