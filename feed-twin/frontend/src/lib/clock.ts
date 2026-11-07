/**
 * Two run records on one plot.
 *
 * Each record's series is thinned on its own, so two runs never share sample
 * times. They are drawn on the union of both clocks: each run held at its own
 * last sample, and a gap outside its own span. On the first run's clock alone,
 * a second run that burned longer lost its tail-off and its burnout.
 */

/** Every sample time of every trace, once each, in order [s]. */
export function unionTimes(clocks: readonly (readonly number[])[]): number[] {
  return [...new Set(clocks.flat())].sort((a, b) => a - b);
}

/** `values` sampled at `own` [s], read at each of `times` (ascending): the
 *  last sample at or before it, NaN before the first or after the last. */
export function holdOn(times: readonly number[], own: readonly number[], values: readonly number[]): number[] {
  const first = own[0];
  const last = own[own.length - 1];
  let i = 0;
  return times.map((t) => {
    if (!own.length || t < first || t > last) return NaN;
    while (i < own.length - 1 && own[i + 1] <= t) i += 1;
    return values[i];
  });
}
