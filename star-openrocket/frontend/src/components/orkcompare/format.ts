/**
 * How the ORK vs CAD table prints a number: in the user's units (the Units tab)
 * for every quantity that has a choice, plain for the dimensionless ones.
 * Pure, so the unit handling is testable without React (format.test.ts).
 */
import type { Kind } from '../../lib/units/quantities'
import type { RowUnit } from '../../lib/orkCompare'

/** The slice of the units context this needs (lib/units/unitsContext's `Units`). */
export interface UnitFormatter {
  num: (si: number | null | undefined, kind: Kind, digits?: number) => string
  lab: (kind: Kind) => string
  dec: (v: number | null | undefined, digits?: number) => string
}

const KIND: Partial<Record<RowUnit, Kind>> = { length: 'length', mass: 'mass', area: 'area' }

/** Digits beyond the unit's default: fin dimensions and masses need finer steps than a whole airframe. */
const EXTRA: Partial<Record<RowUnit, number>> = { length: 4, mass: 3, area: 5 }

export function formatCell(v: number | null, unit: RowUnit, u: UnitFormatter): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const kind = KIND[unit]
  if (kind) return `${u.num(v, kind, EXTRA[unit])} ${u.lab(kind)}`
  if (unit === 'count') return String(Math.round(v))
  if (unit === 'cal') return `${u.dec(v, 2)} cal`
  if (unit === 'perRad') return u.dec(v, 3)
  return String(v)
}

export function formatDelta(d: number | null, unit: RowUnit, u: UnitFormatter): string {
  if (d == null || !Number.isFinite(d)) return '—'
  const s = formatCell(Math.abs(d), unit, u)
  if (d === 0) return s
  return `${d > 0 ? '+' : '−'}${s}`
}

export function formatPct(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—'
  const a = Math.abs(p)
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${a.toFixed(digits)} %`
}
