import { fmt } from '../../layerx/format';
import { MINUS, NBSP } from '../units';

/**
 * The change of a figure against the compared run, for DeltaChip. Neutral by design: whether +5 %
 * is good depends on the figure, so a chip never colours it.
 */
export interface Delta {
  /** current − reference, in display units */
  diff: number;
  /** the same as a percent of |reference|; null when the reference is 0 */
  pct: number | null;
  /** below the figure's own last digit and under 0.05 %: the same number */
  same: boolean;
}

export function delta(cur: number | null | undefined, ref: number | null | undefined, digits: number): Delta | null {
  if (cur === null || cur === undefined || ref === null || ref === undefined || !Number.isFinite(cur) || !Number.isFinite(ref)) return null;
  const diff = cur - ref;
  const pct = ref !== 0 ? (diff / Math.abs(ref)) * 100 : null;
  const same = Math.abs(diff) < 0.5 * 10 ** -digits && (pct === null || Math.abs(pct) < 0.05);
  return { diff, pct, same };
}

const signed = (x: number, digits: number) => {
  const t = fmt(Math.abs(x), digits);
  // A change that rounds to zero carries no sign.
  return Number(t.replace(/,/g, '')) === 0 ? t : `${x >= 0 ? '+' : MINUS}${t}`;
};

/**
 * "+0.11 s", "−2.9 %", "+12 N (+0.2 %)" or "same"; null when there is nothing to compare.
 * `mode` picks the absolute change, the percent, or both.
 */
export function deltaText(d: Delta | null, opts: { digits: number; unit?: string; mode?: 'abs' | 'pct' | 'both' }): string | null {
  if (!d) return null;
  if (d.same) return 'same';
  const { digits, unit = '', mode = 'abs' } = opts;
  const abs = `${signed(d.diff, digits)}${unit ? NBSP + unit : ''}`;
  const pct = d.pct === null ? null : `${signed(d.pct, 1)}${NBSP}%`;
  // Under the last digit but not the same number: the percent says how much, "0.00" would not.
  const absZero = Number(fmt(Math.abs(d.diff), digits).replace(/,/g, '')) === 0;
  if (mode === 'pct' || (absZero && pct)) return pct ?? abs;
  if (mode === 'both' && pct) return `${abs} (${pct})`;
  return abs;
}
