/**
 * A number and its unit, as drawn on a symbol.
 *
 * One rule for all of them. The engine printed `300psi`, the relief `650 psi`
 * and the bottle `2000 psi`, which is three ways to write one thing on one
 * sheet. A unit reads with a space before it; a dimensionless value reads
 * bare; a long decimal is cut to what a symbol has room for.
 */

import type { ParamValue } from './params';

export function fmtValue(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  const fixed = abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toPrecision(digits);
  // `toPrecision` leaves trailing zeros; a symbol has no room for them.
  return String(Number(fixed));
}

export function fmtParam(p: ParamValue | undefined): string {
  if (!p) return '';
  const unit = p.unit === '-' || !p.unit ? '' : ` ${p.unit}`;
  return `${fmtValue(p.value)}${unit}`;
}
