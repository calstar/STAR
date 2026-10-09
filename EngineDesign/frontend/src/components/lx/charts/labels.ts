/**
 * Direct labels: each series named at its right end, in its colour, nudged apart when two would
 * overlap. The nudge moves labels as little as possible (least squares) while keeping their
 * order and a gap between them, and keeps them inside the plot.
 */

export interface LabelItem {
  key: string;
  /** Where the label wants its centre [px, down is positive]. */
  y: number;
  /** Label height [px]. */
  h: number;
}

/**
 * Centre y for every label so none overlap: order kept, `gap` between neighbours, inside
 * [top, bottom] when they fit (stacked from the top when they do not). Isotonic regression
 * (pool-adjacent-violators) on the labels' tops after removing the stack offsets, then clamped:
 * clamping an isotonic fit to a common box is still the least-squares answer.
 */
export function placeLabels(items: readonly LabelItem[], top: number, bottom: number, gap = 2): Map<string, number> {
  const out = new Map<string, number>();
  const live = items.filter((it) => Number.isFinite(it.y));
  if (live.length === 0) return out;
  // Stable: equal y keeps the given order.
  const sorted = live.map((it, i) => ({ it, i })).sort((a, b) => a.it.y - b.it.y || a.i - b.i).map((x) => x.it);

  const offset: number[] = [];
  let acc = 0;
  for (const it of sorted) {
    offset.push(acc);
    acc += it.h + gap;
  }
  const total = acc - gap;
  // z_i = top_i - offset_i must be non-decreasing; target c_i = desired top - offset.
  const c = sorted.map((it, i) => it.y - it.h / 2 - offset[i]);

  // Pool adjacent violators.
  const blocks: { sum: number; n: number }[] = [];
  for (const v of c) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.pop();
      a.sum += b.sum;
      a.n += b.n;
    }
  }
  const z: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) z.push(b.sum / b.n);

  // The box, in z: the first top at or below `top`, the last bottom at or above `bottom`.
  const zMin = top;
  const zMax = bottom - total;
  sorted.forEach((it, i) => {
    const zi = zMax < zMin ? zMin : Math.min(Math.max(z[i], zMin), zMax);
    out.set(it.key, zi + offset[i] + it.h / 2);
  });
  return out;
}

// ------------------------------------------------------------------ the worst-point note

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a note must keep off, in the same px frame as the anchor. */
export interface NoteObstacles {
  /** Lines drawn in the plot, each as [x0, y0, x1, y1, ...]. */
  polylines?: readonly (readonly number[])[];
  /** Horizontal lines across the plot (limits) at these y. */
  hlines?: readonly number[];
  /** Vertical lines down the plot (event marks, a cursor at rest) at these x. */
  vlines?: readonly number[];
  /** Other text already placed. */
  boxes?: readonly Box[];
}

export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Does the segment (x0,y0)-(x1,y1) touch the box? Liang-Barsky clip. */
export function segmentHitsBox(x0: number, y0: number, x1: number, y1: number, b: Box): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [[-dx, x0 - b.x], [dx, b.x + b.w - x0], [-dy, y0 - b.y], [dy, b.y + b.h - y0]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

/**
 * How badly a note box collides with the obstacles. A limit line or other text under it is never
 * acceptable while anything else is free (1000 each); a data line crossed costs 40, plus a little
 * for each piece of it inside, so a line clipped at a corner is cheaper than one run along.
 */
export function noteCost(b: Box, obs: NoteObstacles): number {
  let cost = 0;
  for (const y of obs.hlines ?? []) if (y >= b.y - 1 && y <= b.y + b.h + 1) cost += 1000;
  for (const x of obs.vlines ?? []) if (x >= b.x - 1 && x <= b.x + b.w + 1) cost += 50;
  for (const o of obs.boxes ?? []) if (boxesOverlap(b, o, 2)) cost += 1000;
  const grown = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
  for (const p of obs.polylines ?? []) {
    let pieces = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [x0, y0, x1, y1] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      // Cheap reject before the clip.
      if (Math.max(x0, x1) < grown.x || Math.min(x0, x1) > grown.x + grown.w) continue;
      if (Math.max(y0, y1) < grown.y || Math.min(y0, y1) > grown.y + grown.h) continue;
      if (segmentHitsBox(x0, y0, x1, y1, grown)) pieces++;
    }
    if (pieces) cost += 40 + 0.5 * pieces;
  }
  return cost;
}

/**
 * Where the worst point's one-line note goes: beside its ring, on the side that crosses nothing.
 * Candidates run from the nearest spots (above-right, above-left, below-right, below-left, level)
 * to farther ones; each is kept inside `bounds` and scored by what it covers (a limit line or
 * other text is never acceptable when anything else is free, a data line costs per crossing).
 * The cheapest wins; a tie keeps the nearer, earlier spot.
 */
export function placeNote(anchor: { x: number; y: number }, size: { w: number; h: number }, bounds: Box, obs: NoteObstacles, ring = 6): Box {
  const { w, h } = size;
  const { x, y } = anchor;
  const gx = ring + 4;
  const gy = ring + 2;
  const right = x + gx;
  const left = x - gx - w;
  const spots: [number, number][] = [
    [right, y - gy - h], [left, y - gy - h], [right, y + gy], [left, y + gy],
    [right, y - h / 2], [left, y - h / 2],
    [right, y - gy - 2 * h - 4], [left, y - gy - 2 * h - 4], [right, y + gy + h + 4], [left, y + gy + h + 4],
    [x - w / 2, y - gy - h - 2], [x - w / 2, y + gy + 2],
    [right, y - gy - 3 * h - 8], [left, y - gy - 3 * h - 8], [right, y + gy + 2 * h + 8], [left, y + gy + 2 * h + 8],
  ];
  const fixed = spots.length;
  // Then a sweep up and down both sides (and centred), 2 px at a time, for a gap between lines.
  for (let dy = 2; dy <= 6 * h; dy += 2) {
    for (const sy of [y - h / 2 - dy, y - h / 2 + dy]) spots.push([right, sy], [left, sy], [x - w / 2, sy]);
  }
  const ringBox: Box = { x: x - ring - 1, y: y - ring - 1, w: 2 * ring + 2, h: 2 * ring + 2 };
  let best: Box | null = null;
  let bestCost = Infinity;
  spots.forEach(([sx, sy], k) => {
    const bx = Math.min(Math.max(sx, bounds.x), bounds.x + bounds.w - w);
    const by = Math.min(Math.max(sy, bounds.y), bounds.y + bounds.h - h);
    const b: Box = { x: Math.max(bounds.x, bx), y: Math.max(bounds.y, by), w, h };
    // Clamping can slide a spot over its own ring: that one is out. A free spot of the preferred
    // ones wins in their order; past them, the nearest free spot of the sweep.
    const order = k < fixed ? k * 0.01 : 0.2 + 0.05 * Math.hypot(b.x + w / 2 - x, b.y + h / 2 - y);
    const cost = (boxesOverlap(b, ringBox) ? 5000 : 0) + noteCost(b, obs) + order;
    if (cost < bestCost) {
      bestCost = cost;
      best = b;
    }
  });
  return best ?? { x: right, y: y - gy - h, w, h };
}

/**
 * A hairline from the ring to its note when the note had to sit away from it (more than `near`
 * px clear of the ring), so the two still read as one; null when they touch.
 */
export function leaderFor(anchor: { x: number; y: number }, box: Box, ring: number, near = 8): [number, number, number, number] | null {
  const cx = Math.min(Math.max(anchor.x, box.x), box.x + box.w);
  const cy = Math.min(Math.max(anchor.y, box.y), box.y + box.h);
  const d = Math.hypot(cx - anchor.x, cy - anchor.y);
  if (d <= ring + near) return null;
  const ux = (cx - anchor.x) / d;
  const uy = (cy - anchor.y) / d;
  return [anchor.x + ux * (ring + 1.5), anchor.y + uy * (ring + 1.5), cx - ux * 1.5, cy - uy * 1.5];
}
