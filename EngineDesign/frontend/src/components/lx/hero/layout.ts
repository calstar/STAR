import { axisOf, domeLoaders, INLINE, isLiquidLine, type DLine, type DSymbol, type Drawing } from './drawing';

/**
 * Where the schematic draws each thing, in screen px: the drawing's own positions fitted to the
 * panel (one scale on both axes, nothing flipped), symbols at a fixed size, lines routed
 * orthogonally between them, labels and instrument tags put where they cover nothing.
 *
 * Pure, so the tests can check that a line keeps out of symbols and off another line, and that
 * labels do not collide.
 */

export interface Pt { x: number; y: number }
export interface Box { x0: number; y0: number; x1: number; y1: number }
export type Dir = 'up' | 'down' | 'left' | 'right';

export interface PlacedSymbol {
  s: DSymbol;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** The direction lines pass through it (valves, regulators, the engine). */
  axis: 'h' | 'v';
}

export interface PlacedLine {
  line: DLine;
  pts: Pt[];
  /** A tank's liquid side (to a main valve or a fill), or gas. */
  liquid: boolean;
}

export interface PlacedTag {
  s: DSymbol;
  host: string;
  cx: number;
  cy: number;
  r: number;
}

export interface PlacedLabel {
  id: string;
  /** The text anchor point: x and the first baseline's top. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  box: Box;
}

export interface SchematicLayout {
  width: number;
  height: number;
  scale: number;
  symbols: Map<string, PlacedSymbol>;
  lines: PlacedLine[];
  labels: Map<string, PlacedLabel>;
  tags: PlacedTag[];
}

export const TAG_R = 9;
const STUB = 12;
/** An instrument drawn this close to its host (drawing units) keeps the author's spot. */
const TAG_KEEP = 110;

/** A symbol's drawn size [px]. Tanks are as tall as their volume against the largest tank. */
export function sizeOf(s: DSymbol, maxTankL: number): { w: number; h: number } {
  switch (s.kind) {
    case 'bottle': return { w: 16, h: 38 };
    case 'dewar': return { w: 30, h: 40 };
    case 'tank': {
      const v = s.params.volume?.value;
      const f = v && maxTankL > 0 ? Math.min(1, v / maxTankL) : 1;
      return { w: 26, h: Math.round(36 + 36 * f) };
    }
    // Valves and regulators carry their actuator above the line: the box is symmetric about the
    // line, so it is tall enough for the actuator on both sides.
    case 'regulator': return { w: 22, h: 26 };
    case 'solenoid': case 'valve': case 'relief': return { w: 18, h: 26 };
    case 'check': case 'qd': return { w: 16, h: 14 };
    case 'manifold': return { w: 8, h: 8 };
    case 'junction': return { w: 6, h: 6 };
    case 'vent': return { w: 12, h: 12 };
    case 'engine': return { w: 32, h: 22 };
    case 'instrument': return { w: TAG_R * 2, h: TAG_R * 2 };
  }
}

export const boxOf = (p: { cx: number; cy: number; w: number; h: number }, pad = 0): Box =>
  ({ x0: p.cx - p.w / 2 - pad, y0: p.cy - p.h / 2 - pad, x1: p.cx + p.w / 2 + pad, y1: p.cy + p.h / 2 + pad });

export const boxesMeet = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Does the axis-aligned (or any) segment p-q pass through the box's interior? */
export function segmentHitsBox(p: Pt, q: Pt, b: Box): boolean {
  // Liang-Barsky clip of the segment against the box.
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const edges: [number, number][] = [[-dx, p.x - b.x0], [dx, b.x1 - p.x], [-dy, p.y - b.y0], [dy, b.y1 - p.y]];
  for (const [pp, qq] of edges) {
    if (pp === 0) {
      if (qq <= 0) return false;
    } else {
      const r = qq / pp;
      if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
  }
  return t1 - t0 > 1e-6;
}

/** Collinear overlap [px] of two axis-aligned segments lying within `tol` of each other. */
export function overlapLength(a: Pt, b: Pt, c: Pt, d: Pt, tol = 3): number {
  const h1 = Math.abs(a.y - b.y) < 0.5;
  const h2 = Math.abs(c.y - d.y) < 0.5;
  const v1 = Math.abs(a.x - b.x) < 0.5;
  const v2 = Math.abs(c.x - d.x) < 0.5;
  if (h1 && h2 && Math.abs(a.y - c.y) < tol) {
    return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
  }
  if (v1 && v2 && Math.abs(a.x - c.x) < tol) {
    return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
  }
  return 0;
}

/**
 * Drop repeated points and corners that are not corners (a point in the middle of a straight run).
 * A point where the route turns straight back is kept: that is a fault the cost must see.
 */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  const between = (a: number, b: number, c: number) => (b - a) * (c - b) >= 0;
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const vertical = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01 && between(a.y, b.y, c.y);
      const horizontal = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01 && between(a.x, b.x, c.x);
      if (!vertical && !horizontal) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

const step = (p: Pt, d: Dir, n: number): Pt =>
  d === 'up' ? { x: p.x, y: p.y - n } : d === 'down' ? { x: p.x, y: p.y + n } : d === 'left' ? { x: p.x - n, y: p.y } : { x: p.x + n, y: p.y };

/** One end of a line: where it meets its symbol, and how it must leave. */
export interface End {
  at: Pt;
  /** Leaves the symbol's boundary this way first (a tank's top or bottom port, the engine's face). */
  stub?: Dir;
  /** The symbol's through-axis: a route should arrive along it (a valve is not entered from its side). */
  axis?: 'h' | 'v';
  /** The symbol this end belongs to; a route may cross its box only when there is no stub. */
  box: Box;
}

interface Routed { pts: Pt[] }

/** Cost of a candidate route against what is already drawn. Lower is better. */
export function routeCost(pts: Pt[], a: End, b: End, drawn: readonly Routed[], obstacles: readonly Box[]): number {
  let cost = 0;
  let bends = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    cost += (Math.abs(q.x - p.x) + Math.abs(q.y - p.y)) / 100;
    if (i > 0) {
      const o = pts[i - 1];
      const before = Math.abs(o.x - p.x) < 0.01 ? 'v' : 'h';
      const now = Math.abs(p.x - q.x) < 0.01 ? 'v' : 'h';
      if (before !== now) bends++;
      // Doubling straight back on itself.
      if (before === now && ((q.x - p.x) * (p.x - o.x) < 0 || (q.y - p.y) * (p.y - o.y) < 0)) cost += 40;
    }
    for (const box of obstacles) if (segmentHitsBox(p, q, box)) cost += 60;
    // An end with a stub may not be crossed by the rest of its own route.
    if (a.stub && i > 0 && segmentHitsBox(p, q, a.box)) cost += 60;
    if (b.stub && i + 2 < pts.length && segmentHitsBox(p, q, b.box)) cost += 60;
    // Two lines along each other read as one: the worst fault a route can have.
    for (const r of drawn) {
      for (let k = 0; k + 1 < r.pts.length; k++) cost += overlapLength(p, q, r.pts[k], r.pts[k + 1], 7);
    }
  }
  cost += bends;
  // Arriving at a valve or regulator across its axis.
  const along = (p: Pt, q: Pt) => (Math.abs(p.x - q.x) < 0.01 ? 'v' : 'h');
  if (a.axis && pts.length > 1 && along(pts[0], pts[1]) !== a.axis) cost += 4;
  if (b.axis && pts.length > 1 && along(pts[pts.length - 2], pts[pts.length - 1]) !== b.axis) cost += 4;
  return cost;
}

/** Orthogonal candidates between two ends (straight, L, Z at three splits). */
export function candidates(a: End, b: End): Pt[][] {
  const a0 = a.stub ? step(a.at, a.stub, STUB) : a.at;
  const b0 = b.stub ? step(b.at, b.stub, STUB) : b.at;
  const head = a.stub ? [a.at, a0] : [a0];
  const tail = b.stub ? [b0, b.at] : [b0];
  const out: Pt[][] = [];
  // Two nearly aligned centres: one straight run at the start's level (the symbol at the far end
  // covers the pixel it misses by).
  if (!a.stub && !b.stub && Math.abs(a0.y - b0.y) < 1.5) out.push([a0, { x: b0.x, y: a0.y }]);
  if (!a.stub && !b.stub && Math.abs(a0.x - b0.x) < 1.5) out.push([a0, { x: a0.x, y: b0.y }]);
  const mids: Pt[][] = [[{ x: b0.x, y: a0.y }], [{ x: a0.x, y: b0.y }]];
  for (const f of [0.5, 0.3, 0.7]) {
    const mx = Math.round(a0.x + (b0.x - a0.x) * f);
    const my = Math.round(a0.y + (b0.y - a0.y) * f);
    mids.push([{ x: mx, y: a0.y }, { x: mx, y: b0.y }], [{ x: a0.x, y: my }, { x: b0.x, y: my }]);
  }
  for (const m of mids) out.push(simplify([...head, ...m, ...tail]));
  return out;
}

/** The best candidate route for one line, given those already drawn. */
export function route(a: End, b: End, drawn: readonly Routed[], obstacles: readonly Box[]): Pt[] {
  let best: Pt[] | null = null;
  let bestCost = Infinity;
  for (const c of candidates(a, b)) {
    const cost = routeCost(c, a, b, drawn, obstacles);
    if (cost < bestCost - 1e-9) { best = c; bestCost = cost; }
  }
  return best ?? [a.at, b.at];
}

// ------------------------------------------------------------------ the whole layout

export interface LayoutOptions {
  width: number;
  maxHeight: number;
  minHeight?: number;
  /** A label's size [px] (one or two rows), or null for none. */
  labelSize?: (s: DSymbol) => { w: number; h: number } | null;
}

const PAD_X = 56;
const PAD_TOP = 36;
const PAD_BOTTOM = 44;

/** The drawing's extent over its symbols (instruments are placed by their hosts). */
function extent(d: Drawing) {
  const body = d.symbols.filter((s) => s.kind !== 'instrument');
  const xs = body.map((s) => s.x);
  const ys = body.map((s) => s.y);
  const bx0 = xs.length ? Math.min(...xs) : 0;
  const by0 = ys.length ? Math.min(...ys) : 0;
  return { bx0, by0, bw: Math.max((xs.length ? Math.max(...xs) : 1) - bx0, 1), bh: Math.max((ys.length ? Math.max(...ys) : 1) - by0, 1) };
}

/** px per drawing unit when `d` is fitted to `width` x `maxHeight` (one scale both ways). */
export function fitScale(d: Drawing, width: number, maxHeight: number): number {
  const { bw, bh } = extent(d);
  const W = Math.max(width, 2 * PAD_X + 40);
  return Math.max(0.05, Math.min((W - 2 * PAD_X) / bw, (maxHeight - PAD_TOP - PAD_BOTTOM) / bh));
}

export function layoutSchematic(d: Drawing, opts: LayoutOptions): SchematicLayout {
  const domes = domeLoaders(d);
  const domeLines = new Set(d.lines.filter((l) => domes.get(l.from) === l.to).map((l) => l.id));
  const body = d.symbols.filter((s) => s.kind !== 'instrument');
  const maxTankL = Math.max(0, ...body.filter((s) => s.kind === 'tank').map((s) => s.params.volume?.value ?? 0));

  // ---- fit
  const { bx0, by0, bw, bh } = extent(d);
  const W = Math.max(opts.width, 2 * PAD_X + 40);
  const scale = fitScale(d, opts.width, opts.maxHeight);
  const H = Math.max(opts.minHeight ?? 0, Math.round(bh * scale + PAD_TOP + PAD_BOTTOM));
  const ox = (W - bw * scale) / 2 - bx0 * scale;
  const oy = PAD_TOP + (H - PAD_TOP - PAD_BOTTOM - bh * scale) / 2 - by0 * scale;
  const toScreen = (x: number, y: number): Pt => ({ x: Math.round(ox + x * scale), y: Math.round(oy + y * scale) });

  // ---- symbols
  const symbols = new Map<string, PlacedSymbol>();
  for (const s of body) {
    const p = toScreen(s.x, s.y);
    const size = sizeOf(s, maxTankL);
    const axis = s.kind === 'engine' ? 'h' : INLINE.has(s.kind) ? axisOf(d, s, domeLines) : 'h';
    const vertical = axis === 'v' && INLINE.has(s.kind);
    symbols.set(s.id, { s, cx: p.x, cy: p.y, w: vertical ? size.h : size.w, h: vertical ? size.w : size.h, axis });
  }

  // ---- ends. A tank takes gas in its upper half and liquid in its lower: through its top (or
  //      bottom) when the far end is above (or below) it, otherwise through its side, level with the
  //      far end where that is in the right half, so a line to a valve beside it runs straight. The
  //      engine takes its feeds on its injector face. Lines sharing a port are spread along it.
  const ends = new Map<string, [End, End]>();
  type Side = 'top' | 'bottom' | 'left' | 'right' | 'face';
  const portSlots = new Map<string, { line: DLine; other: PlacedSymbol; side: Side; want: number; lo: number; hi: number }[]>();
  for (const l of d.lines) {
    for (const [selfId, otherId] of [[l.from, l.to], [l.to, l.from]] as const) {
      const self = symbols.get(selfId);
      const other = symbols.get(otherId);
      if (!self || !other) continue;
      const box = boxOf(self);
      let side: Side | null = null;
      let want = 0;
      let lo = 0;
      let hi = 0;
      if (self.s.kind === 'tank' || self.s.kind === 'dewar') {
        const liquid = isLiquidLine(d, self.s, l);
        const beside = other.cx >= self.cx ? 'right' : 'left';
        if (liquid) {
          side = other.cy >= box.y1 ? 'bottom' : beside;
          [lo, hi] = [self.cy + 4, box.y1 - 7];
        } else {
          side = other.cy <= box.y0 ? 'top' : beside;
          [lo, hi] = [box.y0 + 7, self.cy + 2];
        }
        want = side === 'top' || side === 'bottom' ? other.cx : Math.min(hi, Math.max(lo, other.cy));
      } else if (self.s.kind === 'engine') {
        side = 'face';
        want = other.cy;
        [lo, hi] = [box.y0 + 4, box.y1 - 4];
      }
      if (!side) continue;
      const key = `${selfId}:${side}`;
      const list = portSlots.get(key) ?? [];
      list.push({ line: l, other, side, want, lo, hi });
      portSlots.set(key, list);
    }
  }
  const portAt = new Map<string, End>(); // `${lineId}:${symbolId}`
  const GAP = 8;
  for (const [key, list] of portSlots) {
    const self = symbols.get(key.split(':')[0]) as PlacedSymbol;
    const box = boxOf(self);
    const side = list[0].side;
    list.sort((p, q) => p.want - q.want || p.other.cy - q.other.cy);
    const n = list.length;
    let at: number[];
    if (side === 'top' || side === 'bottom') {
      // Across the head, in the order of the far ends, centred.
      const span = Math.min(self.w - 8, 10 * (n - 1));
      at = list.map((_, k) => self.cx + (n > 1 ? -span / 2 + (span * k) / (n - 1) : 0));
    } else if (side === 'face') {
      const span = Math.min(self.h - 8, 10 * (n - 1));
      at = list.map((_, k) => self.cy + (n > 1 ? -span / 2 + (span * k) / (n - 1) : 0));
    } else {
      // Down the side: each where it wants to be, then pushed apart, kept inside its half.
      at = list.map((it) => it.want);
      for (let k = 1; k < n; k++) at[k] = Math.max(at[k], at[k - 1] + GAP);
      for (let k = n - 1; k >= 0; k--) {
        at[k] = Math.min(at[k], list[k].hi, k + 1 < n ? at[k + 1] - GAP : Infinity);
        at[k] = Math.max(at[k], list[k].lo - GAP * 2);
      }
    }
    list.forEach((it, k) => {
      const v = Math.round(at[k] * 2) / 2;
      const end: End = side === 'top' ? { at: { x: v, y: box.y0 }, stub: 'up', box }
        : side === 'bottom' ? { at: { x: v, y: box.y1 }, stub: 'down', box }
        : side === 'left' ? { at: { x: box.x0, y: v }, stub: 'left', box }
        : side === 'right' ? { at: { x: box.x1, y: v }, stub: 'right', box }
        : { at: { x: box.x0, y: v }, stub: 'left', box };
      portAt.set(`${it.line.id}:${self.s.id}`, end);
    });
  }
  const endOf = (l: DLine, id: string): End | null => {
    const hit = portAt.get(`${l.id}:${id}`);
    if (hit) return hit;
    const p = symbols.get(id);
    if (!p) return null;
    return { at: { x: p.cx, y: p.cy }, axis: INLINE.has(p.s.kind) && !domeLines.has(l.id) ? p.axis : undefined, box: boxOf(p) };
  };
  for (const l of d.lines) {
    const a = endOf(l, l.from);
    const b = endOf(l, l.to);
    if (a && b) ends.set(l.id, [a, b]);
  }

  // ---- route: lines whose ends line up first (they keep their straight run), then the rest in
  //      drawing order. Every symbol other than a line's own two is an obstacle.
  const order = d.lines.filter((l) => ends.has(l.id)).map((l, i) => {
    const [a, b] = ends.get(l.id) as [End, End];
    const aligned = !a.stub && !b.stub && (Math.abs(a.at.x - b.at.x) < 1.5 || Math.abs(a.at.y - b.at.y) < 1.5);
    return { l, i, aligned };
  }).sort((p, q) => Number(q.aligned) - Number(p.aligned) || p.i - q.i);
  const drawn: Routed[] = [];
  const lines: PlacedLine[] = [];
  for (const { l } of order) {
    const [a, b] = ends.get(l.id) as [End, End];
    const obstacles = [...symbols.values()].filter((p) => p.s.id !== l.from && p.s.id !== l.to).map((p) => boxOf(p, 1));
    const pts = route(a, b, drawn, obstacles);
    drawn.push({ pts });
    const tank = [l.from, l.to].map((id) => symbols.get(id)?.s).find((s) => s?.kind === 'tank' || s?.kind === 'dewar');
    lines.push({ line: l, pts, liquid: tank ? isLiquidLine(d, tank, l) : false });
  }
  // Back to drawing order, so the SVG is stable.
  const rank = new Map(d.lines.map((l, i) => [l.id, i]));
  lines.sort((p, q) => (rank.get(p.line.id) ?? 0) - (rank.get(q.line.id) ?? 0));

  // ---- labels
  const segs: [Pt, Pt][] = lines.flatMap((pl) => pl.pts.slice(1).map((q, k) => [pl.pts[k], q] as [Pt, Pt]));
  const symBoxes = [...symbols.values()].map((p) => ({ id: p.s.id, box: boxOf(p, 2) }));
  const labels = new Map<string, PlacedLabel>();
  const taken: Box[] = [];
  const inside = (b: Box) => b.x0 >= 2 && b.y0 >= 2 && b.x1 <= W - 2 && b.y1 <= H - 2;
  const clash = (b: Box, self: string) => {
    let c = 0;
    for (const [p, q] of segs) if (segmentHitsBox(p, q, b)) c += 10;
    for (const s of symBoxes) if (s.id !== self && boxesMeet(s.box, b)) c += 20;
    for (const t of taken) if (boxesMeet(t, b)) c += 25;
    if (!inside(b)) c += 60;
    return c;
  };
  const labelled = body.filter((s) => opts.labelSize?.(s));
  const midY = (by0 + bh / 2) * scale + oy;
  // Valves and regulators first: their names belong on one side of the line and nowhere else, where
  // a vessel's name has several good spots. Then the big symbols, which have the fewest.
  const rankOf = (s: DSymbol) => (INLINE.has(s.kind) ? 0 : 1);
  labelled.sort((p, q) => rankOf(p) - rankOf(q) || (symbols.get(q.id)?.h ?? 0) - (symbols.get(p.id)?.h ?? 0));
  for (const s of labelled) {
    const size = opts.labelSize?.(s);
    const p = symbols.get(s.id);
    if (!size || !p) continue;
    const bb = boxOf(p);
    const g = 5;
    const spot = (name: SpotName): PlacedLabel => labelSpot(s.id, name, p, bb, size, g);
    const spots = spotOrder(p, midY).map(spot);
    let best = spots[0];
    let bestCost = Infinity;
    spots.forEach((sp, k) => {
      const c = clash(sp.box, s.id) + k * 0.5;
      if (c < bestCost) { best = sp; bestCost = c; }
    });
    labels.set(s.id, best);
    taken.push(best.box);
  }

  // ---- instrument tags, beside their hosts, clear of everything else
  const tags: PlacedTag[] = [];
  const tagBoxes: Box[] = [];
  for (const s of d.symbols) {
    if (s.kind !== 'instrument' || !s.attachedTo) continue;
    const host = symbols.get(s.attachedTo);
    if (!host) continue;
    const own = toScreen(s.x, s.y);
    const near = Math.hypot(s.x - host.s.x, s.y - host.s.y) <= TAG_KEEP;
    // Just clear of the host's box in each direction.
    const reachOf = (dx: number, dy: number) => (Math.abs(dx) * host.w + Math.abs(dy) * host.h) / 2 + TAG_R + 7;
    const downstream = s.options.side === 'downstream';
    const dirs: [number, number][] = downstream
      ? [[1, -1], [1, 1], [0, -1], [0, 1], [1, 0], [-1, -1], [-1, 1], [-1, 0]]
      : [[0, -1], [1, -1], [-1, -1], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]];
    const spots: Pt[] = [
      ...(near ? [own] : []),
      ...dirs.map(([dx, dy]) => {
        const n = Math.hypot(dx, dy);
        const reach = reachOf(dx / n, dy / n);
        return { x: Math.round(host.cx + (dx / n) * reach), y: Math.round(host.cy + (dy / n) * reach) };
      }),
    ];
    let best = spots[0];
    let bestCost = Infinity;
    spots.forEach((sp, k) => {
      const b = { x0: sp.x - TAG_R - 2, y0: sp.y - TAG_R - 2, x1: sp.x + TAG_R + 2, y1: sp.y + TAG_R + 2 };
      let c = k * 0.3 + clash(b, '');
      for (const t of tagBoxes) if (boxesMeet(t, b)) c += 25;
      if (c < bestCost) { best = sp; bestCost = c; }
    });
    tags.push({ s, host: host.s.id, cx: best.x, cy: best.y, r: TAG_R });
    tagBoxes.push({ x0: best.x - TAG_R - 2, y0: best.y - TAG_R - 2, x1: best.x + TAG_R + 2, y1: best.y + TAG_R + 2 });
  }

  return { width: W, height: H, scale, symbols, lines, labels, tags };
}

type SpotName = 'below' | 'above' | 'right' | 'rightTop' | 'rightBottom' | 'left' | 'leftTop' | 'leftBottom';

/** Where a label may go around a symbol, best first: a vessel's name reads to its right, a valve's
 * on the side away from the middle of the drawing (so two valves facing each other across a gap do
 * not stack their names in it), a vertical valve's beside it. */
export function spotOrder(p: PlacedSymbol, midY: number): SpotName[] {
  const k = p.s.kind;
  if (k === 'tank' || k === 'dewar' || k === 'bottle') return ['right', 'rightTop', 'rightBottom', 'below', 'above', 'left', 'leftTop', 'leftBottom'];
  if (k === 'engine') return ['below', 'above', 'right', 'left', 'rightBottom', 'rightTop'];
  if (p.axis === 'v') return ['right', 'left', 'above', 'below', 'rightTop', 'rightBottom'];
  const out: SpotName[] = p.cy <= midY ? ['above', 'below'] : ['below', 'above'];
  return [...out, 'right', 'left', 'rightBottom', 'rightTop', 'leftBottom', 'leftTop'];
}

function labelSpot(id: string, name: SpotName, p: PlacedSymbol, bb: Box, size: { w: number; h: number }, g: number): PlacedLabel {
  const right = bb.x1 + g + 2;
  const left = bb.x0 - g - 2;
  const at = (x: number, y: number, anchor: PlacedLabel['anchor']): PlacedLabel => {
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - size.w : x - size.w / 2;
    return { id, x, y, anchor, box: { x0, y0: y, x1: x0 + size.w, y1: y + size.h } };
  };
  switch (name) {
    case 'below': return at(p.cx, bb.y1 + g, 'middle');
    case 'above': return at(p.cx, bb.y0 - g - size.h, 'middle');
    case 'right': return at(right, p.cy - size.h / 2, 'start');
    case 'rightTop': return at(right, bb.y0, 'start');
    case 'rightBottom': return at(right, bb.y1 - size.h, 'start');
    case 'left': return at(left, p.cy - size.h / 2, 'end');
    case 'leftTop': return at(left, bb.y0, 'end');
    case 'leftBottom': return at(left, bb.y1 - size.h, 'end');
  }
}

/** An SVG path through the points. */
export const pathOf = (pts: readonly Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
