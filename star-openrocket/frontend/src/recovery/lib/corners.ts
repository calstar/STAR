/**
 * Rendering a corner of the §11.9 sweep.
 *
 * One formatter, used by the legend, the tooltip, the worst-case cards and the
 * table, so the same corner never reads two different ways in two places on
 * the same screen.
 */

import type { Kind } from './quantities'
import { fmt } from './units'

/**
 * Converts an SI value to the user's chosen unit and formats it.
 *
 * Passed in rather than read from context because this module is pure -- it is
 * imported by tests that have no React tree. Every caller that renders to the
 * screen supplies `useUnits().num`; the tests supply nothing and get SI.
 */
export type Show = (si: number, kind: Kind) => string

/** How each swept key is written, and in what order.
 *
 *  Order is fixed rather than taken from the payload so two corners always line
 *  up column-wise when read down a list.
 *
 *  `name` is what a reader who does not have the symbols memorised needs;
 *  `short` is what fits in a chart legend. Both exist because the legend has no
 *  room for "opening force coefficient" and a worst-case card has no excuse for
 *  showing a bare `Cx1.8` and hoping. */
const KEYS: {
  key: string; short: string; name: string; unit: string; kind?: Kind
  help: string
}[] = [
  { key: 'Cx', short: 'Cx', name: 'Cx', unit: '',
    help: 'Opening force coefficient. Never measured for this hardware - the '
        + 'largest single uncertainty in the model.' },
  { key: 'n', short: 'n', name: 'fill const n', unit: '',
    help: 'Filling constant: canopy diameters fallen during inflation. Sets '
        + 'how long the canopy takes to open.' },
  { key: 'CdS_body', short: '', name: 'airframe', unit: '', kind: 'area',
    help: 'Airframe attitude under canopy. Axial is nose-down, broadside is '
        + 'sideways - a 36x difference in drag area, and nobody knows which.' },
  { key: 'v_rel', short: 'v', name: 'separation', unit: 'm/s', kind: 'speed',
    help: 'Separation velocity between body and canopy at line stretch. '
        + 'Drives the snatch load.' },
  { key: 'delay', short: 'Δt', name: 'delay', unit: 's',
    help: 'Charge-to-line-stretch lag. 0 is free-packed, up to 1 s bagged - '
        + 'the vehicle keeps accelerating until the canopy sees air.' },
  { key: 'm', short: 'm', name: 'mass', unit: 'kg', kind: 'mass',
    help: 'Descending mass.' },
]

/** The readable name and unit for a swept key, for anywhere with room.
 *  `kind` is present when the unit is user-selectable, in which case the
 *  caller should render `lab(kind)` rather than the static `unit`. */
export function keyMeta(key: string): {
  name: string; unit: string; kind?: Kind; help: string
} {
  const m = KEYS.find((k) => k.key === key)
  return m
    ? { name: m.name, unit: m.unit, kind: m.kind, help: m.help }
    : { name: key, unit: '', help: '' }
}

/** Trim trailing zeros: 6 not 6.0, 1.8 not 1.80. Corner labels sit in a legend
 *  and a table where every extra character costs width. */
function tidy(v: number): string {
  return String(Number(v.toFixed(3)))
}

/**
 * One swept parameter as `Cx1.8`, or the airframe as its §6.4 attitude name.
 *
 * `CdS_body` is never shown as a raw area. It travels as one because that is
 * what it physically is and what a custom bound would be, but "0.00486" tells
 * a reader nothing about which way the vehicle is pointing -- the backend
 * sends `attitude` alongside for exactly this.
 */
export function cornerPart(key: string, value: number, attitude?: string,
                           show?: Show): string {
  if (key === 'CdS_body') return attitude ?? fmt(value, 5)
  const meta = KEYS.find((k) => k.key === key)
  const shown = meta?.kind && show ? show(value, meta.kind) : tidy(value)
  return `${meta?.short ?? key}${shown}`
}

/**
 * Just the value: `1.8`, `6`, `axial`.
 *
 * For a table, where the column header already names the parameter and
 * repeating it in all 32 rows is noise -- `n6` down an `n` column says the
 * same thing twice. `cornerPart` is the form for a legend or a chip, which has
 * no header to lean on.
 */
export function cornerValue(key: string, value: number, attitude?: string,
                            show?: Show): string {
  if (key === 'CdS_body') return attitude ?? fmt(value, 5)
  const meta = KEYS.find((k) => k.key === key)
  if (meta?.kind && show) return show(value, meta.kind)
  return tidy(value)
}

/** The whole corner: `Cx1.8 n6 axial v5 Δt0`. */
export function cornerLabel(corner: Record<string, number>, attitude?: string,
                            show?: Show): string {
  return orderedKeys(corner)
    .map((k) => cornerPart(k, corner[k], attitude, show))
    .join(' ')
}

/** The corner's keys in display order, with anything unrecognised appended so
 *  a new swept parameter shows up rather than silently vanishing. */
export function orderedKeys(corner: Record<string, number>): string[] {
  const known = KEYS.map((k) => k.key).filter((k) => k in corner)
  const rest = Object.keys(corner).filter((k) => !known.includes(k))
  return [...known, ...rest]
}

/**
 * The eq (36) candidate, in words.
 *
 * The backend sends `"main / F_inf (bound)"` -- device, then which of the
 * three competing load candidates won. The raw form is exact and unreadable:
 * "F_inf (bound)" is the infinite-mass opening bound, "snatch" is the
 * line-stretch shock, and "Cx * max F_T (numerical)" is the integrated peak
 * scaled up. Which one wins decides which fix helps, so it has to be legible.
 */
export function candidateLabel(raw: string): { device: string; what: string } {
  const [device = '', candidate = ''] = raw.split(' / ')
  const what =
    candidate.startsWith('F_inf') ? 'canopy opening'
    : candidate === 'snatch' ? 'line-stretch snatch'
    : candidate.startsWith('Cx') ? 'integrated peak'
    : candidate
  return { device: device === '-' ? 'trajectory' : device, what }
}
