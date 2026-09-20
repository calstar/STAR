import { pointsToPath } from './route';
import type { Pt } from './route';

/**
 * Where lines cross without meeting, the drawing says so.
 *
 * Nothing in this tool infers a connection from two paths overlapping, and it
 * never will: a crossing on a drawing is usually one line passing over
 * another, and guessing wrong either invents a leak path or hides a real one.
 * But the code keeping that distinction was no use to a reader if the drawing
 * did not show it -- a crossing and a tee looked the same on the sheet, one
 * with a dot and one without, and the dot is ten pixels.
 *
 * So the vertical line hops the horizontal one, the way a schematic has drawn
 * a crossing for a century. Vertical over horizontal is a convention, chosen
 * because every crossing between orthogonal runs is one of each, so it needs
 * no tie-break. The hop is drawn into the line's own path rather than masked
 * over it, so it exports with the line and takes the line's colour.
 */

const EPS = 1e-6;

/** Radius of the hop, and how far from a corner or an end one may sit. */
export const HOP_R = 5;

/**
 * The points where the vertical segments of `mine` cross a horizontal
 * segment of any of `others`, strictly inside both -- a line ending on
 * another is a tee's business, not a hop's.
 */
export function crossingsOf(mine: Pt[], others: Pt[][], r = HOP_R): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < mine.length - 1; i++) {
    const p = mine[i], q = mine[i + 1];
    if (Math.abs(p.x - q.x) > EPS) continue;           // only vertical segments hop
    const x = p.x;
    const y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
    for (const o of others) {
      for (let j = 0; j < o.length - 1; j++) {
        const a = o[j], b = o[j + 1];
        if (Math.abs(a.y - b.y) > EPS) continue;       // over horizontal ones
        const y = a.y;
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        // Two radii from any corner or end: a hop that touches a corner
        // reads as the line failing to turn.
        if (x > x1 + 2 * r && x < x2 - 2 * r && y > y1 + 2 * r && y < y2 - 2 * r) out.push({ x, y });
      }
    }
  }
  return out;
}

/**
 * The path, with a semicircle over each crossing. The bulge is always to
 * the right of the vertical, whichever way the line is travelling, so a run
 * drawn upward and one drawn downward hop the same way.
 */
export function pathWithHops(pts: Pt[], hops: Pt[], r = HOP_R): string {
  if (hops.length === 0 || pts.length < 2) return pointsToPath(pts);
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const vertical = Math.abs(p.x - q.x) < EPS;
    const lo = Math.min(p.y, q.y), hi = Math.max(p.y, q.y);
    const here = vertical
      ? hops.filter(h => Math.abs(h.x - p.x) < EPS && h.y > lo + r - EPS && h.y < hi - r + EPS)
      : [];
    if (here.length === 0) { d += ` L ${q.x},${q.y}`; continue; }
    const s = q.y > p.y ? 1 : -1;
    here.sort((a, b) => (a.y - b.y) * s);
    for (const h of here) {
      d += ` L ${p.x},${h.y - r * s} A ${r} ${r} 0 0 ${s > 0 ? 1 : 0} ${p.x},${h.y + r * s}`;
    }
    d += ` L ${q.x},${q.y}`;
  }
  return d;
}
