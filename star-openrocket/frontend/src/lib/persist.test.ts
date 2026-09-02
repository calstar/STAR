/**
 * The unified design (OrkConfig) revives cleanly from anything a browser or an
 * old export might hand it -- including pre-merge blobs (a flat ViewerConfig, a
 * bare recovery UiConfig) and garbage. It must never throw and must always
 * return a fully-shaped { cad, recovery } so `handleRestore` is safe.
 */

import { describe, expect, it } from 'vitest'
import { reviveOrkConfig } from './persist'
import { defaultOrkConfig } from '../types/config'

function isFullyShaped(c: unknown) {
  const o = c as { cad?: unknown; recovery?: unknown }
  return !!o && typeof o === 'object'
    && !!o.cad && typeof o.cad === 'object'
    && !!o.recovery && typeof o.recovery === 'object'
}

describe('hidden parts are part of the design', () => {
  it('round-trips hiddenKeys', () => {
    // Hidden parts are excluded from the centre of mass, so two people opening
    // the same design have to see the same set hidden -- it cannot be a local
    // preference the way the compare-plot selection is.
    const saved = JSON.stringify({
      cad: { version: 1, hiddenKeys: ['occ-1', 'occ-2'] },
      recovery: {},
    })
    expect(reviveOrkConfig(saved)!.cad.hiddenKeys).toEqual(['occ-1', 'occ-2'])
  })

  it('defaults to nothing hidden, and ignores a non-list', () => {
    expect(defaultOrkConfig().cad.hiddenKeys).toEqual([])
    const junk = JSON.stringify({ cad: { version: 1, hiddenKeys: 'all' }, recovery: {} })
    expect(reviveOrkConfig(junk)!.cad.hiddenKeys).toEqual([])
  })

  it('drops non-string members rather than carrying them into a Set', () => {
    const mixed = JSON.stringify({
      cad: { version: 1, hiddenKeys: ['occ-1', 3, null, 'occ-2'] },
      recovery: {},
    })
    expect(reviveOrkConfig(mixed)!.cad.hiddenKeys).toEqual(['occ-1', 'occ-2'])
  })
})

describe('the design carries no viewing preferences', () => {
  it('drops compare-plot selections saved by an older build', () => {
    // These lived on `flight` until they moved to localStorage. A design saved
    // before that still has them, and a spread would lift them back into the
    // live config and write them out again on the next autosave -- so the
    // preference would keep travelling to everyone it was shared with.
    const legacy = JSON.stringify({
      cad: {
        version: 1,
        flight: {
          inclination: 80, heading: 12, cpModel: 'ours',
          compareSeries: ['altitude'], fullCompareSeries: ['speed'],
        },
      },
      recovery: {},
    })
    const flight = reviveOrkConfig(legacy)!.cad.flight as unknown as Record<string, unknown>
    expect(Object.keys(flight).sort()).toEqual(['cpModel', 'heading', 'inclination'])
    // The real launch params still survive the trip.
    expect(flight.inclination).toBe(80)
    expect(flight.heading).toBe(12)
    expect(flight.cpModel).toBe('ours')
  })
})

describe('reviveOrkConfig', () => {
  it('round-trips a valid unified config', () => {
    const c = defaultOrkConfig()
    c.cad.railLength = 2.5
    c.recovery.vehicle.m = 22.5
    const back = reviveOrkConfig(JSON.stringify(c))!
    expect(back.cad.railLength).toBe(2.5)
    expect(back.recovery.vehicle.m).toBe(22.5)
  })

  it('defaults both slices for a pre-merge flat ViewerConfig (no `cad`/`recovery`)', () => {
    const legacy = { version: 1, modelId: 'old', railLength: 9, overrides: {}, outerFaces: [], finFaces: [], finCount: 3, motor: null, flight: {} }
    const back = reviveOrkConfig(JSON.stringify(legacy))
    expect(isFullyShaped(back)).toBe(true)
    // The old top-level fields are not read into `cad`; it falls back to defaults.
    expect(back!.cad.modelId).toBe(null)
  })

  it('defaults for a bare recovery UiConfig (vehicle at top level)', () => {
    const legacy = { vehicle: { m: 30 }, devices: [{ name: 'x' }] }
    const back = reviveOrkConfig(JSON.stringify(legacy))
    expect(isFullyShaped(back)).toBe(true)
  })

  it('returns null for non-JSON / non-object, never throwing', () => {
    expect(reviveOrkConfig('not json {')).toBe(null)
    expect(reviveOrkConfig('[1,2,3]')).toBe(null)
    expect(reviveOrkConfig(null)).toBe(null)
  })
})
