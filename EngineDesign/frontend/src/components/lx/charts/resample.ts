/**
 * A run drawn on another run's clock. uPlot wants every series on one x array, and the compared
 * ("ghost") run was sampled on its own: both clocks have Fire = 0, so the ghost is read at each of
 * this run's times. Outside the ghost's samples, and across its gaps, the value is null.
 */
export function alignOnto(t: readonly number[], srcT: readonly number[], srcValues: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(t.length);
  // Monotone sweep: both axes ascend, so one pass instead of a search per point.
  let j = 0;
  const n = srcT.length;
  for (let i = 0; i < t.length; i++) {
    const q = t[i];
    if (n === 0 || !(q >= srcT[0]) || !(q <= srcT[n - 1])) {
      out[i] = null;
      continue;
    }
    while (j < n - 1 && srcT[j + 1] <= q) j++;
    const a = srcValues[j] ?? null;
    if (q === srcT[j] || j === n - 1) {
      out[i] = q === srcT[j] ? a : null;
      continue;
    }
    const b = srcValues[j + 1] ?? null;
    const span = srcT[j + 1] - srcT[j];
    out[i] = a === null || b === null ? null : span > 0 ? a + ((b - a) * (q - srcT[j])) / span : a;
  }
  return out;
}

/**
 * Values for the firing samples only: everything outside `mask` becomes null (a gap), so a
 * firing-only quantity (chamber pressure, ΔP/Pc) draws nothing before Fire or after burnout.
 */
export function onlyWhere(values: readonly (number | null)[], mask: readonly boolean[]): (number | null)[] {
  return values.map((v, i) => (mask[i] ? v : null));
}
