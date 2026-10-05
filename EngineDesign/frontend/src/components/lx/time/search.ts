/**
 * Index arithmetic on a burn's time axis. Pure, so every chart and the store share one answer to
 * "which sample is the cursor on".
 */

/**
 * Index of the sample nearest `t` in an ascending array, by bisection. A tie goes to the earlier
 * sample. -1 for an empty array; an off-the-end `t` gives the first or last index. Non-finite
 * entries are not expected (a time axis has none).
 */
export function nearestIndex(ts: ArrayLike<number>, t: number): number {
  const n = ts.length;
  if (n === 0) return -1;
  if (!(t > ts[0])) return 0; // also catches NaN
  if (t >= ts[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  // Invariant: ts[lo] <= t < ts[hi].
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - ts[lo] <= ts[hi] - t ? lo : hi;
}

/** `v` held inside [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Linear interpolation of `values` (on `ts`) at `t`; null outside the samples or across a gap.
 * Used to read a run whose clock differs from the cursor's (the compared run, the flight).
 */
export function valueAt(ts: ArrayLike<number>, values: ArrayLike<number | null>, t: number): number | null {
  const n = ts.length;
  if (n === 0 || !(t >= ts[0]) || !(t <= ts[n - 1])) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const a = values[lo];
  const b = values[hi];
  if (t === ts[lo]) return a ?? null;
  if (t === ts[hi]) return b ?? null;
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const span = ts[hi] - ts[lo];
  return span > 0 ? a + ((b - a) * (t - ts[lo])) / span : a;
}
