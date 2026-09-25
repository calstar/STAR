import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { End, Pt } from './route';
import { sameBoxes } from './lineRoute';
import { boundsOf } from './routeGrid';
import { separate } from './tracks';
import type { Sheet, TrackLine } from './tracks';

/**
 * Where every line on the page is drawn, worked out from where each routed
 * itself.
 *
 * Each line routes itself inside its own render, from its own two ends, and
 * publishes that route here after the render commits -- its *base* route.
 * Two things need all of them together: lines that coincide are drawn apart
 * (`tracks.ts`, a pass over every base route on the page), and a vertical
 * hops the horizontals it crosses, so it needs to know where they are drawn.
 * So a line reads back from here how it is to be drawn and the drawn routes
 * near it, and draws that.
 *
 * **It never loops.** The pass reads base routes only, and a line's base
 * route depends on nothing here, so drawing a moved line again publishes the
 * same base route and changes nothing.
 *
 * **A line is woken only by what is near it.** Every change used to bump one
 * version every mounted line subscribed to, so a drag tick that moved three
 * lines re-rendered all of them, each rebuilding its list of every other
 * line. Now, after a change, a line is looked at only if it changed or its
 * box meets the box of a line that did -- before or after -- which is the
 * only way its hops or its own drawing can change; and it is woken only if
 * what it reads now differs from what it drew. A line that has just drawn
 * itself where it routed, with the same neighbours, is not woken to do it
 * again.
 *
 * The pass runs when something asks, at most once per change, and the lines
 * are told in a microtask after the commit that published -- before the
 * browser paints -- so a burst of lines publishing in one commit costs one
 * pass.
 *
 * **A symbol moving is a change too.** A moved segment keeps out of the
 * page's symbols, and a symbol can move -- or be dropped, or taken away --
 * without any line's own route changing: an instrument with no lines, put
 * down on a crossbar that was moved a grid step over. The pass used to read
 * the symbols only when some line published, so the moved line stayed drawn
 * through it until a line anywhere else on the page happened to move, and
 * then jumped for no reason anyone could see. So the store listens to the
 * sheet the lines lend it (`LineInfo.watchSheet`), and a sheet with other
 * symbols on it than the pass last kept out of is a reason for a pass.
 */

/** What a line says about itself besides its route: what the pass needs to move it. */
export interface LineInfo {
  /** Its two ends as the router had them (a tee's carrying `J_END`). */
  a: End;
  b: End;
  /** Does it route itself -- no corners of its own, and not a pipe's? Only such a line is ever moved. */
  free: boolean;
  /** The page's symbols, which a moved segment keeps out of: asked for when the pass runs. */
  sheet?: () => Sheet | undefined;
  /** Be told when the page's symbols may have changed. Returns the way to stop. */
  watchSheet?: (l: () => void) => () => void;
}

/** What a line reads: the route it published, how it is to be drawn, and how the lines near it are. */
export interface LineView {
  base: Pt[];
  pts: Pt[];
  /** The drawn routes of the lines whose boxes meet this one's, in id order: all it can cross. */
  near: Pt[][];
}

interface Entry { base: Pt[]; info?: LineInfo }

const entries = new Map<string, Entry>();
let drawn = new Map<string, Pt[]>();
const views = new Map<string, LineView>();
/** Lines published or taken away since the last pass. */
const touched = new Set<string>();
let stale = false;
let passCount = 0;

/** Do two routes go through the same points? */
export const sameRoute = (a: Pt[] | undefined, b: Pt[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y));

const sameEnd = (a: End, b: End) => a.x === b.x && a.y === b.y && a.side === b.side
  && a.stub === b.stub && a.clear === b.clear && a.inset === b.inset;

const sameInfo = (a: LineInfo | undefined, b: LineInfo | undefined) =>
  a === b || (!!a && !!b && a.free === b.free && a.sheet === b.sheet && a.watchSheet === b.watchSheet
    && sameEnd(a.a, b.a) && sameEnd(a.b, b.b));

// ── Who is near whom ────────────────────────────────────────────────────────

type Rect = [number, number, number, number];
const CELL = 200;

function rectOf(pts: Pt[]): Rect {
  const { x0, y0, x1, y1 } = boundsOf(pts);
  return [x0, y0, x1, y1];
}

const meet = (r: Rect, s: Rect) => r[0] <= s[2] && s[0] <= r[2] && r[1] <= s[3] && s[1] <= r[3];

/** The drawn lines' boxes, filed by where they are. */
const rects = new Map<string, Rect>();
const cells = new Map<string, Set<string>>();

function eachCell(r: Rect, f: (k: string) => void) {
  for (let cx = Math.floor(r[0] / CELL); cx <= Math.floor(r[2] / CELL); cx++) {
    for (let cy = Math.floor(r[1] / CELL); cy <= Math.floor(r[3] / CELL); cy++) f(`${cx},${cy}`);
  }
}

function file(id: string, r: Rect | null) {
  const old = rects.get(id);
  if (old) eachCell(old, k => { const s = cells.get(k); s?.delete(id); if (s && !s.size) cells.delete(k); });
  if (!r) { rects.delete(id); return; }
  rects.set(id, r);
  eachCell(r, k => { const s = cells.get(k); if (s) s.add(id); else cells.set(k, new Set([id])); });
}

function linesMeeting(r: Rect): Set<string> {
  const out = new Set<string>();
  eachCell(r, k => { for (const id of cells.get(k) ?? []) if (!out.has(id) && meet(r, rects.get(id)!)) out.add(id); });
  return out;
}

// ── The pass, and who hears of it ───────────────────────────────────────────

const lineListeners = new Map<string, Set<() => void>>();
const routeListeners = new Map<string, Set<() => void>>();
/** Told at the next microtask: lines whose view changed from what they drew, and routes that moved. */
const wakeLines = new Set<string>();
const wakeRoutes = new Set<string>();
let scheduled = false;

function listen(on: Map<string, Set<() => void>>, id: string, l: () => void) {
  const set = on.get(id);
  if (set) set.add(l); else on.set(id, new Set([l]));
  return () => {
    const s = on.get(id);
    s?.delete(l);
    if (s && !s.size) on.delete(id);
  };
}

function changed() {
  stale = true;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    refresh();
    const lines = [...wakeLines], routes = [...wakeRoutes];
    wakeLines.clear();
    wakeRoutes.clear();
    for (const id of lines) for (const l of [...(lineListeners.get(id) ?? [])]) l();
    for (const id of routes) for (const l of [...(routeListeners.get(id) ?? [])]) l();
  });
}

/** No neighbours: one array, so views with none compare equal. */
export const NO_LINES: Pt[][] = [];

function viewOf(id: string): LineView {
  const pts = drawn.get(id)!;
  const others = [...linesMeeting(rects.get(id)!)].filter(o => o !== id).sort();
  const near = others.length ? others.map(o => drawn.get(o)!) : NO_LINES;
  return { base: entries.get(id)!.base, pts, near };
}

const sameNear = (a: Pt[][], b: Pt[][]) => a === b || (a.length === b.length && a.every((p, i) => p === b[i]));

// ── The page's symbols ──────────────────────────────────────────────────────

/**
 * Every line as published, in id order, as the pass takes it; and the line
 * whose sheet the pass reads -- the first that may move and lends one, which
 * is as good as any, since every line on a page lends the same sheet.
 */
function published(): { lines: TrackLine[]; from: LineInfo | undefined } {
  const lines: TrackLine[] = [];
  let from: LineInfo | undefined;
  for (const [id, e] of [...entries].sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) {
    lines.push({ id, pts: e.base, a: e.info?.a, b: e.info?.b, free: e.info?.free });
    if (!from && e.info?.free && e.info.sheet) from = e.info;
  }
  return { lines, from };
}

/** Where the last pass read the symbols from, and what it read. */
let sheetFrom: LineInfo | undefined;
let sheetUsed: Sheet | undefined;
/** What the store is listening to for the symbols moving, and the way to stop. */
let listening: { watch: NonNullable<LineInfo['watchSheet']>; off: () => void } | null = null;

function listenTo(info: LineInfo | undefined) {
  const watch = info?.watchSheet;
  if (listening?.watch === watch) return;
  listening?.off();
  listening = watch ? { watch, off: watch(sheetMoved) } : null;
}

/**
 * The page's symbols may have changed. A pass if they have: the sheet the
 * lines lend is filed afresh for every change to the canvas's nodes -- a
 * selection, a drag tick -- so it is told apart from the one the pass read
 * by the symbols on it where it can say what they are, and otherwise by
 * what object it is.
 */
function sheetMoved() {
  const now = sheetFrom?.sheet?.();
  if (now === sheetUsed || (now?.boxes && sheetUsed?.boxes && sameBoxes(now.boxes, sheetUsed.boxes))) {
    sheetUsed = now;
    return;
  }
  changed();
}

/**
 * Brings the drawing up to date with what was published: the pass over every
 * line, then a fresh view for each line that changed or is near one that
 * did, and a note of whom to tell.
 */
function refresh() {
  if (!stale) return;
  stale = false;
  passCount++;
  const { lines, from } = published();
  sheetFrom = from;
  sheetUsed = from?.sheet?.();
  listenTo(from);
  const next = separate(lines, sheetUsed);
  // A line drawn as it was keeps the very array it was drawn with, which is
  // what lets a neighbour's view compare equal.
  const moved = new Set(touched);
  touched.clear();
  for (const [id, pts] of next) {
    const was = drawn.get(id);
    if (was && sameRoute(was, pts)) next.set(id, was); else moved.add(id);
  }
  for (const id of drawn.keys()) if (!next.has(id)) moved.add(id);
  // Everything a moved line was near, or is near now.
  const around: Rect[] = [];
  for (const id of moved) {
    const was = rects.get(id);
    if (was) around.push(was);
    const pts = next.get(id);
    const r = pts && pts.length ? rectOf(pts) : null;
    if (r) around.push(r);
    file(id, r);
  }
  const prev = drawn;
  drawn = next;
  const look = new Set<string>();
  for (const id of moved) look.add(id);
  for (const r of around) for (const id of linesMeeting(r)) look.add(id);
  for (const id of look) {
    if (!entries.has(id) || !drawn.has(id) || !rects.has(id)) {
      views.delete(id);
      continue;
    }
    const was = views.get(id);
    const now = viewOf(id);
    if (was && was.base === now.base && was.pts === now.pts && sameNear(was.near, now.near)) continue;
    views.set(id, now);
    // What the line drew when it last rendered: the view it read, if that
    // was for the route it routed; otherwise its own route, beside the
    // neighbours it had. Told only if what it should draw is different.
    const drewPts = was && sameRoute(was.base, now.base) ? was.pts : now.base;
    const drewNear = was?.near ?? NO_LINES;
    if (!sameRoute(drewPts, now.pts) || !sameNear(drewNear, now.near)) wakeLines.add(id);
  }
  for (const id of moved) if (prev.get(id) !== drawn.get(id)) wakeRoutes.add(id);
}

// ── What lines and others call ──────────────────────────────────────────────

/**
 * A line's route as it routed itself, after it rendered. Without `info` the
 * line is drawn exactly as published, and others move off it.
 */
export function publishEdge(id: string, pts: Pt[], info?: LineInfo): void {
  const e = entries.get(id);
  const same = !!e && sameRoute(e.base, pts);
  if (same && sameInfo(e!.info, info)) return;
  entries.set(id, { base: same ? e!.base : pts, info });
  touched.add(id);
  changed();
}

export function unpublishEdge(id: string): void {
  if (!entries.delete(id)) return;
  touched.add(id);
  changed();
}

/** What line `id` is to draw, as of now: its view, or null before it has published. */
export function lineView(id: string): LineView | null {
  refresh();
  return views.get(id) ?? null;
}

/** Be told when line `id`'s view changes from what it drew. Returns the way to stop. */
export const watchLine = (id: string, l: () => void) => listen(lineListeners, id, l);

/** Be told when line `id` is drawn somewhere new. Returns the way to stop. */
export const watchRoute = (id: string, l: () => void) => listen(routeListeners, id, l);

/**
 * What line `id` is to draw: its view, or null before it has published. A
 * line whose route has changed since the view was worked out draws its own
 * route until the pass catches up, which it does before the next paint.
 */
export function useLineView(id: string): LineView | null {
  const subscribe = useCallback((l: () => void) => watchLine(id, l), [id]);
  const get = useCallback(() => lineView(id), [id]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * The drawn routes of just these lines, as one map that keeps its identity
 * until one of them moves: for whatever lands on a line (a probe's leader).
 */
export function useDrawnRoutes(ids: readonly string[]): ReadonlyMap<string, Pt[]> {
  // The ids by value, so a new array naming the same lines subscribes to nothing new.
  const key = JSON.stringify(ids);
  const last = useRef<{ key: string; map: Map<string, Pt[]> } | null>(null);
  const subscribe = useCallback((l: () => void) => {
    const offs = (JSON.parse(key) as string[]).map(id => watchRoute(id, l));
    return () => offs.forEach(off => off());
  }, [key]);
  const get = useCallback(() => {
    refresh();
    const map = new Map<string, Pt[]>();
    for (const id of JSON.parse(key) as string[]) { const pts = drawn.get(id); if (pts) map.set(id, pts); }
    const was = last.current;
    if (was && was.key === key && was.map.size === map.size && [...map].every(([id, pts]) => was.map.get(id) === pts)) return was.map;
    last.current = { key, map };
    return map;
  }, [key]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * The lines on the page as each published itself, in id order: what a
 * caller needs to work out how the page would be drawn with some of them
 * changed -- a preview, with `tracks.drawnAfter` -- without the canvas
 * drawing it.
 */
export const publishedLines = (): TrackLine[] => published().lines;

/** How many times the pass has run: for tests, and for measuring what a change costs. */
export const passes = () => passCount;

/** Every line as it is drawn -- moved off its neighbours, without its hops -- for callers that want the table. */
export function drawnCorners(): Map<string, Pt[]> {
  refresh();
  return new Map(drawn);
}
