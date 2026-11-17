import { describe, expect, it } from 'vitest'
import { fmt, fmtNumber, fromDisplay, IMPERIAL, METRIC, parsePrefs, toDisplay, unitFor } from './units'

describe('units', () => {
  it('round-trips every length and mass unit exactly enough', () => {
    for (const length of ['mm', 'cm', 'm', 'in', 'ft'] as const) {
      for (const mass of ['g', 'kg', 'oz', 'lb'] as const) {
        const p = { length, mass }
        for (const kind of ['length', 'mass', 'bulkDensity', 'surfaceDensity', 'lineDensity', 'angle', 'altitude'] as const) {
          const si = 0.0123456
          expect(fromDisplay(kind, toDisplay(kind, si, p), p)).toBeCloseTo(si, 12)
        }
      }
    }
  })

  it('uses the exact inch and ounce', () => {
    expect(toDisplay('length', 0.0254, IMPERIAL)).toBeCloseTo(1, 12)
    expect(toDisplay('mass', 0.45359237, { length: 'in', mass: 'lb' })).toBeCloseTo(1, 12)
    expect(toDisplay('mass', 0.028349523125, IMPERIAL)).toBeCloseTo(1, 12)
    expect(toDisplay('length', 0.3048, { length: 'ft', mass: 'lb' })).toBeCloseTo(1, 12)
  })

  it('shows metric lengths in the chosen unit', () => {
    expect(toDisplay('length', 0.1, METRIC)).toBeCloseTo(10, 12)
    expect(toDisplay('length', 0.1, { length: 'mm', mass: 'g' })).toBeCloseTo(100, 12)
    expect(fmt('length', 0.4254, METRIC)).toBe('42.54 cm')
    expect(fmt('mass', 0.0712591, METRIC)).toBe('71.3 g')
  })

  it('angles are radians inside, degrees outside', () => {
    expect(toDisplay('angle', Math.PI / 2, METRIC)).toBeCloseTo(90, 12)
    expect(fmt('angle', Math.PI / 180 * 19, METRIC)).toBe('19°')
  })

  it('derived kinds follow the length system', () => {
    expect(unitFor('bulkDensity', METRIC).label).toBe('g/cm³')
    expect(toDisplay('bulkDensity', 680, METRIC)).toBeCloseTo(0.68, 12)
    expect(unitFor('bulkDensity', IMPERIAL).label).toBe('lb/ft³')
    expect(toDisplay('bulkDensity', 1000, IMPERIAL)).toBeCloseTo(62.428, 3)
    expect(unitFor('altitude', IMPERIAL).label).toBe('ft')
  })

  it('formats without trailing zeros and survives NaN', () => {
    expect(fmtNumber(2.5, 2)).toBe('2.5')
    expect(fmtNumber(3, 2)).toBe('3')
    expect(fmtNumber(-0.0001, 2)).toBe('-0')
    expect(fmtNumber(NaN, 2)).toBe('—')
  })

  it('parses stored prefs defensively', () => {
    expect(parsePrefs(null)).toEqual(METRIC)
    expect(parsePrefs({ length: 'in', mass: 'bogus' })).toEqual({ length: 'in', mass: 'g' })
    expect(parsePrefs({ length: 'ft', mass: 'lb' })).toEqual({ length: 'ft', mass: 'lb' })
  })
})
