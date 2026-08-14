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
