/**
 * Display units. SI is the only thing ever stored or sent; this file is the one
 * place a number crosses into what a person reads or types, and back.
 *
 * Two choices drive everything: the length unit and the mass unit. Whether the
 * length unit is metric or imperial then decides the derived kinds (densities,
 * altitude), so "inches and grams" is allowed and does what it says.
 */

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type MassUnit = 'g' | 'kg' | 'oz' | 'lb'

export interface UnitPrefs {
  length: LengthUnit
  mass: MassUnit
}

export type Kind =
  | 'length'      // component dimensions
  | 'mass'
  | 'angle'       // rad on the wire, degrees on screen (OpenRocket shows degrees)
  | 'altitude'
  | 'time'
  | 'bulkDensity'
  | 'surfaceDensity'
  | 'lineDensity'
  | 'area'
  | 'none'        // counts, coefficients, Mach

export const M_PER_IN = 0.0254
export const M_PER_FT = 0.3048
export const KG_PER_LB = 0.45359237
export const KG_PER_OZ = KG_PER_LB / 16

const LENGTH: Record<LengthUnit, { per: number; digits: number }> = {
  mm: { per: 1e-3, digits: 1 },
  cm: { per: 1e-2, digits: 2 },
  m: { per: 1, digits: 4 },
  in: { per: M_PER_IN, digits: 3 },
  ft: { per: M_PER_FT, digits: 4 },
}
const MASS: Record<MassUnit, { per: number; digits: number }> = {
  g: { per: 1e-3, digits: 1 },
  kg: { per: 1, digits: 4 },
  oz: { per: KG_PER_OZ, digits: 2 },
  lb: { per: KG_PER_LB, digits: 3 },
}

export const METRIC: UnitPrefs = { length: 'cm', mass: 'g' }
export const IMPERIAL: UnitPrefs = { length: 'in', mass: 'oz' }
export const LENGTH_UNITS: LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft']
export const MASS_UNITS: MassUnit[] = ['g', 'kg', 'oz', 'lb']

export function isImperial(p: UnitPrefs): boolean {
  return p.length === 'in' || p.length === 'ft'
}

interface Def { label: string; per: number; digits: number }

/** The unit a kind is shown in under these preferences. `per` is SI per unit. */
export function unitFor(kind: Kind, p: UnitPrefs): Def {
  const imp = isImperial(p)
  switch (kind) {
    case 'length':
      return { label: p.length, ...LENGTH[p.length] }
    case 'mass':
      return { label: p.mass, ...MASS[p.mass] }
    case 'angle':
      return { label: '°', per: Math.PI / 180, digits: 1 }
    case 'altitude':
      return imp ? { label: 'ft', per: M_PER_FT, digits: 0 } : { label: 'm', per: 1, digits: 0 }
    case 'time':
      return { label: 's', per: 1, digits: 2 }
    case 'bulkDensity':
      return imp
        ? { label: 'lb/ft³', per: KG_PER_LB / M_PER_FT ** 3, digits: 2 }
        : { label: 'g/cm³', per: 1000, digits: 3 }
    case 'surfaceDensity':
      return imp
        ? { label: 'oz/in²', per: KG_PER_OZ / M_PER_IN ** 2, digits: 4 }
        : { label: 'g/m²', per: 1e-3, digits: 1 }
    case 'lineDensity':
      return imp
        ? { label: 'oz/in', per: KG_PER_OZ / M_PER_IN, digits: 4 }
        : { label: 'g/m', per: 1e-3, digits: 2 }
    case 'area':
      return imp
        ? { label: 'in²', per: M_PER_IN ** 2, digits: 2 }
        : { label: 'cm²', per: 1e-4, digits: 2 }
    case 'none':
      return { label: '', per: 1, digits: 3 }
  }
}

export function toDisplay(kind: Kind, si: number, p: UnitPrefs): number {
  return si / unitFor(kind, p).per
}

export function fromDisplay(kind: Kind, shown: number, p: UnitPrefs): number {
  return shown * unitFor(kind, p).per
}

/** Rounds for display without trailing-zero noise: 2.50 -> "2.5". */
export function fmtNumber(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
}

/**
 * OpenRocket's Unit.toString: three significant figures, trailing zeros
 * dropped ("42.5 cm", "26 cm", "6.16 g").
 */
export function fmtSig(v: number, sig = 3): string {
  if (!Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const mag = Math.floor(Math.log10(Math.abs(v)))
  const decimals = Math.max(0, sig - 1 - mag)
  return fmtNumber(v, Math.min(decimals, 10))
}

export function fmt(kind: Kind, si: number, p: UnitPrefs, digits?: number): string {
  const u = unitFor(kind, p)
  const n = digits == null ? fmtSig(si / u.per) : fmtNumber(si / u.per, digits)
  if (!u.label) return n
  return u.label === '°' ? `${n}°` : `${n} ${u.label}`
}

/** For the materials density fields: which kind a material type is shown as. */
export function densityKind(t: 'bulk' | 'surface' | 'line'): Kind {
  return t === 'bulk' ? 'bulkDensity' : t === 'surface' ? 'surfaceDensity' : 'lineDensity'
}

export function parsePrefs(raw: unknown): UnitPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<UnitPrefs>
  return {
    length: LENGTH_UNITS.includes(o.length as LengthUnit) ? (o.length as LengthUnit) : METRIC.length,
    mass: MASS_UNITS.includes(o.mass as MassUnit) ? (o.mass as MassUnit) : METRIC.mass,
  }
}
