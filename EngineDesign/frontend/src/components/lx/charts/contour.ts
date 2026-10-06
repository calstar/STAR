/**
 * Iso-lines of a gridded field by marching squares: the Isp contours under the operating map.
 *
 * `z[i][j]` is the value at (x[i], y[j]). A cell with a missing corner draws nothing. A saddle
 * (opposite corners on the same side of the level) is resolved by the cell's mean, so the lines
 * never cross.
 */

/** A segment in data coordinates: [x0, y0, x1, y1]. */
export type Segment = [number, number, number, number];

export function contourSegments(
  x: readonly number[],
  y: readonly number[],
  z: readonly (readonly (number | null)[])[],
  level: number,
): Segment[] {
  const out: Segment[] = [];
  const nx = Math.min(x.length, z.length);
  for (let i = 0; i + 1 < nx; i++) {
    const c0 = z[i];
    const c1 = z[i + 1];
    const ny = Math.min(y.length, c0.length, c1.length);
    for (let j = 0; j + 1 < ny; j++) {
      // Corners, counter-clockwise from bottom-left: (i,j) (i+1,j) (i+1,j+1) (i,j+1).
      const v = [c0[j], c1[j], c1[j + 1], c0[j + 1]];
      if (v.some((w) => w === null || w === undefined || !Number.isFinite(w))) continue;
      const [a, b, c, d] = v as number[];
      const px = [x[i], x[i + 1], x[i + 1], x[i]];
      const py = [y[j], y[j], y[j + 1], y[j + 1]];
      const above = [a, b, c, d].map((w) => w >= level);
      const code = (above[0] ? 1 : 0) | (above[1] ? 2 : 0) | (above[2] ? 4 : 0) | (above[3] ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // The crossing on edge k (corner k to corner k+1), by linear interpolation.
      const cross = (k: number): [number, number] => {
        const k2 = (k + 1) % 4;
        const wa = [a, b, c, d][k];
        const wb = [a, b, c, d][k2];
        const f = wb === wa ? 0.5 : (level - wa) / (wb - wa);
        return [px[k] + (px[k2] - px[k]) * f, py[k] + (py[k2] - py[k]) * f];
      };
      // Edges crossed: those whose two corners differ.
      const edges = [0, 1, 2, 3].filter((k) => above[k] !== above[(k + 1) % 4]);
      if (edges.length === 2) {
        const [p, q] = [cross(edges[0]), cross(edges[1])];
        out.push([p[0], p[1], q[0], q[1]]);
      } else if (edges.length === 4) {
        // Saddle: pair the edges so the mean's side stays connected.
        const centreAbove = (a + b + c + d) / 4 >= level;
        const pairs: [number, number][] = centreAbove === above[0] ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
        for (const [e0, e1] of pairs) {
          const [p, q] = [cross(e0), cross(e1)];
          out.push([p[0], p[1], q[0], q[1]]);
        }
      }
    }
  }
  return out;
}
