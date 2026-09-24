/**
 * A manifold's ports as fractions of the way round its block.
 *
 * The arithmetic the drawing (`ManifoldNode`) and the Geometry editor
 * (`ManifoldEditor`) both place ports with. It is here rather than in the
 * editor because the editor reads its starting layout from the node, and the
 * node importing the editor back would make the two a cycle.
 */

export interface ManifoldGeometry {
  width: number;
  height: number;
  /** Port id → fraction of the perimeter, clockwise from the top-left. */
  positions: Record<string, number>;
}

/** Point on the block's perimeter at fraction `t`, clockwise from top-left. */
export function perimeterPoint(t: number, w: number, h: number) {
  const per = 2 * (w + h);
  let d = ((t % 1) + 1) % 1 * per;
  if (d <= w) return { x: d, y: 0, side: 'top' as const };
  d -= w;
  if (d <= h) return { x: w, y: d, side: 'right' as const };
  d -= h;
  if (d <= w) return { x: w - d, y: h, side: 'bottom' as const };
  d -= w;
  return { x: 0, y: h - d, side: 'left' as const };
}

/** The fraction nearest an arbitrary point — what a drag lands on. */
export function nearestFraction(px: number, py: number, w: number, h: number): number {
  const per = 2 * (w + h);
  const cands: [number, number][] = [
    [Math.min(w, Math.max(0, px)) / per, Math.hypot(px - Math.min(w, Math.max(0, px)), py)],
    [(w + Math.min(h, Math.max(0, py))) / per, Math.hypot(px - w, py - Math.min(h, Math.max(0, py)))],
    [(w + h + (w - Math.min(w, Math.max(0, px)))) / per, Math.hypot(px - Math.min(w, Math.max(0, px)), py - h)],
    [(2 * w + h + (h - Math.min(h, Math.max(0, py)))) / per, Math.hypot(px, py - Math.min(h, Math.max(0, py)))],
  ];
  cands.sort((a, b) => a[1] - b[1]);
  return ((cands[0][0] % 1) + 1) % 1;
}

/**
 * Evenly round the perimeter.
 *
 * Where a port goes that a saved layout does not mention -- one added since
 * the layout was saved. Not what a fresh manifold looks like: that is
 * `manifoldLayout` with no geometry, 'in' on the near end and the outlets down
 * one long side.
 */
export function defaultPositions(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id, i) => { out[id] = (i + 0.5) / Math.max(1, ids.length); });
  return out;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

/** A port as drawn: the side it is on and px along it from the top-left. */
export interface DrawnPort { side: Side; along: number }

export interface ManifoldLayout {
  width: number;
  height: number;
  /** Every port, plugged ones included -- whether to draw one is not layout. */
  ports: Record<string, DrawnPort>;
}

/** The perimeter fraction of a port drawn `along` a side: `perimeterPoint` backwards. */
export function fractionOf(port: DrawnPort, w: number, h: number): number {
  const per = 2 * (w + h);
  switch (port.side) {
    case 'top': return port.along / per;
    case 'right': return (w + port.along) / per;
    case 'bottom': return (w + h + (w - port.along)) / per;
    default: return (2 * w + h + (h - port.along)) / per;
  }
}
