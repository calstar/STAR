/**
 * The design study's resolver, and the rules the chart depends on.
 *
 * The resolver is duplicated on purpose -- `physics/study.axis_values` computes
 * the same grid -- because the GUI shows the resolved values and the run count
 * BEFORE the backend is ever called. If the two disagreed, the user would tick
 * through a study that is not the one computed, and nothing would say so. The
 * LINEAR_CASES table below is the same table as in `tests/test_study.py`; they
 * are meant to be edited together.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_RUNS, STUDY_VARS, axisKind, axisValueLabel, axisValues, runCount,
  studyVar,
} from './study'
import { QUANTITIES } from './quantities'
import type { UiStudyAxis } from '../types/schema'
import { STUDY_COLOURS, studyColour } from '../components/chartTheme'

function linear(start: number, stop: number, points: number): UiStudyAxis {
  return {
    uid: 'a1', key: 'm', device: null, enabled: true, mode: 'linear',
    start, stop, points, values: null, canopies: null,
  }
}

function list(values: number[], enabled = true): UiStudyAxis {
  return {
    uid: 'a2', key: 'n', device: 'main', enabled, mode: 'list',
    start: null, stop: null, points: null, values, canopies: null,
  }
}

/** THE SHARED CASE TABLE. Mirrored in `tests/test_study.py::LINEAR_CASES`. */
const LINEAR_CASES: [number, number, number, number[]][] = [
  [0, 1, 2, [0, 1]],
  [800, 2000, 5, [800, 1100, 1400, 1700, 2000]],
  [5, 5, 3, [5, 5, 5]],
  [1, 2, 1, [1]],
  [2000, 800, 3, [2000, 1400, 800]],
]

describe('axis values', () => {
  it.each(LINEAR_CASES)(
    'linear %d to %d in %d points includes both ends',
    (start, stop, points, expected) => {
      // `points` is how many values you get, not how many gaps. There is no
      // reading of "5 points from 800 to 2000" whose answer excludes 2000.
      const got = axisValues(linear(start, stop, points))
      expect(got).toHaveLength(points)
      expect(got).toEqual(expected)
    })

  it('ends on the stop verbatim, not start + (n-1)*step', () => {
    // Those differ in the last digit, and a top-of-range reading
    // 1999.9999999999998 looks like a bug in the physics rather than IEEE 754.
    expect(axisValues(linear(1, 2, 7)).at(-1)).toBe(2)
  })

  it('takes a list verbatim', () => {
    expect(axisValues(list([6, 8, 12]))).toEqual([6, 8, 12])
  })

  it('is unit-free — SI in, SI out, no converter anywhere', () => {
    // The grid is arithmetic on stored values. Units are applied when a value
    // is *shown*, never when it is resolved, or switching to feet would move
    // the designs being compared.
    expect(axisValues(linear(152.4, 457.2, 3))).toEqual([152.4, 304.79999999999995, 457.2])
  })

  it('returns nothing for an incomplete linear axis rather than guessing', () => {
    const half = { ...linear(1, 2, 3), stop: null }
    expect(axisValues(half)).toEqual([])
  })
})

describe('run count', () => {
  it('is the product over enabled axes', () => {
    expect(runCount([linear(0, 1, 4), list([6, 8, 12])])).toBe(12)
  })

  it('excludes disabled axes without zeroing the product', () => {
    // Off is not the same as pinned: the parameter keeps its configured value
    // and contributes a factor of one, not of zero.
    expect(runCount([linear(0, 1, 4), list([6, 8, 12], false)])).toBe(4)
  })

  it('is 1 with no axes at all — the design you already have', () => {
    expect(runCount([])).toBe(1)
  })

  it('agrees with the backend limit', () => {
    // Mirrors `physics.study.MAX_RUNS`. The backend enforces it; this constant
    // only exists so the button can go grey before anyone presses it.
    expect(MAX_RUNS).toBe(20)
    expect(runCount([linear(0, 1, 20)])).toBe(MAX_RUNS)
    expect(runCount([linear(0, 1, 21)])).toBeGreaterThan(MAX_RUNS)
  })
})

describe('variables', () => {
  it('declares a kind for everything with a physical dimension', () => {
    // A study value the user types must land in the right unit. Anything
    // without a kind has to be genuinely dimensionless or in seconds --
    // `quantities.ts` deliberately offers no dropdown for those.
    const dimensionless = ['canopy', 'trigger', 'n', 'Cx', 'j', 'delay']
    for (const v of STUDY_VARS) {
      if (dimensionless.includes(v.key)) continue
      expect(v.kind, `${v.key} needs a kind`).toBeDefined()
    }
  })

  it('only names kinds that exist', () => {
    // A typo'd kind would otherwise throw the first time someone opened that
    // row, not at build time.
    for (const v of STUDY_VARS) {
      if (v.kind) expect(Object.keys(QUANTITIES)).toContain(v.kind)
    }
  })

  it('makes the canopy list-only — there is nothing halfway between two', () => {
    expect(studyVar('canopy')?.listOnly).toBe(true)
    expect(studyVar('m')?.listOnly).toBeFalsy()
  })

  it('reads the trigger kind off the device, not the variable table', () => {
    // The one variable whose unit is not a property of the variable: an
    // ALTITUDE device deploys at a height, a TIME device at a time, and
    // showing seconds in feet would be nonsense.
    const devices = [
      { name: 'main', trigger: { kind: 'ALTITUDE' } },
      { name: 'drogue', trigger: { kind: 'TIME' } },
    ]
    expect(axisKind({ key: 'trigger', device: 'main' }, devices)).toBe('altitude')
    expect(axisKind({ key: 'trigger', device: 'drogue' }, devices)).toBeUndefined()
  })
})

describe('value labels', () => {
  const show = (si: number) => `${si * 2} shown`

  it('returns SI with no converter, so tests need no provider', () => {
    expect(axisValueLabel(6, undefined, undefined)).toBe('6')
    expect(axisValueLabel(1.23456, undefined, undefined)).toBe('1.2346')
  })

  it('goes through the converter when the value has a quantity', () => {
    expect(axisValueLabel(5, 'mass', show)).toBe('10 shown')
  })

  it('leaves a dimensionless value alone even with a converter present', () => {
    // Cx has no kind, so the Units tab must not be able to touch it.
    expect(axisValueLabel(1.8, undefined, show)).toBe('1.8')
  })

  it('shows a canopy by its label, never its drag area', () => {
    const canopy = { label: 'Iris Ultra 60 (IFC-60-S)', CdS: 3.889, D0: 2.002, m_c: 0.298, j: 2 }
    expect(axisValueLabel(canopy, 'area', show)).toBe('Iris Ultra 60 (IFC-60-S)')
  })
})

describe('study colours', () => {
  it('has ten distinct hues', () => {
    expect(STUDY_COLOURS).toHaveLength(10)
    expect(new Set(STUDY_COLOURS).size).toBe(10)
  })

  it('cycles at ten, so a repeat is as far away as it can be', () => {
    // Repeats are accepted here, unlike the corner palette -- but they must
    // land ten designs apart and never sooner, which is the whole reason the
    // hues are in wheel order.
    expect(studyColour(0)).toBe(studyColour(10))
    expect(studyColour(3)).toBe(studyColour(13))
    for (let i = 0; i < 10; i += 1) {
      for (let j = i + 1; j < 10; j += 1) {
        expect(studyColour(i)).not.toBe(studyColour(j))
      }
    }
  })

  it('is keyed on position, not on how many are visible', () => {
    // Colour follows the design. Hiding one must not repaint the others, or
    // two screenshots of the same study disagree about which line is which.
    expect(studyColour(7)).toBe(STUDY_COLOURS[7])
  })
})
