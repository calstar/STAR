import { describe, expect, it } from 'vitest'
import { convertMethod, offsetFor, relativePosition } from './position'
import type { AxialMethod } from '../types'

// The simple model rocket's body tube: 0.3 long, front at 0.1 from the tip.
const ctx = (length: number) => ({ length, parentLength: 0.3, parentX: 0.1, prevEnd: 0.05 })

describe('axial position methods (AxialMethod.java)', () => {
  it('reproduces the golden positions of the simple model rocket', () => {
    // parachute: top 0.032 -> 0.132 absolute
    expect(0.1 + relativePosition({ method: 'top', value: 0.032 }, ctx(0.042))).toBeCloseTo(0.132, 12)
    // launch lug: middle 0 -> 0.2325
    expect(0.1 + relativePosition({ method: 'middle', value: 0 }, ctx(0.035))).toBeCloseTo(0.2325, 12)
    // fins: bottom 0 -> 0.3492
    expect(0.1 + relativePosition({ method: 'bottom', value: 0 }, ctx(0.0508))).toBeCloseTo(0.3492, 12)
    // inner tube: bottom +0.005 -> 0.33
    expect(0.1 + relativePosition({ method: 'bottom', value: 0.005 }, ctx(0.075))).toBeCloseTo(0.33, 12)
    // centering ring: bottom -0.045 -> 0.353
    expect(0.1 + relativePosition({ method: 'bottom', value: -0.045 }, ctx(0.002))).toBeCloseTo(0.353, 12)
  })

  it('absolute is from the tip, after from the previous sibling', () => {
    expect(relativePosition({ method: 'absolute', value: 0.25 }, ctx(0.01))).toBeCloseTo(0.15, 12)
    expect(relativePosition({ method: 'after', value: 0.01 }, ctx(0.01))).toBeCloseTo(0.06, 12)
  })

  it('offsetFor inverts relativePosition for every method', () => {
    const methods: AxialMethod[] = ['absolute', 'after', 'top', 'middle', 'bottom']
    for (const m of methods) {
      for (const rel of [-0.02, 0, 0.1234, 0.3]) {
        expect(relativePosition({ method: m, value: offsetFor(m, rel, ctx(0.04)) }, ctx(0.04))).toBeCloseTo(rel, 12)
      }
    }
  })

  it('changing the method keeps the component where it is (as OpenRocket does)', () => {
    const fins = { method: 'bottom' as const, value: 0 }
    const c = ctx(0.0508)
    const top = convertMethod(fins, 'top', c)
    expect(top).toEqual({ method: 'top', value: expect.closeTo(0.2492, 12) })
    const mid = convertMethod(fins, 'middle', c)
    expect(mid.value).toBeCloseTo(0.1246, 12)
    const abs = convertMethod(fins, 'absolute', c)
    expect(abs.value).toBeCloseTo(0.3492, 12)
    // and back
    expect(convertMethod(abs, 'bottom', c).value).toBe(0)
  })
})
