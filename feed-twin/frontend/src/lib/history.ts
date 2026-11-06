/**
 * The stand's channel history as the Plots tab draws it and as its CSV
 * downloads it. One reading of the wire for both, so a channel the plot calls
 * blind is not a column of readings in the spreadsheet.
 */

import type { RunResult } from '../api';
import { PRESSURE_UNIT, isPressureChannel, toPsia, unitLabel } from './pressure';

type Wire = { unit?: string; values: number[] };

/** What a channel plots in, as a person reads it: pressure (gauge on the
 *  wire, psia here) or temperature. Thrust, O/F and flows are the Engine
 *  page's. */
export const shownUnit = (c: { unit?: string }) => (isPressureChannel(c) ? PRESSURE_UNIT : unitLabel(c.unit ?? ''));

/** A temperature channel the twin has nothing to read for: the node its
 *  thermocouple sits on carries no temperature, and the wire sends 0 K --
 *  which no sensor reads. Plotted, it was a flat line at absolute zero. */
export const unread = (c: Wire) => !isPressureChannel(c) && c.unit === 'K' && c.values.every((v) => !(v > 0));

/** How far a state change's time on the wire can sit from the sample it
 *  happened at [s]: the history endpoint rounds an event to the millisecond
 *  and keeps a sample's time whole, so the first Fire sample at 0.7577 s came
 *  with its event at 0.758 and was labelled Ready. */
const EVENT_ROUNDING_S = 0.0005;

/** The state each sample was taken in, from the window's state changes.
 *  Before the first change the window does not say: blank, unless it has no
 *  change at all, when every sample is in `current`. */
export function statesAt(times: readonly number[], events: RunResult['events'], current: string): string[] {
  const changes = events ?? [];
  let at = 0;
  let state = changes.length ? '' : current;
  return times.map((t) => {
    while (at < changes.length && changes[at].t <= t + EVENT_ROUNDING_S) state = changes[at++].label;
    return state;
  });
}

/** The whole trace as CSV: time, state, then one column per channel by its
 *  console name. Pressures in psia, as the column says (3 places keeps the
 *  wire's hundredths of a psi); a channel the twin cannot read is left empty,
 *  never written as 0 K. */
export function historyCsv(
  full: Pick<RunResult, 'times_s' | 'channels' | 'events'>,
  current: string,
  nameOf: (id: string, tag: string) => string,
): string {
  const cols = full.channels;
  const blind = cols.map(unread);
  const states = statesAt(full.times_s, full.events, current);
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    ['t_s', 'state', ...cols.map((c) => `${nameOf(c.id, c.tag)} [${shownUnit(c)}]`)].map(quote).join(','),
    ...full.times_s.map((t, i) =>
      [
        t.toFixed(3),
        quote(states[i]),
        ...cols.map((c, j) => {
          const v = c.values[i];
          if (blind[j] || v === undefined || v === null) return '';
          return isPressureChannel(c) ? toPsia(v).toFixed(3) : String(v);
        }),
      ].join(','),
    ),
  ];
  return lines.join('\n');
}
