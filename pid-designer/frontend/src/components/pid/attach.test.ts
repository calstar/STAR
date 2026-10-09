import { afterEach, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  dragAttached, isInstrument, centreOf, clipAt, leaderTarget, lineRoutes, remapAttachments,
  clearOfHost,
} from './attach';
import { AttachmentLayer } from './AttachmentLayer';
import { publishEdge, unpublishEdge } from './edgeGeometry';
import { nearestOnPolyline, pointsToPath, segmentEntersBox } from './route';
import type { Pt } from './route';

/** What a probe dropped at `point` clips to, host only: `clipAt` without where on a line. */
const targetAt = (...a: Parameters<typeof clipAt>) => {
  const clip = clipAt(...a);
  return clip && { id: clip.id, kind: clip.kind };
};

const node = (id: string, componentType: string, x: number, y: number,
              w = 60, h = 60, data: Record<string, unknown> = {}): Node =>
  ({ id, position: { x, y }, measured: { width: w, height: h },
     data: { componentType, label: id, ...data } }) as unknown as Node;

const edge = (id: string, source: string, target: string): Edge =>
  ({ id, source, target }) as unknown as Edge;

describe('what an instrument clips to', () => {
  const nodes = [
    node('TANK', 'TANK', 0, 0, 60, 100),
    node('SOL', 'SOL', 300, 20),
  ];
  const edges = [edge('e1', 'TANK', 'SOL')];

  it('picks the component under the drop', () => {
    expect(targetAt({ x: 30, y: 50 }, nodes, edges)).toEqual({ id: 'TANK', kind: 'node' });
  });

  it('picks the line when the drop is near it but on nothing', () => {
    // Centres are (30,50) and (330,50), so the run is along y = 50.
    expect(targetAt({ x: 180, y: 54 }, nodes, edges)).toEqual({ id: 'e1', kind: 'edge' });
  });

  it('attaches to nothing out in open canvas', () => {
    expect(targetAt({ x: 180, y: 400 }, nodes, edges)).toBeNull();
  });

  it('prefers the component over the line running through it', () => {
    // A valve sits on its own line; dropping a probe on the valve means the
    // valve, which is the more specific of the two answers.
    expect(targetAt({ x: 330, y: 50 }, nodes, edges)).toEqual({ id: 'SOL', kind: 'node' });
  });

  it('never clips one probe to another', () => {
    const withProbe = [...nodes, node('TC-1', 'TC', 20, 40)];
    expect(targetAt({ x: 30, y: 50 }, withProbe, edges)).toEqual({ id: 'TANK', kind: 'node' });
  });

  it('does not clip a probe to itself', () => {
    const withProbe = [...nodes, node('TC-1', 'TC', 500, 500)];
    expect(targetAt({ x: 520, y: 520 }, withProbe, edges, 'TC-1')).toBeNull();
  });
});

describe('instruments follow what they measure', () => {
  it('moves everything clipped to a component by the same delta', () => {
    const nodes = [
      node('TANK', 'TANK', 0, 0, 60, 100),
      node('TC-1', 'TC', 80, -10, 60, 60, { attachedTo: 'TANK' }),
      node('TC-2', 'TC', 400, 400, 60, 60, { attachedTo: 'SOL' }),
    ];
    const moved = dragAttached(nodes, 'TANK', { x: 25, y: -15 });
    expect(moved.find(n => n.id === 'TC-1')!.position).toEqual({ x: 105, y: -25 });
    // Clipped to something else, so untouched.
    expect(moved.find(n => n.id === 'TC-2')!.position).toEqual({ x: 400, y: 400 });
  });

  it('leaves the array alone when nothing actually moved', () => {
    const nodes = [node('TANK', 'TANK', 0, 0)];
    expect(dragAttached(nodes, 'TANK', { x: 0, y: 0 })).toBe(nodes);
  });
});

describe('which components attach rather than connect', () => {
  it('counts the probes, and not the fittings', () => {
    // A gauge or a transducer screws into a tee and is part of the feed
    // system, so it connects like anything else.
    expect(['RTD', 'TC', 'LC'].every(isInstrument)).toBe(true);
    expect(['PT', 'PG', 'TANK', 'SOL', 'PR', 'QD', 'ENGINE'].some(isInstrument)).toBe(false);
  });
});

describe('the page you are looking at', () => {
  const gse: Node[] = [
    { id: 'TANK', type: 'TANK', position: { x: 0, y: 0 },
      measured: { width: 60, height: 100 },
      data: { componentType: 'TANK', label: 'TANK', page: 'GSE' } },
    { id: 'SOL', type: 'SOL', position: { x: 300, y: 20 },
      measured: { width: 60, height: 60 },
      data: { componentType: 'SOL', label: 'SOL', page: 'GSE' } },
  ];
  const wire: Edge[] = [{ id: 'e1', source: 'TANK', target: 'SOL' }];

  it('is the only page a drop can land on', () => {
    // The graph is whole so fluid and checks span pages -- which means an
    // unscoped hit test would clip a probe to a tank that is not on screen.
    expect(targetAt({ x: 30, y: 50 }, gse, wire, undefined, 'GSE'))
      .toEqual({ id: 'TANK', kind: 'node' });
    expect(targetAt({ x: 30, y: 50 }, gse, wire, undefined, 'Main')).toBeNull();
  });

  it('hides the lines on it too', () => {
    expect(targetAt({ x: 180, y: 54 }, gse, wire, undefined, 'GSE'))
      .toEqual({ id: 'e1', kind: 'edge' });
    expect(targetAt({ x: 180, y: 54 }, gse, wire, undefined, 'Main')).toBeNull();
  });

  it('hits everything when no page is named', () => {
    expect(targetAt({ x: 30, y: 50 }, gse, wire)).toEqual({ id: 'TANK', kind: 'node' });
  });
});

describe('a node nobody has measured yet', () => {
  it('is its own size, not everything\u2019s size', () => {
    // A junction is a ten-pixel dot and `measured` arrives a render after the
    // node does. Falling back to 60 put its centre 25 px off the pipe, so a
    // second branch made in the same batch missed the line entirely.
    const junction: Node = { id: 'j', type: 'JUNCTION', position: { x: 100, y: 100 },
      data: { componentType: 'JUNCTION' } } as unknown as Node;
    expect(centreOf(junction)).toEqual({ x: 105, y: 105 });

    const valve: Node = { id: 'v', type: 'MAN', position: { x: 100, y: 100 },
      data: { componentType: 'MAN' } } as unknown as Node;
    expect(centreOf(valve)).toEqual({ x: 130, y: 130 });
  });

  it('yields to a real measurement once there is one', () => {
    const tank: Node = { id: 't', type: 'TANK', position: { x: 0, y: 0 },
      measured: { width: 60, height: 100 },
      data: { componentType: 'TANK' } } as unknown as Node;
    expect(centreOf(tank)).toEqual({ x: 30, y: 50 });
  });
});

// ── Lines as they are drawn ──────────────────────────────────────────────────

/** A 60 px symbol with its ports mid-side, as valves and sensors have them. */
const sym = (id: string, x: number, y: number, page = 'Main'): Node =>
  ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 },
     data: { componentType: 'MAN', label: id, page } }) as unknown as Node;

const line = (id: string, source: string, sh: string, target: string, th: string, data = {}): Edge =>
  ({ id, source, sourceHandle: sh, target, targetHandle: th, data }) as unknown as Edge;

/** A leaves right, B takes it in at the top: an L, round the corner at (330, 30). */
function bent() {
  const nodes = [sym('A', 0, 0), sym('B', 300, 200)];
  const edges = [line('A-B', 'A', 'r', 'B', 't')];
  return { nodes, edges, pts: lineRoutes(nodes, edges).get('A-B')! };
}

describe('a probe dropped on a line clips to the pipe as drawn', () => {
  it('routes a line nobody has drawn yet the way it will draw itself', () => {
    // Out of A's right port (3 px beyond the box, where a line meets a
    // handle), along to the column of B's top port, and down into it.
    const { pts } = bent();
    expect(pts[0]).toEqual({ x: 63, y: 30 });
    expect(pts[pts.length - 1]).toEqual({ x: 330, y: 197 });
    expect(pts.some(p => p.x === 330 && p.y === 30)).toBe(true);
  });

  it('clips on either leg of a bent line', () => {
    const { nodes, edges } = bent();
    // The chord between the two centres runs nowhere near either point.
    expect(targetAt({ x: 200, y: 32 }, nodes, edges)).toEqual({ id: 'A-B', kind: 'edge' });
    expect(targetAt({ x: 327, y: 120 }, nodes, edges)).toEqual({ id: 'A-B', kind: 'edge' });
  });

  it('does not clip in the empty space inside the bend', () => {
    // On the chord, and a hundred pixels from the pipe.
    const { nodes, edges } = bent();
    expect(targetAt({ x: 180, y: 130 }, nodes, edges)).toBeNull();
  });

  it('says how far along the line it landed', () => {
    const { nodes, edges, pts } = bent();
    const clip = clipAt({ x: 330, y: 120 }, nodes, edges)!;
    expect(clip.id).toBe('A-B');
    expect(clip.at).toBeCloseTo(nearestOnPolyline(pts, { x: 330, y: 120 })!.t, 9);
    expect(clip.at!).toBeGreaterThan(0.5);
    // A component carries no position along it.
    expect(clipAt({ x: 30, y: 30 }, nodes, edges)).toEqual({ id: 'A', kind: 'node' });
  });

  it('hit-tests the lines it is handed when the caller has them', () => {
    // As rendered, somebody has dragged this line's crossbar down to y = 100:
    // the drop at y = 100 is on it, and nowhere near where it would route
    // itself.
    const { nodes, edges } = bent();
    const drawnLines = [{ id: 'A-B', d: pointsToPath([{ x: 63, y: 30 }, { x: 80, y: 30 }, { x: 80, y: 100 }, { x: 330, y: 100 }, { x: 330, y: 197 }]) }];
    expect(targetAt({ x: 200, y: 100 }, nodes, edges, undefined, undefined, drawnLines)).toEqual({ id: 'A-B', kind: 'edge' });
    expect(targetAt({ x: 200, y: 30 }, nodes, edges, undefined, undefined, drawnLines)).toBeNull();
  });

  it('only hits lines with both ends on the page', () => {
    const nodes = [sym('A', 0, 0), sym('B', 300, 200, 'GSE')];
    const edges = [line('A-B', 'A', 'r', 'B', 't')];
    expect(targetAt({ x: 200, y: 32 }, nodes, edges, undefined, 'Main')).toBeNull();
  });
});

describe('where a leader lands on a line', () => {
  afterEach(() => unpublishEdge('A-B'));

  it('is on the pipe, however it bends', () => {
    const { nodes, edges, pts } = bent();
    const mid = leaderTarget('A-B', nodes, edges)!;
    expect(nearestOnPolyline(pts, mid)!.dist).toBeLessThan(1e-9);
  });

  it('is where the probe was dropped, when that was kept', () => {
    const { nodes, edges, pts } = bent();
    const clip = clipAt({ x: 330, y: 150 }, nodes, edges)!;
    const at = leaderTarget('A-B', nodes, edges, clip.at)!;
    expect(at.x).toBeCloseTo(330, 9);
    expect(at.y).toBeCloseTo(150, 9);
    expect(nearestOnPolyline(pts, at)!.dist).toBeLessThan(1e-9);
  });

  it('follows the corners a line published when it drew', () => {
    const { nodes, edges } = bent();
    const drawn: Pt[] = [{ x: 63, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 120 }, { x: 330, y: 120 }, { x: 330, y: 197 }];
    publishEdge('A-B', drawn);
    expect(lineRoutes(nodes, edges).get('A-B')).toEqual(drawn);
    const mid = leaderTarget('A-B', nodes, edges)!;
    expect(nearestOnPolyline(drawn, mid)!.dist).toBeLessThan(1e-9);
  });

  it('stands a new probe off the point it clipped to', () => {
    const { nodes, edges } = bent();
    const at = clipAt({ x: 330, y: 150 }, nodes, edges)!;
    expect(clearOfHost(at, { x: 0, y: 0 }, nodes, edges, at.at)).toEqual({ x: 344, y: 150 - 74 });
  });
});

describe('the leaders drawn', () => {
  const probe = (id: string, attachedTo: string, extra: Record<string, unknown> = {}): Node =>
    ({ id, type: 'TC', position: { x: 380, y: 60 }, measured: { width: 60, height: 60 },
       data: { componentType: 'TC', label: id, attachedTo, ...extra } }) as unknown as Node;

  /** Every leader's landing dot, by probe id. */
  function dots(nodes: Node[], edges: Edge[]): Map<string, Pt> {
    const tree = AttachmentLayer({ nodes, edges }) as unknown as
      { props: { children: { props: { children: { key: string; props: { children: { props: Record<string, number> }[] } }[] } } } } | null;
    const out = new Map<string, Pt>();
    for (const g of tree?.props.children.props.children ?? []) {
      const circle = g.props.children[1].props;
      out.set(String(g.key), { x: circle.cx, y: circle.cy });
    }
    return out;
  }

  it('lands on the drawn line at the point the probe was clipped', () => {
    const { nodes, edges, pts } = bent();
    const clip = clipAt({ x: 330, y: 150 }, nodes, edges)!;
    const drawn = dots([...nodes, probe('TC1', 'A-B', { attachedAt: clip.at })], edges).get('TC1')!;
    expect(nearestOnPolyline(pts, drawn)!.dist).toBeLessThan(1e-9);
    expect(drawn.y).toBeCloseTo(150, 9);
  });

  it('draws nothing for a probe on another page, or clipped to something there', () => {
    // What the page's view hands over: everything, off-page things hidden.
    const { nodes, edges } = bent();
    const hiddenProbe = { ...probe('TC1', 'A-B'), hidden: true };
    const onHiddenLine = probe('TC2', 'A-B');
    const onHiddenSymbol = probe('TC3', 'B');
    expect(dots([...nodes, hiddenProbe], edges).size).toBe(0);
    expect(dots([...nodes, onHiddenLine], edges.map(e => ({ ...e, hidden: true }))).size).toBe(0);
    expect(dots([nodes[0], { ...nodes[1], hidden: true }, onHiddenSymbol], edges).size).toBe(0);
    // The same probes, all shown, all draw.
    expect(dots([...nodes, probe('TC1', 'A-B'), probe('TC3', 'B')], edges).size).toBe(2);
  });
});

describe('a probe on a line that is replaced', () => {
  const tc = (id: string, attachedTo: string, attachedAt?: number): Node =>
    ({ id, type: 'TC', position: { x: 0, y: 0 },
       data: { componentType: 'TC', label: id, attachedTo, ...(attachedAt === undefined ? {} : { attachedAt }) } }) as unknown as Node;
  const clip = (n: Node) => n.data as { attachedTo?: string; attachedAt?: number };

  // A straight run from x = 0 to x = 300, cut by a tee at x = 200.
  const whole: Pt[] = [{ x: 0, y: 0 }, { x: 300, y: 0 }];
  const halves = [
    { id: 'A-j', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
    { id: 'j-B', points: [{ x: 200, y: 0 }, { x: 300, y: 0 }] },
  ];

  it('goes to the half that holds its clip point, and says where on it', () => {
    const nodes = [tc('near', 'A-B', 0.1), tc('far', 'A-B', 0.9), tc('other', 'X-Y', 0.5)];
    const out = remapAttachments(nodes, 'A-B', halves, whole);
    expect(clip(out[0])).toMatchObject({ attachedTo: 'A-j' });
    expect(clip(out[0]).attachedAt).toBeCloseTo(30 / 200, 9);
    expect(clip(out[1])).toMatchObject({ attachedTo: 'j-B' });
    expect(clip(out[1]).attachedAt).toBeCloseTo(70 / 100, 9);
    expect(out[2]).toBe(nodes[2]);
  });

  it('takes the halves laid end to end as the old line when not told it', () => {
    const out = remapAttachments([tc('far', 'A-B', 0.9)], 'A-B', halves);
    expect(clip(out[0]).attachedTo).toBe('j-B');
    expect(clip(out[0]).attachedAt).toBeCloseTo(0.7, 9);
  });

  it('puts a probe clipped before positions were kept at the middle of the old line', () => {
    const out = remapAttachments([tc('old', 'A-B')], 'A-B', halves, whole);
    // 150 of 300 is on the first half, three quarters of the way along it.
    expect(clip(out[0]).attachedTo).toBe('A-j');
    expect(clip(out[0]).attachedAt).toBeCloseTo(0.75, 9);
  });

  it('follows a healed line from either half', () => {
    const healed = [{ id: 'A-B2', points: whole }];
    const nodes = [tc('p', 'A-j', 0.5), tc('q', 'j-B', 0.5)];
    const once = remapAttachments(nodes, 'A-j', healed, halves[0].points);
    const both = remapAttachments(once, 'j-B', healed, halves[1].points);
    expect(clip(both[0])).toMatchObject({ attachedTo: 'A-B2' });
    expect(clip(both[0]).attachedAt).toBeCloseTo(100 / 300, 9);
    expect(clip(both[1])).toMatchObject({ attachedTo: 'A-B2' });
    expect(clip(both[1]).attachedAt).toBeCloseTo(250 / 300, 9);
  });

  it('hands back the same array when nothing was clipped to the line', () => {
    const nodes = [tc('other', 'X-Y', 0.5)];
    expect(remapAttachments(nodes, 'A-B', halves, whole)).toBe(nodes);
  });
});

describe('a line that has not drawn yet', () => {
  const valve = (id: string, x: number, y: number, rotation = 0): Node =>
    ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, rotation } }) as unknown as Node;

  it('is routed round the symbols in its way, as the canvas will route it', () => {
    // T's bottom port straight down to V3's left, V2 in between: the canvas
    // goes round V2. The old guess drew straight through it, and a leader
    // landed where the line would not be.
    const nodes = [valve('T', 170, 0), valve('V2', 170, 170), valve('V3', 300, 170)];
    const edges = [{ id: 'T-V3', source: 'T', sourceHandle: 'b', target: 'V3', targetHandle: 'l', data: {} } as unknown as Edge];
    const pts = lineRoutes(nodes, edges, new Map()).get('T-V3')!;
    const v2 = { x: 170, y: 170, w: 60, h: 60 };
    const through = pts.some((p, i) => i + 1 < pts.length && segmentEntersBox(p, pts[i + 1], v2, 1));
    expect(through, JSON.stringify(pts)).toBe(false);
  });

  it('leaves a turned symbol by the side its port is turned to', () => {
    // Turned a quarter, a valve's `r` faces down and its `l` up.
    const nodes = [valve('A', 0, 0, 90), valve('B', 0, 300, 90)];
    const edges = [{ id: 'A-B', source: 'A', sourceHandle: 'r', target: 'B', targetHandle: 'l', data: {} } as unknown as Edge];
    const pts = lineRoutes(nodes, edges, new Map()).get('A-B')!;
    expect(pts[0]).toEqual({ x: 30, y: 63 });
    expect(pts[pts.length - 1]).toEqual({ x: 30, y: 297 });
  });
});
