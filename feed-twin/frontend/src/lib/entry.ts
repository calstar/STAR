/**
 * What a typed setting commits. Pure, shared by the Configuration rows and
 * the GSE tab's cart fields; tested in views/config.test.ts and
 * lib/entry.test.ts.
 */

import type { Tunable } from '../api';
import { isGaugeTunable, typedPsia } from './pressure';

/** What a number box commits when it holds `raw` and the stand runs on
 *  `value`: the new value (gauge for a gauge row, snapped to its detent in
 *  psia; otherwise kept within its bounds), or null for nothing -- an
 *  emptied box, half a number, or the shown value typed back. `Number('')`
 *  is 0: backspacing the dome to retype it and pausing committed 0 psig to
 *  the running stand, and the box jumped to 14.7 under the cursor. */
export function rowCommit(
  raw: string,
  t: Pick<Tunable, 'step' | 'low' | 'high' | 'unit' | 'gauge_wire'>,
  value: number,
): number | null {
  if (isGaugeTunable(t)) return typedPsia(raw, value, t.step, t.low, t.high);
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return null;
  const next = Math.min(t.high, Math.max(t.low, n));
  return Math.abs(next - value) > 0 ? next : null;
}

/** What the stand says it now runs on, for the settings a command sent: a
 *  number it clamped (a 0 s fill is 1 s) is shown as it runs, not as typed. */
export function settled<T extends object>(patch: Partial<T>, ran: Partial<T> | null | undefined): Partial<T> {
  if (!ran) return {};
  return Object.fromEntries(
    Object.keys(patch)
      .filter((k) => k in ran)
      .map((k) => [k, ran[k as keyof T]]),
  ) as Partial<T>;
}
