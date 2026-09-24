import type { Edge, Node } from '@xyflow/react';
import { J_END, isJunction } from './junctions';
import type { Along, EndLookup } from './junctions';
import { pageOf } from './pages';
import { pathPoints, routeOrthogonal, routeThrough, throughAsStored } from './route';
import type { Box, End, Pt } from './route';
import { NO_BOXES, PORT_REACH, REACH, boundsOf, boxGrid, perPage, portOf, routeAuto, withinReach } from './routeGrid';
import type { BoxGrid, Obstacles } from './routeGrid';

/**
 * How a line is drawn -- which is also the route its hops are worked out on,
 * the one a press on it is measured against, and the one the reseat priced
 * when it chose the faces the line is on.
 *
 * - A line with stored corners is drawn through them (`routeThrough`): a
 *   person's corners, the slice of its pipe the reseat handed it, or the way
 *   round the lines about it the reseat found for a branch (`routeAmong`),
 *   which depends on more than its two ends and the symbols, and so is not
 *   something the line can work out for itself.
 * - A pipe's line without corners is the straight piece of the pipe between
 *   two stations, and is drawn as the router draws two ends in line
 *   (`routeOrthogonal`): the pipe as a whole was routed, round what was in
 *   its way, once (`pipeGeometry`), and each of its lines draws its slice of
 *   that and nothing of its own.
 * - Every other line routes itself, and goes round the symbols in its way
 *   (`routeAuto`). A line only reaches a symbol through its ports: drawn by
 *   its two ends alone it ran through whatever stood between them -- a tank's
 *   third outlet to a valve down the row ran through the valve beside it and
 *   left over that valve's port, which reads as a series connection that is
 *   not there. The reseat prices a branch's faces with this same route, so a
 *   face chosen to go round a symbol is drawn going round it.
 */

export interface LineData {
  waypoints?: Pt[];
  /**
   * The waypoints are the router's -- a slice of a pipe, a bend a part was
   * put into, or a branch's way round the lines about it -- not a person's.
   */
  viaRun?: boolean;
  offset?: number;
}

/** Something at the end of a line: a node, or what `useNodesData` gives for one. */
interface EndNode {
  type?: string;
  data?: unknown;
}

/** Is `handle` one of the two faces a riding tee's pipe runs through? */
function runFace(n: EndNode | undefined, handle: string | null | undefined): boolean {
  if (!n || !handle) return false;
  const d = n.data as { componentType?: string; along?: Along } | undefined;
  const tee = d?.componentType === 'JUNCTION' || n.type === 'JUNCTION';
  return tee && !!d?.along && (handle === d.along.in || handle === d.along.out);
}

/** Is this line one of a pipe's: a run line of a tee that rides it? */
export function isPipeLine(
  source: EndNode | undefined, sourceHandle: string | null | undefined,
  target: EndNode | undefined, targetHandle: string | null | undefined,
): boolean {
  return runFace(source, sourceHandle) || runFace(target, targetHandle);
}

/**
 * Whether the reseat's model of a line and the line itself agree that it
 * routes itself: no stored corners, and not a pipe's.
 */
export function routesItself(
  data: LineData | undefined,
  source: EndNode | undefined, sourceHandle: string | null | undefined,
  target: EndNode | undefined, targetHandle: string | null | undefined,
): boolean {
  return !data?.waypoints?.length && !isPipeLine(source, sourceHandle, target, targetHandle);
}

/**
 * The route a line is drawn with, between its two ends as React Flow places
 * them (a tee's carrying J_END). `obstacles` are the symbols in its way for a
 * line that routes itself (`inTheWay`), and null for one that does not.
 */
export function routeOfLine(a: End, b: End, data: LineData | undefined, obstacles: Box[] | null): Pt[] {
  const offset = data?.offset ?? 0;
  if (data?.waypoints?.length) {
    // The router's corners are drawn as the router left them while they fit
    // (`throughAsStored`); a person's are fitted to the ports as they are.
    const exact = data.viaRun ? throughAsStored(a, b, data.waypoints) : null;
    return exact ?? pathPoints(routeThrough(a, b, data.waypoints).d);
  }
  if (obstacles?.length) return pathPoints(routeAuto(a, b, obstacles, offset).d);
  return pathPoints(routeOrthogonal(a, b, offset).d);
}

// ── What is in a line's way ──────────────────────────────────────────────────

/**
 * How far round the plain route's bounding box a line that has to go round
 * something first looks for what its route depends on. The search's first
 * corridor is that box grown by `REACH` (`searchNear` in routeGrid.ts), a
 * symbol counts there grown by its ports' reach, and the search nearly
 * always finds its route in that corridor; when it does, the symbols within
 * this are all its answer depends on. Nothing rests on the number being the
 * search's: every answer is checked (`inTheWay`), and a different number
 * only changes how often the smaller set passes.
 */
const FIRST_LOOK = REACH + PORT_REACH + 1;

/**
 * What a line was last told, by the plain route it asked about: for which
 * ends and offset, whether that plain route is the router's own for them,
 * the symbols within reach and those near, the router's route among the
 * near ones alone, and the answer.
 */
interface Told {
  a: End; b: End; offset: number; routers: boolean;
  reach: Box[]; near: Box[]; nearRoute: string; boxes: Box[];
}
const told = new WeakMap<Pt[], Told>();

/**
 * The symbols to tell the router about for a line whose plain route is
 * `plain` (`routeOrthogonal` between `a` and `b`, with `offset`): none at all
 * when that route runs into nothing, and otherwise symbols within the
 * router's reach that are known to give the same answer as all of them --
 * those near the line when they do, which is nearly always.
 *
 * What a line subscribes to, so that it is drawn again only when a symbol
 * comes into its way or goes out of it, or -- for one that has to go round
 * something -- when a symbol its route depends on moves; not whenever
 * anything on the sheet does. Told of every symbol within the router's
 * reach of its bounding box, a purge supply run from the far left of a stand
 * to a bay across it, with a valve in its way, was drawn again on nearly
 * every tick of a drag of nearly every symbol on the sheet -- most of them
 * hundreds of pixels from any leg of it, where the search it had already
 * done never looked.
 *
 * So a line that has to go round something is told only of the symbols near
 * its bounding box (`FIRST_LOOK`) when the router, told of just those,
 * answers exactly as it does told of all within reach -- which is checked
 * each time, not assumed: whatever the router's corridors, what the line is
 * told always gives the route it would be given told of everything, and a
 * move that changes that route changes the answer here. Otherwise it is told
 * of all within reach.
 *
 * Worked out again only when what is within reach changes, and then at the
 * price of one remembered answer from the router (`routeAuto`) -- what the
 * line re-rendering would have cost -- plus its answer for the near symbols
 * when they have changed too.
 *
 * While a drag is on, the symbols it has picked up (`BoxGrid.lifted`) are in
 * the way of a line only when the line ends on one of them (`portOf`), as
 * the reseat routes it (`Pricing.lineSheetFor`). A line that ends on none of
 * them is part of the drawing being dragged over, as a pipe the drag does
 * not touch is: routed round a valve dragged across it, a branch on the far
 * side of a stand swung out into a detour and back as the valve went by, a
 * new shape on every tick for a symbol it has nothing to do with. It is
 * routed round the symbol, if the symbol is let go of in its way, when it is.
 */
export function inTheWay(plain: Pt[], grid: BoxGrid, a: End, b: End, offset = 0): Box[] {
  if (grid.lifted.size && ![...grid.lifted].some(bx => portOf(a, bx) || portOf(b, bx))) grid = grid.withoutLifted();
  const reach = withinReach(plain, grid, a, b);
  if (reach === NO_BOXES) return NO_BOXES;
  let last = told.get(plain);
  if (last && (last.a !== a || last.b !== b || last.offset !== offset)) last = undefined;
  if (last && sameBoxes(last.reach, reach)) return last.boxes;
  // The check asks the router what the line will ask it, so the plain route
  // has to be the router's for these ends and this offset: a line drawn with
  // a legacy crossbar its caller did not pass is told of everything.
  const routers = last?.routers ?? samePoints(pathPoints(routeOrthogonal(a, b, offset).d), plain);
  const { x0, y0, x1, y1 } = boundsOf(plain);
  const f = FIRST_LOOK;
  const near = routers
    ? reach.filter(bx => bx.x < x1 + f && bx.x + bx.w > x0 - f && bx.y < y1 + f && bx.y + bx.h > y0 - f)
    : reach;
  let nearRoute = '';
  let boxes = reach;
  if (near.length < reach.length) {
    nearRoute = last && sameBoxes(last.near, near) ? last.nearRoute : routeAuto(a, b, near, offset).d;
    if (nearRoute === routeAuto(a, b, reach, offset).d) boxes = near;
  }
  told.set(plain, { a, b, offset, routers, reach, near, nearRoute, boxes });
  return boxes;
}

const samePoints = (p: Pt[], q: Pt[]) => p.length === q.length && p.every((v, i) => v.x === q[i].x && v.y === q[i].y);

/** Do two answers from `inTheWay` name the same boxes? What stops a line re-rendering for a move that is none of its business. */
export function sameBoxes(p: Box[], q: Box[]): boolean {
  return p === q || (p.length === q.length
    && p.every((b, i) => b.x === q[i].x && b.y === q[i].y && b.w === q[i].w && b.h === q[i].h));
}

/**
 * A line's own route, as the canvas routes it, worked out from the drawing:
 * its ends looked up with `endOf` (a tee's carrying J_END, as BranchableEdge
 * gives it), and, for a line that routes itself, the symbols on its page in
 * its way -- `obstacles` as given, or every visible symbol on the page of its
 * source. Null when an end cannot be looked up.
 *
 * Not always where the canvas draws it: a line that routes itself and would
 * lie along another is drawn with its middle a grid step or so over, which
 * takes every line on the page to work out (`tracks.drawnScene`, or
 * `tracks.drawnAfter` for a drawing with a change made to it). This is what
 * that starts from, what the reseat prices faces with, and what the line
 * publishes as its own.
 */
export function drawnRoute(
  edge: Edge, nodesById: Map<string, Node>, endOf: EndLookup, obstacles?: Obstacles,
): Pt[] | null {
  const s = nodesById.get(edge.source), t = nodesById.get(edge.target);
  if (!s || !t) return null;
  const a0 = endOf(s, edge.sourceHandle), b0 = endOf(t, edge.targetHandle);
  if (!a0 || !b0) return null;
  const a: End = isJunction(s) ? { ...a0, ...J_END } : a0;
  const b: End = isJunction(t) ? { ...b0, ...J_END } : b0;
  const data = edge.data as LineData | undefined;
  if (!routesItself(data, s, edge.sourceHandle, t, edge.targetHandle)) return routeOfLine(a, b, data, null);
  const boxes = perPage(nodesById, obstacles)(pageOf(s.data as { page?: string }));
  // Everything within reach, rather than `inTheWay`'s fewest: nothing
  // subscribes to this answer, and the router gives the same route from both.
  const plain = pathPoints(routeOrthogonal(a, b, data?.offset ?? 0).d);
  return routeOfLine(a, b, data, withinReach(plain, boxGrid(boxes), a, b));
}
