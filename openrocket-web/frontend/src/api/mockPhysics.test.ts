import { describe, expect, it } from 'vitest'
import { SIMPLE_ROCKET, SIMPLE_ROCKET_GOLDEN, ID } from './fixture'
import { mockAnalyze } from './mockPhysics'

/**
 * The mock is not the port; this only keeps the stand-in close enough to
 * OpenRocket that the UI looks right while the real backend is written.
 */
describe('mock analysis vs OpenRocket 24.12 (A simple model rocket)', () => {
  const a = mockAnalyze(SIMPLE_ROCKET, { mach: 0.3, aoaDeg: 0, rollRate: 0, theta: 0, configId: null })
  const g = SIMPLE_ROCKET_GOLDEN
  const rel = (x: number, y: number) => Math.abs(x - y) / Math.abs(y)

  it('places every component where OpenRocket does', () => {
    for (const gc of g.components) {
      const c = a.components.find((r) => r.id === gc.id)!
      expect(c, gc.name).toBeTruthy()
      expect(c.x, gc.name).toBeCloseTo(gc.x, 6)
    }
  })
  it('component masses within 6 %', () => {
    for (const gc of g.components) {
      const c = a.components.find((r) => r.id === gc.id)!
      expect(rel(c.mass, gc.mass), `${gc.name} ${c.mass} vs ${gc.mass}`).toBeLessThan(0.06)
    }
  })
  it('length, diameter, mass, CG, CP and stability close', () => {
    expect(a.length).toBeCloseTo(g.length, 6)
    expect(a.maxDiameter).toBeCloseTo(g.maxDiameter, 9)
    expect(rel(a.cg.mass, g.cg.mass)).toBeLessThan(0.02)
    expect(Math.abs(a.cg.x - g.cg.x)).toBeLessThan(0.003)
    expect(Math.abs(a.cp.x - g.cp.x)).toBeLessThan(0.003)
    expect(rel(a.cp.cna, g.cp.cna)).toBeLessThan(0.02)
    expect(Math.abs(a.stability.calibers - g.stability.calibers)).toBeLessThan(0.15)
    expect(rel(a.cd.total, g.cd.total)).toBeLessThan(0.1)
  })
  it('nose cone CP and fin CP match Barrowman', () => {
    const nose = a.components.find((c) => c.id === ID.nose)!
    expect(nose.cna).toBeCloseTo(2, 6)
    expect(Math.abs(nose.cpx - 0.04643)).toBeLessThan(0.001)
    const fins = a.components.find((c) => c.id === ID.fins)!
    expect(fins.cpx).toBeCloseTo(0.3746, 4)
  })
  it('draws a body, three fins, the internals, the recovery and the motor', () => {
    const kinds = a.figure.shapes.map((s) => s.kind)
    expect(kinds.filter((k) => k === 'fin').length).toBe(3)
    expect(kinds).toContain('motor')
    expect(kinds).toContain('recovery')
    expect(a.figure.shapes.find((s) => s.id === ID.nose && s.kind === 'body')!.points.length).toBeGreaterThan(40)
  })
  it('resolves the body tube auto radius from the nose cone', () => {
    expect(a.resolved[ID.body].radius).toBeCloseTo(0.0125, 9)
  })
  it('a different configuration changes the loaded mass', () => {
    const a8 = mockAnalyze(SIMPLE_ROCKET, { mach: 0.3, aoaDeg: 0, rollRate: 0, theta: 0, configId: SIMPLE_ROCKET.motorConfigs[0].id })
    expect(a8.cg.mass).toBeLessThan(a.cg.mass)
    expect(a8.cgEmpty.mass).toBeCloseTo(a.cgEmpty.mass, 9)
  })
})
