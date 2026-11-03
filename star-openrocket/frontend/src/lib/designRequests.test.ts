/**
 * The browser builds the same request bodies from a design as the server does.
 *
 * Reads the hand-written cases in tests/fixtures/design_requests/, the same files
 * tests/test_design_requests.py holds backend/design_requests.py to. Change the
 * conversion in one place only and one of the two suites fails.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { designRequests } from './designRequests'
import type { Part } from '../types'
import type { OrkConfig } from '../types/config'

const DIR = fileURLToPath(new URL('../../../tests/fixtures/design_requests', import.meta.url))
const CASES = readdirSync(DIR).filter((f) => f.endsWith('.json'))

/** Deep equality with floats to 1e-12 relative: the airframe band is computed on both sides. */
function close(a: unknown, b: unknown, path = '$'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = Math.max(1e-15, 1e-12 * Math.max(Math.abs(a), Math.abs(b)))
    if (Math.abs(a - b) > tol) throw new Error(`${path}: ${a} != ${b}`)
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new Error(`${path}: ${a.length} items vs ${b.length}`)
    a.forEach((x, i) => close(x, b[i], `${path}[${i}]`))
    return
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    expect(ka, `${path} keys`).toEqual(kb)
    for (const k of ka) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
    return
  }
  expect(a, path).toEqual(b)
}

describe('design -> request bodies, against the shared fixtures', () => {
  it('has cases', () => expect(CASES.length).toBeGreaterThanOrEqual(2))

  for (const file of CASES) {
    it(file, () => {
      const c = JSON.parse(readFileSync(join(DIR, file), 'utf-8'))
      const got = designRequests(c.config as OrkConfig, c.manifestParts as Part[])
      close(got.flightDynamics, c.expected.flightDynamics)
      close(got.ork, { ...c.expected.flightDynamics, devices: c.expected.ork_devices })
      close(got.recovery, c.expected.recovery)
    })
  }
})
