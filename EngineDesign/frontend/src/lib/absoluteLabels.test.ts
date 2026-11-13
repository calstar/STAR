import { describe, expect, it } from 'vitest';

/**
 * Absolute pressures are labelled psia on the screen (ADR 0004; lib/pressure.ts).
 *
 * Layer 1's result card printed the nozzle exit pressure -- absolute, 14.22 psia on the LE4 (3)
 * stand's engine -- as "psi", beside a target it labelled "psia". This pins the card's own unit.
 */
const raw = import.meta.glob('../components/Layer1Optimization.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

describe('Layer 1 exit pressure', () => {
  it('is labelled psia, like its target', () => {
    const src = Object.values(raw)[0]
    expect(src, 'Layer1Optimization.tsx not found').toBeTruthy()
    const start = src.indexOf('>Exit Pressure<')
    expect(start).toBeGreaterThan(0)
    const card = src.slice(start, src.indexOf('</div>', start))
    expect(card).toContain('P_exit')
    expect(card).not.toMatch(/>\s*psi\s*</)
    expect(card).toMatch(/>\s*psia\s*</)
  })
})
