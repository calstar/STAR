// A drag let go on a symbol's body means its free port the line reaches
// best (drop.ts, rule d). Which one is decided by the route to each, searched
// round the symbols in the way; this is that the choice is the one asking
// every port gives, and that ports no route to could win are not asked.
import { describe, expect, it, vi } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

const asked = vi.hoisted(() => ({ routes: 0 }));
vi.mock('./routeGrid', async (orig) => {
  const G = await orig<typeof import('./routeGrid')>();
  return { ...G, routeAuto: (...a: Parameters<typeof G.routeAuto>) => { asked.routes++; return G.routeAuto(...a); } };
});

import { resolveDrop } from './drop';
import type { DropScene } from './drop';
import type { EndLookup } from './junctions';
import { obstacleBoxes, routeAuto } from './routeGrid';
import { pathPoints, routeCost, simplifyPoints } from './route';
import type { Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });
/** A symbol 60 wide and `h` high with ports down its left and right sides every 20 px, and one top and bottom. */
function symbol(id: string, x: number, y: number, h = 120): Node {
  return { id, type: 'MAN', position: { x, y }, measured: { width: 60, height: h }, data: { componentType: 'MAN', label: id } };
}
const PORTS = ['l1', 'l2', 'l3', 'l4', 'l5', 'r1', 'r2', 'r3', 'r4', 'r5', 't', 'b'];
const endOf: EndLookup = (n, h) => {
  const { x, y } = n.position;
  const hgt = n.measured?.height ?? 60;
  if (!h) return null;
  if (h === 't') return { x: x + 30, y, side: Position.Top };
  if (h === 'b') return { x: x + 30, y: y + hgt, side: Position.Bottom };
  const k = Number(h.slice(1));
  return h[0] === 'l' ? { x, y: y + 20 * k, side: Position.Left } : { x: x + 60, y: y + 20 * k, side: Position.Right };
};

describe('a drop on a symbol body', () => {
  it('takes the free port the line reaches best, as asking every port does, and asks fewer', () => {
    const M = symbol('M', 400, 200), S = symbol('S', 0, 0, 60);
    const others = [symbol('X', 250, 200, 60), symbol('Y', 400, 420, 60), symbol('Z', 560, 60, 60)];
    const nodes = [M, S, ...others];
    const boxes = obstacleBoxes(nodes);
    let fewer = 0;
    for (const [sx, sy] of [[0, 0], [100, 400], [800, 250], [420, 0], [700, 600], [200, 150]]) {
      const src = { ...S, position: P(sx, sy) };
      const g = [src, ...nodes.filter(n => n.id !== 'S')];
      const scene: DropScene = { nodes: g, edges: [] as Edge[], endOf, portsOf: n => (n.id === 'M' ? PORTS : ['r']), obstacles: boxes };
      asked.routes = 0;
      const plan = resolveDrop({ kind: 'port', nodeId: 'S', handle: 'r' }, P(430, 260), { node: 'M' }, scene);
      const routes = asked.routes;
      expect(plan.kind).toBe('connect');
      // Every port asked, the first of the cheapest.
      const from = endOf(src, 'r')!;
      const costs = PORTS.map(h => routeCost(simplifyPoints(pathPoints(routeAuto(from, endOf(M, h)!, boxes).d))));
      const best = PORTS[costs.indexOf(Math.min(...costs))];
      expect((plan as { to: { handle?: string } }).to.handle, `from ${sx},${sy}`).toBe(best);
      if (routes < PORTS.length) fewer++;
    }
    expect(fewer).toBeGreaterThan(0);
  });
});
