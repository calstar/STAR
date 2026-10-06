import { extent } from './scale';

/**
 * A sparkline's geometry: an SVG path with gaps, thinned to at most four points per pixel column
 * (first, lowest, highest, last), so 2000 samples in a 96 px cell cost ~400 points, not 2000.
 */

export interface SparkGeometry {
  d: string;
  /** Time to x [px]. */
  x: (t: number) => number;
  /** Value to y [px]. */
  y: (v: number) => number;
  /** Number of points in the path (for tests and budgets). */
  points: number;
}

export function sparkGeometry(
  t: readonly number[],
  values: readonly (number | null)[],
  width: number,
  height: number,
  opts: { pad?: number; include?: readonly number[] } = {},
): SparkGeometry {
  const pad = opts.pad ?? 2;
  const n = Math.min(t.length, values.length);
  const t0 = n ? t[0] : 0;
  const t1 = n ? t[n - 1] : 1;
  const ext = extent([values.slice(0, n)], opts.include ?? []) ?? [0, 1];
  let [lo, hi] = ext;
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(lo))) {
    lo -= 0.5;
    hi += 0.5;
  }
  const w = Math.max(1, width - 2 * pad);
  const h = Math.max(1, height - 2 * pad);
  const x = (tt: number) => pad + (t1 > t0 ? ((tt - t0) / (t1 - t0)) * w : w / 2);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * h;

  const parts: string[] = [];
  let points = 0;
  let penDown = false;
  // One column at a time: its first, min, max and last sample, in time order.
  let col = -1;
  let bucket: { i: number; v: number }[] = [];
  const flushBucket = () => {
    if (!bucket.length) return;
    let min = bucket[0];
    let max = bucket[0];
    for (const b of bucket) {
      if (b.v < min.v) min = b;
      if (b.v > max.v) max = b;
    }
    const keep = [bucket[0], min, max, bucket[bucket.length - 1]]
      .filter((b, k, arr) => arr.findIndex((o) => o.i === b.i) === k)
      .sort((a, b) => a.i - b.i);
    for (const b of keep) {
      parts.push(`${penDown ? 'L' : 'M'}${x(t[b.i]).toFixed(1)} ${y(b.v).toFixed(1)}`);
      penDown = true;
      points++;
    }
    bucket = [];
  };
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      flushBucket();
      penDown = false;
      continue;
    }
    const c = Math.floor(x(t[i]));
    if (c !== col) {
      flushBucket();
      col = c;
    }
    bucket.push({ i, v });
  }
  flushBucket();
  return { d: parts.join(''), x, y, points };
}
