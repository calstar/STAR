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

/** Radius of a hop, where there is room for a full one (see `bulgeSide`). */
export const HOP_R = 5;

/**
 * The smallest hop worth drawing. Where there is less room than `HOP_R`
 * the arc is made smaller rather than left out: a small hop still says "not
 * joined", and a plain cross says the opposite.
 */
const MIN_R = 1;

/**
 * A crossing to hop, which way its arc bulges (+1 toward +x, -1 toward -x;
 * unset is +1, the convention), and its radius when there was not room for
 * a full one.
 */
export interface Hop extends Pt {
  bulge?: 1 | -1;
  r?: number;
}

/**
 * The side of the vertical a hop bulges to, and how big it can be there.
 *
 * The arc spans its radius either way along the vertical and out to one
 * side, over the horizontal line. That side needs two radii of the
 * horizontal line beyond the crossing (exactly two allowed), or the arc runs
 * off the end of the line it hops, or over its corner. The conventional +x
 * side is taken when a full hop fits there -- unless the hopping line itself
 * turns that way within two radii of the crossing, where the arc would sit
 * in the elbow of its own corner and read as a kink; then the other. Where
 * neither side has room for a full hop, the roomier side and a smaller arc.
 */
function bulgeSide(mine: Pt[], i: number, y: number, left: number, right: number, vr: number, r: number): { side: 1 | -1; r: number } | null {
  const fits = (s: 1 | -1) => Math.min(vr, (s > 0 ? right : left) / 2);
  // Which way my own line turns at either end of this vertical, if near.
  const turns: number[] = [];
  const p = mine[i], q = mine[i + 1];
  if (i > 0 && Math.abs(p.y - y) < 2 * r + EPS) turns.push(Math.sign(mine[i - 1].x - p.x));
  if (i + 2 < mine.length && Math.abs(q.y - y) < 2 * r + EPS) turns.push(Math.sign(mine[i + 2].x - q.x));
  const crowded = (s: 1 | -1) => turns.includes(s);
  const order: (1 | -1)[] = crowded(1) && !crowded(-1) ? [-1, 1] : [1, -1];
  for (const s of order) if (fits(s) >= r - EPS) return { side: s, r };
  const best = order.reduce((u, v) => (fits(v) > fits(u) + EPS ? v : u));
  const size = fits(best);
  return size >= MIN_R - EPS ? { side: best, r: size } : null;
}

/**
 * The points where the vertical segments of `mine` cross a horizontal
 * segment of any of `others`, strictly inside both -- a line ending on
 * another is a tee's business, not a hop's.
 *
 * Gated on what the arc actually needs (`bulgeSide`): its radius of the
 * vertical either side of the crossing -- it runs exactly that far, so
 * exactly that is enough -- and two radii of the horizontal on the side it
 * bulges to. The gate used to be two radii, strictly, every way, so a
 * crossing near any corner or port -- a quarter of them on a real bay -- was
 * drawn as a plain cross, which reads as a joint.
 */
export function crossingsOf(mine: Pt[], others: Pt[][], r = HOP_R): Hop[] {
  const out: Hop[] = [];
  for (let i = 0; i < mine.length - 1; i++) {
    const p = mine[i], q = mine[i + 1];
    if (Math.abs(p.x - q.x) > EPS) continue;           // only vertical segments hop
    const x = p.x;
    const y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
    const here: { y: number; side: 1 | -1; r: number }[] = [];
    for (const o of others) {
      for (let j = 0; j < o.length - 1; j++) {
        const a = o[j], b = o[j + 1];
        if (Math.abs(a.y - b.y) > EPS) continue;       // over horizontal ones
        const y = a.y;
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        if (!(x > x1 + EPS && x < x2 - EPS)) continue;
        if (!(y > y1 + EPS && y < y2 - EPS)) continue;
        if (here.some(h => Math.abs(h.y - y) < EPS)) continue;
        const hop = bulgeSide(mine, i, y, x - x1, x2 - x, Math.min(r, y - y1, y2 - y), r);
        if (hop) here.push({ y, ...hop });
      }
    }
    // Two crossings on one vertical closer than two arcs: each arc gets half
    // the gap, so both are marked and neither runs into the other.
    here.sort((u, v) => u.y - v.y);
    for (let k = 0; k + 1 < here.length; k++) {
      const gap = here[k + 1].y - here[k].y;
      if (here[k].r + here[k + 1].r > gap + EPS) {
        here[k].r = Math.min(here[k].r, gap / 2);
        here[k + 1].r = Math.min(here[k + 1].r, gap / 2);
      }
    }
    for (const hop of here) {
      if (hop.r < MIN_R - EPS) continue;
      const h: Hop = { x, y: hop.y };
      if (hop.side < 0) h.bulge = -1;
      if (hop.r < r - EPS) h.r = hop.r;
      out.push(h);
    }
  }
  return out;
}

/**
 * The path, with a semicircle over each crossing. The bulge is to the side
 * the hop says -- +x unless that is where the line turns or the other line
 * ends -- whichever way the line is travelling, so a run drawn upward and one
 * drawn downward hop the same way.
 */
export function pathWithHops(pts: Pt[], hops: Hop[], r = HOP_R): string {
  if (hops.length === 0 || pts.length < 2) return pointsToPath(pts);
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const vertical = Math.abs(p.x - q.x) < EPS;
    const lo = Math.min(p.y, q.y), hi = Math.max(p.y, q.y);
    const here = vertical
      ? hops.filter(h => Math.abs(h.x - p.x) < EPS && h.y >= lo + (h.r ?? r) - EPS && h.y <= hi - (h.r ?? r) + EPS)
      : [];
    if (here.length === 0) { d += ` L ${q.x},${q.y}`; continue; }
    const s = q.y > p.y ? 1 : -1;
    here.sort((a, b) => (a.y - b.y) * s);
    for (const h of here) {
      const hr = h.r ?? r;
      // Clockwise on screen (sweep 1) from the upper end bulges to +x.
      const sweep = (s > 0) === ((h.bulge ?? 1) > 0) ? 1 : 0;
      d += ` L ${p.x},${h.y - hr * s} A ${hr} ${hr} 0 0 ${sweep} ${p.x},${h.y + hr * s}`;
    }
    d += ` L ${q.x},${q.y}`;
  }
  return d;
}
