/**
 * Restoring a stored config.
 *
 * `reviveUiConfig` takes the raw string rather than reading storage itself, so
 * every case here is exercised without a DOM -- which matters, because the
 * cases worth pinning are the corrupt ones and those are awkward to arrange
 * through a real `localStorage`.
 *
 * The property under test throughout: a stored config must come back as the
 * user left it, and anything it cannot supply must come back as today's
 * default rather than as `undefined`. An `undefined` on a required field
 * type-checks, reaches a form, and renders as an empty box on an input the
 * user never touched.
 */

import { describe, expect, it } from 'vitest'
import { reviveUiConfig } from './persist'
import { defaultUiConfig } from './serialise'

const stored = (patch: Record<string, unknown>) =>
  JSON.stringify({ ...defaultUiConfig(), ...patch })

describe('reviving a stored config', () => {
  it('is null when there is nothing stored', () => {
    expect(reviveUiConfig(null)).toBeNull()
  })

  it('is null rather than a crash on a truncated write', () => {
    expect(reviveUiConfig('{"vehicle":{"m":5.6')).toBeNull()
  })

  it('is null on a value that is not an object', () => {
    for (const raw of ['null', '3', '"config"', '[]']) {
      expect(reviveUiConfig(raw), raw).toBeNull()
    }
  })

  it('is null on a config with no devices - that is not a config', () => {
    expect(reviveUiConfig(stored({ devices: [] }))).toBeNull()
    expect(reviveUiConfig(stored({ devices: [null] }))).toBeNull()
  })

  it('keeps an edited vehicle', () => {
    const ui = reviveUiConfig(stored({
      vehicle: { ...defaultUiConfig().vehicle, m: 9.1, h_a: 1500 },
    }))
    expect(ui!.vehicle.m).toBe(9.1)
    expect(ui!.vehicle.h_a).toBe(1500)
  })

  it('keeps the corner bounds and the sweeps - the whole point of this', () => {
    const base = defaultUiConfig()
    const ui = reviveUiConfig(stored({
      sweep: base.sweep.map((p) => (p.key === 'Cx' ? { ...p, max: 2.4 } : p)),
      study: [{
        uid: 'a1', key: 'pad_month', device: null, enabled: true, mode: 'list',
        start: null, stop: null, points: null, values: null, canopies: null,
        pads: [{ label: 'KNID January', T_pad: 281, p_pad: 92100, lapse: null }],
      }],
    }))
    expect(ui!.sweep.find((p) => p.key === 'Cx')!.max).toBe(2.4)
    expect(ui!.study).toHaveLength(1)
    expect(ui!.study[0].pads![0].label).toBe('KNID January')
  })

  it('keeps an empty study, which is a real state and not a missing one', () => {
    // Unlike `sweep`, which opens on the documented §15.7 band, the app opens
    // on no sweeps at all -- so "empty" here must not fall back to anything.
    expect(reviveUiConfig(stored({ study: [] }))!.study).toEqual([])
  })

  it('fills a field the stored copy predates, rather than leaving it undefined', () => {
    // The realistic version of this: the config was written by a build that
    // had no `month` on the site, and the form that reads it is required.
    const old = JSON.parse(stored({}))
    delete old.site.month
    delete old.site.profile
    const ui = reviveUiConfig(JSON.stringify(old))
    expect(ui!.site.month).toBe(defaultUiConfig().site.month)
    expect(ui!.site.profile).toBe('standard')
  })

  it('fills a device field the stored copy predates', () => {
    const old = JSON.parse(stored({}))
    delete old.devices[0].v_rel
    expect(reviveUiConfig(JSON.stringify(old))!.devices[0].v_rel)
      .toBe(defaultUiConfig().devices[0].v_rel)
  })

  it('issues fresh device keys', () => {
    // `nextUid` restarts at d1 every load, so a restored uid would collide
    // with the next device added this session and React would reconcile two
    // different cards as one.
    const ui = reviveUiConfig(stored({}))!
    const uids = ui.devices.map((d) => d.uid)
    expect(new Set(uids).size).toBe(uids.length)
    expect(reviveUiConfig(stored({}))!.devices[0].uid).not.toBe(uids[0])
  })

  it('does not repair a config the backend would reject', () => {
    // A stored CdS of zero is the user's own half-finished device card. It
    // comes back as it was and fails validation loudly, which is exactly what
    // happens if they type it -- silently repairing it would overwrite a value
    // somebody put there on purpose.
    const broken = JSON.parse(stored({}))
    broken.devices[0].CdS = 0
    expect(reviveUiConfig(JSON.stringify(broken))!.devices[0].CdS).toBe(0)
  })
})
