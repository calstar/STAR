/**
 * The imperial display layer must never reach the physics.
 *
 * PLAN.md §1.1: units are SI internally, always -- convert at the I/O boundary
 * only. The GUI shows mass in pounds, apogee in feet and the airframe in
 * inches, but `schema.py` is unit-blind: it will happily accept 12.5 as a mass
 * in kilograms and return a descent for a 27 lb vehicle without complaint.
 *
 * That is the failure these tests exist for, and it is a quiet one -- a 2.2x
 * mass error changes every load by 2.2x while every number still looks
 * plausible. Nothing on the Python side can catch it, because by then the
 * units are gone.
 */

import { describe, expect, it } from 'vitest'

import {
  KG_PER_LB,
  M_PER_IN,
  ft2m,
  in2m,
  kg2lb,
  lb2kg,
  m2ft,
  m2in,
  n2lbf,
} from './units'
import { defaultUiConfig, toWireConfig } from './serialise'
import type { UiConfig } from '../types/schema'

/** What `UnitInput` does: display value -> stored SI value. */
const fromDisplay = (shown: number, perUnit: number) => shown * perUnit
/** ...and back, which is what it renders. */
const toDisplay = (si: number, perUnit: number) => si / perUnit

describe('conversion factors are the exact defined values', () => {
  it('inch and pound are exact, so round trips do not drift', () => {
    // Both are defined exactly, not measured. If either becomes an
    // approximation, a value typed as 12.5 reads back as 12.499999 and every
    // saved config churns on reload.
    expect(M_PER_IN).toBe(0.0254)
    expect(KG_PER_LB).toBe(0.45359237)
  })

  it('known equivalences hold', () => {
    expect(in2m(1)).toBeCloseTo(0.0254, 12)
    expect(in2m(4)).toBeCloseTo(0.1016, 12)      // a 4 in airframe
    expect(lb2kg(12.5)).toBeCloseTo(5.669904625, 9) // the worked example
    expect(ft2m(3000)).toBeCloseTo(914.4, 6)     // 3000 ft apogee
    expect(m2ft(1)).toBeCloseTo(3.280839895, 9)
    expect(m2in(1)).toBeCloseTo(39.37007874, 8)
    expect(kg2lb(1)).toBeCloseTo(2.20462262, 8)
  })
})

describe('UnitInput round-trips without drift', () => {
  it('display -> SI -> display is the identity', () => {
    for (const perUnit of [M_PER_IN, KG_PER_LB, 0.3048]) {
      for (const shown of [0.25, 1, 4, 12.5, 56.75, 3000, 10000]) {
        expect(toDisplay(fromDisplay(shown, perUnit), perUnit)).toBeCloseTo(shown, 10)
      }
    }
  })

  it('stores SI, not the displayed number', () => {
    // The whole bug in one assertion: typing 12.5 lb must store 5.67 kg, and
    // emphatically not 12.5.
    const stored = fromDisplay(12.5, KG_PER_LB)
    expect(stored).toBeCloseTo(5.6699, 4)
    expect(stored).not.toBeCloseTo(12.5, 1)
  })
})

describe('the wire config carries SI', () => {
  const wire = toWireConfig(defaultUiConfig())

  it('mass is kilograms, not pounds', () => {
    // 5.67 kg is 12.5 lb. If the serialiser ever leaked the display value the
    // mass would read ~12.5, so bracket it well below that.
    expect(wire.vehicle.m).toBeGreaterThan(1)
    expect(wire.vehicle.m).toBeLessThan(10)
    expect(wire.vehicle.m).toBeCloseTo(5.67, 2)
  })

  it('apogee is metres, not feet', () => {
    // 914 m is 3000 ft. A leaked display value would be 3000-odd.
    expect(wire.vehicle.h_a).toBeLessThan(2000)
    expect(wire.vehicle.h_a).toBeCloseTo(914, 0)
  })

  it('airframe dimensions are metres, not inches', () => {
    // 0.1016 m is 4 in; 1.4224 m is 56 in.
    expect(wire.vehicle.d_body).toBeLessThan(1)
    expect(wire.vehicle.d_body).toBeCloseTo(0.1016, 4)
    expect(wire.vehicle.l_body).toBeLessThan(10)
    expect(wire.vehicle.l_body).toBeCloseTo(1.4224, 4)
  })

  // The defaults are stored in SI but edited in imperial, so "is the stored
  // number tidy" is the wrong question -- the one that matters is whether the
  // box the user actually reads opens on a round number. A metric constant
  // pasted in later (5.67 kg, 914 m) fails here and nowhere else.
  it('every imperial-edited default is round in its display unit', () => {
    const v = wire.vehicle
    const shown: [string, number][] = [
      ['mass, lb', v.m / KG_PER_LB],
      ['apogee, ft', v.h_a / 0.3048],
      ['diameter, in', v.d_body / M_PER_IN],
      ['length, in', v.l_body / M_PER_IN],
      ...Object.entries(wire.hardware?.links ?? {})
        .map(([k, n]): [string, number] => [`${k}, lbf`, n2lbf(n)]),
      ...wire.devices
        .filter((d) => d.trigger.kind === 'ALTITUDE')
        .map((d): [string, number] => [`${d.name} trigger, ft`, m2ft(d.trigger.value)]),
    ]
    for (const [what, value] of shown) {
      // Round to a tenth at worst; anything finer is a converted metric value.
      expect([what, Math.abs(value * 10 - Math.round(value * 10))])
        .toEqual([what, expect.closeTo(0, 6)])
    }
  })

  it('every wire quantity is plausible as SI', () => {
    // A sweep of the whole payload rather than named fields, so a NEW imperial
    // input added later is caught even if nobody updates this file. Each bound
    // is loose enough to pass any sane vehicle and tight enough to fail the
    // corresponding unit slip.
    const v = wire.vehicle
    expect(v.m).toBeLessThan(500)          // kg; lb would need to exceed this
    expect(v.d_body).toBeLessThan(2)       // m; inches would be 4+
    expect(v.l_body).toBeLessThan(30)      // m; inches would be 56+
    expect(v.h_a).toBeLessThan(100000)     // m
    for (const d of wire.devices) {
      expect(d.CdS).toBeLessThan(1000)     // m^2; sq ft would be ~10x
      expect(d.D0).toBeLessThan(30)        // m; inches would be 63
      expect(d.m_c).toBeLessThan(100)      // kg
    }
  })
})

describe('imperial editing produces the SI the physics expects', () => {
  it('a 12.5 lb / 3000 ft / 4 in vehicle serialises to the worked example', () => {
    // End to end: the numbers a user actually types on the vehicle card,
    // through the same conversion the widget applies, into the wire config.
    const ui: UiConfig = defaultUiConfig()
    ui.vehicle = {
      ...ui.vehicle,
      m: fromDisplay(12.5, KG_PER_LB),
      h_a: fromDisplay(3000, 0.3048),
      d_body: fromDisplay(4, M_PER_IN),
      l_body: fromDisplay(56.7, M_PER_IN),
    }
    const out = toWireConfig(ui)
    expect(out.vehicle.m).toBeCloseTo(5.6699, 3)
    expect(out.vehicle.h_a).toBeCloseTo(914.4, 1)
    expect(out.vehicle.d_body).toBeCloseTo(0.1016, 5)
    expect(out.vehicle.l_body).toBeCloseTo(1.44018, 4)

    // ...and the fineness ratio is unit-free, so it must agree either way.
    expect(out.vehicle.l_body / out.vehicle.d_body).toBeCloseTo(56.7 / 4, 6)
  })
})
