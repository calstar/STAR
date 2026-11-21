/**
 * ORK vs CAD: the rows of the comparison table, derived from the two sides' own
 * results and nothing else.
 *
 * CAD is the CAD tab's StabilityResult (POST /api/models/{id}/stability, the mesh
 * Barrowman at Mach 0.3, AoA 0). ORK is the OpenRocket tab's document and its
 * analysis (POST /api/ork/analyze, openrocket-web's port of OpenRocket 24.12, asked
 * for at the same Mach 0.3, AoA 0 -- OpenRocket's own design-view default).
 *
 * Pure functions, SI in and out: the tab formats them in the user's units. The one
 * rule that matters is that a row only ever pairs like with like -- a CG with the
 * motor in against a CG with the motor in, never against an empty one. So each side
 * reports the states it has (empty always; with motor only when it has a motor at
 * launch), and a with-motor row compares only when both sides have that state --
 * a side without it shows nothing there, never its empty number.
 */
import type { Analysis, Component, RocketDocument } from '@openrocket-web'
import type { StabilityResult } from '../types'

/** The Mach both sides are evaluated at: compute_stability's default, and OpenRocket's design view. */
export const COMPARE_MACH = 0.3

/** How a row's numbers are shown: a unit kind of star-openrocket's unit system, or a plain number. */
export type RowUnit = 'length' | 'mass' | 'area' | 'count' | 'cal' | 'perRad' | 'text'

export type Severity = 'ok' | 'warn' | 'bad' | 'na'

export interface FinSide {
  count: number
  rootChord: number
  tipChord: number
  /** Fin height, root to tip (OpenRocket's "height"). */
  span: number
  /** Leading-edge sweep length, root LE to tip LE along the axis. */
  sweep: number
  /** One fin's planform area. */
  area: number
  /** The fin set's CNα, on this side's own reference area. */
  cna: number | null
}

export interface MassState {
  mass: number
  cg: number
}

/** Everything one side contributes; null where the side has no such number. */
export interface Side {
  length: number
  refDiameter: number
  maxDiameter: number
  cp: number
  /** CNα on this side's own reference diameter. */
  cna: number
  empty: MassState
  /** With the motor loaded at launch. Null when the side has no motor (or not at launch). */
  withMotor: MassState | null
  fins: FinSide | null
  nose: { length: number; shape: string } | null
  /** Why a state or a value is missing or how it was chosen, for the table's footnotes. */
  notes: string[]
}

// -- CAD -----------------------------------------------------------------------

/**
 * The CAD side, from a StabilityResult. Its `mass`/`cg` include the motor when one
 * was selected; the empty state is that minus the motor, which the result carries
 * with its own CG -- the same algebra the backend did forwards, done backwards.
 */
export function cadSide(st: StabilityResult): Side {
  const notes: string[] = []
  const total: MassState = { mass: st.mass, cg: st.cg.fromNose }
  let empty = total
  let withMotor: MassState | null = null
  const m = st.motor
  if (m) {
    const mMotor = m.state === 'burnout' ? m.dryMass : m.wetMass
    const mEmpty = st.mass - mMotor
    if (m.cgFromNose != null && mEmpty > 0) {
      empty = { mass: mEmpty, cg: (st.mass * st.cg.fromNose - mMotor * m.cgFromNose) / mEmpty }
    } else {
      notes.push('The CAD result has no motor CG, so its empty CG cannot be separated from the motor.')
      empty = { mass: NaN, cg: NaN }
    }
    if (m.state === 'launch') withMotor = total
    else
      notes.push(
        `The CAD motor (${m.name}) is at burnout; OpenRocket's with-motor numbers are at launch, so they are not compared. Set it to launch in the CAD tab to compare them.`,
      )
  }
  const f = st.fins
  return {
    length: st.bodyLength,
    refDiameter: st.refDiameter,
    maxDiameter: 2 * st.rMax,
    cp: st.cp.fromNose,
    cna: st.cna,
    empty,
    withMotor,
    fins:
      f && f.count > 0
        ? { count: f.count, rootChord: f.rootChord, tipChord: f.tipChord, span: f.span, sweep: f.sweep, area: f.area, cna: f.cna }
        : null,
    nose: null,
    notes,
  }
}

// -- ORK -----------------------------------------------------------------------

const FIN_TYPES = new Set(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'])

/** A param's number: plain, or the `value` of an auto/position object. */
export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object' && 'value' in v) {
    const x = (v as { value: unknown }).value
    return typeof x === 'number' && Number.isFinite(x) ? x : null
  }
  return null
}

function shoelace(pts: [number, number][]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/**
 * One fin set's planform, the way OpenRocket describes it. Trapezoidal and elliptical
 * fins carry it as params; a freeform one (which is what the CAD export writes) is read
 * from its outline: root chord along y = 0, span the highest point, tip chord the run
 * at that height, sweep the tip's leading edge.
 */
export function finGeometry(c: Component): Omit<FinSide, 'cna'> | null {
  const p = c.params
  const count = num(p.instancecount) ?? num(p.fincount) ?? 1
  if (c.type === 'trapezoidfinset') {
    const root = num(p.rootchord) ?? 0
    const tip = num(p.tipchord) ?? 0
    const span = num(p.height) ?? 0
    return { count, rootChord: root, tipChord: tip, span, sweep: num(p.sweeplength) ?? 0, area: ((root + tip) / 2) * span }
  }
  if (c.type === 'ellipticalfinset') {
    const root = num(p.rootchord) ?? 0
    const span = num(p.height) ?? 0
    return { count, rootChord: root, tipChord: 0, span, sweep: 0, area: (Math.PI / 4) * root * span }
  }
  if (c.type === 'freeformfinset') {
    const pts = (Array.isArray(p.finpoints) ? p.finpoints : []) as [number, number][]
    if (pts.length < 3) return null
    const span = Math.max(...pts.map(([, y]) => y))
    const atRoot = pts.filter(([, y]) => Math.abs(y) < 1e-9).map(([x]) => x)
    const rootLe = atRoot.length ? Math.min(...atRoot) : pts[0][0]
    const rootTe = atRoot.length ? Math.max(...atRoot) : pts[pts.length - 1][0]
    const tol = Math.max(1e-9, 1e-6 * span)
    const atTip = pts.filter(([, y]) => Math.abs(y - span) <= tol).map(([x]) => x)
    const tipLe = Math.min(...atTip)
    const tipTe = Math.max(...atTip)
    return { count, rootChord: rootTe - rootLe, tipChord: tipTe - tipLe, span, sweep: tipLe - rootLe, area: shoelace(pts) }
  }
  return null
}

function walk(c: Component, out: Component[]): Component[] {
  out.push(c)
  for (const ch of c.children ?? []) walk(ch, out)
  return out
}

/** The ORK side, from the open document and its analysis at COMPARE_MACH. */
export function orkSide(doc: RocketDocument, a: Analysis): Side {
  const notes: string[] = []
  // Only what the analysed configuration flies: a fin set on an inactive stage is not in it.
  const inConfig = new Map(a.components.map((r) => [r.id, r]))
  const all = walk(doc.rocket, []).filter((c) => inConfig.has(c.id))

  const finSets = all
    .filter((c) => FIN_TYPES.has(c.type))
    .map((c) => ({ c, g: finGeometry(c) }))
    .filter((x): x is { c: Component; g: Omit<FinSide, 'cna'> } => x.g != null)
  let fins: FinSide | null = null
  if (finSets.length) {
    const best = finSets.reduce((b, x) => (x.g.area * x.g.count > b.g.area * b.g.count ? x : b))
    fins = { ...best.g, cna: inConfig.get(best.c.id)?.cna ?? null }
    if (finSets.length > 1)
      notes.push(
        `The OpenRocket design has ${finSets.length} fin sets; the fin rows compare "${best.c.name}", the one with the most area.`,
      )
  }
  const tubeFins = all.filter((c) => c.type === 'tubefinset')
  if (tubeFins.length) notes.push(`Tube fins (${tubeFins.map((c) => c.name).join(', ')}) are not compared.`)

  const noseC = all.find((c) => c.type === 'nosecone')
  const nose = noseC
    ? { length: num(noseC.params.length) ?? NaN, shape: typeof noseC.params.shape === 'string' ? noseC.params.shape : '' }
    : null

  const hasMotor = (a.motors?.length ?? 0) > 0
  return {
    length: a.length,
    refDiameter: a.reference.length,
    maxDiameter: a.maxDiameter,
    cp: a.cp.x,
    cna: a.cp.cna,
    empty: { mass: a.cgEmpty.mass, cg: a.cgEmpty.x },
    withMotor: hasMotor ? { mass: a.cg.mass, cg: a.cg.x } : null,
    fins,
    nose,
    notes,
  }
}

// -- rows ----------------------------------------------------------------------

export interface Row {
  id: string
  label: string
  unit: RowUnit
  cad: number | null
  ork: number | null
  /** For text rows (nose shape). */
  cadText?: string
  orkText?: string
  /** ORK − CAD, SI. */
  delta: number | null
  /** 100 · (ORK − CAD) / |CAD|; null when CAD is zero or either side is missing. */
  deltaPct: number | null
  severity: Severity
  hint?: string
}

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/** ORK − CAD, and that as a percentage of CAD. */
export function delta(cad: number | null, ork: number | null): { delta: number | null; deltaPct: number | null } {
  if (!ok(cad) || !ok(ork)) return { delta: null, deltaPct: null }
  // A difference at the level of float noise (the same number carried through two
  // programs) is no difference: snapped to 0, so it neither prints as -0.0000000000
  // nor flags.
  const raw = ork - cad
  const d = Math.abs(raw) <= 1e-9 * Math.max(Math.abs(cad), Math.abs(ork)) ? 0 : raw
  return { delta: d, deltaPct: Math.abs(cad) > 1e-12 ? (100 * d) / Math.abs(cad) : null }
}

/**
 * How large a difference is, by kind. Percentages for physical sizes (warn ≥ 2 %,
 * bad ≥ 5 %); calibers absolutely for the margin (warn ≥ 0.1, bad ≥ 0.25 cal), since
 * a percentage of a margin near zero means nothing; counts must match exactly.
 */
export function severity(unit: RowUnit, cad: number | null, ork: number | null): Severity {
  if (!ok(cad) || !ok(ork)) return 'na'
  const { delta: d, deltaPct: pct } = delta(cad, ork)
  if (d == null) return 'na'
  if (unit === 'count') return d === 0 ? 'ok' : 'bad'
  if (unit === 'cal') return Math.abs(d) >= 0.25 ? 'bad' : Math.abs(d) >= 0.1 ? 'warn' : 'ok'
  if (pct == null) return Math.abs(d) < 1e-6 ? 'ok' : 'bad'
  const a = Math.abs(pct)
  return a >= 5 ? 'bad' : a >= 2 ? 'warn' : 'ok'
}

function row(id: string, label: string, unit: RowUnit, cad: number | null, ork: number | null, hint?: string): Row {
  const c = ok(cad) ? cad : null
  const o = ok(ork) ? ork : null
  return { id, label, unit, cad: c, ork: o, ...delta(c, o), severity: severity(unit, c, o), hint }
}

/**
 * The table. Either side may be absent (not computed yet / no document): its column
 * is then empty and nothing is flagged. The with-motor rows appear when either side
 * has a motor at launch, and carry a number (and a Δ) only for the sides that do.
 */
export function compareRows(cad: Side | null, ork: Side | null): Row[] {
  const rows: Row[] = []
  rows.push(row('length', 'Total length', 'length', cad?.length ?? null, ork?.length ?? null))
  rows.push(row('refDiameter', 'Reference diameter', 'length', cad?.refDiameter ?? null, ork?.refDiameter ?? null))
  rows.push(row('maxDiameter', 'Max. body diameter', 'length', cad?.maxDiameter ?? null, ork?.maxDiameter ?? null))

  rows.push(row('massEmpty', 'Mass, empty (no motor)', 'mass', cad?.empty.mass ?? null, ork?.empty.mass ?? null))
  const loaded = Boolean(cad?.withMotor || ork?.withMotor)
  const cadM = cad?.withMotor ?? null
  const orkM = ork?.withMotor ?? null
  if (loaded) rows.push(row('massLoaded', 'Mass, with motor (launch)', 'mass', cadM?.mass ?? null, orkM?.mass ?? null))
  rows.push(row('cgEmpty', 'CG from nose, empty', 'length', cad?.empty.cg ?? null, ork?.empty.cg ?? null))
  if (loaded) rows.push(row('cgLoaded', 'CG from nose, with motor', 'length', cadM?.cg ?? null, orkM?.cg ?? null))
  rows.push(row('cp', `CP from nose (Mach ${COMPARE_MACH}, α 0°)`, 'length', cad?.cp ?? null, ork?.cp ?? null))

  // CNα is per the side's own reference area. Rescale ORK's onto the CAD's reference
  // diameter (CNα·d² is what is invariant) so a different reference is not read as a
  // different rocket; say so when it changed anything.
  const scale = cad && ork && cad.refDiameter > 0 ? (ork.refDiameter / cad.refDiameter) ** 2 : 1
  const rescaled = Math.abs(scale - 1) > 1e-6
  const hintRef = rescaled ? 'ORK CNα rescaled to the CAD reference diameter' : undefined
  rows.push(row('cna', 'CNα (per rad)', 'perRad', cad?.cna ?? null, ork ? ork.cna * scale : null, hintRef))

  // Static margin on each side's own reference diameter, as each program prints it.
  const margin = (s: Side | null, st: MassState | null | undefined) =>
    s && st && s.refDiameter > 0 ? (s.cp - st.cg) / s.refDiameter : null
  rows.push(row('marginEmpty', 'Static margin, empty', 'cal', margin(cad, cad?.empty), margin(ork, ork?.empty)))
  if (loaded) rows.push(row('marginLoaded', 'Static margin, with motor', 'cal', margin(cad, cadM), margin(ork, orkM)))

  const cf = cad?.fins ?? null
  const of = ork?.fins ?? null
  rows.push(row('finCount', 'Fin count', 'count', cf?.count ?? (cad ? 0 : null), of?.count ?? (ork ? 0 : null)))
  rows.push(row('finRoot', 'Fin root chord', 'length', cf?.rootChord ?? null, of?.rootChord ?? null))
  rows.push(row('finTip', 'Fin tip chord', 'length', cf?.tipChord ?? null, of?.tipChord ?? null))
  rows.push(row('finSpan', 'Fin span (height)', 'length', cf?.span ?? null, of?.span ?? null))
  rows.push(row('finSweep', 'Fin sweep length', 'length', cf?.sweep ?? null, of?.sweep ?? null))
  rows.push(row('finArea', 'Fin area (one fin)', 'area', cf?.area ?? null, of?.area ?? null))
  rows.push(row('finCna', 'Fin set CNα (per rad)', 'perRad', cf?.cna ?? null, of?.cna != null ? of.cna * scale : null, hintRef))

  const noseLen = ork?.nose?.length ?? null
  rows.push({
    ...row('noseLength', 'Nose cone length', 'length', null, noseLen, 'the CAD result does not separate the nose from the body'),
    severity: 'na',
  })
  if (ork?.nose?.shape)
    rows.push({ ...row('noseShape', 'Nose cone shape', 'text', null, null), cadText: undefined, orkText: ork.nose.shape })
  return rows
}
