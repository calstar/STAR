import type { Node } from '@xyflow/react';
import {
  AXIS_EPS, CORNER, GRID, STUB, facing, isHorizontal, pathPoints, pointsToPath, routeCost, routeOrthogonal, segmentEntersBox,
  simplifyPoints,
} from './route';
import type { Box, End, Pt, Route } from './route';
import { pageOf } from './pages';

export type { Box } from './route';

/**
 * Routing that knows what else is on the sheet.
 *
 * `routeOrthogonal` sees only a line's two ends (and their own bodies), so a
 * run from a tank's third outlet to a valve drew its corner through the valve
 * beside it and left over that valve's port -- a parallel connection that
 * read as a series one. Here the symbols in between are obstacles: the fast
 * shape is kept whenever it misses them all, which is nearly always, and only
 * a line that would run through something is searched for properly.
 *
 * The search is a shortest path over the Hanan grid -- every line through a
 * port, a stub end, an obstacle's edge grown by a margin, and the middle of
 * each gap between those -- priced the way the shape router prices shapes:
 * length, `CORNER` a corner, and a little for running close alongside a
 * symbol. Among axis-parallel boxes that grid holds a best rectilinear route,
 * and it is small: a few dozen lines for the symbols near one run.
 *
 * Small because only the symbols near the run are in it. The grid's lines
 * run the whole width and height of the search, so its size goes with the
 * square of the symbols in it, and a search that took in every symbol inside
 * a long diagonal run's bounding box -- most of a crowded sheet -- laid out
 * millions of states and took most of a second, on every render. So a
 * search is kept to a corridor round the plain route (`searchNear`), held to
 * a budget, and remembered (`remembered`). Past the budget it settles for a
 * good route over the best one, and past that for the plain route, which is
 * where every line started: some line, drawn now, is better than a perfect
 * one late.
 */

/** How far clear of a symbol a detour runs when it has the room. */
const MARGIN = 12;
/** What each pixel run inside that margin costs on top of its length. */
const CLOSE = 0.5;
/**
 * What each pixel costs by which the leg out of a port falls short of its
 * stub. A stub is shortened only to get out through a gap narrower than it.
 */
const SHORT = 3;
/**
 * How far either side of the plain route a search looks. A detour round
 * one symbol runs its width and a margin off the route, well inside this;
 * one that has to go further -- round a row of symbols across the way --
 * is looked for again twice as wide, and then four times (`searchNear`).
 * What a drawn line first asks about is measured from this too
 * (`lineRoute.inTheWay`), so the two cannot drift apart.
 */
export const REACH = 120;
const WIDENINGS = 3;
/**
 * What one line's search may spend, in states taken off the heap, over all
 * the corridors it tries: first proving its route the cheapest, then -- once
 * that runs out -- heading for the target (`GREEDY`). A route between two
 * symbols a few squares apart takes a few hundred; these are for the run
 * that crosses a whole crowded sheet, and hold it to about ten milliseconds.
 */
const EXACT_POPS = 20_000;
const GREEDY_POPS = 15_000;
/**
 * The most grid points a search lays out at all, and the most it proves a
 * route the cheapest over. Past the second a search goes straight to the
 * greedy pass; past the first it is not run, and the line takes the plain
 * route.
 */
const MAX_POINTS = 60_000;
const EXACT_POINTS = 30_000;
/**
 * How far the greedy pass trusts its estimate over the cost so far. At one
 * the search proves its route the cheapest, which on a sheet full of equal
 * ways through can mean trying most of them; at two it heads for the target
 * and finds a route at most twice the best, and in practice within a corner
 * or two of it.
 */
const GREEDY = 2;
/** A line touching a box's edge is not in it. */
const TOUCH = 1;

/**
 * What the last search cost -- one `gridRoute`, or all the corridors of one
 * `routeAuto` that needed one: how many grids it laid out, the most points
 * any of them had, and the states it took off its heaps. All nought for an
 * answer remembered from before. For tests and profiling; nothing reads it
 * to decide anything.
 */
export const lastSearch = { rounds: 0, points: 0, popped: 0 };

/** What a search has left to spend, in heap pops, on each kind of pass. */
interface Budget { exact: number; greedy: number }

const freshSearch = (): Budget => {
  lastSearch.rounds = 0;
  lastSearch.points = 0;
  lastSearch.popped = 0;
  return { exact: EXACT_POPS, greedy: GREEDY_POPS };
};

/** Node types that are never in a line's way: tees, section boxes, and text. */
const NOT_OBSTACLES = new Set(['JUNCTION', 'REGION', 'TEXT']);

/** A node's component type. */
const typeOf = (n: Node) => (n.data as { componentType?: string } | undefined)?.componentType ?? '';

/** The box a node occupies on the sheet: its position and measured size, turned already. */
export function boxOfNode(n: Node): Box {
  return {
    x: n.position.x,
    y: n.position.y,
    w: n.measured?.width ?? n.width ?? 60,
    h: n.measured?.height ?? n.height ?? 60,
  };
}

/**
 * The obstacles a page's nodes put in the way of its lines.
 *
 * Every visible symbol, the ends' own included -- a line that only reaches a
 * symbol through its ports never needs to pass through one. Tees are not
 * obstacles (a branch meets a tee on purpose, and a tee is smaller than the
 * margin anyway), nor are section boxes, which frame symbols rather than
 * block anything, nor text; and neither is anything on another page.
 */
export function obstacleBoxes(nodes: Node[]): Box[] {
  const out: Box[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    // Either says so: a tee from an old drawing has its node type and no
    // component type, or a component type its node type does not repeat.
    if (NOT_OBSTACLES.has(typeOf(n)) || NOT_OBSTACLES.has(n.type ?? '')) continue;
    out.push(boxOfNode(n));
  }
  return out;
}

/**
 * What automatic routes go round, page by page: every visible symbol on the
 * page -- not tees, section boxes or text (`obstacleBoxes`). One function for
 * one drawing -- the same one every time it is asked for that array of
 * nodes -- each page's boxes worked out when first asked for.
 *
 * By page because the pages of a drawing share one plane: a symbol on another
 * page can stand exactly where a line on this one runs, and is not in its way.
 */
export function obstaclesByPage(nodes: Node[] | ReadonlyMap<string, Node>): (page: string) => Box[] {
  let by = byDrawing.get(nodes);
  if (by) return by;
  const onPage = new Map<string, Node[]>();
  for (const n of Array.isArray(nodes) ? nodes : nodes.values()) {
    const page = pageOf(n.data as { page?: string });
    const list = onPage.get(page);
    if (list) list.push(n); else onPage.set(page, [n]);
  }
  const boxes = new Map<string, Box[]>();
  by = (page: string) => {
    let b = boxes.get(page);
    if (!b) { b = obstacleBoxes(onPage.get(page) ?? []); boxes.set(page, b); }
    return b;
  };
  byDrawing.set(nodes, by);
  return by;
}
const byDrawing = new WeakMap<object, (page: string) => Box[]>();

/**
 * What automatic routes go round, as a caller gives it: one list for the
 * whole drawing, or each page's own. The pages of a drawing share one plane
 * -- a symbol on the GSE page can stand exactly where one on the vehicle page
 * does -- so a drawing with more than one page is only routed right by the
 * second: one list for all of them sent a line round a symbol drawn on a
 * page it is not on, and re-routed it again whenever the list changed with
 * the page being looked at.
 */
export type Obstacles = Box[] | ((page: string) => Box[]);

/**
 * What a caller's `obstacles` say goes in the way on each page: its own
 * function as it is, its one list on every page, and when it gives none,
 * each page's symbols (`obstaclesByPage`).
 *
 * The one reading of `Obstacles` there is: the drop, its preview, a line
 * drawn from the drawing, the pass that moves lines apart and the reseat all
 * ask it. A caller that says nothing has to be routed round the same symbols
 * by every one of them, or a preview is not the line the drop makes.
 */
export function perPage(nodes: Node[] | ReadonlyMap<string, Node>, obstacles?: Obstacles): (page: string) => Box[] {
  if (typeof obstacles === 'function') return obstacles;
  if (obstacles) return () => obstacles;
  return obstaclesByPage(nodes);
}

/** None: the answer for a line nothing is in the way of, the same array every time so it compares equal. */
export const NO_BOXES: Box[] = [];

// ── Boxes by where they are ──────────────────────────────────────────────────

const CELL = 200;

/**
 * Boxes filed by where they are, so that a route asks only about the few
 * near it. Pricing every way a line could leave every junction against every
 * symbol on the sheet made the reseat grow with the square of the drawing,
 * and a line drawn by asking about every symbol re-rendered when any moved.
 */
export class BoxGrid {
  private readonly cells = new Map<string, number[]>();
  readonly boxes: Box[];

  constructor(boxes: Box[]) {
    this.boxes = boxes;
    boxes.forEach((b, i) => {
      for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
        for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) {
          const k = `${cx},${cy}`;
          const list = this.cells.get(k);
          if (list) list.push(i); else this.cells.set(k, [i]);
        }
      }
    });
  }

  /** The boxes whose insides overlap [x0, x1] x [y0, y1], in the order they were given. */
  overlapping(x0: number, y0: number, x1: number, y1: number): Box[] {
    const hit = new Set<number>();
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        for (const i of this.cells.get(`${cx},${cy}`) ?? []) hit.add(i);
      }
    }
    return [...hit].sort((i, j) => i - j).map(i => this.boxes[i])
      .filter(b => b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0);
  }
}

const grids = new WeakMap<object, BoxGrid>();

/** The obstacles among a set of nodes -- those `obstacleBoxes` counts, the hidden ones not -- filed once per array. */
export function obstacleGrid(nodes: Node[]): BoxGrid {
  let g = grids.get(nodes);
  if (!g) { g = new BoxGrid(obstacleBoxes(nodes)); grids.set(nodes, g); }
  return g;
}

/** The same for a list of boxes already made, filed once per list. */
export function boxGrid(boxes: Box[]): BoxGrid {
  let g = grids.get(boxes);
  if (!g) { g = new BoxGrid(boxes); grids.set(boxes, g); }
  return g;
}

/** The bounding box of a path. */
export function boundsOf(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

/**
 * How far round a line's plain route `routeAuto` can look for a way round
 * what is in it: its widest search corridor (`REACH` doubled twice), and
 * some. A symbol further off than this cannot change its answer.
 */
export const SEARCH_REACH = 600;

/** Does a drawn run pass through the inside of any of the boxes? */
export function routeHitsBoxes(pts: Pt[], boxes: Box[], inset = TOUCH): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    for (const b of boxes) if (segmentEntersBox(pts[i], pts[i + 1], b, inset)) return true;
  }
  return false;
}

const strictlyInside = (p: Pt, b: Box, inset = TOUCH) =>
  p.x > b.x + inset && p.x < b.x + b.w - inset && p.y > b.y + inset && p.y < b.y + b.h - inset;

/**
 * How far a symbol's ports stand out of its box: a handle is centred on the
 * box's edge and a line meets its outer edge, three pixels out.
 */
export const PORT_REACH = 3;

/** How far a point is from a box, nought inside it. */
const distanceTo = (p: Pt, b: Box) =>
  Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));

/**
 * The boxes a route between `a` and `b` is held clear of: every obstacle but
 * one an end sits inside (overlapping symbols, which no route can keep out
 * of), each grown by its ports' reach -- except the symbols the route ends
 * on, whose ports it leaves and arrives at.
 *
 * A line touching a box's edge is not in it, and a line that ends nowhere
 * near a symbol could run down the symbol's edge and through the port
 * standing out of it: a branch dropped down a valve's side crossed the
 * valve's inlet where the pipe arrived, and read as a four-way joint at the
 * valve. Held its ports' reach clear, it goes round.
 */
export function heldClear(boxes: Box[], a: Pt, b: Pt): Box[] {
  return avoidable(boxes, a, b).map(bx => {
    const own = distanceTo(a, bx) <= PORT_REACH + 0.5 || distanceTo(b, bx) <= PORT_REACH + 0.5;
    return own ? bx : { x: bx.x - PORT_REACH, y: bx.y - PORT_REACH, w: bx.w + 2 * PORT_REACH, h: bx.h + 2 * PORT_REACH };
  });
}

/**
 * The boxes a route between `a` and `b` can be held out of at all: every one
 * but those an end sits inside (overlapping symbols), which no route could
 * keep out of. As they are, not grown by their ports' reach (`heldClear`).
 */
export function avoidable(boxes: Box[], a: Pt, b: Pt): Box[] {
  return boxes.filter(bx => !strictlyInside(a, bx) && !strictlyInside(b, bx));
}

/**
 * What `routeAuto` has to be shown for a route whose plain shape is `plain`
 * (`routeOrthogonal` between `a` and `b`), out of the boxes filed in `grid`:
 * none at all -- `NO_BOXES`, the same array every time -- when that shape
 * runs into nothing, the ends' own bodies included, which is `routeAuto`'s
 * own first test and nearly every line; and otherwise every box within its
 * search's reach of the shape (`SEARCH_REACH`), which is everything that
 * search can see. So `routeAuto` shown these answers exactly what it answers
 * shown every box in the grid, without being handed a whole sheet of symbols
 * for each line. A shape in the way of nothing but an end's own body is
 * still in the way, and still searched: what it gets is never `NO_BOXES`,
 * though it may be empty.
 *
 * Asked by the line as it draws itself (`lineRoute`) and by the reseat
 * pricing a face for it and routing its pipes (`pipes`), which each had
 * their own copy of the test; a line has to be drawn along the route it was
 * priced on.
 */
export function withinReach(plain: Pt[], grid: BoxGrid, a: End, b: End): Box[] {
  const own = [a.body, b.body].filter((x): x is Box => !!x);
  if ((!grid.boxes.length && !own.length) || plain.length < 2) return NO_BOXES;
  const { x0, y0, x1, y1 } = boundsOf(plain);
  // Held clear of the symbols by their ports' reach, as `routeAuto` holds it.
  const r = PORT_REACH;
  const near = grid.overlapping(x0 - r, y0 - r, x1 + r, y1 + r);
  if (!routeHitsBoxes(plain, heldClear([...near, ...own], a, b))) return NO_BOXES;
  return grid.overlapping(x0 - SEARCH_REACH, y0 - SEARCH_REACH, x1 + SEARCH_REACH, y1 + SEARCH_REACH);
}

/**
 * The route for a line, clear of the obstacles when it can be.
 *
 * `routeOrthogonal` when its shape runs through none of them; otherwise the
 * grid search; and `routeOrthogonal` again if even that finds no way (the
 * ends boxed in), since some line is better than none. An end's own `body`
 * counts as an obstacle too. Deterministic: the same ends and boxes always
 * give the same route.
 *
 * This is the route of a line nobody has routed by hand -- one with stored
 * corners is `routeThrough`'s -- and it is meant to be asked the same way
 * wherever a line is drawn or priced: `obstacles` from `obstacleBoxes` over
 * the nodes on the line's page, and a symbol's end carrying
 * `body: boxOfNode(node)`. `offset` is a legacy crossbar's (`routeOrthogonal`);
 * a searched route has no crossbar to offer, so its grip is null.
 */
export function routeAuto(a: End, b: End, obstacles: Box[], offset = 0): Route {
  const fast = routeOrthogonal(a, b, offset);
  const own = [a.body, b.body].filter((x): x is Box => !!x);
  const boxes = heldClear([...obstacles, ...own], a, b);
  if (!boxes.length) return fast;
  const pts = pathPoints(fast.d);
  if (!routeHitsBoxes(pts, boxes)) return fast;
  const found = remembered(a, b, offset, boxes, pts);
  // Clear by construction (`searchNear`); checked all the same, since a line
  // drawn through a symbol is the one thing this is here to prevent.
  return found && !routeHitsBoxes(found, boxes) ? { d: pointsToPath(found), grip: null } : fast;
}

// ── Among the other lines ────────────────────────────────────────────────────

/**
 * A line a route is looked for among, and what the route pays for what it
 * does to it: crossing it, lying on it, running near it, running beside it.
 *
 * `routeAuto` sees symbols and nothing else, and a line routed by its two
 * ends and the symbols in between took whatever shape was shortest whatever
 * else was drawn there: a branch whose pipe's far end had been dragged in
 * between its tee and the symbol it runs to crossed its own pipe to get
 * there, and ran along the pipe a tee's clearance off; a crossbar was put at
 * a tee's stub, fourteen pixels under the pipe, when any level further down
 * was as short. Those shapes are what the fast
 * router draws, and are usually right; a line whose fast shape pays for any
 * of these is looked for again with the other lines on the page as things
 * it would rather keep its distance from -- soft, where a symbol is hard: a
 * route may still cross a line, or run beside one, when nothing better is
 * to be had (`routeAmong`).
 *
 * What each thing costs is the caller's to say, in pixels of length, since
 * it is the caller who prices the route this proposes against the others
 * it has (`pipes.ts`, which prices a branch's faces): a crossing of another
 * line is a hop and costs little; one of the pipe the route's own tee rides
 * costs a great deal; lying on a line reads as one line.
 *
 * The search prices by the step, and a stretch along a line is as many steps
 * as the grid has lines across it: charged at every step, what is meant to
 * be charged once for the stretch made a long one cost thousands, and the
 * search went a long way round rather than pay it. So what is charged once
 * is spread over a grid step's length instead (`softSteps`) -- about the
 * same for a short stretch, and more for a long one, which is the one worth
 * avoiding.
 */
export interface SoftLine {
  pts: Pt[];
  /** Crossing it, once for each time. */
  cross: number;
  /** Nearer than `lie.within`: it reads as lying on it. Once for the stretch, and per pixel of it. */
  lie: { within: number; once: number; px: number };
  /** Nearer than `near.within`, beyond lying on it: once for the stretch, and per pixel. */
  near?: { within: number; once: number; px: number };
  /** No further than `beside.within` from it, beyond nearer: per pixel. */
  beside: { within: number; px: number };
}

/**
 * What each pixel run close alongside a symbol costs a route looked for among
 * the lines, where `routeAuto` charges `CLOSE`. A route that has to keep its
 * distance from the lines has more ways to go than one that need not, and
 * with the symbol's margin nearly free it took the channel between a symbol
 * and the port beside it, three pixels off the symbol's side for its whole
 * height -- the lines kept clear of, and the symbol hugged instead.
 */
const CLOSE_AMONG = 2;

/**
 * What a route looked for among the lines pays, per pixel of its length, for
 * each pixel it runs from the plain route's own levels: next to nothing, and
 * only there to settle ties. Off a sheet of open canvas every level a
 * crossbar could be put at costs the same, and the search, which follows
 * whichever way is further along, put a crossbar a hundred pixels down that
 * thirty would have cleared -- as good a route, and much less like the one
 * the line had. A run along a row is as far off as that row is from the
 * nearest row the plain route runs along, and a run down a column likewise:
 * counted once per line of the grid (`awayFrom`), not worked out afresh for
 * every step the search takes.
 */
const STAY = 1e-4;

/**
 * For each of the grid's lines `vs` across one axis, how far it is from the
 * nearest of the plain route's own on that axis (`at`), in whole grid
 * steps' worth of pixels -- and a pixel more for a line off the grid, so
 * that of two levels within one step of each other the one on the grid the
 * symbols are on is not passed over for the middle of a channel half a
 * pixel nearer.
 */
function awayFrom(vs: number[], at: number[]): Float64Array {
  const out = new Float64Array(vs.length);
  vs.forEach((v, i) => {
    let best = Infinity;
    for (const a of at) best = Math.min(best, Math.abs(v - a));
    if (!at.length) best = 0;
    out[i] = Math.ceil(best / GRID - 1e-9) * GRID + (Math.abs(v - Math.round(v / GRID) * GRID) > 1e-6 ? 1 : 0);
  });
  return out;
}

/**
 * How many times a search among the lines widens its corridor, and so how
 * far past the plain route it can look: `REACH`, then twice that. A way
 * round the lines that has to go further is not worth drawing, and the
 * search that found it would have had to be shown every line within that
 * much of the route -- on a crowded page, every line. `AMONG_REACH` is as
 * far as any line can matter to one, a line's clearance included: what a
 * caller has to show it.
 */
const AMONG_WIDENINGS = 2;

/**
 * What a search among the lines may spend, in states taken off the heap:
 * a quarter of what a search round the symbols may. The lines make every
 * way through cost something, and the estimate, which knows only length and
 * corners, then leaves the proof that one is the cheapest to trying nearly
 * every state of the grid; a reseat that asked it for each branch after
 * each edit spent most of its time there. Past the exact budget the search
 * heads for the target and settles for a good way, which is all a proposal
 * the caller prices against the router's own needs to be.
 */
const AMONG_EXACT_POPS = 5_000;
const AMONG_GREEDY_POPS = 4_000;
export const AMONG_REACH = 2 * REACH + 4 * GRID;

/** Everything a route is looked for among besides the symbols. */
export interface Soft {
  lines: SoftLine[];
  /** The junctions' dots a route may not pass through (not its own ends'), how near is through, and what it costs. */
  dots: { at: Pt[]; reach: number; cost: number };
}

/**
 * The route for a line looked for among the other lines on its page as well
 * as round the symbols (`Soft`): the cheapest the search finds, by length,
 * `CORNER` a corner, a little for running close alongside a symbol, and what
 * each line near it charges. Null when the search finds none clear of the
 * symbols, or runs out of what it may spend. Deterministic, and remembered
 * like `routeAuto`'s: the same ends, symbols and lines give the same route.
 *
 * Not `routeAuto`: a line that routes itself is drawn from its two ends and
 * the symbols alone (`lineRoute`), and this answer depends on what else is
 * on the page. A caller that takes it keeps it as the line's corners.
 * `plain` is the plain route between the two ends (`routeOrthogonal`), for
 * a caller that has it already.
 *
 * Remembered as `routeAuto`'s searches are (`remembered`): by the two ends,
 * with the corridors the search looked in and what of the symbols and the
 * lines reached into them, which is all the answer can depend on. The reseat
 * asks again on every tick of a drag, and a symbol dragged across the far
 * side of the sheet costs no line here a search.
 */
export function routeAmong(a: End, b: End, obstacles: Box[], soft: Soft, plain?: Pt[]): Pt[] | null {
  const own = [a.body, b.body].filter((x): x is Box => !!x);
  const boxes = heldClear([...obstacles, ...own], a, b);
  const key = `${endKey(a)}|${endKey(b)}`;
  const kept = amongMemo.get(key);
  const hit = kept?.find(r => r.seen === seenAmong(boxes, soft, r.tried));
  if (kept && hit) {
    amongMemo.delete(key);
    amongMemo.set(key, kept);
    freshSearch();
    return hit.found;
  }
  const fast = plain ?? pathPoints(routeOrthogonal(a, b).d);
  const tried: Box[] = [];
  const found = searchNear(a, b, boxes, fast, tried, soft);
  const clear = found && !routeHitsBoxes(found, boxes) ? found : null;
  const list = [{ tried, seen: seenAmong(boxes, soft, tried), found: clear }, ...(kept ?? [])].slice(0, 4);
  amongMemo.delete(key);
  amongMemo.set(key, list);
  amongKept += list.length - (kept?.length ?? 0);
  while (amongKept > MEMO && amongMemo.size) {
    const oldest = amongMemo.keys().next().value!;
    amongKept -= amongMemo.get(oldest)!.length;
    amongMemo.delete(oldest);
  }
  return clear;
}

const amongMemo = new Map<string, Remembered[]>();
let amongKept = 0;
/**
 * What of the symbols and the lines reach into the corridors, as one
 * string: what a remembered answer is checked against. The lines segment by
 * segment, as a search kept to the corridors meets them (`softWithin`).
 */
function seenAmong(boxes: Box[], soft: Soft, tried: Box[]): string {
  const parts: (string | number)[] = [seenIn(boxes, tried)];
  const clip = clipTo(tried);
  for (const l of soft.lines) {
    const c = clearOf(l);
    let named = false;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const p = l.pts[i], q = l.pts[i + 1];
      if (!meets(p, q, c, tried)) continue;
      if (!named) {
        parts.push('|', l.cross, l.lie.within, l.lie.once, l.lie.px, l.near?.within ?? '', l.near?.once ?? '', l.near?.px ?? '',
          l.beside.within, l.beside.px);
        named = true;
      }
      const [u, v] = clip(p, q, c);
      parts.push(u.x, u.y, v.x, v.y);
    }
  }
  const r = soft.dots.reach;
  parts.push('|', r, soft.dots.cost);
  for (const d of soft.dots.at) if (tried.some(x => overlap({ x: d.x - r, y: d.y - r, w: 2 * r, h: 2 * r }, x))) parts.push(d.x, d.y);
  return parts.join(',');
}
const endKey = (e: End) => `${e.x},${e.y},${e.side},${e.stub ?? ''},${e.clear ?? ''},${e.inset ?? ''},${e.body ? boxKey(e.body) : ''}`;

/** How far from it a line stops costing anything: where the search is given a way to run clear of it. */
const clearOf = (l: SoftLine) => Math.max(l.lie.within, l.near?.within ?? 0, l.beside.within) + GRID;

/** A segment's box grown by `by` every way. */
const segmentBox = (p: Pt, q: Pt, by: number): Box =>
  ({ x: Math.min(p.x, q.x) - by, y: Math.min(p.y, q.y) - by, w: Math.abs(p.x - q.x) + 2 * by, h: Math.abs(p.y - q.y) + 2 * by });

/** Does a segment's box grown by `by` meet any of the rectangles, edges touching included? */
function meets(p: Pt, q: Pt, by: number, rects: Box[]): boolean {
  const x0 = Math.min(p.x, q.x) - by, x1 = Math.max(p.x, q.x) + by, y0 = Math.min(p.y, q.y) - by, y1 = Math.max(p.y, q.y) + by;
  for (const r of rects) if (x0 <= r.x + r.w && r.x <= x1 && y0 <= r.y + r.h && r.y <= y1) return true;
  return false;
}

/**
 * The part of `soft` that can reach into any of the rectangles: what a
 * search kept to them can meet. Segment by segment -- each is priced on its
 * own (`softSteps`) -- so a line whose far end moves, a long way outside,
 * is not something a remembered search has to be looked for again for.
 */
function softWithin(soft: Soft, rects: Box[]): Soft {
  const lines: SoftLine[] = [];
  const clip = clipTo(rects);
  for (const l of soft.lines) {
    const c = clearOf(l);
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const p = l.pts[i], q = l.pts[i + 1];
      if (meets(p, q, c, rects)) lines.push({ ...l, pts: clip(p, q, c) });
    }
  }
  const r = soft.dots.reach;
  const at = soft.dots.at.filter(d => rects.some(x => overlap({ x: d.x - r, y: d.y - r, w: 2 * r, h: 2 * r }, x)));
  return { lines, dots: { ...soft.dots, at } };
}

/**
 * A segment cut back to the rectangles' bounds and a line's clearance and a
 * grid step more: all of it a search kept to them can meet, its cut ends
 * further off than any line of the grid, so that what is inside is still
 * crossed, not touched at its end. A header running the width of the sheet
 * is one segment, and whole, its far end dragged a step made every branch
 * off it a search to be done again.
 */
function clipTo(rects: Box[]): (p: Pt, q: Pt, c: number) => Pt[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const at = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return (p, q, c) => {
    const m = c + GRID;
    return [{ x: at(p.x, x0 - m, x1 + m), y: at(p.y, y0 - m, y1 + m) }, { x: at(q.x, x0 - m, x1 + m), y: at(q.y, y0 - m, y1 + m) }];
  };
}

/**
 * How near the plain route a line has to come for the search to be given a
 * way to run clear of it (`clearOf`). Further off, it is still priced, but
 * lays no lines of its own across the grid: a grid with a pair of lines for
 * every line on a crowded page was ten thousand points, and the search
 * through it a millisecond or two, for ways round lines the route had no
 * reason to go near.
 */
const LANES = REACH / 2;

/**
 * Searches already done, by what they were asked. A line is drawn on every
 * render that touches it, and one that needed a search needs the same one
 * each time until something near it moves; a drag elsewhere on the sheet
 * should not cost it anything.
 *
 * Kept by the ends and the offset, each answer with the corridors its search
 * looked in (`searchNear`) and the boxes that reached into them -- which are
 * the only boxes the answer can depend on, since a search goes nowhere
 * outside the corridors it tries. So a remembered answer is exactly the one
 * a fresh search would give, and a symbol moved anywhere those corridors do
 * not reach does not cost a search. Keyed instead by every box within the
 * widest corridor any search might try, a long line across the sheet that
 * had to go round something was searched afresh whenever any symbol within
 * six hundred pixels of it moved -- nearly every symbol, on a stand.
 */
interface Remembered { tried: Box[]; seen: string; found: Pt[] | null }
const memo = new Map<string, Remembered[]>();
const MEMO = 256;
let remembering = 0;

const boxKey = (bx: Box) => `${bx.x},${bx.y},${bx.w},${bx.h}`;
/** The boxes reaching into any of the corridors, as one string: what a remembered answer is checked against. */
const seenIn = (boxes: Box[], tried: Box[]) =>
  boxes.filter(bx => tried.some(c => overlap(bx, c))).map(boxKey).sort().join(';');

function remembered(a: End, b: End, offset: number, boxes: Box[], fast: Pt[]): Pt[] | null {
  const end = (e: End) => `${e.x},${e.y},${e.side},${e.stub ?? ''},${e.clear ?? ''},${e.inset ?? ''},${e.body ? boxKey(e.body) : ''}`;
  const key = `${end(a)}|${end(b)}|${offset}`;
  const kept = memo.get(key);
  const hit = kept?.find(r => r.seen === seenIn(boxes, r.tried));
  if (kept && hit) {
    memo.delete(key);
    memo.set(key, kept);
    freshSearch();
    return hit.found;
  }
  const tried: Box[] = [];
  const found = searchNear(a, b, boxes, fast, tried);
  const entry = { tried, seen: seenIn(boxes, tried), found };
  const list = kept ? [entry, ...kept].slice(0, 4) : [entry];
  memo.delete(key);
  memo.set(key, list);
  remembering += list.length - (kept?.length ?? 0);
  while (remembering > MEMO && memo.size) {
    const oldest = memo.keys().next().value!;
    remembering -= memo.get(oldest)!.length;
    memo.delete(oldest);
  }
  return found;
}

/**
 * The search, kept to the neighbourhood of the plain route rather than the
 * whole sheet.
 *
 * Each search is given a corridor: it sees the symbols that reach into it,
 * and goes nowhere outside it. Any symbol a route in the corridor runs into
 * reaches into the corridor, so was seen, and a route found there is clear
 * of everything with no need to look again. (Left free to go anywhere, a
 * search went through the open middle of a long diagonal run's bounding
 * box, where nothing had been looked at, and ran into what was there.)
 *
 * First the plain route's bounding box grown by `REACH`, where the best
 * route nearly always is -- if proving that is cheap enough. Otherwise, or
 * when that is walled off, every segment of the plain route grown by
 * `REACH` each way: a narrower strip for a long run across a crowded sheet,
 * far fewer symbols, and a route that follows the plain one round whatever
 * is in its way. Twice as wide, and four times, when there is no way through
 * that. Null when there is none even then, or the budget is spent.
 */
function searchNear(a: End, b: End, boxes: Box[], fast: Pt[], tried: Box[] = [], soft?: Soft): Pt[] | null {
  const budget = freshSearch();
  if (soft) { budget.exact = AMONG_EXACT_POPS; budget.greedy = AMONG_GREEDY_POPS; }
  const xs = fast.map(p => p.x), ys = fast.map(p => p.y);
  const x0 = Math.min(...xs) - REACH, y0 = Math.min(...ys) - REACH;
  const span = [{ x: x0, y: y0, w: Math.max(...xs) + REACH - x0, h: Math.max(...ys) + REACH - y0 }];
  tried.push(...span);
  const first = searchGrid(a, b, boxes.filter(bx => overlap(bx, span[0])), budget, span, true, soft && softWithin(soft, span), fast);
  // Round the symbols, the first route found is the one: the corridors
  // widen only to find a way at all. Among the lines, a way found in the
  // first corridor may still pay for crossing a line it should not -- the
  // way round the symbol at the pipe's far end lying just outside it -- and
  // the wider corridors are looked in too, and the cheapest taken: each
  // looking only for a way that comes in under the best found so far.
  const settled = (f: Found | null) => !!f && (!soft || f.cost - routeCost(f.pts) < WIDEN_PAST);
  if (settled(first)) return first!.pts;
  let best = first;
  for (let k = 0, reach = REACH; k < (soft ? AMONG_WIDENINGS : WIDENINGS); k++, reach *= 2) {
    const corridor = fast.slice(0, -1).map((p, i) => {
      const q = fast[i + 1];
      const x = Math.min(p.x, q.x) - reach, y = Math.min(p.y, q.y) - reach;
      return { x, y, w: Math.max(p.x, q.x) + reach - x, h: Math.max(p.y, q.y) + reach - y };
    });
    tried.push(...corridor);
    const found = searchGrid(
      a, b, boxes.filter(bx => corridor.some(c => overlap(bx, c))), budget, corridor, false, soft && softWithin(soft, corridor), fast,
      best?.cost ?? Infinity,
    );
    if (found && (!best || found.cost < best.cost - 1e-9)) best = found;
    if (settled(best)) break;
    if (budget.exact <= 0 && budget.greedy <= 0) break;
  }
  return best?.pts ?? null;
}

/**
 * What a route found among the lines may pay beyond its length and corners
 * -- for running close to a symbol, a stub cut short, a line run beside or
 * hopped -- and still be taken from the first corridor it was found in.
 * More than this is a line lain on, a dot run through, or the pipe its own
 * tee rides crossed, and the search looks wider for a way that does none of
 * them. Less, and the wider corridors were searched for nothing: on a page
 * put together at random, most ways round cost a little whatever, and
 * looking three times for each made every reseat five times slower.
 */
const WIDEN_PAST = 500;

/** A route a search found, and what it cost the search. */
interface Found { pts: Pt[]; cost: number }

/** Do two boxes overlap, edges touching included? */
const overlap = (p: Box, q: Box) => p.x <= q.x + q.w && q.x <= p.x + p.w && p.y <= q.y + q.h && q.y <= p.y + p.h;

/** The four ways a leg can run, by index: +x, -x, +y, -y. */
const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const dirIndex = (side: End['side']) => (isHorizontal(side) ? (facing(side) > 0 ? 0 : 1) : (facing(side) > 0 ? 2 : 3));

/** A step of the grid runs inside the margin round a box, or through a box. */
const NEAR = 1, BLOCKED = 2;

/** The first index of a sorted array whose value is greater than `v` (the length when none is). */
function above(vs: number[], v: number): number {
  let lo = 0, hi = vs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (vs[m] > v) hi = m; else lo = m + 1;
  }
  return lo;
}

/** The last index of a sorted array whose value is less than `v` (-1 when none is). */
function below(vs: number[], v: number): number {
  let lo = 0, hi = vs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (vs[m] < v) lo = m + 1; else hi = m;
  }
  return lo - 1;
}

/** Sorted, de-duplicated, to the hundredth of a pixel. */
function lines(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values.map(v => Math.round(v * 100) / 100).sort((p, q) => p - q)) {
    if (!out.length || v - out[out.length - 1] > 0.01) out.push(v);
  }
  return out;
}

/**
 * The grid's lines on one axis: the given ones, and the middle of every gap
 * between them narrower than four margins -- the channel between two
 * symbols, or between a port and the symbol in front of it -- so a run that
 * has to go through one goes down the middle of it rather than along one
 * side.
 */
function withChannels(raw: number[]): number[] {
  const s = lines(raw);
  const mids: number[] = [];
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] < 4 * MARGIN) mids.push((s[i] + s[i - 1]) / 2);
  return lines([...s, ...mids]);
}

/**
 * A binary heap of states keyed by estimated total cost. Of two equally
 * promising states the one further along (more cost behind it, less ahead)
 * comes first -- on open sheet every staircase between two points is as
 * short as every other, and taking them breadth-first tries them all -- and
 * then the lower state, so a search is repeatable.
 */
class Heap {
  private cost = new Float64Array(64);
  private done = new Float64Array(64);
  private state = new Int32Array(64);
  size = 0;
  private less(i: number, j: number) {
    if (this.cost[i] !== this.cost[j]) return this.cost[i] < this.cost[j];
    if (this.done[i] !== this.done[j]) return this.done[i] > this.done[j];
    return this.state[i] < this.state[j];
  }
  private swap(i: number, j: number) {
    const c = this.cost[i]; this.cost[i] = this.cost[j]; this.cost[j] = c;
    const g = this.done[i]; this.done[i] = this.done[j]; this.done[j] = g;
    const s = this.state[i]; this.state[i] = this.state[j]; this.state[j] = s;
  }
  push(c: number, g: number, s: number) {
    if (this.size === this.cost.length) {
      const cost = new Float64Array(this.size * 2); cost.set(this.cost); this.cost = cost;
      const done = new Float64Array(this.size * 2); done.set(this.done); this.done = done;
      const state = new Int32Array(this.size * 2); state.set(this.state); this.state = state;
    }
    let k = this.size++;
    this.cost[k] = c; this.done[k] = g; this.state[k] = s;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }
  /** The cost behind the state last popped. */
  top = 0;
  pop(): number {
    const s = this.state[0];
    this.top = this.done[0];
    this.size--;
    if (this.size > 0) {
      this.cost[0] = this.cost[this.size]; this.done[0] = this.done[this.size]; this.state[0] = this.state[this.size];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === k) break;
        this.swap(m, k);
        k = m;
      }
    }
    return s;
  }
}

/** What a pass of the search returns when it runs out of budget before it finds anything. */
const SPENT = -2;

/**
 * The shortest square route from `a` to `b` that keeps out of every box.
 *
 * It leaves `a` along the way `a` faces and reaches `b` from the side `b`
 * faces; it may turn out of a port's leg before the stub is up only to get
 * through a gap narrower than the stub (at a price per pixel short), never
 * turns back on itself, and runs through no box's inside. An A* search over
 * (grid point, heading) states. Null when there is no such route among the
 * grid's lines.
 *
 * Also null when the search would cost too much to run on a render: a grid
 * of more than `MAX_POINTS`, or a greedy pass that also runs out. The first
 * pass proves its route the cheapest; one that runs out of `EXACT_POPS`
 * first, or has more than `EXACT_POINTS` to prove it over, hands over to a
 * greedier one (`GREEDY`), which heads for the target and settles for a
 * good route.
 */
export function gridRoute(a: End, b: End, boxes: Box[]): Pt[] | null {
  return searchGrid(a, b, boxes, freshSearch())?.pts ?? null;
}

/**
 * Scratch arrays for the search, kept from one to the next: a line is
 * searched for on every render it needs one, and a fresh few megabytes each
 * time is work for the collector that nothing needs.
 */
const scratch = {
  cells: 0, states: 0,
  across: new Uint8Array(0), down: new Uint8Array(0), dist: new Float64Array(0), prev: new Int32Array(0),
};
function buffers(cells: number) {
  if (scratch.cells < cells) {
    scratch.cells = cells;
    scratch.across = new Uint8Array(cells);
    scratch.down = new Uint8Array(cells);
  }
  if (scratch.states < cells * 4) {
    scratch.states = cells * 4;
    scratch.dist = new Float64Array(cells * 4);
    scratch.prev = new Int32Array(cells * 4);
  }
  scratch.across.fill(0, 0, cells);
  scratch.down.fill(0, 0, cells);
  return scratch;
}

/**
 * `gridRoute`, spending from a budget a caller may share across several
 * searches; given a corridor (rectangles), going nowhere outside it; and
 * with `exactOnly`, giving up rather than settling for less than the best.
 */
function searchGrid(
  a: End, b: End, boxes: Box[], budget: Budget, corridor?: Box[], exactOnly = false, soft?: Soft, plain?: Pt[],
  bound = Infinity,
): Found | null {
  const fa = DIRS[dirIndex(a.side)], fb = DIRS[dirIndex(b.side)];
  const sa = a.stub ?? STUB, sb = b.stub ?? STUB;
  const rawX = [a.x, b.x, a.x + fa.x * sa, b.x + fb.x * sb];
  const rawY = [a.y, b.y, a.y + fa.y * sa, b.y + fb.y * sb];
  // A box's own edges are not among them: a run has no business along
  // them, and between two symbols closer than two margins the channel's
  // middle is (`withChannels`). They were once, and made the grid three
  // times as fine each way for nothing.
  for (const bx of boxes) {
    rawX.push(bx.x - MARGIN, bx.x + bx.w + MARGIN);
    rawY.push(bx.y - MARGIN, bx.y + bx.h + MARGIN);
  }
  // Two more kinds of line, neither with channels of its own. The middle
  // between the two ends, where the plain router would put a crossbar: in
  // open sheet, with nothing else to lay a line along, a run between two
  // ends facing apart had only the ends' own two rows to go round by, and
  // folded back over its own first leg to use them. And the corridor's
  // edges, so that no step of the grid is partly in it and partly out.
  // Among other lines, a third: where a route runs clear of each of them
  // (`clearOf`), either side and past either end, and either side of each
  // dot -- the only places a route that has to keep its distance can go.
  const clearX: number[] = [], clearY: number[] = [];
  const lanes = (plain ?? []).slice(0, -1).map((p, i) => segmentBox(p, plain![i + 1], LANES));
  for (const l of soft?.lines ?? []) {
    const c = clearOf(l);
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const p = l.pts[i], q = l.pts[i + 1];
      if (plain && !lanes.some(x => overlap(segmentBox(p, q, c), x))) continue;
      if (Math.abs(p.y - q.y) < AXIS_EPS) {
        clearY.push(p.y - c, p.y + c);
        clearX.push(Math.min(p.x, q.x) - c, Math.max(p.x, q.x) + c);
      } else if (Math.abs(p.x - q.x) < AXIS_EPS) {
        clearX.push(p.x - c, p.x + c);
        clearY.push(Math.min(p.y, q.y) - c, Math.max(p.y, q.y) + c);
      }
    }
  }
  // Two grid steps off a dot: a route turned just short of one points
  // straight at it.
  for (const d of soft?.dots.at ?? []) {
    const c = Math.ceil(soft!.dots.reach / GRID) * GRID + GRID;
    clearX.push(d.x - c, d.x + c);
    clearY.push(d.y - c, d.y + c);
  }
  const inside = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
  const inX = (v: number) => !corridor || corridor.some(r => inside(v, r.x, r.x + r.w));
  const inY = (v: number) => !corridor || corridor.some(r => inside(v, r.y, r.y + r.h));
  // Among other lines, a line of the grid within half a grid step of an
  // end's own axis is that axis. Priced by the pixel for running close to a
  // symbol, a route out of a tee a pixel inside a symbol's margin turned off
  // its axis for that pixel and turned back, a kink nobody could read.
  const edges = (corridor ?? []).flatMap(r => [r.x, r.x + r.w, r.y, r.y + r.h]);
  const axis = (vs: number[], own: number[]) =>
    (soft ? vs.filter(v => own.includes(v) || edges.includes(v) || own.every(o => Math.abs(v - o) >= GRID / 2)) : vs);
  const xs = axis(lines([
    ...withChannels(rawX), (a.x + b.x) / 2, ...(corridor ?? []).flatMap(r => [r.x, r.x + r.w]), ...clearX.filter(inX),
  ]), lines([a.x, b.x]));
  const ys = axis(lines([
    ...withChannels(rawY), (a.y + b.y) / 2, ...(corridor ?? []).flatMap(r => [r.y, r.y + r.h]), ...clearY.filter(inY),
  ]), lines([a.y, b.y]));
  const nx = xs.length, ny = ys.length;
  lastSearch.rounds++;
  lastSearch.points = Math.max(lastSearch.points, nx * ny);
  if (nx * ny > (exactOnly ? EXACT_POINTS : MAX_POINTS)) return null;
  const index = (vs: number[], v: number) => {
    let best = 0;
    for (let i = 1; i < vs.length; i++) if (Math.abs(vs[i] - v) < Math.abs(vs[best] - v)) best = i;
    return best;
  };
  const si = index(xs, a.x), sj = index(ys, a.y), ti = index(xs, b.x), tj = index(ys, b.y);
  const startDir = dirIndex(a.side);
  const goalDir = dirIndex(b.side) ^ 1;   // arriving at b moves against the way b faces

  // What lies under each step between neighbouring grid points: nothing, the
  // margin round a box (a surcharge), or a box (no way through). across[i*ny+j]
  // is the step (i, j) -> (i+1, j); down[..] is (i, j) -> (i, j+1). The grid's
  // lines include every box's margin, so the margin covers whole steps; a
  // step that reaches into a box at all is through it. Marking them box by
  // box is far cheaper than asking every box about every step.
  const { across, down, dist, prev } = buffers(nx * ny);
  // Outside the corridor is as good as a box: every step starts blocked,
  // and those inside one of its rectangles are opened.
  if (corridor) {
    across.fill(BLOCKED, 0, nx * ny);
    down.fill(BLOCKED, 0, nx * ny);
    for (const r of corridor) {
      const i0 = index(xs, r.x), i1 = index(xs, r.x + r.w), j0 = index(ys, r.y), j1 = index(ys, r.y + r.h);
      for (let i = i0; i < i1; i++) across.fill(0, i * ny + j0, i * ny + j1 + 1);
      for (let i = i0; i <= i1; i++) down.fill(0, i * ny + j0, i * ny + j1);
    }
  }
  const mark = (x0: number, x1: number, y0: number, y1: number, what: number) => {
    // A step along a row runs through (x0, x1) x (y0, y1) when the row is
    // strictly inside it across and the step overlaps it along -- exactly
    // `segmentEntersBox`, for the one kind of segment the grid has.
    const r0 = above(ys, y0), r1 = below(ys, y1);
    const c0 = Math.max(0, above(xs, x0) - 1), c1 = Math.min(nx - 2, below(xs, x1));
    for (let j = r0; j <= r1; j++) for (let i = c0; i <= c1; i++) across[i * ny + j] = Math.max(across[i * ny + j], what);
    const k0 = above(xs, x0), k1 = below(xs, x1);
    const s0 = Math.max(0, above(ys, y0) - 1), s1 = Math.min(ny - 2, below(ys, y1));
    for (let i = k0; i <= k1; i++) for (let j = s0; j <= s1; j++) down[i * ny + j] = Math.max(down[i * ny + j], what);
  };
  for (const bx of boxes) {
    mark(bx.x - MARGIN, bx.x + bx.w + MARGIN, bx.y - MARGIN, bx.y + bx.h + MARGIN, NEAR);
    mark(bx.x + TOUCH, bx.x + bx.w - TOUCH, bx.y + TOUCH, bx.y + bx.h - TOUCH, BLOCKED);
  }
  // What each step pays for the other lines and the dots, on top of that;
  // and for running off the plain route, worked out for a step the first
  // time the search takes it (`STAY`).
  const extra = soft && (soft.lines.length || soft.dots.at.length) ? softSteps(xs, ys, soft) : null;
  // The plain route's own rows and columns: where its runs along each axis are.
  const rowsOff = extra && plain ? awayFrom(ys, plain.slice(0, -1).filter((p, i) => p.y === plain[i + 1].y).map(p => p.y)) : null;
  const colsOff = extra && plain ? awayFrom(xs, plain.slice(0, -1).filter((p, i) => p.x === plain[i + 1].x).map(p => p.x)) : null;
  const stepCost = (i: number, j: number, i2: number, j2: number): number => {
    const h = i2 !== i;
    const k = h ? Math.min(i, i2) * ny + j : i * ny + Math.min(j, j2);
    const what = h ? across[k] : down[k];
    if (what === BLOCKED) return Infinity;
    const len = h ? Math.abs(xs[i2] - xs[i]) : Math.abs(ys[j2] - ys[j]);
    if (!extra) return what === NEAR ? len * (1 + CLOSE) : len;
    const off = rowsOff ? STAY * len * (h ? rowsOff[j] : colsOff![i]) : 0;
    return (what === NEAR ? len * (1 + CLOSE_AMONG) : len) + (h ? extra.across[k] : extra.down[k]) + off;
  };
  // How far short of its stub a leg out of a port would be, turning here.
  const shortOut = (i: number, j: number) => {
    const along = (xs[i] - a.x) * fa.x + (ys[j] - a.y) * fa.y;
    const onLeg = fa.x !== 0 ? j === sj : i === si;
    return onLeg && along < sa ? sa - along : 0;
  };
  const shortIn = (i: number, j: number) => {
    const along = (xs[i] - b.x) * fb.x + (ys[j] - b.y) * fb.y;
    const onLeg = fb.x !== 0 ? j === tj : i === ti;
    return onLeg && along < sb ? sb - along : 0;
  };
  // The estimate: the distance left, and a corner for every turn the run
  // cannot avoid on the way -- none when b is straight ahead and the run is
  // already heading into it, one when a single turn can bring it in, two
  // otherwise. Never more than the real cost, so the first route the exact
  // pass finds is the cheapest; and much less searching than the distance
  // alone, which takes every corner to be free.
  const estimate = (i: number, j: number, d: number) => {
    const dx = xs[ti] - xs[i], dy = ys[tj] - ys[j];
    const u = DIRS[d], g = DIRS[goalDir];
    const ahead = dx * u.x + dy * u.y, aside = Math.abs(dx * u.y) + Math.abs(dy * u.x);
    let turns: number;
    if (d === goalDir) turns = aside === 0 && ahead >= 0 ? 0 : 2;
    else if (d === (goalDir ^ 1)) turns = 2;
    else turns = ahead >= 0 && dx * g.x + dy * g.y > 0 ? 1 : 2;
    return Math.abs(dx) + Math.abs(dy) + CORNER * turns;
  };

  const N = nx * ny * 4;
  const key = (i: number, j: number, d: number) => (i * ny + j) * 4 + d;
  const start = key(si, sj, startDir);
  // One pass: the goal state, -1 when there is no route, or `SPENT`.
  const pass = (weight: number, allowance: number): { goal: number; popped: number } => {
    dist.fill(Infinity, 0, N);
    prev.fill(-1, 0, N);
    const heap = new Heap();
    dist[start] = 0;
    heap.push(weight * estimate(si, sj, startDir), 0, start);
    let popped = 0;
    while (heap.size) {
      if (popped >= allowance) return { goal: SPENT, popped };
      popped++;
      const s = heap.pop();
      const c = heap.top;
      if (c > dist[s] + 1e-9) continue;                  // a stale entry
      const d = s % 4, ij = (s - d) / 4, j = ij % ny, i = (ij - j) / ny;
      if (i === ti && j === tj) {
        if (d === goalDir) return { goal: s, popped };
        continue;
      }
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (d ^ 1)) continue;                    // never straight back
        if (s === start && nd !== d) continue;           // leave a port the way it faces
        const i2 = i + DIRS[nd].x, j2 = j + DIRS[nd].y;
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
        const step = stepCost(i, j, i2, j2);
        if (step === Infinity) continue;
        let turnCost = 0;
        if (nd !== d) turnCost = CORNER + SHORT * shortOut(i, j);
        // Turning onto b's own leg short of its stub.
        if (nd === goalDir && nd !== d) turnCost += SHORT * shortIn(i, j);
        const n2 = key(i2, j2, nd);
        const c2 = c + step + turnCost;
        if (c2 >= dist[n2] - 1e-9) continue;
        const e2 = estimate(i2, j2, nd);
        // No way on from here can come in under a route already found.
        if (c2 + e2 >= bound) continue;
        dist[n2] = c2; prev[n2] = s; heap.push(c2 + weight * e2, c2, n2);
      }
    }
    return { goal: -1, popped };
  };
  let goal = SPENT;
  if (nx * ny <= EXACT_POINTS && budget.exact > 0) {
    const r = pass(1, budget.exact);
    budget.exact -= r.popped;
    lastSearch.popped += r.popped;
    goal = r.goal;
  }
  if (goal === SPENT && exactOnly) return null;
  if (goal === SPENT) {
    const r = pass(GREEDY, budget.greedy);
    budget.greedy -= r.popped;
    lastSearch.popped += r.popped;
    goal = r.goal;
  }
  if (goal < 0) return null;
  const cost = dist[goal];
  const chain: Pt[] = [];
  for (let s = goal; s >= 0; s = prev[s]) {
    const d = s % 4, ij = (s - d) / 4, j = ij % ny, i = (ij - j) / ny;
    chain.push({ x: xs[i], y: ys[j] });
  }
  chain.reverse();
  // The grid's lines are the ends' own coordinates to the hundredth; put the
  // ends back exactly, and the snap in simplifyPoints squares the rest to them.
  chain[0] = { x: a.x, y: a.y };
  chain[chain.length - 1] = { x: b.x, y: b.y };
  return { pts: simplifyPoints(chain), cost };
}

/**
 * What each step of the grid pays for the lines and dots of `soft`, laid
 * out like the steps themselves: `across[i*ny+j]` for the step (i, j) ->
 * (i+1, j), `down` for (i, j) -> (i, j+1).
 *
 * A step along a line, near enough to it, pays by how near, per pixel of it
 * the two run together -- what is charged once for a stretch spread over a
 * grid step (`SoftLine`). A step across a line pays for the crossing; one
 * that meets the line's end instead, near enough to read as joining it, pays
 * what lying on it does. A crossing exactly at a point of the grid is paid
 * by the step leaving that point toward larger coordinates, so a route
 * straight through it pays once, and one that turns there onto the line pays
 * for lying on it. And a step through a dot pays for passing through it.
 */
function softSteps(xs: number[], ys: number[], soft: Soft): { across: Float64Array; down: Float64Array } {
  const nx = xs.length, ny = ys.length;
  const across = new Float64Array(nx * ny), down = new Float64Array(nx * ny);
  // One segment of a line, at `at` across and from `lo` to `hi` along: the
  // steps that run with it (`withIt`) and the steps that cross it
  // (`acrossIt`), the grid's lines along it (`us`) and across it (`vs`), and
  // where the step between two of them is kept (`idx`).
  const segment = (
    l: SoftLine, at: number, lo: number, hi: number,
    withIt: Float64Array, acrossIt: Float64Array,
    us: number[], vs: number[], idx: (u: number, v: number) => number,
  ) => {
    const reach = Math.max(l.lie.within, l.near?.within ?? 0, l.beside.within);
    // Steps running with it: on the lines across it within reach.
    for (let v = Math.max(0, below(vs, at - reach) + 1); v < vs.length && vs[v] <= at + reach + 1e-9; v++) {
      const d = Math.abs(vs[v] - at);
      const per = d < l.lie.within ? l.lie : l.near && d < l.near.within ? l.near : null;
      const px = per ? per.px + per.once / GRID : d <= l.beside.within + 1e-9 ? l.beside.px : 0;
      if (!px) continue;
      for (let u = Math.max(0, above(us, lo) - 1); u + 1 < us.length && us[u] < hi; u++) {
        const o = Math.min(us[u + 1], hi) - Math.max(us[u], lo);
        if (o > AXIS_EPS) withIt[idx(u, v)] += px * o;
      }
    }
    // Steps across it: on the lines along it, from the grid line at or
    // before it to the one after.
    const v = above(vs, at) - 1;
    if (v < 0 || v + 1 >= vs.length) return;
    const w = l.lie.within;
    for (let u = Math.max(0, above(us, lo - w) - 1); u < us.length && us[u] <= hi + w; u++) {
      const x = us[u];
      if (x > lo + w && x < hi - w) acrossIt[idx(u, v)] += l.cross;
      else if (x >= lo - w && x <= hi + w) acrossIt[idx(u, v)] += l.lie.once;
    }
  };
  for (const l of soft.lines) {
    for (let k = 0; k + 1 < l.pts.length; k++) {
      const p = l.pts[k], q = l.pts[k + 1];
      if (Math.abs(p.y - q.y) < AXIS_EPS) {
        segment(l, p.y, Math.min(p.x, q.x), Math.max(p.x, q.x), across, down, xs, ys, (u, v) => u * ny + v);
      } else if (Math.abs(p.x - q.x) < AXIS_EPS) {
        segment(l, p.x, Math.min(p.y, q.y), Math.max(p.y, q.y), down, across, ys, xs, (u, v) => v * ny + u);
      }
    }
  }
  const r = soft.dots.reach;
  for (const d of soft.dots.at) {
    for (let j = Math.max(0, below(ys, d.y - r) + 1); j < ny && ys[j] < d.y + r; j++) {
      for (let i = Math.max(0, above(xs, d.x - r) - 1); i + 1 < nx && xs[i] < d.x + r; i++) {
        if (xs[i + 1] > d.x - r) across[i * ny + j] += soft.dots.cost;
      }
    }
    for (let i = Math.max(0, below(xs, d.x - r) + 1); i < nx && xs[i] < d.x + r; i++) {
      for (let j = Math.max(0, above(ys, d.y - r) - 1); j + 1 < ny && ys[j] < d.y + r; j++) {
        if (ys[j + 1] > d.y - r) down[i * ny + j] += soft.dots.cost;
      }
    }
  }
  return { across, down };
}
