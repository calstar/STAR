import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { J_END, isJunction, junctionEnd } from './junctions';
import type { EndLookup, Face } from './junctions';
import { pathPoints, routeOrthogonal, segmentEntersBox } from './route';
import type { Box, End, Pt } from './route';
import { NO_BOXES, boxGrid, obstacleBoxes, obstacleGrid, routeAuto } from './routeGrid';
import { drawnRoute, inTheWay, isPipeLine, routeOfLine, routesItself, sameBoxes } from './lineRoute';

/**
 * A sweep runs hundreds of routes: well inside a test's usual five seconds
 * alone, but not always on a machine busy with other work.
 */
const SWEEP_MS = 30_000;

const P = (x: number, y: number): Pt => ({ x, y });
const part = (id: string, x: number, y: number, page = 'Main'): Node => ({
  id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, page },
});
const teeOn = (id: string, cx: number, cy: number, along?: { in: Face; out: Face }): Node => ({
  id, type: 'JUNCTION', position: { x: cx - 5, y: cy - 5 },
  data: { componentType: 'JUNCTION', label: id, page: 'Main', ...(along ? { along: { t: 0.5, ...along } } : {}) },
});
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
const E = (s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${s}.${sh}-${t}.${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th, data });
const through = (pts: Pt[], boxes: Box[]) =>
  boxes.filter(b => pts.some((p, i) => i + 1 < pts.length && segmentEntersBox(p, pts[i + 1], b, 2)));
const box = (n: Node): Box => ({ x: n.position.x, y: n.position.y, w: 60, h: 60 });

describe('which lines route themselves', () => {
  const run = teeOn('J', 200, 130, { in: 'l', out: 'r' });
  it('every line without stored corners but a pipe\'s', () => {
    expect(isPipeLine(part('A', 0, 100), 'r', run, 'l')).toBe(true);
    expect(isPipeLine(run, 'r', part('B', 400, 100), 'l')).toBe(true);
    // A branch off the tee, a line to an open end, a line between symbols.
    expect(routesItself({}, run, 'b', part('C', 170, 250), 't')).toBe(true);
    expect(routesItself({}, part('A', 0, 0), 'r', teeOn('O', 200, 30), 'l')).toBe(true);
    expect(routesItself(undefined, part('A', 0, 0), 'r', part('B', 200, 0), 'l')).toBe(true);
    // Corners of its own, or its pipe's slice.
    expect(routesItself({ waypoints: [P(100, 30)] }, part('A', 0, 0), 'r', part('B', 200, 0), 'l')).toBe(false);
    expect(routesItself({}, part('A', 0, 100), 'r', run, 'l')).toBe(false);
  });

  it('knows a tee by either marking', () => {
    const legacy: Node = { id: 'J', type: 'JUNCTION', position: P(195, 125), data: { along: { t: 0.5, in: 'l', out: 'r' } } };
    expect(isPipeLine(part('A', 0, 100), 'r', legacy, 'l')).toBe(true);
  });
});

describe('a line that routes itself', () => {
  it('goes round the symbols between its ends', () => {
    // A tank's third bottom outlet to the last of a row of valves: drawn by
    // its ends alone it runs through the middle valve and over its port.
    const T = part('T', 200, 0), V2 = part('V2', 200, 200), V3 = part('V3', 300, 200);
    const nodes = [T, V2, V3];
    const e = E('T', 'b', 'V3', 'l');
    const plain = pathPoints(routeOrthogonal(endOf(T, 'b')!, endOf(V3, 'l')!).d);
    expect(through(plain, [box(V2)])).toHaveLength(1);
    const drawn = drawnRoute(e, new Map(nodes.map(n => [n.id, n])), endOf)!;
    expect(through(drawn, nodes.map(box))).toEqual([]);
  });

  it('leaves a pipe\'s line as the pipe drew it', () => {
    // The pipe was routed as a whole; its straight slice is drawn straight,
    // whatever it now passes.
    const A = part('A', 0, 100), J = teeOn('J', 300, 130, { in: 'l', out: 'r' }), X = part('X', 120, 100);
    const nodes = [A, J, X];
    const drawn = drawnRoute(E('A', 'r', 'J', 'l'), new Map(nodes.map(n => [n.id, n])), endOf)!;
    expect(drawn).toHaveLength(2);
  });

  it('is not sent round a symbol on another page', () => {
    const A = part('A', 0, 0), B = part('B', 300, 0), G = part('G', 150, 0, 'GSE');
    const nodes = [A, B, G];
    expect(drawnRoute(E('A', 'r', 'B', 'l'), new Map(nodes.map(n => [n.id, n])), endOf)).toHaveLength(2);
  });

  it('goes round what it is told is in its way: nothing when told nothing is, its page\'s symbols when not told', () => {
    const T = part('T', 200, 0), V2 = part('V2', 200, 200), V3 = part('V3', 300, 200);
    const byId = new Map([T, V2, V3].map(n => [n.id, n]));
    const e = E('T', 'b', 'V3', 'l');
    const plain = pathPoints(routeOrthogonal(endOf(T, 'b')!, endOf(V3, 'l')!).d);
    const round = drawnRoute(e, byId, endOf)!;
    expect(round).not.toEqual(plain);
    expect(drawnRoute(e, byId, endOf, [])).toEqual(plain);
    expect(drawnRoute(e, byId, endOf, () => [])).toEqual(plain);
    expect(drawnRoute(e, byId, endOf, [box(V2)])).toEqual(round);
    expect(drawnRoute(e, byId, endOf, page => (page === 'Main' ? [box(V2)] : []))).toEqual(round);
  });
});

describe('inTheWay', () => {
  it('leaves a symbol being dragged out of the way of a line that does not end on it, and in the way of one that does', () => {
    // A line straight from A across to B, and V and W dragged across it
    // together. The line stands still, and is drawn as it was while they go
    // over it -- routed round them on every tick, it swung out into a
    // detour and back for symbols it has nothing to do with -- and is routed
    // round them if they are let go of there. V's own line on to C, with W
    // in its way, goes round W.
    const A = part('A', 0, 0), B = part('B', 500, 0), C = part('C', 700, -20);
    const V = { ...part('V', 150, -20), dragging: true }, W = { ...part('W', 320, -20), dragging: true };
    const a = endOf(A, 'r')!, b = endOf(B, 'l')!;
    const plain = pathPoints(routeOrthogonal(a, b).d);
    expect(through(plain, [box(V), box(W)])).toHaveLength(2);
    expect(inTheWay(plain, obstacleGrid([A, B, C, V, W]), a, b)).toBe(NO_BOXES);
    const still = inTheWay(plain, obstacleGrid([A, B, C, { ...V, dragging: false }, { ...W, dragging: false }]), a, b);
    expect(still).toContainEqual(box(V));
    expect(still).toContainEqual(box(W));
    const v = endOf(V, 'r')!, c = endOf(C, 'l')!;
    const own = pathPoints(routeOrthogonal(v, c).d);
    expect(through(own, [box(W)])).toEqual([box(W)]);
    expect(inTheWay(own, obstacleGrid([A, B, C, V, W]), v, c)).toContainEqual(box(W));
  });

  it('is none -- the same array every time -- for a line whose plain route runs into nothing', () => {
    const grid = obstacleGrid([part('A', 0, 0), part('B', 300, 0), part('Far', 1000, 1000)]);
    const ea = endOf(part('A', 0, 0), 'r')!, eb = endOf(part('B', 300, 0), 'l')!;
    const plain = pathPoints(routeOrthogonal(ea, eb).d);
    expect(inTheWay(plain, grid, ea, eb)).toBe(NO_BOXES);
  });

  it('is what routeAuto needs to answer exactly as it does told of every symbol', () => {
    // Random sheets: the lines that have to go round something are routed
    // the same from the boxes near them as from the whole sheet.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const sides = [Position.Left, Position.Right, Position.Top, Position.Bottom];
    let searched = 0;
    for (let k = 0; k < 300; k++) {
      const syms = Array.from({ length: 40 }, (_, i) => part(`S${i}`, Math.round(rnd() * 150) * 10, Math.round(rnd() * 100) * 10));
      const boxes = obstacleBoxes(syms);
      const a = syms[0], b = syms[1 + Math.floor(rnd() * 39)];
      const ea: End = { ...endOf(a, ['l', 'r', 't', 'b'][Math.floor(rnd() * 4)])! };
      const eb: End = { ...endOf(b, ['l', 'r', 't', 'b'][Math.floor(rnd() * 4)])! };
      if (!sides.includes(ea.side)) continue;
      const plain = pathPoints(routeOrthogonal(ea, eb).d);
      const near = inTheWay(plain, boxGrid(boxes), ea, eb);
      if (near !== NO_BOXES) searched++;
      expect(pathPoints(routeAuto(ea, eb, near).d)).toEqual(pathPoints(routeAuto(ea, eb, boxes).d));
      expect(routeOfLine(ea, eb, {}, near)).toEqual(pathPoints(routeAuto(ea, eb, boxes).d));
    }
    expect(searched).toBeGreaterThan(30);
  }, SWEEP_MS);

  // A purge supply's shape: a long run with a valve on its crossbar, and a
  // symbol well below it -- inside the router's reach of the run's bounding
  // box, and nowhere its search for a way round the valve looks.
  const supply = { a: { x: 63, y: 30, side: Position.Right } as End, b: { x: 897, y: 140, side: Position.Left } as End };
  const supplySheet = (valveX: number, farX: number): Box[] => [
    { x: 0, y: 0, w: 60, h: 60 }, { x: 900, y: 110, w: 60, h: 60 },
    { x: valveX, y: 55, w: 60, h: 60 }, { x: farX, y: 500, w: 60, h: 60 },
  ];

  it('is not changed by a symbol moving far from the route, though near its bounding box', () => {
    const { a, b } = supply;
    const plain = pathPoints(routeOrthogonal(a, b).d);
    const told = (valveX: number, farX: number) => {
      const sheet = supplySheet(valveX, farX);
      const boxes = inTheWay(plain, boxGrid(sheet), a, b);
      expect(boxes).not.toBe(NO_BOXES);
      expect(routeAuto(a, b, boxes).d).toBe(routeAuto(a, b, sheet).d);
      return boxes;
    };
    // So the line is not drawn again when that symbol is dragged...
    expect(sameBoxes(told(450, 200), told(450, 210))).toBe(true);
    // ...and is when the valve in its way is.
    expect(sameBoxes(told(450, 200), told(460, 200))).toBe(false);
  });

  it('is told of everything within reach when its route round what is in its way depends on a symbol further off', () => {
    // A wall across the run taller than the search's first corridor: the way
    // round it runs three hundred pixels off the run, over the top, where a
    // symbol lying just above the wall squeezes it down between the two.
    // Told only of the symbols near the run, the router would route without
    // that one; the answer is checked, and is everything in reach. (The wall
    // reaches further below the run than above it, so that the way over the
    // top is the router's whichever levels up there it has to choose from: a
    // symbol nowhere near the way it takes changes nothing.)
    const a: End = { x: 63, y: 30, side: Position.Right }, b: End = { x: 897, y: 30, side: Position.Left };
    const far: Box = { x: 380, y: -345, w: 200, h: 30 };
    const sheet: Box[] = [{ x: 0, y: 0, w: 60, h: 60 }, { x: 900, y: 0, w: 60, h: 60 }, { x: 450, y: -300, w: 60, h: 680 }, far];
    expect(routeAuto(a, b, sheet.filter(bx => bx !== far)).d).not.toBe(routeAuto(a, b, sheet).d);
    const boxes = inTheWay(pathPoints(routeOrthogonal(a, b).d), boxGrid(sheet), a, b);
    expect(boxes).toContain(far);
    expect(routeAuto(a, b, boxes).d).toBe(routeAuto(a, b, sheet).d);
  });

  it('is told of everything within reach for a legacy crossbar it was not told of', () => {
    // The check asks the router about the line as it is drawn; with an
    // offset the caller did not pass, it would be asking about another line.
    const { a, b } = supply;
    const sheet = supplySheet(450, 200);
    const plain = pathPoints(routeOrthogonal(a, b, -20).d);
    expect(inTheWay(plain, boxGrid(sheet), a, b)).toHaveLength(sheet.length);
    const told = inTheWay(plain, boxGrid(sheet), a, b, -20);
    expect(told).toHaveLength(sheet.length - 1);
    expect(routeAuto(a, b, told, -20).d).toBe(routeAuto(a, b, sheet, -20).d);
  });

  it('names the same boxes by what they are, so a line is not drawn again for nothing', () => {
    const a: Box[] = [{ x: 0, y: 0, w: 60, h: 60 }];
    expect(sameBoxes(a, [{ x: 0, y: 0, w: 60, h: 60 }])).toBe(true);
    expect(sameBoxes(a, [{ x: 0, y: 1, w: 60, h: 60 }])).toBe(false);
    expect(sameBoxes(a, [])).toBe(false);
  });
});

describe('a line carrying the router\'s corners', () => {
  it('is drawn exactly through them, a short leg into a tee included', () => {
    // Where the gap in front of a tee's face is narrower than its stub the
    // router leaves the face by less: here the last leg is a pixel and a
    // half. Refitted, it was drawn four and a half pixels off the path the
    // pipe's tees stand on.
    const a: End = { x: 0, y: 0, side: Position.Left }, b: End = { x: 66, y: -25, side: Position.Left, ...J_END };
    const routed = pathPoints(routeOrthogonal(a, b).d);
    const corners = routed.slice(1, -1);
    expect(corners[corners.length - 1].x).toBe(64.5);
    expect(routeOfLine(a, b, { waypoints: corners, viaRun: true }, null)).toEqual(routed);
  });

  it('is fitted to its ports once they have moved off it, and a person\'s corners always are', () => {
    const a: End = { x: 0, y: 0, side: Position.Right }, b: End = { x: 200, y: 80, side: Position.Left };
    const corners = [P(100, 0), P(100, 80)];
    // The start port moved down: the first corner is off its axis.
    const moved = routeOfLine({ ...a, y: 10 }, b, { waypoints: corners, viaRun: true }, null);
    expect(moved[1]).toEqual(P(100, 10));
    // A person's corner a pixel in front of its port goes out to the stub.
    const hand = routeOfLine(a, b, { waypoints: [P(1, 0), P(1, 80)] }, null);
    expect(hand[1].x).toBe(16);
  });
});
