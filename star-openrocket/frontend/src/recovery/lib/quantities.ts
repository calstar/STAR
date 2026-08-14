/**
 * What every physical quantity in the GUI is measured in, and how to convert.
 *
 * PLAN.md §1.1 -- SI internally, always; convert at the I/O boundary only.
 * This file IS that boundary. Nothing here is ever fed back into a Config: a
 * stored value is SI before a unit is chosen, while it is chosen, and after it
 * is changed. Switching a unit changes what the screen says and nothing else.
 *
 * Before this existed, units were literals at ~90 render sites and they
 * disagreed: altitude was ft on the vehicle card and m in the events table,
 * mass lb for the vehicle and kg for the canopy, force lbf in the hardware
 * inputs and N in every result. One table fixes that by construction -- there
 * is exactly one place to look up what a kind renders as.
 *
 * Every unit is an AFFINE map, not a scale factor, because temperature needs
 * an offset and getting that wrong is silent:
 *
 *     display = si / perUnit + offset
 *     si      = (display - offset) * perUnit
 */

export type System = 'metric' | 'imperial'

/**
 * The quantities that have a choice. Time (s), dimensionless counts, percent
 * and angle are absent on purpose -- they have no imperial form, so offering a
 * dropdown for them would be a control that does nothing.
 */
export type Kind =
  | 'altitude' | 'length' | 'distance' | 'area'
  | 'mass' | 'speed' | 'accel' | 'force' | 'stiffness' | 'energy'
  | 'pressure' | 'temperature' | 'tempDelta' | 'density' | 'lapse'

export interface UnitDef {
  /** Exactly what the dropdown and every unit chip show. */
  label: string
  /** SI units per one display unit. */
  perUnit: number
  /** Added AFTER dividing. Non-zero for absolute temperature only. */
  offset?: number
  /** Display precision. Unit-dependent: 0 dp is right for 1613 N and wrong
   *  for 0.5 m², which is 5.383 ft². */
  digits: number
  /** Spinner granularity for editable fields, in DISPLAY units -- so it has
   *  to live here and not at the call site, or `step={0.25}` inches becomes
   *  0.25 metres the moment someone switches. */
  step: number
}

/* Exact by definition. Everything imperial below is derived from these four
 * rather than pasted as a decimal, so a value typed in imperial and read back
 * cannot drift a digit, and there is no second place to keep in sync. */
export const M_PER_FT = 0.3048
export const M_PER_IN = 0.0254
export const KG_PER_LB = 0.45359237
export const G0 = 9.80665
export const N_PER_LBF = KG_PER_LB * G0   // 4.4482216152605, exact

export const QUANTITIES: Record<Kind, {
  /** Row label in the Units tab. */
  name: string
  /** The SI unit the wire carries. Documentation, and the thing every
   *  `perUnit` below is relative to. */
  si: string
  metric: UnitDef
  imperial: UnitDef
}> = {
  altitude: {
    name: 'Altitude', si: 'm',
    metric: { label: 'm', perUnit: 1, digits: 0, step: 10 },
    imperial: { label: 'ft', perUnit: M_PER_FT, digits: 0, step: 50 },
  },
  length: {
    name: 'Length', si: 'm',
    metric: { label: 'm', perUnit: 1, digits: 3, step: 0.01 },
    imperial: { label: 'in', perUnit: M_PER_IN, digits: 2, step: 0.25 },
  },
  distance: {
    name: 'Distance', si: 'm',
    metric: { label: 'km', perUnit: 1000, digits: 0, step: 1 },
    imperial: { label: 'mi', perUnit: 1609.344, digits: 0, step: 1 },
  },
  area: {
    name: 'Area', si: 'm²',
    metric: { label: 'm²', perUnit: 1, digits: 4, step: 0.001 },
    imperial: { label: 'ft²', perUnit: M_PER_FT ** 2, digits: 3, step: 0.01 },
  },
  mass: {
    name: 'Mass', si: 'kg',
    metric: { label: 'kg', perUnit: 1, digits: 2, step: 0.05 },
    imperial: { label: 'lb', perUnit: KG_PER_LB, digits: 1, step: 0.1 },
  },
  speed: {
    name: 'Speed', si: 'm/s',
    metric: { label: 'm/s', perUnit: 1, digits: 2, step: 0.5 },
    imperial: { label: 'ft/s', perUnit: M_PER_FT, digits: 1, step: 1 },
  },
  accel: {
    name: 'Acceleration', si: 'm/s²',
    metric: { label: 'm/s²', perUnit: 1, digits: 1, step: 1 },
    imperial: { label: 'ft/s²', perUnit: M_PER_FT, digits: 1, step: 1 },
  },
  force: {
    name: 'Force', si: 'N',
    metric: { label: 'N', perUnit: 1, digits: 0, step: 100 },
    imperial: { label: 'lbf', perUnit: N_PER_LBF, digits: 0, step: 50 },
  },
  stiffness: {
    name: 'Stiffness', si: 'N/m',
    metric: { label: 'N/m', perUnit: 1, digits: 0, step: 100 },
    imperial: { label: 'lbf/in', perUnit: N_PER_LBF / M_PER_IN, digits: 1, step: 1 },
  },
  energy: {
    name: 'Energy', si: 'J',
    metric: { label: 'J', perUnit: 1, digits: 0, step: 10 },
    imperial: { label: 'ft·lbf', perUnit: N_PER_LBF * M_PER_FT, digits: 0, step: 10 },
  },
  pressure: {
    name: 'Pressure', si: 'Pa',
    metric: { label: 'Pa', perUnit: 1, digits: 0, step: 100 },
    imperial: { label: 'psi', perUnit: N_PER_LBF / M_PER_IN ** 2, digits: 2, step: 0.1 },
  },
  temperature: {
    name: 'Temperature', si: 'K',
    metric: { label: 'K', perUnit: 1, digits: 2, step: 0.5 },
    // 5/9 K per °F, then the offset that puts absolute zero at -459.67.
    imperial: { label: '°F', perUnit: 5 / 9, offset: -459.67, digits: 1, step: 1 },
  },
  tempDelta: {
    name: 'Temperature difference', si: 'K',
    metric: { label: 'K', perUnit: 1, digits: 2, step: 0.5 },
    // Same scale as `temperature`, NO offset. A 2 K error is 3.6 °F, not
    // 35.6 °F. This kind exists solely so that distinction cannot be lost.
    imperial: { label: '°F', perUnit: 5 / 9, digits: 2, step: 1 },
  },
  density: {
    name: 'Density', si: 'kg/m³',
    metric: { label: 'kg/m³', perUnit: 1, digits: 4, step: 0.001 },
    imperial: { label: 'lb/ft³', perUnit: KG_PER_LB / M_PER_FT ** 3, digits: 4, step: 0.001 },
  },
  lapse: {
    // NB the SI base is K per METRE, which is what the wire carries -- see the
    // `lapse` doc comment in types/schema.ts. The familiar K/km is already a
    // display conversion, and used to be an inline `* 1000` at three sites.
    name: 'Lapse rate', si: 'K/m',
    metric: { label: 'K/km', perUnit: 1e-3, digits: 2, step: 0.1 },
    imperial: {
      label: '°F/1000 ft',
      perUnit: 1 / ((9 / 5) * 1000 * M_PER_FT),
      digits: 2, step: 0.1,
    },
  },
}

export const KINDS = Object.keys(QUANTITIES) as Kind[]

export type UnitPrefs = Record<Kind, System>

/**
 * What the GUI showed before any of this was configurable, quantity by
 * quantity -- so a fresh install renders exactly as it did.
 *
 * Where the old GUI disagreed with itself, the input boxes win: those are the
 * units the user types in, so the readouts follow them rather than the other
 * way round. That resolves altitude to ft (the events table and trajectory
 * chart move), length to in (D0 moves), mass to lb (canopy mass moves) and
 * force to lbf (every result moves).
 */
export const DEFAULT_PREFS: UnitPrefs = {
  altitude: 'imperial',
  length: 'imperial',
  mass: 'imperial',
  force: 'imperial',
  distance: 'metric',
  area: 'metric',
  speed: 'metric',
  accel: 'metric',
  stiffness: 'metric',
  energy: 'metric',
  pressure: 'metric',
  temperature: 'metric',
  tempDelta: 'metric',
  density: 'metric',
  lapse: 'metric',
}

export const unitFor = (kind: Kind, prefs: UnitPrefs): UnitDef =>
  QUANTITIES[kind][prefs[kind]]

export const toDisplay = (si: number, u: UnitDef): number =>
  si / u.perUnit + (u.offset ?? 0)

export const fromDisplay = (shown: number, u: UnitDef): number =>
  (shown - (u.offset ?? 0)) * u.perUnit

/**
 * Read a stored preferences object leniently.
 *
 * Unknown keys are dropped and missing ones fall back to the default, so a
 * file written by a newer version -- or one hand-edited to nonsense -- can
 * never stop the GUI from opening.
 */
export function parsePrefs(raw: unknown): UnitPrefs {
  const out = { ...DEFAULT_PREFS }
  if (raw === null || typeof raw !== 'object') return out
  for (const kind of KINDS) {
    const v = (raw as Record<string, unknown>)[kind]
    if (v === 'metric' || v === 'imperial') out[kind] = v
  }
  return out
}

/* --- how precise a number looks ------------------------------------------
 *
 * Two bounds, because either alone is wrong. A decimal cap is what makes a
 * converted value readable -- 5.669904625 kg is the exact conversion of
 * 12.5 lb, and nobody wants to read it -- but a cap alone destroys small
 * quantities: at two decimals an airframe drag area of 0.005690 m² renders as
 * "0.01", and one of 0.0048 m² renders as "0.00". So a significant-figure
 * floor sits under it and wins where the two disagree.
 */

export interface Precision {
  /** Never show more decimals than this. The readability bound. */
  maxDecimals: number
  /** ...unless that would show fewer significant figures than this. The
   *  resolution bound -- what keeps 0.005690 from becoming 0.01. */
  minSigFigs: number
}

export const DEFAULT_PRECISION: Precision = { maxDecimals: 2, minSigFigs: 2 }

export const PRECISION_LIMITS = {
  maxDecimals: { min: 0, max: 10 },
  minSigFigs: { min: 1, max: 6 },
}

/** Only so a value of 1e-30 cannot ask for thirty decimals -- `toFixed` throws
 *  above 100 and nothing is readable long before that. */
const DECIMAL_CEILING = 10

/**
 * How many decimals to render `value` with.
 *
 * `fieldDigits` is the precision the field would use on its own: a unit's
 * `digits` from the registry, or `Infinity` for an editable box, which has no
 * natural precision of its own. Both bounds apply to it, and the significant-
 * figure floor wins when they conflict.
 *
 * Note the bound is on DECIMALS, so integer digits are never rounded away. A
 * pad pressure of 101325 Pa reads 101,325 at every setting -- it can never
 * read 101,330, which would look like a measurement error rather than a
 * display choice.
 */
export function decimalsFor(value: number, fieldDigits: number,
                            p: Precision): number {
  const want = Math.min(fieldDigits, p.maxDecimals)
  return Math.min(DECIMAL_CEILING,
                  Math.max(0, want, minSigDecimals(value, p)))
}

/** Decimals needed before `p.minSigFigs` significant figures are visible.
 *  Also the floor below which trailing zeros must not be stripped. */
function minSigDecimals(value: number, p: Precision): number {
  // Zero has no significant figures to preserve, and log10(0) is -Infinity.
  if (!Number.isFinite(value) || value === 0) return 0
  const abs = Math.abs(value)
  return abs >= 1
    // The integer part already supplies some of the significant figures.
    ? Math.max(0, p.minSigFigs - (Math.floor(Math.log10(abs)) + 1))
    // The first significant digit sits at decimal k, so the k - 1 leading
    // zeros have to be paid for before the figures start.
    : Math.ceil(-Math.log10(abs)) + p.minSigFigs - 1
}

/**
 * The same policy, for an editable box.
 *
 * Two differences from a readout. A box has no natural precision of its own,
 * so `fieldDigits` is `Infinity` -- the bounds are the only thing shaping it.
 * And trailing zeros are stripped, because `3000.00 ft`, `12.50 lb` and
 * `4.0 in` are all worse to read and worse to edit than `3000`, `12.5` and
 * `4`.
 */
export function formatForInput(value: number, p: Precision): string {
  let d = decimalsFor(value, Infinity, p)
  // Lossless only: a decimal comes off when dropping it leaves the same
  // number, and not otherwise. That separates the two cases that look alike --
  // a 4 in airframe shows `4`, because the zero in `4.0` carries nothing,
  // while 0.005690 keeps every decimal the significant-figure floor asked for,
  // because dropping one would round it to 0.006.
  while (d > 0 && Number(value.toFixed(d - 1)) === Number(value.toFixed(d))) {
    d -= 1
  }
  return value.toFixed(d)
}

/** As `parsePrefs`: a stored value out of range, or not a number at all, falls
 *  back to the default rather than reaching `toFixed(-3)`, which throws. */
export function parsePrecision(raw: unknown): Precision {
  const out = { ...DEFAULT_PRECISION }
  if (raw === null || typeof raw !== 'object') return out
  for (const key of ['maxDecimals', 'minSigFigs'] as const) {
    const v = (raw as Record<string, unknown>)[key]
    const { min, max } = PRECISION_LIMITS[key]
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) {
      out[key] = v
    }
  }
  return out
}
