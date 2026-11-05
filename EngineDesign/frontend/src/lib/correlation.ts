/**
 * When the Time-Series correlation grid says something.
 *
 * Every output of a burn is a function of the two tank pressures. When both pressures only ever
 * move one way (a linear or decaying ramp, the usual profile) the burn is a single path through
 * that plane, every output rises or falls together along it, and every cell reads about ±1.00:
 * the grid restates the profile. It is folded away then, behind a line that says why, and shown
 * when the profile turns back on itself or a pair of outputs comes apart.
 */

/** |r| at or above this: a pair the run cannot tell apart. */
export const CORRELATION_FLOOR = 0.95;

function monotonic(xs: readonly number[] | undefined): boolean {
  if (!xs || xs.length < 3) return true;
  let up = false;
  let down = false;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 1e-9) up = true;
    else if (d < -1e-9) down = true;
    if (up && down) return false;
  }
  return true;
}

/** Is the grid worth showing open? */
export function correlationIsInformative(
  matrix: number[][],
  tankO?: readonly number[],
  tankF?: readonly number[],
): boolean {
  if (monotonic(tankO) && monotonic(tankF)) return false;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      const r = matrix[i][j];
      if (i !== j && Number.isFinite(r) && Math.abs(r) < CORRELATION_FLOOR) return true;
    }
  }
  return false;
}
