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

/**
 * A monospace glyph's advance, in em. DejaVu Sans Mono and Menlo are 0.602;
 * a hair over, so a fitted line never touches what it is fitted inside.
 */
export const MONO_ADVANCE = 0.61;

/**
 * The room a tank's readout has: its barrel is 48 px between the walls
 * (x 6..54 of 60), less a pixel each side so no glyph touches a wall.
 */
export const TANK_READOUT_W = 46;

/**
 * The font size at which `text`, in monospace, fits `width` px: `size`, or
 * smaller when it does not fit at `size`.
 *
 * A tank's readout is in psia, to a tenth, so from 1000 psia it is eleven
 * characters -- "3764.7 psia", 49.7 px at 7.5 px -- and it ran through both
 * walls of a 48 px barrel, where the export read its 3 as an 8. Shrunk, it
 * keeps every digit the sheet's rule says it shows.
 */
export function fitMono(text: string, width: number, size: number): number {
  const needed = text.length * MONO_ADVANCE * size;
  if (needed <= width) return size;
  return Math.floor((width / (text.length * MONO_ADVANCE)) * 100) / 100;
}

/** A pressure in psi, to a tenth, with no trailing ".0". */
export function fmtPsi(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return String(Number(value.toFixed(1)));
}
