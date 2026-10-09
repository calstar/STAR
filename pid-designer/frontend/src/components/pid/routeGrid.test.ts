import { describe, expect, it, vi } from 'vitest';
import { Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import { facing, isHorizontal, pathPoints, routeOrthogonal } from './route';
import type { Box, End, Pt } from './route';
import {
  DOT_CLEAR, LIFT, NO_BOXES, VENT_REACH, avoidable, boxGrid, boxOfNode, dotBox, gridRoute, heldClear, lastSearch, lineGrid,
  obstacleBoxes, obstacleGrid, obstaclesByPage, perPage, routeAmong, routeAuto, routeHitsBoxes, withinReach,
} from './routeGrid';
import type { Soft, SoftLine } from './routeGrid';

/**
 * A sweep runs thousands of routes: well inside a test's usual five seconds
 * alone, but not always on a machine busy with other work.
 */
const SWEEP_MS = 30_000;

const P = (x: number, y: number): Pt => ({ x, y });
const L = Position.Left, R = Position.Right, T = Position.Top, B = Position.Bottom;
/** What an end on a tee carries: `J_END` in junctions.ts. */
const TEE = { clear: 14, stub: 6 };

const node = (id: string, componentType: string, x: number, y: number, w = 60, h = 60, extra: Partial<Node> = {}): Node =>
  ({ id, type: componentType, position: { x, y }, measured: { width: w, height: h }, data: { componentType, label: id }, ...extra });

/** Does a run pass through the inside of a box (its edge, and a pixel in, excepted)? */
function through(run: Pt[], b: Box): boolean {
  const x0 = b.x + 1, x1 = b.x + b.w - 1, y0 = b.y + 1, y1 = b.y + b.h - 1;
  for (let i = 0; i + 1 < run.length; i++) {
    const p = run[i], q = run[i + 1];
    if (p.y === q.y && p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1) return true;
    if (p.x === q.x && p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1) return true;
  }
  return false;
}

/** Square all the way, and out of `a` and into `b` along the ways their ports face. */
function wellFormed(run: Pt[], a: End, b: End): boolean {
  for (let i = 0; i + 1 < run.length; i++) if (run[i].x !== run[i + 1].x && run[i].y !== run[i + 1].y) return false;
  const step = (p: Pt, q: Pt) => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) });
  const fa = isHorizontal(a.side) ? { x: facing(a.side), y: 0 } : { x: 0, y: facing(a.side) };
  const fb = isHorizontal(b.side) ? { x: -facing(b.side), y: 0 } : { x: 0, y: -facing(b.side) };
  const first = step(run[0], run[1]), last = step(run[run.length - 2], run[run.length - 1]);
  return first.x === fa.x && first.y === fa.y && last.x === fb.x && last.y === fb.y
    && run[0].x === a.x && run[0].y === a.y && run[run.length - 1].x === b.x && run[run.length - 1].y === b.y;
}

describe('a line with nothing in its way', () => {
  it('is exactly the shape the plain router draws, grip and offset included', () => {
    const a: End = { x: 63, y: 30, side: R }, b: End = { x: 297, y: 130, side: L };
    const far = obstacleBoxes([node('X', 'MAN', 500, 500)]);
    expect(routeAuto(a, b, far)).toEqual(routeOrthogonal(a, b));
    expect(routeAuto(a, b, far, 40)).toEqual(routeOrthogonal(a, b, 40));
    expect(routeAuto(a, b, [])).toEqual(routeOrthogonal(a, b));
  });
});

describe('a line with a symbol in its way', () => {
  it('goes round a valve between the tank outlet and the valve it feeds', () => {
    // A tank with three bottom outlets over a row of valves. The third
    // outlet to the third valve's inlet turned its corner through the
    // second valve and ran out over its outlet, so a parallel connection
    // read as a series one.
    const nodes = [node('T', 'TANK', 200, 0, 60, 100), node('V1', 'MAN', 100, 200), node('V2', 'MAN', 200, 200), node('V3', 'MAN', 300, 200)];
    const boxes = obstacleBoxes(nodes);
    const a: End = { x: 245, y: 103, side: B }, b: End = { x: 297, y: 230, side: L };
    expect(routeHitsBoxes(pathPoints(routeOrthogonal(a, b).d), boxes)).toBe(true);
    const run = pathPoints(routeAuto(a, b, boxes).d);
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    expect(routeHitsBoxes(run, boxes), JSON.stringify(run)).toBe(false);
    // Nowhere near V2's outlet, which is what made it read as V2 -> V3.
    const overV2Outlet = run.some((p, i) => i + 1 < run.length && p.y === 230 && run[i + 1].y === 230
      && Math.min(p.x, run[i + 1].x) <= 263 && Math.max(p.x, run[i + 1].x) >= 263);
    expect(overV2Outlet).toBe(false);
  });

  it('goes round a symbol standing between two in a row', () => {
    const nodes = [node('A', 'MAN', 0, 0), node('B', 'MAN', 150, 0), node('C', 'MAN', 300, 0)];
    const boxes = obstacleBoxes(nodes);
    const a: End = { x: 63, y: 30, side: R }, b: End = { x: 297, y: 30, side: L };
    const run = pathPoints(routeAuto(a, b, boxes).d);
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    expect(through(run, boxOfNode(nodes[1])), JSON.stringify(run)).toBe(false);
  });

  it('takes a bypass round the valve it bypasses', () => {
    // Tees under the run either side of a valve, joined: the plain U between
    // two downward faces ran along under the run, through the valve.
    const V = node('V', 'PR', 200, 0);
    const a: End = { x: 130, y: 38, side: B, ...TEE }, b: End = { x: 330, y: 38, side: B, ...TEE };
    const boxes = obstacleBoxes([node('A', 'MAN', 0, 0), V, node('C', 'MAN', 400, 0)]);
    expect(through(pathPoints(routeOrthogonal(a, b).d), boxOfNode(V))).toBe(true);
    const run = pathPoints(routeAuto(a, b, boxes).d);
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    expect(routeHitsBoxes(run, boxes), JSON.stringify(run)).toBe(false);
  });

  it('takes a branch to a second regulator round the first', () => {
    // A bottle feeds PR1 from its lid; PR2 stands beside PR1. A branch from
    // a tee on the feed to PR2's inlet went through PR1.
    const nodes = [node('BTL', 'TANK', 0, 200, 60, 100), node('PR1', 'PR', 150, 40), node('PR2', 'PR', 300, 40)];
    const boxes = obstacleBoxes(nodes);
    for (const a of [{ x: 90, y: 62, side: T, ...TEE }, { x: 90, y: 78, side: B, ...TEE }] as End[]) {
      const b: End = { x: 297, y: 70, side: L };
      const run = pathPoints(routeAuto(a, b, boxes).d);
      expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
      expect(routeHitsBoxes(run, boxes), JSON.stringify(run)).toBe(false);
    }
  });

  it('keeps out of the body of its own end when that end says where it is', () => {
    // A port near the top of a tall tank's side, to a valve below and to the
    // right of it facing the same way.
    const tank: Box = { x: 0, y: 0, w: 60, h: 200 };
    const a: End = { x: -3, y: 10, side: L, body: tank }, b: End = { x: 100, y: 150, side: L };
    const run = pathPoints(routeAuto(a, b, []).d);
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    expect(through(run, tank), JSON.stringify(run)).toBe(false);
    // With nothing else about, that is the plain router's doing: it is told
    // the body too. A relief valve on the tank's lid, in the way of the plain
    // route over the top, makes it a search -- and the tank is not among the
    // obstacles, only on the end, so the search has to be told it as well.
    // Not told, the shortest way was straight down the tank's side and
    // across through it.
    const relief: Box = { x: 10, y: -60, w: 40, h: 40 };
    expect(routeHitsBoxes(pathPoints(routeOrthogonal(a, b).d), [relief])).toBe(true);
    const round = pathPoints(routeAuto(a, b, [relief]).d);
    expect(wellFormed(round, a, b), JSON.stringify(round)).toBe(true);
    expect(routeHitsBoxes(round, [relief]), JSON.stringify(round)).toBe(false);
    expect(through(round, tank), JSON.stringify(round)).toBe(false);
  });
});

describe('a line past a symbol it does not end on', () => {
  it('is held clear of the symbol\'s edge and the ports standing out of it', () => {
    // A tee's branch straight down x = 510 to an open end, past a valve whose
    // left side is x = 510: down the valve's edge and across its inlet port,
    // which read as a four-way joint at the valve.
    const a: End = { x: 510, y: 300, side: B, ...TEE }, b: End = { x: 510, y: 560, side: T, ...TEE };
    const valve: Box = { x: 510, y: 420, w: 60, h: 60 };
    const run = pathPoints(routeAuto(a, b, [valve]).d);
    const reach = { x: 507, y: 417, w: 66, h: 66 };
    expect(routeHitsBoxes(run, [reach]), JSON.stringify(run)).toBe(false);
    expect(wellFormed(run, a, b)).toBe(true);
    // Three pixels further off, it is clear already, and stays straight.
    expect(pathPoints(routeAuto({ ...a, x: 506 }, { ...b, x: 506 }, [valve]).d)).toEqual([P(506, 300), P(506, 560)]);
  });

  it('still reaches the ports of the symbols it ends on', () => {
    // A line into the valve's own left port, and one out of a port beside a
    // second valve's corner: neither is pushed off the symbol it ends on.
    const valve: Box = { x: 510, y: 420, w: 60, h: 60 };
    const a: End = { x: 300, y: 450, side: R }, b: End = { x: 507, y: 450, side: L };
    expect(pathPoints(routeAuto(a, b, [valve]).d)).toEqual([P(300, 450), P(507, 450)]);
  });
});

describe('a search over a crowded sheet', () => {
  /** A repeatable stream of numbers in [0, 1). */
  function stream(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }
  const SIDES = [L, R, T, B];
  const crosses = (run: Pt[]) => {
    for (let i = 0; i + 1 < run.length; i++) for (let j = i + 2; j + 1 < run.length; j++) {
      const [p, q, r, s] = [run[i], run[i + 1], run[j], run[j + 1]];
      if (Math.max(p.x, q.x) >= Math.min(r.x, s.x) && Math.max(r.x, s.x) >= Math.min(p.x, q.x)
        && Math.max(p.y, q.y) >= Math.min(r.y, s.y) && Math.max(r.y, s.y) >= Math.min(p.y, q.y)) return true;
    }
    return false;
  };

  it('finds routes that are square, untangled, clear of every symbol, and out of and into their ports the way they face', () => {
    const next = stream(7);
    const bad: string[] = [];
    let found = 0;
    for (let n = 0; n < 400; n++) {
      const boxes: Box[] = [];
      for (let k = 1 + Math.floor(next() * 8); k > 0; k--) {
        boxes.push({ x: Math.round(next() * 40) * 10 - 100, y: Math.round(next() * 40) * 10 - 100, w: 20 + Math.round(next() * 8) * 10, h: 20 + Math.round(next() * 8) * 10 });
      }
      const end = (): End => ({ x: Math.round(next() * 400) - 100, y: Math.round(next() * 400) - 100, side: SIDES[Math.floor(next() * 4)] });
      const a = end(), b = end();
      if (boxes.some(bx => a.x >= bx.x && a.x <= bx.x + bx.w && a.y >= bx.y && a.y <= bx.y + bx.h)) continue;
      if (boxes.some(bx => b.x >= bx.x && b.x <= bx.x + bx.w && b.y >= bx.y && b.y <= bx.y + bx.h)) continue;
      const run = gridRoute(a, b, boxes);
      if (!run) continue;
      found++;
      const label = JSON.stringify({ a, b, boxes, run });
      if (!wellFormed(run, a, b)) bad.push(`not square or wrong way: ${label}`);
      else if (routeHitsBoxes(run, boxes)) bad.push(`through a box: ${label}`);
      else if (crosses(run)) bad.push(`crosses itself: ${label}`);
    }
    expect(found).toBeGreaterThan(200);
    expect(bad.slice(0, 3), bad.slice(0, 3).join('\n')).toEqual([]);
  }, SWEEP_MS);

  it('goes round the near side of a symbol in the way, a margin clear of it', () => {
    // The symbol reaches twenty above the line and sixty below: over the
    // top is the shorter way round.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 300, y: 0, side: L };
    const run = gridRoute(a, b, [{ x: 120, y: -20, w: 60, h: 80 }])!;
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    expect(run).toHaveLength(6);
    expect(Math.min(...run.map(p => p.y))).toBe(-32);
    expect(Math.max(...run.map(p => p.y))).toBe(0);
  });

  it('takes the channel between two symbols rather than going round both', () => {
    // Thirty pixels between them: closer to each than a margin, but far
    // shorter than the long way round.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 300, y: 0, side: L };
    const run = gridRoute(a, b, [{ x: 120, y: -100, w: 60, h: 85 }, { x: 120, y: 15, w: 60, h: 85 }]);
    expect(run).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }]);
  });

  it('stands a margin off a symbol it would otherwise run right along', () => {
    // Four pixels above a symbol three hundred long, a run reads as the
    // symbol's edge. Every pixel inside the margin costs half again, and
    // stepping out to a margin's clearance costs less than that.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 500, y: 0, side: L };
    expect(gridRoute(a, b, [{ x: 100, y: 4, w: 300, h: 60 }])).toEqual([
      { x: 0, y: 0 }, { x: 88, y: 0 }, { x: 88, y: -8 }, { x: 484, y: -8 }, { x: 484, y: 0 }, { x: 500, y: 0 },
    ]);
  });

  it('takes a channel narrower than two margins down its middle, when the run has to turn into it', () => {
    // A wall of two symbols with ten pixels between them, and the run's ends
    // well off that line on either side. Each symbol's margin line lies
    // inside the other symbol, so the only way through the gap short of
    // going round the whole wall is the line down its middle.
    const a: End = { x: 0, y: -60, side: R }, b: End = { x: 300, y: 40, side: L };
    const run = gridRoute(a, b, [{ x: 100, y: -200, w: 60, h: 195 }, { x: 100, y: 5, w: 60, h: 195 }])!;
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    const through = run.some((p, i) => i + 1 < run.length && p.y === 0 && run[i + 1].y === 0
      && Math.min(p.x, run[i + 1].x) < 100 && Math.max(p.x, run[i + 1].x) > 160);
    expect(through, JSON.stringify(run)).toBe(true);
  });

  it('leaves a port by its whole stub when nothing makes it turn sooner', () => {
    // Turning halfway along the stub is no longer; it is only charged for.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: -100, y: 100, side: R };
    expect(gridRoute(a, b, [])).toEqual([{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 100 }, { x: -100, y: 100 }]);
  });

  it('goes round between two ends facing apart in open sheet, not back over its own first leg', () => {
    // With nothing else on the sheet to lay a line along, the only rows were
    // the ends' own two, and the route folded back along its first leg to
    // use them. The middle between the ends is a row too.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: -100, y: 100, side: L };
    expect(gridRoute(a, b, [])).toEqual([
      { x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 50 }, { x: -116, y: 50 }, { x: -116, y: 100 }, { x: -100, y: 100 },
    ]);
  });
});

describe('a long run across a crowded sheet', () => {
  /** A repeatable stream of numbers in [0, 1). */
  function stream(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }
  /** A hundred and eighty symbols scattered over a sheet three thousand by two, twenty apart at least. */
  function crowded(): Box[] {
    const next = stream(99);
    const boxes: Box[] = [];
    while (boxes.length < 180) {
      const b = { x: Math.round(next() * 300) * 10, y: Math.round(next() * 200) * 10, w: 60, h: next() < 0.15 ? 100 : 60 };
      if (boxes.some(o => o.x < b.x + b.w + 20 && b.x < o.x + o.w + 20 && o.y < b.y + b.h + 20 && b.y < o.y + o.h + 20)) continue;
      boxes.push(b);
    }
    return boxes;
  }
  /**
   * What one search may spend: the two passes' budgets, twenty thousand and
   * fifteen thousand states. Searched over everything in the run's bounding
   * box, the run below took nearly two million, and most of a second.
   */
  const BUDGET = 35_000;

  it('is searched within a budget, and is still clear of every symbol', () => {
    const boxes = crowded();
    const a: End = { x: 2767, y: 1990, side: L }, b: End = { x: 287, y: 400, side: L };
    const run = pathPoints(routeAuto(a, b, boxes).d);
    expect(lastSearch.rounds).toBeGreaterThan(0);
    expect(lastSearch.popped).toBeLessThanOrEqual(BUDGET);
    expect(wellFormed(run, a, b), JSON.stringify(run)).toBe(true);
    expect(routeHitsBoxes(run, boxes), JSON.stringify(run)).toBe(false);
  });

  it('holds every search to the budget, and draws each route square and clear, or the plain one', () => {
    const boxes = crowded();
    const next = stream(5);
    const sides = [L, R, T, B];
    const port = (bx: Box, side: Position): End => ({
      x: side === L ? bx.x - 3 : side === R ? bx.x + bx.w + 3 : bx.x + bx.w / 2,
      y: side === T ? bx.y - 3 : side === B ? bx.y + bx.h + 3 : bx.y + bx.h / 2,
      side, body: bx,
    });
    const bad: string[] = [];
    let searched = 0, clear = 0;
    for (let k = 0; k < 80; k++) {
      const i = Math.floor(next() * boxes.length), j = Math.floor(next() * boxes.length);
      const a = port(boxes[i], sides[Math.floor(next() * 4)]), b = port(boxes[j], sides[Math.floor(next() * 4)]);
      if (i === j || !routeHitsBoxes(pathPoints(routeOrthogonal(a, b).d), boxes)) continue;
      searched++;
      const d = routeAuto(a, b, boxes).d;
      const run = pathPoints(d);
      const label = JSON.stringify({ a, b, d, popped: lastSearch.popped });
      if (lastSearch.popped > BUDGET) bad.push(`over budget: ${label}`);
      if (d === routeOrthogonal(a, b).d) continue;
      clear++;
      if (!wellFormed(run, a, b)) bad.push(`not square or the wrong way: ${label}`);
      if (routeHitsBoxes(run, boxes)) bad.push(`through a symbol: ${label}`);
    }
    expect(searched).toBeGreaterThan(50);
    expect(clear / searched).toBeGreaterThan(0.95);
    expect(bad.slice(0, 3), bad.slice(0, 3).join('\n')).toEqual([]);
  }, SWEEP_MS);

  it('depends only on the symbols near its plain route', async () => {
    // A search goes nowhere outside a corridor round the plain route, and
    // what it remembers is keyed on the symbols within the widest of those
    // corridors. Two routers that have never met -- one told only those
    // symbols, one told the whole sheet -- have to agree.
    const boxes = crowded();
    const next = stream(21);
    const told = await import('./routeGrid');
    vi.resetModules();
    const fresh = await import('./routeGrid');
    expect(fresh.routeAuto).not.toBe(told.routeAuto);
    const WIDEST = 480;
    let n = 0;
    for (let k = 0; k < 60; k++) {
      const a: End = { x: Math.round(next() * 3000), y: Math.round(next() * 2000), side: [L, R, T, B][Math.floor(next() * 4)] };
      const b: End = { x: Math.round(next() * 3000), y: Math.round(next() * 2000), side: [L, R, T, B][Math.floor(next() * 4)] };
      const plain = pathPoints(routeOrthogonal(a, b).d);
      if (!routeHitsBoxes(plain, boxes)) continue;
      const xs = plain.map(p => p.x), ys = plain.map(p => p.y);
      const near = boxes.filter(bx => bx.x <= Math.max(...xs) + WIDEST && bx.x + bx.w >= Math.min(...xs) - WIDEST
        && bx.y <= Math.max(...ys) + WIDEST && bx.y + bx.h >= Math.min(...ys) - WIDEST);
      n++;
      expect(fresh.routeAuto(a, b, near).d, JSON.stringify({ a, b })).toBe(told.routeAuto(a, b, boxes).d);
    }
    expect(n).toBeGreaterThan(20);
  }, SWEEP_MS);
});

describe('a search that is remembered', () => {
  // The tank-and-valves scene, somewhere no other test in this file has
  // already searched.
  const nodes = [node('T', 'TANK', 1200, 0, 60, 100), node('V1', 'MAN', 1100, 200), node('V2', 'MAN', 1200, 200), node('V3', 'MAN', 1300, 200)];
  const a: End = { x: 1245, y: 103, side: B }, b: End = { x: 1297, y: 230, side: L };

  it('is not done again until something near the line moves', () => {
    const boxes = obstacleBoxes(nodes);
    const first = routeAuto(a, b, boxes).d;
    expect(lastSearch.rounds).toBeGreaterThan(0);
    // The same symbols again, in another order and another array.
    expect(routeAuto(a, b, [...boxes].reverse()).d).toBe(first);
    expect(lastSearch.rounds).toBe(0);
    // A symbol put down on the far side of the sheet changes nothing here.
    expect(routeAuto(a, b, [...boxes, { x: 3000, y: 3000, w: 60, h: 60 }]).d).toBe(first);
    expect(lastSearch.rounds).toBe(0);
    // The valve in the way nudged a square: searched again.
    const moved = obstacleBoxes(nodes.map(n => (n.id === 'V2' ? { ...n, position: { x: 1210, y: 200 } } : n)));
    const again = pathPoints(routeAuto(a, b, moved).d);
    expect(lastSearch.rounds).toBeGreaterThan(0);
    expect(routeHitsBoxes(again, moved)).toBe(false);
  });

  it('is not done again when a symbol moves outside every corridor its search looked in', () => {
    // A long run that has to go round one valve, found in the first
    // corridor, a hundred and twenty pixels round the plain route. A symbol
    // moving three hundred pixels off it -- inside the widest corridor any
    // search might try, which is what the answer used to be kept by -- is
    // nothing the answer depends on.
    const a: End = { x: 8000, y: 0, side: R }, b: End = { x: 9000, y: 0, side: L };
    const valve: Box = { x: 8470, y: -30, w: 60, h: 60 };
    const far = (y: number): Box => ({ x: 8500, y, w: 60, h: 60 });
    const first = routeAuto(a, b, [valve, far(300)]).d;
    expect(lastSearch.rounds).toBeGreaterThan(0);
    expect(routeAuto(a, b, [valve, far(330)]).d).toBe(first);
    expect(lastSearch.rounds).toBe(0);
    // The same valve nudged is a fresh search.
    routeAuto(a, b, [{ ...valve, y: -20 }, far(330)]);
    expect(lastSearch.rounds).toBeGreaterThan(0);
  });

  it('is done again when something out where it had to go round moves', () => {
    // A wall right across a straight run: the way round is two hundred
    // pixels off the plain route, found only once the search has widened.
    // What the route depends on is that far out, so what it is remembered
    // by has to reach that far too, or a symbol put down in the way of the
    // detour is not noticed and the old detour is drawn straight through it.
    const a: End = { x: 5000, y: 0, side: R }, b: End = { x: 6000, y: 0, side: L };
    const wall: Box = { x: 5400, y: -200, w: 60, h: 400 };
    const round = pathPoints(routeAuto(a, b, [wall]).d);
    expect(wellFormed(round, a, b), JSON.stringify(round)).toBe(true);
    expect(routeHitsBoxes(round, [wall]), JSON.stringify(round)).toBe(false);
    const over = round.some(p => p.y < -200);
    const blocker: Box = { x: 5380, y: over ? -240 : 210, w: 100, h: 30 };
    expect(routeHitsBoxes(round, [blocker])).toBe(true);
    const now = pathPoints(routeAuto(a, b, [wall, blocker]).d);
    expect(routeHitsBoxes(now, [wall, blocker]), JSON.stringify(now)).toBe(false);
  });

  it('keeps an end that brings its own body apart from the same body among the obstacles', async () => {
    // A port low on a tall tank's side, round the tank's foot and past a
    // pump beside it to the bottom port of a valve. The boxes the search is
    // held clear of are the same either way; the plain route is not, since
    // the plain router is told an end's body and assumes a small one
    // otherwise, and a search starts in a corridor round the plain route.
    // Here the two corridors find crossbars under the tank five pixels
    // apart, so whichever is asked second has to be searched for, not handed
    // the first one's answer.
    const told = await import('./routeGrid');
    vi.resetModules();
    const fresh = await import('./routeGrid');
    expect(fresh.routeAuto).not.toBe(told.routeAuto);
    const tank: Box = { x: 12000, y: 12000, w: 90, h: 270 };
    const pump: Box = { x: 12150, y: 12180, w: 40, h: 100 }, valve: Box = { x: 12310, y: 12050, w: 60, h: 60 };
    const a: End = { x: 11997, y: 12157, side: L }, b: End = { x: 12340, y: 12113, side: B };
    const onEnd = told.routeAuto({ ...a, body: tank }, b, [pump, valve]).d;
    const among = told.routeAuto(a, b, [pump, valve, tank]).d;
    // Both searched: neither is the plain route.
    expect(onEnd).not.toBe(routeOrthogonal({ ...a, body: tank }, b).d);
    expect(among).not.toBe(routeOrthogonal(a, b).d);
    expect(among).not.toBe(onEnd);
    expect(among).toBe(fresh.routeAuto(a, b, [pump, valve, tank]).d);
  });
});

describe('a route looked for among other lines', () => {
  // Priced as the reseat prices a branch (pipes.ts): the pipe its own tee
  // rides is a great deal to cross or to run along, nearer than a tee's
  // clearance a lot, and beside it by the pixel; another line is a hop to
  // cross and something to keep its distance from.
  const own = (pts: Pt[]): SoftLine =>
    ({ pts, cross: 1000, lie: { within: 4, once: 2000, px: 1 }, near: { within: 14, once: 300, px: 1 }, beside: { within: 20, px: 1 } });
  const other = (pts: Pt[]): SoftLine =>
    ({ pts, cross: 20, lie: { within: 5, once: 2000, px: 1 }, near: { within: 10, once: 100, px: 1 }, beside: { within: 20, px: 1 } });
  const among = (lines: SoftLine[], dots: Pt[] = []): Soft => ({ lines, dots: { at: dots, reach: 7, cost: 2000 } });
  /**
   * How far one drawn line runs alongside another nearer than `w` to it.
   * Exactly `w` off is clear of it: two grid steps off a line is where a
   * route that keeps its distance runs (`besideOf`).
   */
  function beside(p: Pt[], q: Pt[], w: number): number {
    let t = 0;
    for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
      const [a, b, c, d] = [p[i], p[i + 1], q[j], q[j + 1]];
      if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < w) t += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
      if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < w) t += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
    }
    return t;
  }
  /** Does one drawn line cross another at right angles? */
  const crosses = (p: Pt[], q: Pt[]) => p.slice(0, -1).some((a, i) => q.slice(0, -1).some((c, j) => {
    const b = p[i + 1], d = q[j + 1];
    const [h, v] = a.y === b.y && c.x === d.x ? [[a, b], [c, d]] : a.x === b.x && c.y === d.y ? [[c, d], [a, b]] : [null, null];
    return !!h && !!v && v[0].x > Math.min(h[0].x, h[1].x) && v[0].x < Math.max(h[0].x, h[1].x)
      && h[0].y > Math.min(v[0].y, v[1].y) && h[0].y < Math.max(v[0].y, v[1].y);
  }));

  it('puts a crossbar the router set under its own pipe at the first level clear of it, and no further', () => {
    // A tee's bottom face under a pipe along y = 100, to a port facing right
    // down and across. Every level for the crossbar is as short as every
    // other; the router's is its tee's stub, fourteen pixels under the pipe.
    // The first level clear of the pipe is two grid steps under it: running
    // beside a line is running nearer it than that.
    const a: End = { x: 100, y: 108, side: B, ...TEE }, b: End = { x: 500, y: 300, side: R };
    expect(pathPoints(routeOrthogonal(a, b).d)).toEqual([P(100, 108), P(100, 114), P(516, 114), P(516, 300), P(500, 300)]);
    const pipe = [P(-100, 100), P(600, 100)];
    expect(routeAmong(a, b, [], among([own(pipe)]))).toEqual([P(100, 108), P(100, 120), P(516, 120), P(516, 300), P(500, 300)]);
  });

  it('goes round the end of its own pipe rather than across it', () => {
    // A tee on a pipe that ends at x = 300, its top face; a port below the
    // pipe that the line has to come down into. Straight over is across the
    // pipe; round its end, clear of it by more than two grid steps, is not.
    const a: End = { x: 200, y: 92, side: T, ...TEE }, b: End = { x: 250, y: 200, side: T };
    const pipe = [P(0, 100), P(300, 100)];
    const route = routeAmong(a, b, [], among([own(pipe)]))!;
    expect(wellFormed(route, a, b), JSON.stringify(route)).toBe(true);
    expect(crosses(route, pipe), JSON.stringify(route)).toBe(false);
    expect(beside(route, pipe, 20), JSON.stringify(route)).toBe(0);
  });

  it('crosses another line when it has to, but never lies along it', () => {
    // A port facing right and one facing left further along the same row,
    // with another line along that row between them.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 600, y: 0, side: L };
    const line = [P(200, 0), P(400, 0)];
    const route = routeAmong(a, b, [], among([other(line)]))!;
    expect(wellFormed(route, a, b), JSON.stringify(route)).toBe(true);
    expect(beside(route, line, 20), JSON.stringify(route)).toBe(0);
    // And across a line that stands in the way from top to bottom, it goes
    // straight over it: a hop, where the way round would be a long one.
    const wall = [P(300, -1000), P(300, 1000)];
    expect(routeAmong(a, b, [], among([other(wall)]))).toEqual([P(0, 0), P(600, 0)]);
  });

  it('keeps out of a dot, two grid steps off', () => {
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 600, y: 0, side: L };
    const route = routeAmong(a, b, [], among([], [P(300, 0)]))!;
    expect(wellFormed(route, a, b), JSON.stringify(route)).toBe(true);
    for (let i = 0; i + 1 < route.length; i++) {
      const p = route[i], q = route[i + 1];
      if (p.y === q.y && Math.min(p.x, q.x) < 300 && Math.max(p.x, q.x) > 300) expect(Math.abs(p.y)).toBeGreaterThanOrEqual(20);
    }
  });

  it('is not looked for again until a line or a symbol where it looked moves', () => {
    const a: End = { x: 20100, y: 108, side: B, ...TEE }, b: End = { x: 20500, y: 300, side: R };
    const pipe = own([P(19900, 100), P(20600, 100)]);
    const first = routeAmong(a, b, [], among([pipe]));
    expect(lastSearch.rounds).toBeGreaterThan(0);
    // A line and a symbol far off: remembered.
    expect(routeAmong(a, b, [{ x: 24000, y: 0, w: 60, h: 60 }], among([pipe, other([P(24000, 0), P(25000, 0)])]))).toEqual(first);
    expect(lastSearch.rounds).toBe(0);
    // A line across where the crossbar went: looked for again, and kept clear of.
    const across = other([P(20000, 130), P(20700, 130)]);
    const again = routeAmong(a, b, [], among([pipe, across]))!;
    expect(lastSearch.rounds).toBeGreaterThan(0);
    expect(again).not.toEqual(first);
    expect(beside(again, across.pts, 9)).toBe(0);
  });

  it('puts a crossbar between two lines forty pixels apart half-way, two grid steps clear of each', () => {
    // A tee's bottom face on a pipe along y = 210, to a port facing up down
    // and across; another line along y = 250 under the tee, stopping short
    // of the port. Under the other line the crossbar crosses it; between
    // the two, the lanes a grid step further out than running beside
    // reaches were each ten pixels from one of them. Half-way is twenty
    // from both, and crosses nothing.
    const a: End = { x: 350, y: 218, side: B, ...TEE }, b: End = { x: 600, y: 400, side: T };
    const pipe = [P(100, 210), P(800, 210)], line = [P(100, 250), P(500, 250)];
    const route = routeAmong(a, b, [], among([own(pipe), other(line)]))!;
    expect(route).toEqual([P(350, 218), P(350, 230), P(600, 230), P(600, 400)]);
    expect(beside(route, pipe, 20) + beside(route, line, 20)).toBe(0);
    expect(crosses(route, line)).toBe(false);
  });

  it('brings a riser up into its tee two grid steps off a line beside it, with no step under the tee', () => {
    // A tank's lid below and to the right, a tee on a pipe along y = 160;
    // a line straight down x = 570, twenty pixels to the left of the tee,
    // and another along y = 200 to the right. Up x = 590 the riser is two
    // grid steps off the line beside it, which is clear of it; it once
    // ran up x = 600 instead and stepped over into the tee six pixels under
    // it: ten pixels more clearance, bought with two corners nobody could
    // read.
    const a: End = { x: 680, y: 447, side: T }, b: End = { x: 590, y: 168, side: B, ...TEE };
    const beside570 = [P(570, -100), P(570, 290), P(200, 290)];
    const route = routeAmong(a, b, [], among([own([P(400, 160), P(800, 160)]), other(beside570), other([P(450, 200), P(800, 200)])]))!;
    expect(route).toEqual([P(680, 447), P(680, 307.5), P(590, 307.5), P(590, 168)]);
    expect(beside(route, beside570, 20)).toBe(0);
  });

  it('leaves a tee along its own axis, not a step to the side of it to be out of a symbol\'s margin', () => {
    // A tee on the last leg of its pipe, a pixel inside the margin of the
    // valve the pipe runs on to, its bottom face to a port down and to the
    // right. Straight down, the leg runs inside the valve's margin for its
    // first thirty-odd pixels; the search stepped six pixels to the left
    // under the tee to get out of it, and back -- a kink as short as the
    // tee's own stub. A line of the grid within a grid step of an end's
    // own axis is that axis.
    const a: End = { x: 176, y: 218, side: B, ...TEE }, b: End = { x: 380, y: 400, side: T };
    const pipe = [P(60, 30), P(150, 30), P(150, 210), P(190, 210)];
    const route = routeAmong(a, b, [{ x: 190, y: 180, w: 60, h: 60 }, { x: 0, y: 0, w: 60, h: 60 }], among([own(pipe)]))!;
    expect(route).toEqual([P(176, 218), P(176, 309), P(380, 309), P(380, 400)]);
  });

  it('remembers every search a reseat of a crowded page asks for until the next one asks for them again', () => {
    // A reseat asks for a route among the lines for every face of every
    // line that pays for the lines round it -- four hundred of them on a
    // stand of a hundred and thirty symbols -- and the next reseat asks for
    // them all again, in the same order. Remembering fewer than that, each
    // was forgotten just before it was asked for again, and every reseat
    // searched afresh for all of them.
    const asks = Array.from({ length: 450 }, (_, k) => {
      const x = 40000 + 1000 * (k % 30), y = 1000 * Math.floor(k / 30);
      const a: End = { x: x + 100, y: y + 108, side: B, ...TEE }, b: End = { x: x + 500, y: y + 300, side: R };
      return { a, b, soft: among([own([P(x - 100, y + 100), P(x + 600, y + 100)])]) };
    });
    for (const q of asks) routeAmong(q.a, q.b, [], q.soft);
    let searched = 0;
    for (const q of asks) {
      routeAmong(q.a, q.b, [], q.soft);
      searched += lastSearch.rounds;
    }
    expect(searched).toBe(0);
  });

  it('gives the same route whatever order it is asked in', () => {
    const a: End = { x: 30100, y: 108, side: B, ...TEE }, b: End = { x: 30500, y: 300, side: R };
    const lines = [own([P(29900, 100), P(30600, 100)]), other([P(30200, 150), P(30200, 400)]), other([P(30000, 250), P(30700, 250)])];
    const one = routeAmong(a, b, [], among(lines));
    expect(routeAmong(a, b, [], among([...lines]))).toEqual(one);
    vi.resetModules();
    return import('./routeGrid').then(fresh => expect(fresh.routeAmong(a, b, [], among(lines))).toEqual(one));
  });
});

describe('a search that is repeatable', () => {
  it('takes the level a detour runs at from the symbols next to it, not from one further off in the corridor it looks in', () => {
    // A solenoid's left port to a tee's bottom face up and to the left, a
    // valve and a tank in the way: every level between the valve and the
    // tee's stub is as short as every other. Which one the search took was
    // whichever it reached first, and that went with the lines its grid
    // had -- every edge of every symbol in the corridor it looked in: a
    // copy pasted beside the solenoid gave it a level of its own, and a
    // branch that had nothing to do with the copy moved to it. The level is
    // the nearest the plain route clear of what is in the way, which only
    // the valve beside it says.
    const a: End = { x: 997, y: 590, side: L, body: { x: 1000, y: 560, w: 60, h: 60 } };
    const b: End = { x: 460, y: 168, side: B, ...TEE };
    const sheet: Box[] = [
      { x: 460, y: 320, w: 60, h: 60 }, { x: 450, y: 450, w: 60, h: 100 }, { x: 370, y: 130, w: 60, h: 60 }, { x: 800, y: 130, w: 60, h: 60 },
    ];
    const pasted: Box = { x: 1100, y: 240, w: 60, h: 60 };
    const route = routeAuto(a, b, sheet).d;
    expect(pathPoints(route)).toEqual([P(997, 590), P(535, 590), P(535, 305), P(460, 305), P(460, 168)]);
    expect(routeAuto(a, b, [...sheet, pasted]).d).toBe(route);
  });

  it('draws the same route whatever order the obstacles come in', () => {
    const nodes = [node('T', 'TANK', 200, 0, 60, 100), node('V1', 'MAN', 100, 200), node('V2', 'MAN', 200, 200), node('V3', 'MAN', 300, 200)];
    const a: End = { x: 245, y: 103, side: B }, b: End = { x: 297, y: 230, side: L };
    const one = routeAuto(a, b, obstacleBoxes(nodes)).d;
    expect(routeAuto(a, b, obstacleBoxes([...nodes].reverse())).d).toBe(one);
    expect(routeAuto(a, b, obstacleBoxes(nodes)).d).toBe(one);
  });
});

describe('when there is no way round', () => {
  it('draws the plain route rather than nothing', () => {
    // The target walled in on every side: some line is better than none.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 200, y: 0, side: L };
    const wall: Box[] = [
      { x: 150, y: -60, w: 20, h: 120 }, { x: 150, y: -60, w: 120, h: 20 },
      { x: 150, y: 40, w: 120, h: 20 }, { x: 250, y: -60, w: 20, h: 120 },
    ];
    expect(gridRoute(a, b, wall)).toBeNull();
    expect(routeAuto(a, b, wall)).toEqual(routeOrthogonal(a, b));
  });

  it('never leaves a port sideways to get out', () => {
    // A symbol butted up against the port: the only way out is along its
    // edge, which is not the way the port faces. The search finds nothing
    // rather than a line that leaves the port the wrong way.
    const a: End = { x: 0, y: 0, side: R }, b: End = { x: 200, y: 100, side: L };
    expect(gridRoute(a, b, [{ x: 0, y: -30, w: 60, h: 60 }])).toBeNull();
  });

  it('does not hold a box against a line whose end is inside it', () => {
    // Two symbols dropped overlapping: the port is inside its neighbour and
    // no route could avoid that.
    const a: End = { x: 63, y: 30, side: R }, b: End = { x: 297, y: 30, side: L };
    expect(routeAuto(a, b, [{ x: 40, y: 0, w: 60, h: 60 }])).toEqual(routeOrthogonal(a, b));
  });
});

describe('what is in a line\'s way', () => {
  it('is every symbol shown, at its measured size', () => {
    const boxes = obstacleBoxes([node('V', 'MAN', 10, 20), node('T', 'TANK', 100, 0, 60, 100)]);
    expect(boxes).toEqual([{ x: 10, y: 20, w: 60, h: 60 }, { x: 100, y: 0, w: 60, h: 100 }]);
  });

  it('is not a tee, a section box, text, or anything hidden', () => {
    const boxes = obstacleBoxes([
      node('J', 'JUNCTION', 0, 0, 10, 10),
      { ...node('J2', 'MAN', 0, 0, 10, 10), type: 'JUNCTION', data: { label: 'old tee' } },
      node('S', 'REGION', 0, 0, 400, 300),
      node('X', 'TEXT', 0, 0, 80, 20),
      node('H', 'MAN', 0, 0, 60, 60, { hidden: true }),
      { ...node('J3', 'MAN', 0, 0, 10, 10), data: { componentType: 'JUNCTION', label: 'tee' } },
    ]);
    expect(boxes).toEqual([]);
  });

  it('is sixty square for a symbol not measured yet', () => {
    const n = node('V', 'MAN', 10, 20);
    delete n.measured;
    expect(boxOfNode(n)).toEqual({ x: 10, y: 20, w: 60, h: 60 });
  });
});

describe('what is in a line\'s way, page by page', () => {
  const on = (n: Node, page: string): Node => ({ ...n, data: { ...n.data, page } });

  it('is each page\'s own symbols, and no tee, section or text', () => {
    const nodes: Node[] = [
      on(node('A', 'MAN', 0, 0), 'Main'), on(node('B', 'MAN', 100, 0), 'GSE'),
      on(node('J', 'JUNCTION', 50, 50, 10, 10), 'Main'),
      on(node('R', 'REGION', 0, 0, 300, 200), 'Main'),
      on(node('T', 'TEXT', 0, 0, 80, 20), 'Main'),
    ];
    const by = obstaclesByPage(nodes);
    expect(by('Main')).toEqual([{ x: 0, y: 0, w: 60, h: 60 }]);
    expect(by('GSE')).toEqual([{ x: 100, y: 0, w: 60, h: 60 }]);
    expect(by('Nowhere')).toEqual([]);
  });

  it('puts a symbol that names no page on the first one', () => {
    const by = obstaclesByPage([node('A', 'MAN', 0, 0), on(node('B', 'MAN', 100, 0), 'GSE')]);
    expect(by('Main')).toEqual([{ x: 0, y: 0, w: 60, h: 60 }]);
  });

  it('is one answer for one drawing, however often it is asked', () => {
    // A drag previews and draws against the same drawing frame after frame:
    // the pages' boxes are worked out once for it, not once a frame.
    const nodes = [on(node('A', 'MAN', 0, 0), 'Main'), on(node('B', 'MAN', 200, 0), 'GSE')];
    const by = obstaclesByPage(nodes);
    expect(obstaclesByPage(nodes)).toBe(by);
    expect(by('Main')).toBe(by('Main'));
    // Another array is another drawing, and is asked afresh.
    expect(obstaclesByPage([...nodes])).not.toBe(by);
    // The nodes by id, as a line looks its ends up, are the same drawing read the same way.
    const byId = new Map(nodes.map(n => [n.id, n]));
    expect(obstaclesByPage(byId)('Main')).toEqual(by('Main'));
    expect(obstaclesByPage(byId)('GSE')).toEqual(by('GSE'));
  });
});

describe('what a caller says is in the way', () => {
  const nodes = [
    { ...node('A', 'MAN', 0, 0), data: { componentType: 'MAN', label: 'A', page: 'Main' } },
    { ...node('B', 'MAN', 200, 0), data: { componentType: 'MAN', label: 'B', page: 'GSE' } },
  ];

  it('is its own function, as it is, and its one list on every page', () => {
    const mine = (page: string): Box[] => (page === 'Main' ? [{ x: 1, y: 2, w: 3, h: 4 }] : []);
    expect(perPage(nodes, mine)).toBe(mine);
    const list: Box[] = [{ x: 500, y: 500, w: 60, h: 60 }];
    expect(perPage(nodes, list)('Main')).toBe(list);
    expect(perPage(nodes, list)('GSE')).toBe(list);
  });

  it('is nothing on any page when it says nothing is, and each page\'s symbols when it does not say', () => {
    // An empty list is an answer -- route round nothing -- and not the want of one.
    expect(perPage(nodes, [])('Main')).toEqual([]);
    expect(perPage(nodes, [])('GSE')).toEqual([]);
    expect(perPage(nodes)).toBe(obstaclesByPage(nodes));
    expect(perPage(nodes)('Main')).toEqual([{ x: 0, y: 0, w: 60, h: 60 }]);
    expect(perPage(new Map(nodes.map(n => [n.id, n])))('GSE')).toEqual([{ x: 200, y: 0, w: 60, h: 60 }]);
  });
});

describe('the boxes a route is held clear of', () => {
  it('leave out one an end sits inside, and are grown by their ports\' reach but for the symbols it ends on', () => {
    const a = P(63, 30), b = P(297, 30);
    // Dropped overlapping the symbol `a` is on: no route can keep out of it.
    const over: Box = { x: 40, y: 0, w: 60, h: 60 };
    // The symbol `b` is a port of, three pixels off its edge.
    const own: Box = { x: 300, y: 0, w: 60, h: 60 };
    const other: Box = { x: 150, y: 100, w: 60, h: 60 };
    expect(avoidable([over, own, other], a, b)).toEqual([own, other]);
    expect(heldClear([over, own, other], a, b)).toEqual([own, { x: 147, y: 97, w: 66, h: 66 }]);
  });
});

describe('what a route has to be shown of the sheet', () => {
  it('is nothing -- the same array every time -- when its plain shape runs into nothing', () => {
    const a: End = { x: 63, y: 30, side: R }, b: End = { x: 297, y: 30, side: L };
    const plain = pathPoints(routeOrthogonal(a, b).d);
    expect(withinReach(plain, boxGrid([]), a, b)).toBe(NO_BOXES);
    expect(withinReach(plain, boxGrid([{ x: 150, y: 200, w: 60, h: 60 }]), a, b)).toBe(NO_BOXES);
    // A symbol a pixel clear of the line is in its way all the same: the
    // ports standing out of it reach across the line.
    const grazed: Box = { x: 150, y: 31, w: 60, h: 60 };
    expect(routeHitsBoxes(plain, [grazed])).toBe(false);
    expect(withinReach(plain, boxGrid([grazed]), a, b)).toEqual([grazed]);
  });

  it('is searched for a shape in the way of nothing but its own end\'s body', () => {
    // A port high on the right of a tall tank, to the right-hand port of a
    // valve down to the tank's left: the plain shape comes back across the
    // tank, and only the end knows the tank is there.
    const tank: Box = { x: 0, y: 0, w: 80, h: 170 };
    const a: End = { x: 83, y: 71, side: R, body: tank };
    const b: End = { x: -77, y: 120, side: R, body: { x: -140, y: 90, w: 60, h: 60 } };
    const plain = pathPoints(routeOrthogonal(a, b).d);
    expect(routeHitsBoxes(plain, [tank])).toBe(true);
    const shown = withinReach(plain, boxGrid([]), a, b);
    expect(shown).not.toBe(NO_BOXES);
    expect(shown).toEqual([]);
    const round = pathPoints(routeAuto(a, b, shown).d);
    expect(through(round, tank), JSON.stringify(round)).toBe(false);
    expect(round).toEqual(pathPoints(routeAuto(a, b, []).d));
  });

  it('is all the router needs to answer exactly as it does shown every symbol', () => {
    // Random sheets, with the ends' own bodies told to the ends half the
    // time: shown what this says, the router draws what it draws shown the
    // whole sheet, and when this says nothing the router draws the plain shape.
    let s = 29;
    const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    const sides = [L, R, T, B];
    const portOn = (bx: Box, side: Position, t: number): End => {
      if (side === L) return { x: bx.x - 3, y: Math.round(bx.y + t * bx.h), side };
      if (side === R) return { x: bx.x + bx.w + 3, y: Math.round(bx.y + t * bx.h), side };
      if (side === T) return { x: Math.round(bx.x + t * bx.w), y: bx.y - 3, side };
      return { x: Math.round(bx.x + t * bx.w), y: bx.y + bx.h + 3, side };
    };
    let plainOnes = 0, searched = 0, ownOnly = 0;
    for (let n = 0; n < 300; n++) {
      const boxes: Box[] = [];
      for (let k = 2 + Math.floor(next() * 10); k > 0; k--) {
        boxes.push({ x: Math.round(next() * 60) * 10, y: Math.round(next() * 40) * 10, w: 40 + Math.round(next() * 4) * 10, h: 40 + Math.round(next() * 16) * 10 });
      }
      const i = Math.floor(next() * boxes.length), j = (i + 1 + Math.floor(next() * (boxes.length - 1))) % boxes.length;
      const told = next() < 0.5;
      const a: End = { ...portOn(boxes[i], sides[Math.floor(next() * 4)], next()), ...(told ? { body: boxes[i] } : {}) };
      const b: End = { ...portOn(boxes[j], sides[Math.floor(next() * 4)], next()), ...(told ? { body: boxes[j] } : {}) };
      // On the end, the symbol is not among the obstacles as well.
      const others = told ? boxes.filter((_, k) => k !== i && k !== j) : boxes;
      const plain = pathPoints(routeOrthogonal(a, b).d);
      const shown = withinReach(plain, boxGrid(others), a, b);
      const all = pathPoints(routeAuto(a, b, others).d);
      const label = JSON.stringify({ a, b, others });
      if (shown === NO_BOXES) {
        plainOnes++;
        expect(all, label).toEqual(plain);
      } else {
        searched++;
        if (!routeHitsBoxes(plain, heldClear(others, a, b))) ownOnly++;
        expect(pathPoints(routeAuto(a, b, shown).d), label).toEqual(all);
      }
    }
    expect(plainOnes).toBeGreaterThan(30);
    expect(searched).toBeGreaterThan(30);
    expect(ownOnly).toBeGreaterThan(0);
  }, SWEEP_MS);
});

describe('a line with a junction\'s dot in its way', () => {
  const dot = (id: string, c: Pt, extra: Partial<Node> = {}): Node =>
    ({ id, type: 'JUNCTION', position: { x: c.x - 5, y: c.y - 5 }, measured: { width: 10, height: 10 }, data: { componentType: 'JUNCTION', label: id }, ...extra });
  /** How near a run comes to a point. */
  const nearest = (run: Pt[], c: Pt) => Math.min(...run.slice(0, -1).map((p, i) => {
    const q = run[i + 1];
    return Math.hypot(c.x - Math.max(Math.min(p.x, q.x), Math.min(Math.max(p.x, q.x), c.x)), c.y - Math.max(Math.min(p.y, q.y), Math.min(Math.max(p.y, q.y), c.y)));
  }));

  it('is lifted round it two grid steps off its centre, and is as it was everywhere else', () => {
    // A line straight down from one tank to another, and a tee let go on it
    // at (570, 160). Round the dot as round a small symbol, the search went
    // down the channel between the dot and the next grid line, seven and a
    // half pixels off the tee's centre, through its ring.
    const a: End = { x: 570, y: -97, side: B }, b: End = { x: 570, y: 637, side: T };
    const tee = dot('T', P(570, 160));
    const run = pathPoints(routeAuto(a, b, [dotBox(tee)]).d);
    expect(run, JSON.stringify(run)).toEqual([
      P(570, -97), P(570, 160 - LIFT), P(570 - LIFT, 160 - LIFT), P(570 - LIFT, 160 + LIFT), P(570, 160 + LIFT), P(570, 637),
    ]);
    expect(nearest(run, P(570, 160))).toBeGreaterThanOrEqual(DOT_CLEAR);
  });

  it('keeps two grid steps off it among other symbols and dots, on the grid', () => {
    // The same, with a symbol off to one side and another dot on the line's
    // level beside it: what the search is given lanes by.
    const a: End = { x: 570, y: -97, side: B }, b: End = { x: 570, y: 637, side: T };
    const boxes = [dotBox(dot('T', P(570, 160))), dotBox(dot('O', P(520, 160))), ...obstacleBoxes([node('V', 'MAN', 600, 300)])];
    const run = pathPoints(routeAuto(a, b, boxes).d);
    expect(nearest(run, P(570, 160)), JSON.stringify(run)).toBeGreaterThanOrEqual(DOT_CLEAR);
    expect(nearest(run, P(520, 160)), JSON.stringify(run)).toBeGreaterThanOrEqual(7);
    for (const p of run) expect([p.x % 10, p.y % 10], JSON.stringify(run)).toEqual([0, a.y === p.y || b.y === p.y ? p.y % 10 : 0]);
  });

  it('moves a crossbar that would run through it to a level clear of it, rather than lifting the crossbar round it', () => {
    const a: End = { x: 60, y: 30, side: R }, b: End = { x: 400, y: 330, side: L };
    const plain = pathPoints(routeOrthogonal(a, b).d);
    const bar = plain[1].x;
    const run = pathPoints(routeAuto(a, b, [dotBox(dot('O', P(bar, 180)))]).d);
    expect(run, JSON.stringify(run)).toHaveLength(4);
    expect(nearest(run, P(bar, 180))).toBeGreaterThanOrEqual(DOT_CLEAR);
  });

  it('is in the way of a line that routes itself, but not of one that ends on it, and not while a drag carries it', () => {
    const a: End = { x: 570, y: -97, side: B }, b: End = { x: 570, y: 637, side: T };
    const plain = pathPoints(routeOrthogonal(a, b).d);
    const tee = dot('T', P(570, 160));
    expect(withinReach(plain, lineGrid([tee]), a, b)).not.toBe(NO_BOXES);
    expect(withinReach(plain, obstacleGrid([tee]), a, b)).toBe(NO_BOXES);
    expect(withinReach(plain, lineGrid([{ ...tee, dragging: true }]), a, b)).toBe(NO_BOXES);
    // A line out of the tee's own face leaves it three pixels outside its dot.
    const own: End = { x: 570, y: 168, side: B, clear: 14, stub: 6 };
    expect(pathPoints(routeAuto(own, b, [dotBox(tee)]).d)).toEqual(pathPoints(routeOrthogonal(own, b).d));
    // Ten pixels off its centre a line passes by it.
    const by: End = { x: 580, y: -97, side: B }, to: End = { x: 580, y: 637, side: T };
    expect(pathPoints(routeAuto(by, to, [dotBox(tee)]).d)).toEqual([P(580, -97), P(580, 637)]);
  });
});

describe('a valve that vents', () => {
  const E = (id: string, source: string, sh: string, target: string, th: string) =>
    ({ id, source, sourceHandle: sh, target, targetHandle: th });

  it('is in the way as far out as the mark on its open port, on the side the mark is drawn', () => {
    const V = node('V', 'SOL', 100, 100), W = node('W', 'MAN', 300, 100), K = node('K', 'TANK', -200, 100, 60, 100);
    const U = node('U', 'MAN', 100, 300, 60, 60, { data: { componentType: 'MAN', label: 'U', rotation: 90 } });
    // V plumbed on its left port vents right; W on its right port vents left;
    // U, turned a quarter, vents out of its bottom; K is no valve.
    const edges = [E('kv', 'K', 'b', 'V', 'l'), E('wk', 'W', 'r', 'K', 't'), E('ku', 'K', 'b2', 'U', 'l')];
    const boxes = obstacleBoxes([V, W, K, U], edges);
    expect(boxes).toEqual([
      { x: 100, y: 100, w: 60 + VENT_REACH, h: 60 },
      { x: 300 - VENT_REACH, y: 100, w: 60 + VENT_REACH, h: 60 },
      { x: -200, y: 100, w: 60, h: 100 },
      { x: 100, y: 300, w: 60, h: 60 + VENT_REACH },
    ]);
    // Plumbed on both sides, on neither, or on a port no valve has: no mark.
    expect(obstacleBoxes([V], [E('a', 'K', 'b', 'V', 'l'), E('b', 'V', 'r', 'W', 'l')])).toEqual([boxOfNode(V)]);
    expect(obstacleBoxes([V], [])).toEqual([boxOfNode(V)]);
    expect(obstacleBoxes([V], [E('a', 'K', 'b', 'V', 't')])).toEqual([boxOfNode(V)]);
    // Without the lines, the symbols as they are.
    expect(obstacleBoxes([V, W, K, U])).toEqual([V, W, K, U].map(boxOfNode));
    expect(obstaclesByPage([V, W, K, U], edges)('Main')).toEqual(boxes);
  });

  it('sends a line that would run through the mark round it, as the canvas draws the line', () => {
    // A line straight down twelve pixels off V's open side: clear of V's
    // body, and through the triangle on its port.
    const V = node('V', 'SOL', 100, 100), K = node('K', 'TANK', -200, 100, 60, 100);
    const edges = [E('kv', 'K', 'b', 'V', 'l')];
    const a: End = { x: 172, y: -100, side: B }, b: End = { x: 172, y: 400, side: T };
    const plain = pathPoints(routeOrthogonal(a, b).d);
    const mark = { x: 160, y: 124, w: VENT_REACH, h: 12 };
    const nodes = [V, K];
    const run = pathPoints(routeAuto(a, b, withinReach(plain, lineGrid(nodes, edges), a, b)).d);
    expect(through(run, mark), JSON.stringify(run)).toBe(false);
    // Round it on the open side, a port's reach and a margin clear of the tip.
    const risers = run.slice(0, -1).filter((p, i) => p.x === run[i + 1].x && p.x !== a.x).map(p => p.x);
    expect(risers.length, JSON.stringify(run)).toBeGreaterThan(0);
    for (const x of risers) expect(x, JSON.stringify(run)).toBeGreaterThanOrEqual(160 + VENT_REACH + 3);
    // And the grid it asks is the same one while the lines change and no
    // valve starts or stops venting.
    expect(lineGrid(nodes, [...edges])).toBe(lineGrid(nodes, edges));
  });
});
