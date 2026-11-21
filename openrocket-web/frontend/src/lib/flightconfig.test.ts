import { describe, expect, it } from 'vitest'
import type { Component, RocketDocument } from '../types'
import fixtures from './fixtures/flight-events.json'
import {
  applyDeployment, applyIgnition, applySeparation, deleteConfig, deployEventsFor, duplicateConfig, flightEvents,
  initialIgnitionScope, initialScope, motorIgnition, mountIgnition, newConfig, normEvent, recoveryDevices,
  resetEvent, resetIgnition, resolveEvent, separableStages, stageButtonEnabled, stageList, toggleStage,
} from './flightconfig'
import { findById } from './tree'
import { motorMounts } from '../workbench/configs'

type Fixture = { doc: RocketDocument; events: Record<string, { id: string; kind: string; event: string; altitude?: number; delay: number }[]> }
const FIX = fixtures as unknown as Record<string, Fixture>
const twoStage = () => structuredClone(FIX['Two stage high power rocket'].doc)
const byName = (doc: RocketDocument, name: string): Component => {
  let hit: Component | null = null
  const visit = (c: Component) => {
    if (c.name === name && !hit) hit = c
    c.children.forEach(visit)
  }
  visit(doc.rocket)
  if (!hit) throw new Error(name)
  return hit
}
const ev = (doc: RocketDocument, cfg: string, id: string, kind: string) => flightEvents(doc, cfg).find((e) => e.id === id && e.kind === kind)!

describe('resolution matches orweb/document.py flight_events (itself held to OpenRocket)', () => {
  for (const [name, f] of Object.entries(FIX)) {
    it(name, () => {
      for (const cfg of f.doc.motorConfigs) {
        const ours = flightEvents(f.doc, cfg.id)
        const theirs = f.events[cfg.id]
        expect(ours.length).toBe(theirs.length)
        theirs.forEach((t, i) => {
          const o = ours[i]
          expect([o.id, o.kind]).toEqual([t.id, t.kind])
          expect(normEvent(o.event, '')).toBe(normEvent(t.event, ''))
          expect(o.delay).toBeCloseTo(t.delay, 12)
          if (t.altitude !== undefined) expect(o.altitude).toBeCloseTo(t.altitude, 12)
        })
      }
    })
  }

  it('an absent element is OpenRocket default ejection / 200 m / 0 s; a missing override uses the default', () => {
    const doc = twoStage()
    const booster = byName(doc, 'Booster')
    const bare: Component = { ...booster, params: {} }
    expect(resolveEvent(bare, 'separation', doc.motorConfigs[0].id)).toEqual({ event: 'ejection', altitude: 200, delay: 0, isDefault: true })
    const r = resolveEvent(booster, 'separation', 'not-a-config')
    expect(r.isDefault).toBe(true)
    expect(r.event).toBe('ejection')
    expect(resolveEvent(booster, 'separation', doc.motorConfigs[0].id)).toMatchObject({ event: 'burnout', isDefault: false })
  })
})

describe('the selection dialogs', () => {
  it('separation for one configuration touches only that configuration', () => {
    const doc = twoStage()
    const [a, b] = doc.motorConfigs.map((c) => c.id)
    const booster = byName(doc, 'Booster')
    const out = applySeparation(doc, booster.id, a, { event: 'altitudeascending', altitude: 300, delay: 1 }, 'config')
    expect(ev(out, a, booster.id, 'separation')).toMatchObject({ event: 'altitudeascending', altitude: 300, delay: 1 })
    expect(ev(out, b, booster.id, 'separation')).toEqual(ev(doc, b, booster.id, 'separation'))
    // nothing else moved
    for (const cfg of [a, b]) {
      expect(flightEvents(out, cfg).filter((e) => e.id !== booster.id)).toEqual(flightEvents(doc, cfg).filter((e) => e.id !== booster.id))
    }
    expect(initialScope(findById(out.rocket, booster.id)!, 'separation', a)).toBe('config')
  })

  it('separation for all configurations clears the overrides (reset() then setDefault)', () => {
    const doc = twoStage()
    const booster = byName(doc, 'Booster')
    const out = applySeparation(doc, booster.id, doc.motorConfigs[0].id, { event: 'apogee', altitude: 200, delay: 2 }, 'all')
    for (const cfg of out.motorConfigs) expect(ev(out, cfg.id, booster.id, 'separation')).toMatchObject({ event: 'apogee', delay: 2 })
    const p = findById(out.rocket, booster.id)!.params
    expect(p.separationconfiguration).toBeUndefined()
    // the default sits where the old one was, ahead of anything after it
    const keys = Object.keys(p)
    expect(keys.indexOf('separationevent')).toBe(Object.keys(booster.params).indexOf('separationevent'))
  })

  it('"never" separation drops the delay', () => {
    const doc = twoStage()
    const booster = byName(doc, 'Booster')
    const out = applySeparation(doc, booster.id, doc.motorConfigs[0].id, { event: 'never', altitude: 200, delay: 3 }, 'config')
    expect(ev(out, doc.motorConfigs[0].id, booster.id, 'separation').delay).toBe(0)
  })

  it('deployment for all configurations changes the default and keeps overrides (setDefault only)', () => {
    const doc = twoStage()
    const [a, b] = doc.motorConfigs.map((c) => c.id)
    const drogue = byName(doc, 'Sustainer Drogue')
    const out = applyDeployment(doc, drogue.id, a, { event: 'altitude', altitude: 250, delay: 0.5 }, 'all')
    // both configurations override the drogue in this file, so neither moves ...
    expect(ev(out, a, drogue.id, 'deployment')).toEqual(ev(doc, a, drogue.id, 'deployment'))
    // ... until a configuration is reset to the default
    const reset = resetEvent(resetEvent(out, 'deployment', drogue.id, a), 'deployment', drogue.id, b)
    for (const cfg of [a, b]) expect(ev(reset, cfg, drogue.id, 'deployment')).toMatchObject({ event: 'altitude', altitude: 250, delay: 0.5 })
    expect(findById(reset.rocket, drogue.id)!.params.deploymentconfiguration).toBeUndefined()
    expect(initialScope(findById(reset.rocket, drogue.id)!, 'deployment', a)).toBe('all')
  })

  it('a bottom-stage device cannot deploy at lower stage separation', () => {
    const doc = twoStage()
    expect(deployEventsFor(doc, byName(doc, 'Booster Chute').id).map((o) => o.value)).not.toContain('lowerstageseparation')
    expect(deployEventsFor(doc, byName(doc, 'Sustainer Main').id).map((o) => o.value)).toContain('lowerstageseparation')
  })
})

describe('ignition', () => {
  it('this configuration only sets one motor', () => {
    const doc = twoStage()
    const [a, b] = doc.motorConfigs.map((c) => c.id)
    const mount = byName(doc, 'Sustainer Motor Mount')
    expect(initialIgnitionScope(doc, mount.id, a)).toBe('config')
    const out = applyIgnition(doc, mount.id, a, { event: 'burnout', delay: 1.5 }, 'config')
    expect(motorIgnition(out, a, mount)).toEqual({ event: 'burnout', delay: 1.5 })
    expect(motorIgnition(out, b, mount)).toEqual({ event: 'burnout', delay: 0 })
    expect(mountIgnition(findById(out.rocket, mount.id)!)).toEqual(mountIgnition(mount))
  })

  it('all configurations sets the mount default and every motor in the mount', () => {
    const doc = twoStage()
    const mount = byName(doc, 'Booster motor mount')
    const out = applyIgnition(doc, mount.id, doc.motorConfigs[0].id, { event: 'launch', delay: 0.25 }, 'all')
    expect(mountIgnition(findById(out.rocket, mount.id)!)).toEqual({ event: 'launch', delay: 0.25 })
    for (const c of out.motorConfigs) expect(c.motors[mount.id]).toMatchObject({ ignitionEvent: 'launch', ignitionDelay: 0.25 })
  })

  it('on an empty cell it edits the mount default', () => {
    const doc = twoStage()
    const mount = byName(doc, 'Booster motor mount')
    const cfg = newConfig(doc, 'fresh')
    const withNew = { ...doc, motorConfigs: [...doc.motorConfigs, cfg] }
    expect(initialIgnitionScope(withNew, mount.id, 'fresh')).toBe('all')
    const out = applyIgnition(withNew, mount.id, 'fresh', { event: 'never', delay: 0 }, 'config')
    expect(mountIgnition(findById(out.rocket, mount.id)!).event).toBe('never')
    expect(out.motorConfigs).toEqual(withNew.motorConfigs)
  })

  it('reset ignition is Automatic + 0 s for that cell (MotorConfiguration.useDefaultIgnition)', () => {
    const doc = twoStage()
    const [a, b] = doc.motorConfigs.map((c) => c.id)
    const mount = byName(doc, 'Sustainer Motor Mount')
    const out = resetIgnition(doc, mount.id, a)
    expect(motorIgnition(out, a, mount)).toEqual({ event: 'automatic', delay: 0 })
    expect(motorIgnition(out, b, mount)).toEqual({ event: 'burnout', delay: 0 })
  })
})

describe('configurations', () => {
  it('duplicate copies motors, stages, name and the resolved events as overrides', () => {
    const doc = twoStage()
    const b = doc.motorConfigs[1].id
    // give one device a default-only value so the copy has to materialise it
    const main = byName(doc, 'Sustainer Main')
    const base = resetEvent(doc, 'deployment', main.id, b)
    const out = duplicateConfig(base, b, 'copy')
    expect(out.selectedConfig).toBe('copy')
    expect(out.motorConfigs.map((c) => c.id)).toEqual([doc.motorConfigs[0].id, b, 'copy'])
    const copy = out.motorConfigs[2]
    expect(copy.motors).toEqual(base.motorConfigs[1].motors)
    expect(copy.stages).toEqual(base.motorConfigs[1].stages)
    expect(copy.name).toBe(base.motorConfigs[1].name)
    expect(flightEvents(out, 'copy')).toEqual(flightEvents(base, b))
    for (const c of [...separableStages(out), ...recoveryDevices(out)]) {
      expect(resolveEvent(c, c.type === 'stage' ? 'separation' : 'deployment', 'copy').isDefault).toBe(false)
    }
    // the sustainer (stage 0) gets no separation element: OpenRocket never writes one
    expect(stageList(out)[0].stage.params.separationconfiguration).toBeUndefined()
    // and a later default change does not reach the copy
    const changed = applyDeployment(out, main.id, b, { event: 'never', altitude: 200, delay: 0 }, 'all')
    expect(ev(changed, 'copy', main.id, 'deployment').event).toBe('ejection')
    expect(ev(changed, b, main.id, 'deployment').event).toBe('never')
  })

  it('delete drops the configuration and every override that named it', () => {
    const doc = duplicateConfig(twoStage(), twoStage().motorConfigs[0].id, 'copy')
    const out = deleteConfig(doc, 'copy')
    expect(out.motorConfigs.map((c) => c.id)).toEqual(twoStage().motorConfigs.map((c) => c.id))
    expect(JSON.stringify(out.rocket)).not.toContain('"copy"')
    expect(out.rocket).toEqual(twoStage().rocket)
    expect(out.selectedConfig).toBe(twoStage().motorConfigs[1].id)
    expect(deleteConfig(out, out.motorConfigs[0].id).selectedConfig).toBe(out.selectedConfig)
  })

  it('a new configuration has every stage active and no motors', () => {
    const doc = twoStage()
    expect(newConfig(doc, 'n')).toEqual({ id: 'n', name: '', stages: { '0': true, '1': true }, motors: {} })
    expect(motorMounts(doc).length).toBe(2)
  })
})

describe('stage activeness (ribbon Stages: buttons)', () => {
  it('toggles the configuration stage flag, never below one active stage', () => {
    const doc = twoStage()
    const a = doc.motorConfigs[0].id
    const off = toggleStage(doc, a, 1)
    expect(off.motorConfigs[0].stages).toEqual({ '0': true, '1': false })
    expect(off.motorConfigs[1].stages).toEqual(doc.motorConfigs[1].stages)
    expect(stageButtonEnabled(off, off.motorConfigs[0], 0)).toBe(false)
    expect(stageButtonEnabled(off, off.motorConfigs[0], 1)).toBe(true)
    expect(toggleStage(off, a, 1).motorConfigs[0].stages).toEqual({ '0': true, '1': true })
  })

  it('sub-stages follow their parent stage', () => {
    const doc = structuredClone(FIX['Parallel booster staging'].doc)
    const a = doc.motorConfigs[0].id
    expect(toggleStage(doc, a, 0).motorConfigs[0].stages).toEqual({ '0': false, '1': false })
  })
})
