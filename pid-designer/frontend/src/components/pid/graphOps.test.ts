import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { translateSubgraph, turnSelected } from './graphOps';

const node = (id: string, x: number, y: number, data: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node =>
  ({ id, type: 'MAN', position: { x, y }, data: { componentType: 'MAN', label: id, ...data }, ...extra }) as Node;
const line = (s: string, t: string, waypoints?: { x: number; y: number }[], extra: Record<string, unknown> = {}): Edge =>
  ({ id: `${s}-${t}`, source: s, target: t, data: { ...(waypoints ? { waypoints } : {}), ...extra } });
const d = { x: 40, y: 20 };

describe('moving part of the drawing', () => {
  it('moves the nodes picked up, and only those', () => {
    const out = translateSubgraph([node('a', 0, 0), node('b', 100, 0)], [], new Set(['a']), d);
    expect(out.nodes.map(n => n.position)).toEqual([{ x: 40, y: 20 }, { x: 100, y: 0 }]);
  });

  it('moves the corners of a line picked up whole, hand-drawn and pipe-given alike', () => {
    const nodes = [node('a', 0, 0), node('b', 200, 100)];
    const edges = [
      line('a', 'b', [{ x: 120, y: 30 }, { x: 120, y: 130 }]),
      { ...line('b', 'a', [{ x: 50, y: 50 }], { viaRun: true }), id: 'b-a' },
    ];
    const out = translateSubgraph(nodes, edges, ['a', 'b'], d);
    expect((out.edges[0].data as { waypoints: unknown }).waypoints).toEqual([{ x: 160, y: 50 }, { x: 160, y: 150 }]);
    expect((out.edges[1].data as { waypoints: unknown; viaRun: boolean })).toMatchObject({ waypoints: [{ x: 90, y: 70 }], viaRun: true });
  });

  it('leaves the corners of a line with one end left behind where they were', () => {
    // A corner is a decision about where the pipe runs; moving one end does
    // not unmake it.
    const edges = [line('a', 'b', [{ x: 120, y: 30 }])];
    const out = translateSubgraph([node('a', 0, 0), node('b', 200, 100)], edges, ['a'], d);
    expect(out.edges).toBe(edges);
  });

  it('moves the pipe ends a tee last saw along with it', () => {
    const tee = node('j', 95, 25, { componentType: 'JUNCTION', along: { t: 0.5, in: 'l', out: 'r', from: 'a', to: 'b', ends: { a: { x: 60, y: 30 }, b: { x: 140, y: 30 } } } }, { type: 'JUNCTION' });
    const out = translateSubgraph([tee], [], ['j'], d);
    const along = (out.nodes[0].data as { along: { ends: unknown; t: number; from: string } }).along;
    expect(along.ends).toEqual({ a: { x: 100, y: 50 }, b: { x: 180, y: 50 } });
    expect(along.t).toBe(0.5);
    expect(along.from).toBe('a');
  });

  it('moves a tee\'s home, and where its pipe\'s ends were then, along with it', () => {
    // Picked up and put down elsewhere, a bay's tees are at home there: an
    // end dragged out and back finds its way back to where the bay now is.
    const home = { a: { x: 60, y: 30 }, b: { x: 140, y: 30 }, at: { x: 100, y: 30 } };
    const tee = node('j', 95, 25, { componentType: 'JUNCTION', along: { t: 0.5, in: 'l', out: 'r', from: 'a', to: 'b', home } }, { type: 'JUNCTION' });
    const out = translateSubgraph([tee], [], ['j'], d);
    const along = (out.nodes[0].data as { along: { home: unknown; ends?: unknown } }).along;
    expect(along.home).toEqual({ a: { x: 100, y: 50 }, b: { x: 180, y: 50 }, at: { x: 140, y: 50 } });
    expect(along.ends).toBeUndefined();
  });

  it('hands back the very same arrays when nothing moves', () => {
    const nodes = [node('a', 0, 0)], edges = [line('a', 'a', [{ x: 1, y: 1 }])];
    const still = translateSubgraph(nodes, edges, ['a'], { x: 0, y: 0 });
    expect(still.nodes).toBe(nodes);
    expect(still.edges).toBe(edges);
    const none = translateSubgraph(nodes, edges, [], d);
    expect(none.nodes).toBe(nodes);
  });
});

describe('R', () => {
  it('turns what is selected on the page being looked at, and nothing on another page', () => {
    const nodes = [
      node('main', 0, 0, { page: 'Main' }, { selected: true }),
      node('gse', 0, 0, { page: 'GSE', rotation: 270 }, { selected: true }),
      node('idle', 0, 0, { page: 'GSE' }),
    ];
    const out = turnSelected(nodes, 'GSE');
    const rot = (i: number) => (out[i].data as { rotation?: number }).rotation;
    expect(rot(0)).toBeUndefined();
    expect(rot(1)).toBe(0);
    expect(out[2]).toBe(nodes[2]);
  });

  it('hands back the same array when nothing on the page is selected', () => {
    const nodes = [node('main', 0, 0, { page: 'Main' }, { selected: true })];
    expect(turnSelected(nodes, 'GSE')).toBe(nodes);
  });
});
