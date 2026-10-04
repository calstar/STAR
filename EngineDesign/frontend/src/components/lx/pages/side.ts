import { useCallback } from 'react';
import { useTime } from '../time/hooks';
import { nearestIndex } from '../time/search';
import type { TimeState } from '../time/store';
import type { Quantity, Units } from '../units';

/** Side colours and words, and a cursor index on a clock of its own: shared by the pages. */

/** The index nearest the cursor on a clock of its own (a diagnostics block's `t`); -1 with none. */
export function useClockIndex(t: readonly number[] | null | undefined): number {
  const sel = useCallback((s: TimeState) => (t && t.length ? nearestIndex(t, s.t) : -1), [t]);
  return useTime(sel);
}

export type SideKey = 'ox' | 'fuel' | 'gas';
export const SIDE_VAR: Record<SideKey, string> = { ox: 'var(--lx-lox)', fuel: 'var(--lx-fuel)', gas: 'var(--lx-gas)' };
export const SIDE_TOKEN: Record<SideKey, string> = { ox: '--lx-lox', fuel: '--lx-fuel', gas: '--lx-gas' };
export const SIDE_WORD: Record<SideKey, string> = { ox: 'LOX', fuel: 'Fuel', gas: 'Gas' };


/** "27.0 – 27.4 bar(a)": a range with its unit once, or the one value when both ends print alike. */
export function spanText(u: Pick<Units, 'fmt'>, a: Quantity, b: Quantity): string {
  if (u.fmt(a) === u.fmt(b)) return u.fmt(a);
  return `${u.fmt({ ...a, unit: '' })} – ${u.fmt(b)}`;
}
