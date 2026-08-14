/**
 * The three staleness keys, and what each tab's result really depends on.
 *
 * `UiConfig` carries the inputs for three different computations that overlap
 * without being equal. Getting the overlap wrong is invisible: the app still
 * works, it just re-runs things it did not need to and badges finished results
 * stale for no reason. Nobody notices except as "why does this feel slow", so
 * the boundaries are asserted here rather than left to inspection.
 */

import { describe, expect, it } from 'vitest'

import {
  cornersKey, defaultUiConfig, physicsKey, studyKey, toWireConfig,
} from './serialise'
import type { UiConfig } from '../types/schema'

const base = (): UiConfig => defaultUiConfig()

/** A study axis, as the editor would add one. */
const AXIS = {
  uid: 'a1', key: 'canopy', device: 'main', enabled: true,
  mode: 'list' as const, start: null, stop: null, points: null,
  values: null,
  canopies: [{ label: 'Iris 60', CdS: 3.889, D0: 2.002, m_c: 0.298, j: 2 }],
  pads: null,
}

describe('the wire config', () => {
  it('emits study as an array, not undefined', () => {
    // `Config` is extra="forbid" on the Python side but `study` is a declared
    // field; omitting it entirely would be legal and would also mean a saved
    // config silently dropped the trade study it was saved with.
    expect(toWireConfig(base()).study).toEqual([])
  })

  it('drops the editor-only uid', () => {
    const ui = { ...base(), study: [AXIS] }
    const wire = toWireConfig(ui).study![0]
    expect(wire).not.toHaveProperty('uid')
    // Posting an unknown key is a 422, not a shrug, so this is the whole
    // reason `toWireConfig` names fields instead of spreading.
    expect(Object.keys(wire).sort()).toEqual(
      ['canopies', 'device', 'enabled', 'key', 'mode', 'pads', 'points',
       'start', 'stop', 'values'])
  })

  it('round-trips the study through a save', () => {
    const ui = { ...base(), study: [AXIS] }
    const reloaded = JSON.parse(JSON.stringify(toWireConfig(ui)))
    expect(reloaded.study[0].canopies[0].label).toBe('Iris 60')
  })
})

describe('what each tab re-runs on', () => {
  it('a study edit moves ONLY the study key', () => {
    // Adding a trade study must not fire a /api/simulate and must not badge a
    // finished corner sweep stale. Neither can possibly change.
    const before = base()
    const after = { ...before, study: [AXIS] }
    expect(physicsKey(after)).toBe(physicsKey(before))
    expect(cornersKey(after)).toBe(cornersKey(before))
    expect(studyKey(after)).not.toBe(studyKey(before))
  })

  it('a corner-bound edit moves ONLY the corners key', () => {
    const before = base()
    const after = {
      ...before,
      sweep: before.sweep.map((p) => (p.key === 'Cx' ? { ...p, max: 2.0 } : p)),
    }
    expect(physicsKey(after)).toBe(physicsKey(before))
    expect(studyKey(after)).toBe(studyKey(before))
    expect(cornersKey(after)).not.toBe(cornersKey(before))
  })

  it('a vehicle edit moves all three', () => {
    // The dependency in this direction is real and must stay: changing the
    // vehicle invalidates the simulation, the sweep and the study alike.
    const before = base()
    const after = { ...before, vehicle: { ...before.vehicle, m: 6.0 } }
    expect(physicsKey(after)).not.toBe(physicsKey(before))
    expect(cornersKey(after)).not.toBe(cornersKey(before))
    expect(studyKey(after)).not.toBe(studyKey(before))
  })

  it('UI bookkeeping moves none of them', () => {
    // Collapsing a device card used to cost a full simulate.
    const before = base()
    const after = {
      ...before,
      devices: before.devices.map((d) => ({ ...d, collapsed: !d.collapsed })),
    }
    expect(physicsKey(after)).toBe(physicsKey(before))
    expect(cornersKey(after)).toBe(cornersKey(before))
    expect(studyKey(after)).toBe(studyKey(before))
  })

  it('keeps a fixed shape, so a diff is about values not fields', () => {
    for (const key of [physicsKey, cornersKey, studyKey]) {
      const parsed = JSON.parse(key(base()))
      expect(parsed).toHaveProperty('sweep')
      expect(parsed).toHaveProperty('study')
    }
  })
})
