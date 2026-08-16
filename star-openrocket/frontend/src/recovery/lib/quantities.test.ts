/**
 * The conversion registry, which every unit in the GUI now comes from.
 *
 * Two failures this file exists to catch, both silent:
 *
 *  1. A wrong factor. Nothing downstream can notice -- `schema.py` is
 *     unit-blind and will happily descend a 27 lb vehicle told to it as 12.5.
 *  2. An offset applied to a DIFFERENCE. A 2 K profile error rendered through
 *     the absolute K->°F map reads 35.6 °F instead of 3.6, which looks like a
 *     catastrophically bad model rather than a good one.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PREFS,
  DEFAULT_PRECISION,
  KG_PER_LB,
  KINDS,
  M_PER_FT,
  M_PER_IN,
  N_PER_LBF,
  QUANTITIES,
  decimalsFor,
  formatForInput,
  fromDisplay,
  parsePrecision,
  parsePrefs,
  toDisplay,
  unitFor,
} from '../../lib/units/quantities'
import type { Kind, UnitPrefs } from '../../lib/units/quantities'
import { cornersKey, defaultUiConfig, physicsKey, studyKey } from './serialise'

describe('the exact factors stay exact', () => {
  it('the four base constants are the defined values', () => {
    // Defined, not measured. If any becomes an approximation, a value typed as
    // 12.5 reads back as 12.499999 and every saved config churns on reload.
    expect(M_PER_FT).toBe(0.3048)
    expect(M_PER_IN).toBe(0.0254)
    expect(KG_PER_LB).toBe(0.45359237)
    expect(N_PER_LBF).toBe(0.45359237 * 9.80665)
  })

  it('the derived imperial units are built from them, not pasted', () => {
    expect(QUANTITIES.area.imperial.perUnit).toBe(0.3048 ** 2)
    expect(QUANTITIES.energy.imperial.perUnit).toBeCloseTo(1.3558179483314, 12)
    expect(QUANTITIES.pressure.imperial.perUnit).toBeCloseTo(6894.757293168, 8)
    expect(QUANTITIES.density.imperial.perUnit).toBeCloseTo(16.01846337396, 10)
    expect(QUANTITIES.stiffness.imperial.perUnit).toBeCloseTo(175.126835246476, 10)
  })
})

describe('every kind round-trips in both systems', () => {
  it('display -> SI -> display is the identity', () => {
    for (const kind of KINDS) {
      for (const system of ['metric', 'imperial'] as const) {
        const u = QUANTITIES[kind][system]
        for (const shown of [-6.5, 0, 0.25, 1, 12.5, 3000, 27263]) {
          expect([kind, system, toDisplay(fromDisplay(shown, u), u)])
            .toEqual([kind, system, expect.closeTo(shown, 8)])
        }
      }
    }
  })

  it('SI -> display -> SI is the identity', () => {
    // The direction that matters for a stored value: a unit switch and a
    // switch back must not perturb what the physics sees.
    for (const kind of KINDS) {
      for (const system of ['metric', 'imperial'] as const) {
        const u = QUANTITIES[kind][system]
        for (const si of [0.0065, 1, 5.669904625, 914.4, 101325]) {
          expect([kind, system, fromDisplay(toDisplay(si, u), u)])
            .toEqual([kind, system, expect.closeTo(si, 9)])
        }
      }
    }
  })
})

describe('temperature carries its offset and differences do not', () => {
  const abs = QUANTITIES.temperature.imperial
  const delta = QUANTITIES.tempDelta.imperial

  it('absolute K -> °F hits the fixed points', () => {
    expect(toDisplay(273.15, abs)).toBeCloseTo(32, 9)     // ice
    expect(toDisplay(373.15, abs)).toBeCloseTo(212, 9)    // steam
    expect(toDisplay(255.372, abs)).toBeCloseTo(0, 3)     // 0 °F
    expect(toDisplay(0, abs)).toBeCloseTo(-459.67, 9)     // absolute zero
  })

  it('°F -> K inverts it', () => {
    expect(fromDisplay(32, abs)).toBeCloseTo(273.15, 9)
    expect(fromDisplay(212, abs)).toBeCloseTo(373.15, 9)
  })

  it('a DIFFERENCE of 1 K is 1.8 °F, not 33.8', () => {
    // The whole reason tempDelta is a separate kind. Getting this wrong turns
    // a 2 K model error into a 35.6 °F one on the sounding profile.
    expect(toDisplay(1, delta)).toBeCloseTo(1.8, 12)
    expect(toDisplay(2, delta)).toBeCloseTo(3.6, 12)
    expect(toDisplay(0, delta)).toBe(0)
    expect(QUANTITIES.tempDelta.imperial.offset).toBeUndefined()
  })
})

describe('lapse rate is per metre on the wire', () => {
  // types/schema.ts is explicit that the wire carries K/m. The familiar K/km
  // was an inline `* 1000` at three separate sites before this table existed.
  const si = -0.0065 // the ISA lapse, K/m

  it('metric shows K/km', () => {
    expect(toDisplay(si, QUANTITIES.lapse.metric)).toBeCloseTo(-6.5, 12)
  })

  it('imperial shows °F per 1000 ft', () => {
    // -6.5 K/km * 1.8 °F/K * 0.3048 km/1000ft
    expect(toDisplay(si, QUANTITIES.lapse.imperial)).toBeCloseTo(-3.56616, 5)
  })
})

describe('the defaults reproduce what the GUI showed before it was settable', () => {
  it('the input boxes keep the units they already had', () => {
    const lab = (k: Kind) => unitFor(k, DEFAULT_PREFS).label
    expect(lab('altitude')).toBe('ft')   // apogee, deploy altitude
    expect(lab('length')).toBe('in')     // airframe diameter and length
    expect(lab('mass')).toBe('lb')       // descending mass
    expect(lab('force')).toBe('lbf')     // hardware link ratings
  })

  it('everything else stays SI, as it rendered', () => {
    const lab = (k: Kind) => unitFor(k, DEFAULT_PREFS).label
    expect(lab('speed')).toBe('m/s')
    expect(lab('energy')).toBe('J')
    expect(lab('pressure')).toBe('Pa')
    expect(lab('temperature')).toBe('K')
    expect(lab('area')).toBe('m²')
    expect(lab('density')).toBe('kg/m³')
    expect(lab('lapse')).toBe('K/km')
  })

  it('every kind has a default', () => {
    for (const kind of KINDS) expect(DEFAULT_PREFS[kind]).toBeDefined()
  })

  it('the worked example opens on the numbers it is published with', () => {
    // 12.5 lb / 3000 ft / 4 in / 56 in, straight through the registry.
    const wire = defaultUiConfig().vehicle
    const show = (si: number, k: Kind) => toDisplay(si, unitFor(k, DEFAULT_PREFS))
    expect(show(wire.m, 'mass')).toBeCloseTo(12.5, 9)
    expect(show(wire.h_a, 'altitude')).toBeCloseTo(3000, 9)
    expect(show(wire.d_body, 'length')).toBeCloseTo(4, 9)
    expect(show(wire.l_body, 'length')).toBeCloseTo(56, 9)
  })
})

describe('stored preferences are read leniently', () => {
  it('missing keys fall back to the default', () => {
    expect(parsePrefs({ mass: 'metric' })).toEqual(
      { ...DEFAULT_PREFS, mass: 'metric' })
  })

  it('unknown keys and junk values are ignored, never fatal', () => {
    // A file written by a newer version, or hand-edited, must not stop the GUI
    // from opening.
    expect(parsePrefs({ mass: 'furlongs', notAKind: 'metric' }))
      .toEqual(DEFAULT_PREFS)
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('nonsense')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS)
  })
})

describe('display precision is two bounds, not a target', () => {
  const P = DEFAULT_PRECISION                       // max 2 decimals, min 2 sf
  const show = (v: number, fieldDigits = Infinity, p = P) =>
    v.toFixed(decimalsFor(v, fieldDigits, p))

  it.each([
    // value          fieldDigits  shown        why
    [5.669904625,     Infinity,    '5.67',      'max decimals'],
    [0.005690,        Infinity,    '0.0057',    'min sig figs overrides'],
    [0.0048643918,    4,           '0.0049',    'min sig figs overrides'],
    [0.5,             4,           '0.50',      'max decimals'],
    [0.1016,          Infinity,    '0.10',      'max decimals'],
    [1613.4,          0,           '1613',      'field is already coarser'],
    [101325,          0,           '101325',    'integer digits untouched'],
    [1.2250,          4,           '1.23',      'max decimals'],
    // `decimalsFor` only decides the count. Stripping the trailing zeros an
    // editable box does not want is `formatForInput`'s job, below.
    [12.5,            Infinity,    '12.50',     'stripping happens later'],
    [3000,            Infinity,    '3000.00',   'ditto'],
  ])('%p at %p decimals renders %p (%s)', (v, fieldDigits, want) => {
    expect(show(v, fieldDigits as number)).toBe(want)
  })

  it('the significant-figure floor beats the decimal cap', () => {
    // The case the second bound exists for. Without it this is '0.01', which
    // is a 76% error presented as a measurement.
    expect(show(0.005690)).toBe('0.0057')
    expect(show(0.005690, Infinity, { maxDecimals: 0, minSigFigs: 2 }))
      .toBe('0.0057')
    // ...and the floor is a floor, not a target: two figures, not four.
    expect(show(0.0056904321)).toBe('0.0057')
  })

  it('the decimal cap never touches integer digits', () => {
    // A rounded pad pressure would read as a measurement error rather than a
    // display choice, so magnitude is never negotiable.
    for (const p of [{ maxDecimals: 2, minSigFigs: 2 },
                     { maxDecimals: 0, minSigFigs: 1 },
                     { maxDecimals: 6, minSigFigs: 6 }]) {
      expect(show(101325, 0, p)).toBe('101325')
    }
  })

  it('a field that is already coarser stays coarse', () => {
    // Force carries 0 decimals in the registry because Cx is swept +-20%.
    // Raising the cap must not invent precision the model does not have.
    expect(show(1613.4, 0, { maxDecimals: 6, minSigFigs: 2 })).toBe('1613')
    expect(show(363.2, 0, { maxDecimals: 6, minSigFigs: 2 })).toBe('363')
  })

  it('raising the floor reveals more of a small number', () => {
    expect(show(0.0048643918, 4, { maxDecimals: 2, minSigFigs: 4 }))
      .toBe('0.004864')
  })

  it('never asks toFixed for something it will throw on', () => {
    // toFixed rejects anything outside 0..100, and log10 of 0 is -Infinity.
    for (const v of [0, -0, 1e-9, -1e-9, 1e12, -5.5, NaN, Infinity]) {
      const d = decimalsFor(v, Infinity, P)
      expect([v, d]).toEqual([v, expect.any(Number)])
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(10)
    }
    expect(show(-0.005690)).toBe('-0.0057')
  })

  it.each([
    [5.669904625, '5.67',   'the conversion of 12.5 lb, made readable'],
    [12.5,        '12.5',   'trailing zero stripped'],
    [3000,        '3000',   'no decimals to show'],
    [4,           '4',      'the zero in 4.0 carries nothing'],
    [0.1016,      '0.1',    'the cap already lost the 16; 0.10 adds nothing'],
    [0.005690,    '0.0057', 'the floor beats the cap'],
    [0,           '0',      'not 0.00'],
    [-5.669904625, '-5.67', 'sign does not confuse the rounding'],
  ])('an input box shows %p as %p (%s)', (v, want) => {
    expect(formatForInput(v, P)).toBe(want)
  })

  it('reads a stored precision leniently', () => {
    expect(parsePrecision({ maxDecimals: 4 }))
      .toEqual({ ...DEFAULT_PRECISION, maxDecimals: 4 })
    // Anything that would reach toFixed(-3) has to be rejected here, because
    // there is no second chance further down.
    expect(parsePrecision({ maxDecimals: -3 })).toEqual(DEFAULT_PRECISION)
    expect(parsePrecision({ maxDecimals: 99 })).toEqual(DEFAULT_PRECISION)
    expect(parsePrecision({ minSigFigs: 'two' })).toEqual(DEFAULT_PRECISION)
    expect(parsePrecision({ minSigFigs: 2.5 })).toEqual(DEFAULT_PRECISION)
    expect(parsePrecision(null)).toEqual(DEFAULT_PRECISION)
    expect(parsePrecision(undefined)).toEqual(DEFAULT_PRECISION)
  })
})

describe('a unit preference cannot reach the physics', () => {
  // Vacuous today by signature, which IS the assertion: prefs are not a
  // parameter of any staleness key, so no unit change can re-run a
  // simulation, re-run a sweep, or badge a finished result stale. These fail
  // the moment someone threads prefs in.
  it.each([
    ['physicsKey', physicsKey],
    ['cornersKey', cornersKey],
    ['studyKey', studyKey],
  ])('%s takes a UiConfig and nothing else', (_name, key) => {
    const ui = defaultUiConfig()
    const before = key(ui)
    const prefs: UnitPrefs = Object.fromEntries(
      KINDS.map((k) => [k, 'imperial'])) as UnitPrefs
    expect(prefs.mass).toBe('imperial')     // the switch really happened
    expect(key(ui)).toBe(before)
    expect(key.length).toBe(1)
  })

  it('a saved config carries no unit preference', () => {
    // `Save config` must round-trip between someone working in feet and
    // someone working in metres. The only way to guarantee that is for the
    // wire config to have nowhere to put a unit.
    const wire = JSON.parse(physicsKey(defaultUiConfig()))
    const leaked = JSON.stringify(wire).match(/imperial|metric/)
    expect(leaked).toBeNull()
  })
})
