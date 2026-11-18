/**
 * The ORK vs CAD table's logic: which rows exist, what each side contributes,
 * that a with-motor number is only ever set against a with-motor number, and the
 * Δ / Δ % / highlight arithmetic. Plus the unit handling of the cells.
 */
import { describe, expect, it } from 'vitest'
import type { Analysis, Component, RocketDocument } from '@openrocket-web'

import { cadSide, compareRows, delta, finGeometry, orkSide, severity, type Row } from './orkCompare'
import { formatCell, formatDelta, formatPct, type UnitFormatter } from '../components/orkcompare/format'
import { DEFAULT_PRECISION, DEFAULT_PREFS, decimalsFor, snapDisplay, toDisplay, unitFor } from './units/quantities'
import type { Kind, UnitPrefs } from './units/quantities'
import type { MotorResult, StabilityResult } from '../types'

// -- fixtures -------------------------------------------------------------------

/** A CAD result shaped like POST /stability's: 1.2 m, 0.1 m body, 3 trapezoidal fins. */
function stability(motor: Partial<MotorResult> | null = null): StabilityResult {
  return {
    cg: { world: [0, 0, 0.7], fromNose: 0.7 },
    cp: { world: [0, 0, 0.9], fromNose: 0.9 },
    axisDirection: [0, 0, 1],
    cna: 9.5,
    refDiameter: 0.1,
    rMax: 0.05,
    staticMargin: 2.0,
    bodyLength: 1.2,
    mass: 3.0,
    fins: { count: 3, cna: 7.5, rootChord: 0.16, tipChord: 0.06, sweep: 0.09, span: 0.07, area: 0.0077, planforms: [], symmetric: true },
    motor: motor
      ? ({
          motorId: 'm', simfileId: 's', name: 'Cesaroni J500', quality: 'full', format: 'RASP', state: 'launch',
          wetMass: 1.0, dryMass: 0.4, propMass: 0.6, length: 0.4, diameter: 0.054, burnTime: 2,
          cgFromNose: 1.0, aftFromBase: 0, aftWorld: null, foreWorld: null, radius: 0.027, cgWorld: [0, 0, 1.0],
          ...motor,
        } as MotorResult)
      : null,
  }
}

function comp(type: Component['type'], name: string, params: Component['params'] = {}, children: Component[] = []): Component {
  return { id: `${type}-${name}`, type, name, params, children }
}

function document(fins: Component[], withNose = true): RocketDocument {
  const nose = comp('nosecone', 'Nose', { length: 0.3, shape: 'ogive' })
  const tube = comp('bodytube', 'Body', { length: 0.9, radius: { auto: false, value: 0.05 } }, fins)
  const stage = comp('stage', 'Sustainer', {}, withNose ? [nose, tube] : [tube])
  return {
    version: 1,
    rocket: comp('rocket', 'Synthetic', {}, [stage]),
    motorConfigs: [{ id: 'cfg', name: '', default: true, stages: { '0': true }, motors: {} }],
    selectedConfig: 'cfg',
  }
}

function analysis(doc: RocketDocument, opts: { motors?: boolean; finCna?: number; ref?: number } = {}): Analysis {
  const ids: Component[] = []
  const walk = (c: Component) => {
    ids.push(c)
    c.children.forEach(walk)
  }
  walk(doc.rocket)
  return {
    conditions: { mach: 0.3, aoaDeg: 0, rollRate: 0, theta: 0, configId: 'cfg' },
    reference: { length: opts.ref ?? 0.1, area: Math.PI * ((opts.ref ?? 0.1) / 2) ** 2 },
    length: 1.2,
    lengthAerodynamic: 1.2,
    maxDiameter: 0.1,
    cg: opts.motors ? { x: 0.77, mass: 4.0 } : { x: 0.7, mass: 3.0 },
    cgEmpty: { x: 0.7, mass: 3.0 },
    cp: { x: 0.9, cna: 9.5 },
    stability: { calibers: 2, percent: 16.7 },
    cd: { total: 0.5, friction: 0.3, pressure: 0.1, base: 0.1 },
    components: ids.map((c) => ({
      id: c.id, name: c.name, type: c.type, x: 0, length: 0, mass: 0, cgx: 0, cpx: 0,
      cna: c.type.endsWith('finset') ? (opts.finCna ?? 7.5) : 0, cd: 0,
    })),
    motors: opts.motors
      ? [{ mount: 'x', designation: 'J500', manufacturer: 'Cesaroni', diameter: 0.054, length: 0.4, x: 0, count: 1, absoluteX: [0.8], launchMass: 1, burnoutMass: 0.4 }]
      : [],
    figure: { bounds: { xmin: 0, xmax: 1.2, ymin: -0.1, ymax: 0.1 }, shapes: [] },
    warnings: [],
  } as Analysis
}

const TRAP = comp('trapezoidfinset', 'Fins', { instancecount: 3, rootchord: 0.16, tipchord: 0.06, height: 0.07, sweeplength: 0.09 })
const byId = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id, r]))

// -- CAD side -------------------------------------------------------------------

describe('cadSide', () => {
  it('without a motor, the result is the empty rocket and there is no with-motor state', () => {
    const s = cadSide(stability())
    expect(s.empty).toEqual({ mass: 3.0, cg: 0.7 })
    expect(s.withMotor).toBeNull()
  })

  it('with a motor at launch, separates the empty rocket from the loaded one', () => {
    // 3 kg at 0.7 m includes a 1 kg motor at 1.0 m -> 2 kg at (2.1 - 1.0) / 2 = 0.55 m
    const s = cadSide(stability({ state: 'launch' }))
    expect(s.withMotor).toEqual({ mass: 3.0, cg: 0.7 })
    expect(s.empty.mass).toBeCloseTo(2.0, 12)
    expect(s.empty.cg).toBeCloseTo(0.55, 12)
  })

  it('with a motor at burnout, takes out the dry mass and offers no with-motor state', () => {
    const s = cadSide(stability({ state: 'burnout' }))
    expect(s.withMotor).toBeNull()
    expect(s.empty.mass).toBeCloseTo(2.6, 12)
    expect(s.empty.cg).toBeCloseTo((3 * 0.7 - 0.4 * 1.0) / 2.6, 12)
    expect(s.notes.join(' ')).toMatch(/burnout/)
  })
})

// -- ORK side -------------------------------------------------------------------

describe('orkSide', () => {
  it('has a with-motor state only when the configuration has motors', () => {
    const doc = document([TRAP])
    expect(orkSide(doc, analysis(doc)).withMotor).toBeNull()
    expect(orkSide(doc, analysis(doc, { motors: true })).withMotor).toEqual({ mass: 4.0, cg: 0.77 })
    expect(orkSide(doc, analysis(doc, { motors: true })).empty).toEqual({ mass: 3.0, cg: 0.7 })
  })

  it('compares the fin set with the most area, and says which', () => {
    const small = comp('trapezoidfinset', 'Canards', { instancecount: 4, rootchord: 0.03, tipchord: 0.02, height: 0.02, sweeplength: 0 })
    const doc = document([small, TRAP])
    const s = orkSide(doc, analysis(doc))
    expect(s.fins?.rootChord).toBe(0.16)
    expect(s.fins?.count).toBe(3)
    expect(s.notes.join(' ')).toContain('"Fins"')
  })

  it('ignores a fin set the analysed configuration does not fly', () => {
    const doc = document([TRAP])
    const a = analysis(doc)
    a.components = a.components.filter((c) => c.type !== 'trapezoidfinset')
    expect(orkSide(doc, a).fins).toBeNull()
  })

  it('reads the nose cone', () => {
    const doc = document([TRAP])
    expect(orkSide(doc, analysis(doc)).nose).toEqual({ length: 0.3, shape: 'ogive' })
  })
})

describe('finGeometry', () => {
  it('trapezoidal: the params, area (root + tip) / 2 * height', () => {
    expect(finGeometry(TRAP)).toEqual({ count: 3, rootChord: 0.16, tipChord: 0.06, span: 0.07, sweep: 0.09, area: 0.11 * 0.07 })
  })

  it('freeform (what the CAD export writes): read from the outline', () => {
    const ff = comp('freeformfinset', 'CAD fins', {
      instancecount: 3,
      finpoints: [[0, 0], [0.09, 0.07], [0.15, 0.07], [0.16, 0]],
    })
    const g = finGeometry(ff)!
    expect(g.rootChord).toBeCloseTo(0.16, 12)
    expect(g.tipChord).toBeCloseTo(0.06, 12)
    expect(g.span).toBeCloseTo(0.07, 12)
    expect(g.sweep).toBeCloseTo(0.09, 12)
    expect(g.area).toBeCloseTo(0.11 * 0.07, 12) // a trapezoid, by the shoelace
  })

  it('elliptical: π/4 root * height', () => {
    const e = comp('ellipticalfinset', 'E', { instancecount: 4, rootchord: 0.1, height: 0.05 })
    expect(finGeometry(e)!.area).toBeCloseTo((Math.PI / 4) * 0.1 * 0.05, 12)
  })
})

// -- rows -----------------------------------------------------------------------

describe('compareRows', () => {
  it('pairs empty with empty, and with-motor only with with-motor', () => {
    const doc = document([TRAP])
    // Neither has a motor: no with-motor rows at all.
    let rows = byId(compareRows(cadSide(stability()), orkSide(doc, analysis(doc))))
    expect(rows.cgLoaded).toBeUndefined()
    // CAD has a motor, ORK has none: the loaded CAD CG is shown but set against nothing.
    rows = byId(compareRows(cadSide(stability({ state: 'launch' })), orkSide(doc, analysis(doc))))
    for (const id of ['cgLoaded', 'massLoaded', 'marginLoaded']) {
      expect(rows[id].ork, id).toBeNull()
      expect(rows[id].delta, id).toBeNull()
      expect(rows[id].severity, id).toBe('na')
    }
    expect(rows.cgLoaded.cad).toBe(0.7)
    // And the other way round: ORK loaded, CAD empty -- the CAD's empty CG must not fill in.
    const reverse = byId(compareRows(cadSide(stability()), orkSide(doc, analysis(doc, { motors: true }))))
    for (const id of ['cgLoaded', 'massLoaded', 'marginLoaded']) {
      expect(reverse[id].cad, id).toBeNull()
      expect(reverse[id].severity, id).toBe('na')
    }
    expect(reverse.cgLoaded.ork).toBe(0.77)
    expect(rows.cgEmpty.cad).toBeCloseTo(0.55, 12) // the CAD's EMPTY CG, not its 0.7 loaded one
    expect(rows.cgEmpty.ork).toBe(0.7)

    rows = byId(compareRows(cadSide(stability({ state: 'launch' })), orkSide(doc, analysis(doc, { motors: true }))))
    expect(rows.cgLoaded.cad).toBe(0.7)
    expect(rows.cgLoaded.ork).toBe(0.77)
    expect(rows.massLoaded.cad).toBe(3.0)
    expect(rows.massLoaded.ork).toBe(4.0)
  })

  it('compares an identical rocket as identical', () => {
    const doc = document([TRAP])
    const rows = compareRows(cadSide(stability()), orkSide(doc, analysis(doc)))
    const numeric = rows.filter((r) => r.cad != null && r.ork != null)
    expect(numeric.length).toBeGreaterThan(12)
    for (const r of numeric) {
      expect(r.delta, r.id).toBeCloseTo(0, 12)
      expect(r.severity, r.id).toBe('ok')
    }
  })

  it('has the rows the tab promises', () => {
    const doc = document([TRAP])
    const ids = compareRows(cadSide(stability()), orkSide(doc, analysis(doc))).map((r) => r.id)
    for (const id of ['length', 'refDiameter', 'massEmpty', 'cgEmpty', 'cp', 'cna', 'marginEmpty', 'finCount',
      'finRoot', 'finTip', 'finSpan', 'finSweep', 'finArea', 'noseLength', 'noseShape'])
      expect(ids).toContain(id)
  })

  it('leaves a side empty, unflagged, when it is missing', () => {
    const rows = compareRows(cadSide(stability()), null)
    expect(rows.every((r) => r.ork == null && r.severity === 'na')).toBe(true)
    expect(byId(rows).length.cad).toBe(1.2)
  })

  it('flags a different fin count', () => {
    const doc = document([{ ...TRAP, params: { ...TRAP.params, instancecount: 4 } }])
    expect(byId(compareRows(cadSide(stability()), orkSide(doc, analysis(doc)))).finCount.severity).toBe('bad')
  })

  it('rescales ORK CNα onto the CAD reference diameter', () => {
    const doc = document([TRAP])
    // Same rocket described on a 0.2 m reference: CNα·d² is the same, so CNα is a quarter.
    const a = analysis(doc, { ref: 0.2, finCna: 7.5 / 4 })
    a.cp = { x: 0.9, cna: 9.5 / 4 }
    const rows = byId(compareRows(cadSide(stability()), orkSide(doc, a)))
    expect(rows.cna.ork).toBeCloseTo(9.5, 12)
    expect(rows.finCna.ork).toBeCloseTo(7.5, 12)
    expect(rows.cna.hint).toMatch(/rescaled/)
  })

  it('computes each margin on its own reference diameter', () => {
    const doc = document([TRAP])
    const a = analysis(doc)
    a.cp = { x: 0.95, cna: 9.5 }
    const rows = byId(compareRows(cadSide(stability()), orkSide(doc, a)))
    expect(rows.marginEmpty.cad).toBeCloseTo(2.0, 12)
    expect(rows.marginEmpty.ork).toBeCloseTo(2.5, 12)
    expect(rows.marginEmpty.delta).toBeCloseTo(0.5, 12)
    expect(rows.marginEmpty.severity).toBe('bad')
  })
})

describe('delta and severity', () => {
  it('Δ is ORK − CAD and Δ % is of the CAD value', () => {
    expect(delta(100, 105)).toEqual({ delta: 5, deltaPct: 5 })
    expect(delta(-2, -1)).toEqual({ delta: 1, deltaPct: 50 })
    expect(delta(0, 1)).toEqual({ delta: 1, deltaPct: null })
    expect(delta(null, 1)).toEqual({ delta: null, deltaPct: null })
  })

  it('treats float noise as no difference', () => {
    expect(delta(2.7526301622113483, 2.752630162211348)).toEqual({ delta: 0, deltaPct: 0 })
    expect(delta(1, 1 + 1e-6).delta).toBeCloseTo(1e-6, 15)
  })

  it('grades sizes by percent, margins by calibers, counts exactly', () => {
    expect(severity('length', 1, 1.01)).toBe('ok')
    expect(severity('length', 1, 1.02)).toBe('warn')
    expect(severity('length', 1, 1.05)).toBe('bad')
    expect(severity('mass', 2, 1.9)).toBe('bad')
    expect(severity('cal', 2.0, 2.05)).toBe('ok')
    expect(severity('cal', 0.05, 0.2)).toBe('warn') // 300 % but 0.15 cal
    expect(severity('cal', 2.0, 1.7)).toBe('bad')
    expect(severity('count', 3, 3)).toBe('ok')
    expect(severity('count', 3, 4)).toBe('bad')
    expect(severity('length', 0, 0)).toBe('ok')
    expect(severity('length', 0, 0.01)).toBe('bad')
    expect(severity('length', null, 1)).toBe('na')
  })
})

// -- units ----------------------------------------------------------------------

/** The units context's formatter, without React (same arithmetic as lib/units/unitsContext). */
function formatter(prefs: UnitPrefs): UnitFormatter {
  const render = (v: number, fieldDigits: number) => v.toFixed(decimalsFor(v, fieldDigits, DEFAULT_PRECISION))
  return {
    num: (si, kind: Kind, digits) => {
      if (si == null || !Number.isFinite(si)) return '-'
      const def = unitFor(kind, prefs)
      return render(snapDisplay(toDisplay(si, def)), digits ?? def.digits)
    },
    lab: (kind) => unitFor(kind, prefs).label,
    dec: (v, digits) => (v == null ? '-' : render(v, digits ?? Infinity)),
  }
}

describe('cell formatting follows the unit preferences', () => {
  const imperial = formatter(DEFAULT_PREFS)
  const metric = formatter({ ...DEFAULT_PREFS, length: 'metric', mass: 'metric' })

  it('lengths and masses in the chosen system', () => {
    expect(formatCell(0.0254, 'length', imperial)).toBe('1.00 in')
    expect(formatCell(0.0254, 'length', metric)).toBe('0.025 m')
    expect(formatCell(0.45359237, 'mass', imperial)).toBe('1.00 lb')
    expect(formatCell(1, 'mass', metric)).toBe('1.00 kg')
  })

  it('dimensionless rows stay plain', () => {
    expect(formatCell(3, 'count', imperial)).toBe('3')
    expect(formatCell(2.345, 'cal', imperial)).toBe('2.35 cal')
    expect(formatCell(null, 'length', imperial)).toBe('—')
  })

  it('signs the difference and its percentage', () => {
    expect(formatDelta(-0.0254, 'length', imperial)).toBe('−1.00 in')
    expect(formatDelta(0.0254, 'length', imperial)).toBe('+1.00 in')
    expect(formatPct(5)).toBe('+5.00 %')
    expect(formatPct(-12.34)).toBe('−12.3 %')
    expect(formatPct(null)).toBe('—')
  })
})
