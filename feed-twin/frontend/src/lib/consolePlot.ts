/**
 * What the console's pressure history shows: which channels are bottles, and
 * where the Burn window starts. Pure, so the choices are tested
 * (consolePlot.test.ts) rather than eyeballed.
 */

/** Is this a bottle's transducer -- a COPV or K-bottle, thousands of psi --
 *  rather than a tank's or the feed's? By its red line or the most it has
 *  read [psig, as the wire gives them], against twice the highest MAWP of the
 *  run tanks (1,500 psig when none is drawn). On one axis with the tanks, a
 *  4,500 psig COPV squeezed the burn into the bottom tenth of the plot. */
export function isBottleChannel(
  c: { values: readonly number[]; meop?: number | null; nop?: number | null },
  tankMawps: readonly number[],
): boolean {
  const line = tankMawps.length ? 2 * Math.max(...tankMawps) : 1500;
  let peak = Math.max(c.meop ?? -Infinity, c.nop ?? -Infinity);
  for (const v of c.values) if (v > peak) peak = v;
  return peak > line;
}

/** Where the Burn window starts [stand s]: `lead` before the last time the
 *  stand entered Fire, and never less than `least` before `now`. With no Fire
 *  in the history, the last `least` seconds. */
export function burnWindowStart(
  events: readonly { t: number; label: string }[],
  now: number,
  lead: number,
  least: number,
): number {
  let fired: number | null = null;
  for (const e of events) if (/^fire$/i.test(e.label)) fired = e.t;
  const start = fired === null ? now - least : fired - lead;
  return Math.min(start, now - least);
}
