/**
 * Display helpers. SI is the wire format everywhere -- these convert only for
 * the eye, never for storage, so nothing here is ever fed back into a Config.
 *
 * PLAN.md §1.4 warns that `h` is overloaded. This file follows the document's
 * resolution: geopotential is `H`, and `z` is a geometric altitude AGL. The
 * atmosphere charts label their axis H; the trajectory charts label it z.
 */

/* The exact factors live in `quantities.ts`, which is the conversion registry
 * the whole GUI reads. Re-exported here so the older call sites keep working
 * while they are converted -- but defined in exactly one place, because two
 * copies of 0.45359237 is two chances to mistype it. */
export { G0, KG_PER_LB, M_PER_FT, M_PER_IN, N_PER_LBF } from '../../lib/units/quantities'
import { KG_PER_LB, M_PER_FT, M_PER_IN, N_PER_LBF } from '../../lib/units/quantities'

export const FT_PER_M = 1 / M_PER_FT

export const m2ft = (m: number) => m / M_PER_FT
export const ft2m = (ft: number) => ft * M_PER_FT
export const n2lbf = (n: number) => n / N_PER_LBF
export const m2in = (m: number) => m / M_PER_IN
export const in2m = (i: number) => i * M_PER_IN
export const kg2lb = (kg: number) => kg / KG_PER_LB
export const lb2kg = (lb: number) => lb * KG_PER_LB

export const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export const monthName = (m: number) => MONTHS[m - 1] ?? String(m)

/** Fixed decimals without the exponent surprises of toPrecision. */
export function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return v.toFixed(digits)
}

/** Thousands-separated integer. For newtons and joules, where the magnitude
 *  is the point and 27263 reads badly next to 1613. */
export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return Math.round(v).toLocaleString('en-US')
}

/** Distinct, colour-blind-safe hues for the per-station chart lines. Ordered
 *  so the first three -- the three METAR stations -- are maximally separable. */
export const SERIES_COLOURS = [
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#22c55e', // green
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
]

export function seriesColour(i: number): string {
  return SERIES_COLOURS[i % SERIES_COLOURS.length]
}

/**
 * Eqs (14)/(15). The axial and broadside airframe drag-area bounds, m².
 *
 * The one piece of physics on this side of the wire, and it is here rather
 * than inline because two places need it and they must not disagree: the
 * corner sweep's airframe bounds and the read-only display of them. The
 * backend has the same two lines in `physics/devices.airframe_band`, and
 * `units.test.ts` pins the two together against the API.
 *
 * §6.4: attitude under canopy is unknown and the two bounds differ by
 * 2.55 * l/d -- 36x at a fineness of 14. Run both; never pick one.
 */
export function airframeBand(d_body: number, l_body: number): [number, number] {
  return [0.6 * Math.PI * d_body ** 2 / 4, 1.2 * l_body * d_body]
}
