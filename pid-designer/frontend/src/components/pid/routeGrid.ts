import type { Node } from '@xyflow/react';
import {
  CORNER, STUB, facing, isHorizontal, pathPoints, pointsToPath, routeOrthogonal, segmentEntersBox, simplifyPoints,
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
function searchNear(a: End, b: End, boxes: Box[], fast: Pt[], tried: Box[] = []): Pt[] | null {
  const budget = freshSearch();
  const xs = fast.map(p => p.x), ys = fast.map(p => p.y);
  const x0 = Math.min(...xs) - REACH, y0 = Math.min(...ys) - REACH;
  const span = [{ x: x0, y: y0, w: Math.max(...xs) + REACH - x0, h: Math.max(...ys) + REACH - y0 }];
  tried.push(...span);
  const first = searchGrid(a, b, boxes.filter(bx => overlap(bx, span[0])), budget, span, true);
  if (first) return first;
  for (let k = 0, reach = REACH; k < WIDENINGS; k++, reach *= 2) {
    const corridor = fast.slice(0, -1).map((p, i) => {
      const q = fast[i + 1];
      const x = Math.min(p.x, q.x) - reach, y = Math.min(p.y, q.y) - reach;
      return { x, y, w: Math.max(p.x, q.x) + reach - x, h: Math.max(p.y, q.y) + reach - y };
    });
    tried.push(...corridor);
    const found = searchGrid(a, b, boxes.filter(bx => corridor.some(c => overlap(bx, c))), budget, corridor);
    if (found) return found;
    if (budget.exact <= 0 && budget.greedy <= 0) break;
  }
  return null;
}

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
  return searchGrid(a, b, boxes, freshSearch());
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
function searchGrid(a: End, b: End, boxes: Box[], budget: Budget, corridor?: Box[], exactOnly = false): Pt[] | null {
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
  const xs = lines([...withChannels(rawX), (a.x + b.x) / 2, ...(corridor ?? []).flatMap(r => [r.x, r.x + r.w])]);
  const ys = lines([...withChannels(rawY), (a.y + b.y) / 2, ...(corridor ?? []).flatMap(r => [r.y, r.y + r.h])]);
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
  const stepCost = (i: number, j: number, i2: number, j2: number): number => {
    const what = i2 !== i ? across[Math.min(i, i2) * ny + j] : down[i * ny + Math.min(j, j2)];
    if (what === BLOCKED) return Infinity;
    const len = i2 !== i ? Math.abs(xs[i2] - xs[i]) : Math.abs(ys[j2] - ys[j]);
    return what === NEAR ? len * (1 + CLOSE) : len;
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
        if (c2 < dist[n2] - 1e-9) { dist[n2] = c2; prev[n2] = s; heap.push(c2 + weight * estimate(i2, j2, nd), c2, n2); }
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
  return simplifyPoints(chain);
}
