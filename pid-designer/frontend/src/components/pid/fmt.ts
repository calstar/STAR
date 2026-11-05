/**
 * A number and its unit, as drawn on a symbol.
 *
 * One rule for all of them. The engine printed `300psi`, the relief `650 psi`
 * and the bottle `2000 psi`, which is three ways to write one thing on one
 * sheet. A unit reads with a space before it; a dimensionless value reads
 * bare; a long decimal is cut to what a symbol has room for.
 */

import type { ParamValue } from './params';
import { PRESSURE_DIFFERENCES, PSI_PA, toPsia, toGaugePa } from './params';

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

/**
 * A pressure as drawn on a symbol: a pressure at a place in psia, a difference
 * in plain psi.
 *
 * The drawing printed "4000 psi" on the COPV, which meant 4014.7 psia, and
 * "385 psi" on the engine, which meant 385 psia -- one spelling, two
 * references, a reader left to know which symbol is which. Now the reference
 * is printed and the number is the absolute one, the team's rule for anything
 * a person reads. One decimal, because the atmosphere that converts gauge to
 * absolute is 14.7, not 15.
 */
export function fmtPressure(key: string, p: ParamValue | undefined, symbol = ''): string {
  if (!p) return '';
  if (PRESSURE_DIFFERENCES.has(key)) {
    // A difference is the same against either reference: plain psi.
    const pa = toGaugePa(p);
    return pa === undefined ? fmtParam(p) : `${fmtPsi(pa / PSI_PA)} psi`;
  }
  const psia = toPsia(p, symbol);
  return psia === undefined ? fmtParam(p) : `${fmtPsi(psia)} psia`;
}

/** A pressure in psi, to a tenth, with no trailing ".0". */
export function fmtPsi(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return String(Number(value.toFixed(1)));
}
